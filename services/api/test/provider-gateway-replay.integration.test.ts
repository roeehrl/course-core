import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { ProviderError } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';
import type { HostBridge, Outcome, ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';
import { fixture } from './fixture.js';

// Idempotent replay after the job ended: real PostgreSQL, the gateway HTTP route, supervisor
// transitions and the spend ledger. Only the provider endpoint is scripted, one answer per request.
const schema = `course_replay_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const ALLOWANCE = 100_000;
type Step = { status: number; headers?: Record<string, string> } | 'ok' | 'hang';
const script: Step[] = [];
let sent = 0;
let admin: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: HostBridge;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const scriptedFetch: typeof fetch = async (_url, init) => {
  sent += 1;
  const step = script.shift();
  if (!step) throw new Error('Unexpected provider request');
  if (step === 'ok') return json({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Compare each value with the smallest so far.' }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
  if (step === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  return json({ error: { code: step.status, message: 'synthetic provider error', status: 'SYNTHETIC' } }, step.status, step.headers);
};

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use a disposable TEST_DATABASE_URL and unset DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Use a disposable loopback test database without connection overrides.');
  admin = createDatabase(url.toString()); await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-csearch_path=${schema}`); db = createDatabase(url.toString());
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const course = compileCourse(fixture()), author = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [author, `test:${author}`, 'Author']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `replay-${workspaceId}`, 'Replay']);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), author]);
  const providers = composeProviders({ registry: { revision: 'test-registry', models: [
    { id: 'gemini-test', providerId: 'google-test', remoteModel: 'synthetic-text-model', enabled: true, capabilities: ['tutoring'], tools: [],
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000 }, limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'google-test', kind: 'scripted-google', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    roles: { companion: { modelId: 'gemini-test', maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
  () => 'synthetic-key-only-in-test', {
    'scripted-google': options => new GoogleProvider({ providerId: options.providerId, registry: options.registry, fetch: scriptedFetch,
      getApiKey: () => { const value = options.getCredential(); if (!value) throw new ProviderError('MISSING_CREDENTIAL'); return value; },
      settings: { maxAttempts: 1, attemptTimeoutMs: 1500, totalTimeoutMs: 3000, baseDelayMs: 500, maxDelayMs: 1000 } }),
  });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: 100_000 } } };
  app = await createServer(db, { loginCodes: true, origin: 'http://localhost:4310', secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await allowUnpricedPaidWork(db, workspaceId);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 100_000_000 });
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

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
  const lease = (await bridge.claimOutbox(randomUUID(), 100, 30000)).find(row => row.eventId === event.id)!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 10_000_000, tokens: 10_000_000 });
  return { ref: ref!, enrollmentId };
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
const halt = (job: Job, reason: 'cancel_requested' | 'deadline_exceeded') => bridge.transition({ type: 'halt', ref: job.ref, reason });
async function used(enrollmentId: string) {
  return Number((await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [enrollmentId])).rows[0].used_micro_usd);
}
async function ledger(enrollmentId: string) {
  return (await db.query('SELECT attempt,state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,released_micro_usd::int AS released FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [enrollmentId])).rows;
}
/** Everything a replay must leave untouched: the dispatch receipt, job snapshot, budgets, ledger and artifacts. */
async function recorded(job: Job, operationId: string) {
  const [dispatch, jobRow, budgets, spend, artifacts] = await Promise.all([
    db.query('SELECT * FROM provider_dispatches WHERE operation_id=$1', [operationId]),
    db.query('SELECT state,runtime_snapshot,updated_at FROM supervisor_jobs WHERE id=$1', [job.ref.jobId]),
    db.query(`SELECT (SELECT row_to_json(w) FROM supervisor_workspace_budgets w WHERE workspace_id=$1) AS workspace,
      (SELECT row_to_json(e) FROM supervisor_enrollment_budgets e WHERE enrollment_id=$2) AS enrollment`, [workspaceId, job.enrollmentId]),
    db.query('SELECT * FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [job.enrollmentId]),
    db.query('SELECT id,digest FROM supervisor_artifacts WHERE operation_id=$1 ORDER BY id', [operationId]),
  ]);
  return { dispatch: dispatch.rows, job: jobRow.rows, budgets: budgets.rows, spend: spend.rows, artifacts: artifacts.rows };
}
/** Replays the request `times` times at once and checks each answer and that nothing changed or was sent. */
async function replay(job: Job, claimed: Claimed, expected: Outcome, times = 1) {
  const before = await recorded(job, claimed.operation.id), calls = sent;
  const answers = await Promise.all(Array.from({ length: times }, () => invoke(claimed.request)));
  for (const answer of answers) expect(answer).toEqual(expected);
  expect(sent).toBe(calls);
  expect(await recorded(job, claimed.operation.id)).toEqual(before);
  return answers[0]!;
}
/** One job through claim -> gateway with a single scripted provider answer. */
async function dispatched(step: Step) {
  const job = await prepare(), claimed = await claim(job);
  script.length = 0; script.push(step);
  const calls = sent, outcome = await invoke(claimed.request);
  expect(sent - calls).toBe(1);
  return { job, claimed, outcome };
}

describe('a repeated gateway request for an ended job replays the recorded outcome', () => {
  it('succeeded: cancelled after settling, the receipt replays (also concurrently) and settles idempotently', async () => {
    const { job, claimed, outcome } = await dispatched('ok');
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: ALLOWANCE, tokens: 120 } });
    expect((await settle(job, claimed, outcome)).effect).toBe('continue');
    expect((await halt(job, 'cancel_requested')).snapshot.state).toBe('cancelled');
    await replay(job, claimed, outcome, 6);
    // The worker that lost its first answer settles the replay: same receipt, no settlement conflict, no new charge.
    expect((await settle(job, claimed, outcome)).effect).toBe('stop');
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
  }, 60000);

  it('not_started (permanent refusal): the job failed; the refusal replays and its settlement is accepted', async () => {
    const { job, claimed, outcome } = await dispatched({ status: 401 });
    expect(outcome).toEqual({ status: 'not_started', retryable: false });
    expect((await settle(job, claimed, outcome)).snapshot).toMatchObject({ state: 'failed', reason: 'provider_rejected' });
    await replay(job, claimed, outcome, 6);
    expect((await settle(job, claimed, outcome)).effect).toBe('stop');
    expect(await used(job.enrollmentId)).toBe(0);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE }]);
  }, 60000);

  it('not_started (retryable throttle) after cancellation replays with its hint; no new attempt is admitted', async () => {
    const { job, claimed, outcome } = await dispatched({ status: 429, headers: { 'retry-after': '7' } });
    expect(outcome).toEqual({ status: 'not_started', retryable: true, retryAfterMs: 7000 });
    expect((await settle(job, claimed, outcome)).effect).toBe('retry');
    expect((await halt(job, 'cancel_requested')).snapshot.state).toBe('cancelled');
    await replay(job, claimed, outcome);
    expect((await settle(job, claimed, outcome)).effect).toBe('stop');
    expect(await used(job.enrollmentId)).toBe(0);
  }, 60000);

  it('uncertain: after the job failed on its deadline, the replay stays uncertain and the reservation stays held', async () => {
    const { job, claimed, outcome } = await dispatched({ status: 500 });
    expect(outcome).toEqual({ status: 'uncertain' });
    expect((await settle(job, claimed, outcome)).snapshot).toMatchObject({ state: 'waiting', reason: 'provider_uncertain' });
    expect((await halt(job, 'deadline_exceeded')).snapshot).toMatchObject({ state: 'failed', reason: 'deadline_exceeded' });
    await replay(job, claimed, outcome, 4);
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'uncertain', reserved: ALLOWANCE, charged: ALLOWANCE, released: 0 }]);
  }, 60000);

  it('a lost answer settled as uncertain is corrected by the replay: a recorded refusal releases the reservation once', async () => {
    const { job, claimed, outcome } = await dispatched({ status: 403 });
    expect(outcome).toEqual({ status: 'not_started', retryable: false });
    // The worker never saw the answer (HTTP failure maps to uncertain) and settles that; then the job is cancelled.
    await settle(job, claimed, { status: 'uncertain' });
    expect((await halt(job, 'cancel_requested')).snapshot.state).toBe('cancelled');
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await replay(job, claimed, outcome)).toEqual(outcome);
    expect((await settle(job, claimed, outcome)).snapshot.operations[0]).toMatchObject({ status: 'not_started', outcome });
    await settle(job, claimed, outcome);
    expect(await used(job.enrollmentId)).toBe(0);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE }]);
  }, 60000);

  it('a lost successful answer replays after a stale fence ended the job and settles its real usage', async () => {
    const { job, claimed, outcome } = await dispatched('ok');
    await settle(job, claimed, { status: 'uncertain' });
    await db.query('UPDATE enrollments SET profile_revision=profile_revision+1,revision=revision+1 WHERE id=$1', [job.enrollmentId]);
    expect(await replay(job, claimed, outcome, 4)).toMatchObject({ status: 'succeeded' });
    expect((await settle(job, claimed, outcome)).snapshot).toMatchObject({ state: 'cancelled', reason: 'stale_revision' });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'unpriced', reserved: ALLOWANCE, charged: ALLOWANCE, released: 0 }]);
  }, 60000);

  it('a dispatch still running when the job ends replays as uncertain; it then records its own outcome', async () => {
    const job = await prepare(), claimed = await claim(job);
    script.length = 0; script.push('hang');
    const calls = sent, running = invoke(claimed.request);
    for (let i = 0; i < 200 && sent === calls; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(sent - calls).toBe(1);
    expect((await halt(job, 'cancel_requested')).snapshot.state).toBe('cancelled');
    expect((await db.query('SELECT state FROM provider_dispatches WHERE operation_id=$1', [claimed.operation.id])).rows[0].state).toBe('in_flight');
    const replays = await Promise.all(Array.from({ length: 4 }, () => invoke(claimed.request)));
    for (const answer of replays) expect(answer).toEqual({ status: 'uncertain' });
    expect(sent - calls).toBe(1);
    expect(await running).toEqual({ status: 'uncertain' });
    await replay(job, claimed, { status: 'uncertain' });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
  }, 60000);

  it('a different request under the same identity is a conflict, live or ended, and changes nothing', async () => {
    const { job, claimed, outcome } = await dispatched({ status: 401 });
    const altered: ProviderRequest = { ...claimed.request, checkpoint: { ...claimed.request.checkpoint, timeoutMs: claimed.request.checkpoint.timeoutMs + 1 } };
    const before = await recorded(job, claimed.operation.id), calls = sent;
    // Not yet settled: the job is still live.
    const live = await post(altered);
    expect(live.statusCode, live.body).toBe(409); expect(live.json().error).toBe('PROVIDER_REQUEST_CONFLICT');
    await settle(job, claimed, outcome);
    const settledState = await recorded(job, claimed.operation.id);
    const ended = await Promise.all(Array.from({ length: 4 }, () => post(altered)));
    for (const r of ended) { expect(r.statusCode, r.body).toBe(409); expect(r.json().error).toBe('PROVIDER_REQUEST_CONFLICT'); }
    expect(sent).toBe(calls);
    expect(await recorded(job, claimed.operation.id)).toEqual(settledState);
    expect(before.dispatch).toEqual(settledState.dispatch);
    // The identical request still replays.
    await replay(job, claimed, outcome);
  }, 60000);

  it('an ended job with no recorded dispatch gets a certified refusal without a provider call', async () => {
    const job = await prepare(), claimed = await claim(job), calls = sent;
    await halt(job, 'cancel_requested');
    expect(await invoke(claimed.request)).toEqual({ status: 'not_started', retryable: false });
    expect(sent).toBe(calls);
    expect((await db.query('SELECT state FROM provider_dispatches WHERE operation_id=$1', [claimed.operation.id])).rows).toEqual([{ state: 'not_started' }]);
  }, 60000);
});
