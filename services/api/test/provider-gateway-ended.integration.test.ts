import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { ProviderError } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';
import type { Outcome, ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { fixture } from './fixture.js';
import { streamedIfAsked } from './streamed-provider-fixture.js';

// Gateway answers for ended jobs: after data erasure, and for a first request that arrives after the
// job ended. Real PostgreSQL, the gateway and erasure HTTP routes, supervisor transitions and the
// spend ledger. Only the provider endpoint is scripted, one answer per request.
const schema = `course_ended_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const origin = 'http://localhost:4310', ALLOWANCE = 100_000;
const REFUSED: Outcome = { status: 'not_started', retryable: false };
type Step = { status: number } | 'ok' | 'hang';
const script: Step[] = [];
let sent = 0;
let testDatabase: TestDatabase | undefined, db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const scriptedFetch: typeof fetch = async (_url, init) => {
  sent += 1;
  const step = script.shift();
  if (!step) throw new Error('Unexpected provider request');
  if (step === 'ok') return json({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Compare each value with the smallest so far.' }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
  if (step === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  return json({ error: { code: step.status, message: 'synthetic provider error', status: 'SYNTHETIC' } }, step.status);
};

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture()), author = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [author, `test:${author}`, 'Author']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `ended-${workspaceId}`, 'Ended']);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), author]);
  const providers = composeProviders({ registry: { revision: 'test-registry', models: [
    { id: 'gemini-test', providerId: 'google-test', remoteModel: 'synthetic-text-model', enabled: true, capabilities: ['tutoring'], tools: [],
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000 }, limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'google-test', kind: 'scripted-google', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    roles: { companion: { modelId: 'gemini-test', maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
  () => 'synthetic-key-only-in-test', {
    'scripted-google': options => new GoogleProvider({ providerId: options.providerId, registry: options.registry, fetch: (async (url, init) => streamedIfAsked(String(url), init, await scriptedFetch(url, init))) as typeof fetch,
      getApiKey: () => { const value = options.getCredential(); if (!value) throw new ProviderError('MISSING_CREDENTIAL'); return value; },
      settings: { maxAttempts: 1, attemptTimeoutMs: 1500, totalTimeoutMs: 3000, baseDelayMs: 500, maxDelayMs: 1000 } }),
  });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: 100_000 } } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await allowUnpricedPaidWork(db, workspaceId);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 100_000_000 });
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function prepare() {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Synthetic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Synthetic' }), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, 'How do I find the minimum?', JSON.stringify({ episodeId: 'min' })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested',
    payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 10_000_000, tokens: 10_000_000 });
  return { ref: ref!, enrollmentId, studentId };
}
type Job = Awaited<ReturnType<typeof prepare>>;
async function claim(job: Job) {
  const ownerId = randomUUID(), result = await bridge.transition({ type: 'claim', ref: job.ref, checkpointId: 'generate', ownerId, availability: { status: 'ready' } });
  expect(result.effect).toBe('invoke');
  const operation = result.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: result.snapshot.specification.key, role: 'companion',
    checkpoint: result.snapshot.specification.checkpoints[0]!, fence: result.snapshot.specification.fence };
  return { operation, request, ownerId };
}
type Claimed = Awaited<ReturnType<typeof claim>>;
const post = (body: ProviderRequest) =>
  app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
async function invoke(body: ProviderRequest) {
  const r = await post(body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Outcome;
}
const settle = (job: Job, claimed: Claimed, outcome: Outcome) =>
  bridge.transition({ type: 'settle', ref: job.ref, operationId: claimed.operation.id, ownerId: claimed.ownerId, outcome });
const halt = (job: Job) => bridge.transition({ type: 'halt', ref: job.ref, reason: 'cancel_requested' });
async function used(enrollmentId: string) {
  return Number((await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [enrollmentId])).rows[0].used_micro_usd);
}
async function ledger(enrollmentId: string) {
  return (await db.query('SELECT attempt,state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,released_micro_usd::int AS released FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [enrollmentId])).rows;
}
const dispatches = async (operationId: string) => (await db.query('SELECT * FROM provider_dispatches WHERE operation_id=$1', [operationId])).rows;
/** Everything a replay must leave untouched. */
async function recorded(job: Job, operationId: string) {
  const [dispatch, jobRow, budgets, spend, artifacts] = await Promise.all([
    dispatches(operationId),
    db.query('SELECT state,runtime_snapshot,updated_at FROM supervisor_jobs WHERE id=$1', [job.ref.jobId]),
    db.query(`SELECT (SELECT row_to_json(w) FROM supervisor_workspace_budgets w WHERE workspace_id=$1) AS workspace,
      (SELECT row_to_json(e) FROM supervisor_enrollment_budgets e WHERE enrollment_id=$2) AS enrollment`, [workspaceId, job.enrollmentId]),
    db.query('SELECT * FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [job.enrollmentId]),
    db.query('SELECT id,digest,content FROM supervisor_artifacts WHERE operation_id=$1 ORDER BY id', [operationId]),
  ]);
  return { dispatch: dispatch, job: jobRow.rows, budgets: budgets.rows, spend: spend.rows, artifacts: artifacts.rows };
}
async function replay(job: Job, claimed: Claimed, expected: Outcome, times = 1) {
  const before = await recorded(job, claimed.operation.id), calls = sent;
  const answers = await Promise.all(Array.from({ length: times }, () => invoke(claimed.request)));
  for (const answer of answers) expect(answer).toEqual(expected);
  expect(sent).toBe(calls);
  expect(await recorded(job, claimed.operation.id)).toEqual(before);
}
async function dispatched(step: Step) {
  const job = await prepare(), claimed = await claim(job);
  script.length = 0; script.push(step);
  const calls = sent, outcome = await invoke(claimed.request);
  expect(sent - calls).toBe(1);
  return { job, claimed, outcome };
}
/** The learner erases their own enrollment through the HTTP route. */
async function erase(job: Job) {
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, job.studentId) } });
  expect(login.statusCode, login.body).toBe(200);
  const r = await app.inject({ method: 'POST', url: `/api/enrollments/${job.enrollmentId}/erase`,
    headers: { origin, cookie: login.cookies.map(c => c.name + '=' + c.value).join('; '), 'x-csrf-token': login.json().csrfToken },
    payload: { confirmation: `ERASE ${job.enrollmentId.slice(0, 8)}`, reason: 'Synthetic learner asked for erasure.' } });
  expect(r.statusCode, r.body).toBe(200);
}
const waiting = async (key: string) => Number((await db.query(
  "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=(hashtext($1)::bigint & 4294967295)::oid", [key])).rows[0].n);
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
}

describe('data erasure keeps the non-personal dispatch outcome', () => {
  it('an erased succeeded dispatch replays its outcome (also concurrently) with no provider call or change', async () => {
    const { job, claimed, outcome } = await dispatched('ok');
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: ALLOWANCE, tokens: 120 } });
    await settle(job, claimed, outcome);
    expect((await halt(job)).snapshot.state).toBe('cancelled');
    const [before] = await dispatches(claimed.operation.id), spend = await ledger(job.enrollmentId);
    // Erasure keeps only the outcome's known fields: anything else is dropped.
    await db.query(`UPDATE provider_dispatches SET outcome=jsonb_set(outcome||'{"note":"personal"}','{artifact,text}','"personal"') WHERE operation_id=$1`, [claimed.operation.id]);
    await erase(job);
    const [after] = await dispatches(claimed.operation.id);
    expect(after.outcome).toEqual(outcome);
    expect(after.candidate).toBeNull();
    expect(after).toMatchObject({ state: 'completed', provider_usage: before.provider_usage, cost_micro_usd: before.cost_micro_usd, model_id: before.model_id });
    expect(JSON.stringify(after)).not.toContain('smallest so far');
    // The spend audit is unchanged by erasure.
    expect(await ledger(job.enrollmentId)).toEqual(spend);
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    await replay(job, claimed, outcome, 6);
  }, 60000);

  it('an erased refusal replays even though erasure cleared the job snapshot; a first request finds the refusal erasure recorded', async () => {
    const { job, claimed, outcome } = await dispatched({ status: 401 });
    expect(outcome).toEqual(REFUSED);
    expect((await settle(job, claimed, outcome)).snapshot.state).toBe('failed');
    await erase(job);
    expect((await db.query('SELECT runtime_snapshot FROM supervisor_jobs WHERE id=$1', [job.ref.jobId])).rows[0].runtime_snapshot).toBeNull();
    await replay(job, claimed, outcome, 4);
    // An operation the gateway never recorded on an erased job: erasure released its reservation and
    // recorded the certified refusal (erasure-spend.ts), so the first request replays that, unsent.
    const other = await prepare(), otherClaim = await claim(other), calls = sent;
    await halt(other); await erase(other);
    expect(await invoke(otherClaim.request)).toEqual(REFUSED);
    expect(sent).toBe(calls);
    expect(await dispatches(otherClaim.operation.id)).toMatchObject([{ state: 'not_started', failure_code: 'ENROLLMENT_ERASED' }]);
    expect(await used(other.enrollmentId)).toBe(0);
  }, 60000);

  it('a receipt erased before outcomes were kept replays as uncertain, never a server error', async () => {
    const { job, claimed, outcome } = await dispatched('ok');
    await settle(job, claimed, outcome); await halt(job); await erase(job);
    // What the earlier erasure left: no outcome at all.
    await db.query('UPDATE provider_dispatches SET outcome=NULL WHERE operation_id=$1', [claimed.operation.id]);
    await replay(job, claimed, { status: 'uncertain' }, 4);
  }, 60000);
});

describe('a first request for an ended job is certified not started', () => {
  it('cancelled before any dispatch: the refusal is recorded once (also concurrently) and releases the reservation once', async () => {
    const job = await prepare(), claimed = await claim(job), calls = sent;
    expect((await halt(job)).snapshot.state).toBe('cancelled');
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    const answers = await Promise.all(Array.from({ length: 6 }, () => invoke(claimed.request)));
    for (const answer of answers) expect(answer).toEqual(REFUSED);
    expect(sent).toBe(calls);
    expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', owner_id: claimed.ownerId, failure_code: 'SUPERVISOR_JOB_ENDED', outcome: REFUSED, candidate: null, provider_usage: null }]);
    expect((await settle(job, claimed, REFUSED)).effect).toBe('stop');
    expect(await used(job.enrollmentId)).toBe(0);
    const released = [{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE }];
    expect(await ledger(job.enrollmentId)).toEqual(released);
    // Repeats replay the receipt; settling it again changes nothing.
    await replay(job, claimed, REFUSED, 4);
    await settle(job, claimed, REFUSED);
    expect(await used(job.enrollmentId)).toBe(0);
    expect(await ledger(job.enrollmentId)).toEqual(released);
  }, 60000);

  it('a request that does not match the stored operation gets no certificate', async () => {
    const job = await prepare(), claimed = await claim(job);
    await halt(job);
    const altered: ProviderRequest = { ...claimed.request, checkpoint: { ...claimed.request.checkpoint, timeoutMs: claimed.request.checkpoint.timeoutMs + 1 } };
    const r = await post(altered);
    expect(r.statusCode, r.body).toBe(409); expect(r.json().error).toBe('SUPERVISOR_OPERATION_MISMATCH');
    expect(await dispatches(claimed.operation.id)).toEqual([]);
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
  }, 60000);

  it('the certificate blocks a later dispatch by the same owner when the job briefly recovers', async () => {
    const job = await prepare(), claimed = await claim(job), calls = sent;
    // Removing the learner's membership ends supervision for now; restoring it makes the job live again.
    await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, job.studentId]);
    expect(await invoke(claimed.request)).toEqual(REFUSED);
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, job.studentId]);
    script.length = 0; script.push('ok');
    expect(await invoke(claimed.request)).toEqual(REFUSED);
    expect(sent).toBe(calls);
    expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', failure_code: 'SUPERVISOR_JOB_ENDED' }]);
    await settle(job, claimed, REFUSED);
    expect(await used(job.enrollmentId)).toBe(0);
  }, 60000);

  it('a dispatch in flight when the job ends is never certified: requests stay uncertain and the reservation stays held', async () => {
    const job = await prepare(), claimed = await claim(job);
    script.length = 0; script.push('hang');
    const calls = sent, running = invoke(claimed.request);
    await until(async () => sent > calls);
    await halt(job);
    const answers = await Promise.all(Array.from({ length: 4 }, () => invoke(claimed.request)));
    for (const answer of answers) expect(answer).toEqual({ status: 'uncertain' });
    expect(await running).toEqual({ status: 'uncertain' });
    expect(sent - calls).toBe(1);
    await settle(job, claimed, { status: 'uncertain' });
    await replay(job, claimed, { status: 'uncertain' });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'uncertain', charged: ALLOWANCE, released: 0 }]);
  }, 60000);

  it('a dispatch admitted first under the lock answers the later first request from its own receipt', async () => {
    const job = await prepare(), claimed = await claim(job), key = `provider:${claimed.operation.id}`, calls = sent;
    script.length = 0; script.push('ok');
    const holder = await db.connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      // The live request passes the job fence, then waits for admission.
      const live = post(claimed.request);
      await until(async () => await waiting(key) === 1);
      await halt(job);
      // Requests after the job ended find no receipt yet and wait on the same lock.
      const late = [post(claimed.request), post(claimed.request)];
      await until(async () => await waiting(key) === 3);
      await holder.query('COMMIT');
      const [first, ...rest] = await Promise.all([live, ...late]);
      expect(first!.statusCode, first!.body).toBe(200);
      // Admitted first, then stopped by its last fence before sending: its own certified refusal.
      expect(first!.json()).toEqual(REFUSED);
      for (const r of rest) { expect(r.statusCode, r.body).toBe(200); expect(['uncertain', 'not_started']).toContain(r.json().status); }
    } finally { holder.release(); }
    expect(sent).toBe(calls);
    expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', owner_id: claimed.ownerId }]);
    expect((await dispatches(claimed.operation.id))[0].failure_code).not.toBe('SUPERVISOR_JOB_ENDED');
    await settle(job, claimed, REFUSED);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE }]);
  }, 60000);

  it('racing a first dispatch with cancellation: a sent call is never certified, an unsent one releases exactly once', async () => {
    for (const delay of [0, 1, 3, 6, 12, 25]) {
      const job = await prepare(), claimed = await claim(job), calls = sent;
      script.length = 0; script.push('ok');
      const live = invoke(claimed.request);
      await new Promise(resolve => setTimeout(resolve, delay));
      await halt(job);
      const late = await Promise.all(Array.from({ length: 3 }, () => invoke(claimed.request)));
      const answer = await live, [row] = await dispatches(claimed.operation.id);
      if (sent > calls) {
        expect(sent - calls).toBe(1);
        expect(answer.status).toBe('succeeded');
        expect(row.state).toBe('completed');
        for (const other of late) expect(['succeeded', 'uncertain']).toContain(other.status);
        await settle(job, claimed, answer);
        expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'unpriced', charged: ALLOWANCE, released: 0 }]);
      } else {
        expect(answer).toEqual(REFUSED);
        expect(row.state).toBe('not_started');
        for (const other of late) expect(['not_started', 'uncertain']).toContain(other.status);
        await settle(job, claimed, REFUSED);
        await settle(job, claimed, REFUSED);
        expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE }]);
      }
      script.length = 0;
    }
  }, 120000);
});
