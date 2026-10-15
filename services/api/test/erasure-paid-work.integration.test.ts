import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { ProviderError } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';
import type { Outcome, ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';
import { fixture } from './fixture.js';

// Data erasure finishes every open supervisor reservation of the erased enrollment before it clears
// the job snapshots the bridge settles against. Real PostgreSQL, the erasure and gateway HTTP routes,
// supervisor transitions, budgets and the spend ledger. Only the provider endpoint is scripted.
const schema = `course_erasure_spend_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const origin = 'http://localhost:4310', ALLOWANCE = 100_000, TOKENS = 100_000;
const REFUSED: Outcome = { status: 'not_started', retryable: false };
/** Text only the scripted provider produces: it must never be stored once the learner is erased. */
const CANARY = `canary-${randomUUID()}`;
type Step = { status: number } | 'ok' | 'gated';
const script: Step[] = [];
let sent = 0, openGate: () => void = () => undefined;
let admin: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = () => json({ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: `Compare each value with the smallest so far. ${CANARY}` }] } }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
const scriptedFetch: typeof fetch = async () => {
  sent += 1;
  const step = script.shift();
  if (!step) throw new Error('Unexpected provider request');
  if (step === 'ok') return answer();
  // The provider has the request and answers only when the test says so.
  if (step === 'gated') return new Promise(resolve => { openGate = () => resolve(answer()); });
  return json({ error: { code: step.status, message: 'synthetic provider error', status: 'SYNTHETIC' } }, step.status);
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
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `erasure-spend-${workspaceId}`, 'Erasure spend']);
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
      settings: { maxAttempts: 1, attemptTimeoutMs: 20_000, totalTimeoutMs: 30_000, baseDelayMs: 500, maxDelayMs: 1000 } }),
  });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: TOKENS } } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await allowUnpricedPaidWork(db, workspaceId);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 100_000_000 });
}, 60000);
afterAll(async () => { openGate(); await app?.close(); await db?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

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
  // Exactly what the worker activity sends (services/supervisor/src/activities.ts).
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
async function budgets(enrollmentId: string) {
  const row = (await db.query(`SELECT e.used_micro_usd::int AS usd,e.used_tokens::int AS tokens,w.used_micro_usd::bigint AS workspace
    FROM supervisor_enrollment_budgets e JOIN supervisor_workspace_budgets w ON w.workspace_id=e.workspace_id WHERE e.enrollment_id=$1`, [enrollmentId])).rows[0];
  return { usd: row.usd as number, tokens: row.tokens as number, workspace: Number(row.workspace) };
}
async function ledger(enrollmentId: string) {
  return (await db.query(`SELECT attempt,state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,released_micro_usd::int AS released,
    actual_micro_usd::int AS actual,settled_at IS NOT NULL AS settled FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt`, [enrollmentId])).rows;
}
const dispatches = async (operationId: string) => (await db.query('SELECT * FROM provider_dispatches WHERE operation_id=$1', [operationId])).rows;
async function login(userId: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(r.statusCode, r.body).toBe(200);
  return { origin, cookie: r.cookies.map(c => c.name + '=' + c.value).join('; '), 'x-csrf-token': r.json().csrfToken as string };
}
/** The learner erases their own enrollment through the HTTP route. */
async function eraseRequest(job: Job) {
  return app.inject({ method: 'POST', url: `/api/enrollments/${job.enrollmentId}/erase`, headers: await login(job.studentId),
    payload: { confirmation: `ERASE ${job.enrollmentId.slice(0, 8)}`, reason: 'Synthetic learner asked for erasure.' } });
}
async function erase(job: Job) {
  const r = await eraseRequest(job);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { counts: Record<string, number>; replayed: boolean };
}
/** Tables (by name) holding any row that contains the canary. */
async function canaryHits() {
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).rows.map(r => r.table_name as string);
  const hits: string[] = [];
  for (const table of tables) if ((await db.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text LIKE $1`, [`%${CANARY}%`])).rows[0].n) hits.push(table);
  return hits;
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('condition not reached');
}
let ownerHeaders: Awaited<ReturnType<typeof login>> | undefined;
/** What Providers > Paid-work spend reports as still held for one enrollment. */
async function reportedHeld(enrollmentId: string) {
  if (!ownerHeaders) {
    const ownerId = randomUUID();
    await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [ownerId, `test:${ownerId}`, 'Synthetic owner']);
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, ownerId]);
    ownerHeaders = await login(ownerId);
  }
  const r = await app.inject({ method: 'GET', url: `/api/admin/workspaces/${workspaceId}/provider-spend`, headers: ownerHeaders });
  expect(r.statusCode, r.body).toBe(200);
  const row = r.json().byEnrollment.find((e: { enrollmentId: string }) => e.enrollmentId === enrollmentId);
  return { held: Number(row.held), charged: Number(row.charged), uncertain: row.uncertain as number };
}

describe('erasure finishes open supervisor reservations', () => {
  it('a reservation that was never dispatched is released once and certified, so a late first request is refused, not lost', async () => {
    const job = await prepare(), claimed = await claim(job), workspaceBefore = (await budgets(job.enrollmentId)).workspace - ALLOWANCE;
    // Cancelled before the worker reached the gateway: the operation is uncertain to the engine.
    expect((await halt(job)).snapshot.operations[0]!.status).toBe('uncertain');
    expect(await budgets(job.enrollmentId)).toMatchObject({ usd: ALLOWANCE, tokens: TOKENS });
    const erased = await erase(job);
    expect(erased.counts).toMatchObject({ paidWorkReleased: 1, paidWorkReleasedMicroUsd: ALLOWANCE, paidWorkSettled: 0, paidWorkClosedUncertain: 0 });
    expect(await budgets(job.enrollmentId)).toEqual({ usd: 0, tokens: 0, workspace: workspaceBefore });
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE, actual: null, settled: true }]);
    expect(await reportedHeld(job.enrollmentId)).toEqual({ held: 0, charged: 0, uncertain: 0 });
    expect((await db.query('SELECT counts FROM data_erasures WHERE enrollment_id=$1', [job.enrollmentId])).rows[0].counts).toMatchObject({ paidWorkReleased: 1 });
    expect((await db.query("SELECT payload FROM learning_events WHERE event_type='data.erased' AND payload->>'enrollmentId'=$1", [job.enrollmentId])).rows[0].payload.counts)
      .toMatchObject({ paidWorkReleased: 1 });
    expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', owner_id: claimed.ownerId, failure_code: 'ENROLLMENT_ERASED', outcome: REFUSED, candidate: null }]);
    // The worker's first request after erasure, and repeats of it: refused, never sent, nothing changes.
    const calls = sent, answers = await Promise.all(Array.from({ length: 4 }, () => invoke(claimed.request)));
    for (const a of answers) expect(a).toEqual(REFUSED);
    expect(sent).toBe(calls);
    // A different body for the same identity is still a conflict.
    const altered = await post({ ...claimed.request, checkpoint: { ...claimed.request.checkpoint, timeoutMs: claimed.request.checkpoint.timeoutMs + 1 } });
    expect(altered.statusCode).toBe(409);
    // The bridge cannot settle an erased job; nothing it is sent changes the finished reservation.
    await expect(settle(job, claimed, REFUSED)).rejects.toThrow();
    // Erasure replays without finishing anything twice.
    const again = await erase(job);
    expect(again).toMatchObject({ replayed: true, counts: { paidWorkReleased: 1 } });
    expect(await budgets(job.enrollmentId)).toEqual({ usd: 0, tokens: 0, workspace: workspaceBefore });
    expect(await ledger(job.enrollmentId)).toHaveLength(1);
  }, 60000);

  it('a definitely refused call the worker never settled is released', async () => {
    const job = await prepare(), claimed = await claim(job);
    script.length = 0; script.push({ status: 401 });
    expect(await invoke(claimed.request)).toEqual(REFUSED);
    await halt(job);
    expect((await erase(job)).counts).toMatchObject({ paidWorkReleased: 1 });
    expect(await budgets(job.enrollmentId)).toMatchObject({ usd: 0, tokens: 0 });
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'not_started', charged: 0, released: ALLOWANCE, settled: true }]);
    expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', failure_code: expect.not.stringMatching(/ENROLLMENT_ERASED/) }]);
  }, 60000);

  it('a completed call the worker never settled is settled at its recorded usage', async () => {
    const job = await prepare(), claimed = await claim(job);
    script.length = 0; script.push('ok');
    const outcome = await invoke(claimed.request);
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: ALLOWANCE, tokens: 120 }, usageBasis: { microUsd: 'reserved_ceiling', tokens: 'reported' } });
    await halt(job);
    expect((await erase(job)).counts).toMatchObject({ paidWorkSettled: 1, paidWorkReleased: 0, paidWorkClosedUncertain: 0 });
    // Unpriced: the full allowance stays charged; the unused tokens go back.
    expect(await budgets(job.enrollmentId)).toMatchObject({ usd: ALLOWANCE, tokens: 120 });
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'unpriced', reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, actual: null, settled: true }]);
    expect(await reportedHeld(job.enrollmentId)).toEqual({ held: 0, charged: ALLOWANCE, uncertain: 0 });
    expect(await canaryHits()).toEqual([]);
  }, 60000);

  it('a call in flight at erasure stays charged at its reservation; its late answer neither charges again nor stores the generated text', async () => {
    const job = await prepare(), claimed = await claim(job);
    script.length = 0; script.push('gated');
    const calls = sent, running = invoke(claimed.request);
    await until(async () => sent > calls);
    expect((await halt(job)).snapshot.state).toBe('cancelled');
    const workspaceBefore = (await budgets(job.enrollmentId)).workspace;
    // Erasure while the provider is still working on the request.
    expect((await erase(job)).counts).toMatchObject({ paidWorkClosedUncertain: 1, paidWorkClosedMicroUsd: ALLOWANCE, paidWorkReleased: 0, paidWorkSettled: 0 });
    const closed = [{ attempt: 1, state: 'uncertain', reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, actual: null, settled: true }];
    expect(await ledger(job.enrollmentId)).toEqual(closed);
    expect(await budgets(job.enrollmentId)).toEqual({ usd: ALLOWANCE, tokens: TOKENS, workspace: workspaceBefore });
    // Spend stays recorded (charged, uncertain) but is no longer an open hold.
    expect(await reportedHeld(job.enrollmentId)).toEqual({ held: 0, charged: ALLOWANCE, uncertain: 1 });
    expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'in_flight' }]);
    // The provider answers now. The job has no snapshot, so nothing is staged or settled.
    openGate();
    expect(await running).toEqual({ status: 'uncertain' });
    expect(sent - calls).toBe(1);
    const [row] = await dispatches(claimed.operation.id);
    expect(row).toMatchObject({ state: 'uncertain', candidate: null, outcome: { status: 'uncertain' } });
    expect((await db.query('SELECT count(*)::int AS n FROM supervisor_artifacts WHERE operation_id=$1', [claimed.operation.id])).rows[0].n).toBe(0);
    expect(await canaryHits()).toEqual([]);
    expect(await ledger(job.enrollmentId)).toEqual(closed);
    expect(await budgets(job.enrollmentId)).toEqual({ usd: ALLOWANCE, tokens: TOKENS, workspace: workspaceBefore });
    // Repeats replay the receipt without a call, and a settlement attempt is refused.
    expect(await invoke(claimed.request)).toEqual({ status: 'uncertain' });
    expect(sent - calls).toBe(1);
    await expect(settle(job, claimed, { status: 'uncertain' })).rejects.toThrow();
    expect(await ledger(job.enrollmentId)).toEqual(closed);
  }, 60000);

  it('a dispatch admitted but paused before its last fence is released, not charged, when erasure lands in between', async () => {
    const job = await prepare(), claimed = await claim(job), calls = sent;
    script.length = 0; script.push('ok');
    // Pause the sender exactly between admission (dispatch row in_flight) and its last fence: with
    // no price for the model, the workspace pricing rule it reads there waits on this lock.
    const holder = await db.connect();
    let live: ReturnType<typeof post> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE workspace_cost_settings IN ACCESS EXCLUSIVE MODE');
      live = post(claimed.request);
      await until(async () => (await dispatches(claimed.operation.id))[0]?.state === 'in_flight'
        && (await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE relation=to_regclass('workspace_cost_settings') AND NOT granted")).rows[0].n > 0);
      expect((await dispatches(claimed.operation.id))[0].sent_at).toBeNull();
      await halt(job);
      expect((await erase(job)).counts).toMatchObject({ paidWorkReleased: 1, paidWorkClosedUncertain: 0 });
      expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', failure_code: 'ENROLLMENT_ERASED', outcome: REFUSED, sent_at: null }]);
    } finally { await holder.query('COMMIT'); holder.release(); }
    const r = await live!;
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual(REFUSED);
    expect(sent).toBe(calls);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE, actual: null, settled: true }]);
    expect(await budgets(job.enrollmentId)).toMatchObject({ usd: 0, tokens: 0 });
    expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', sent_at: null, candidate: null }]);
    expect(await invoke(claimed.request)).toEqual(REFUSED);
    expect(sent).toBe(calls);
  }, 60000);

  it('erasure racing first requests for a never-dispatched operation releases exactly once', async () => {
    for (let round = 0; round < 4; round++) {
      const job = await prepare(), claimed = await claim(job), calls = sent;
      await halt(job);
      const [erased, ...answers] = await Promise.all([eraseRequest(job), ...Array.from({ length: 3 }, () => post(claimed.request))]);
      expect(erased!.statusCode, erased!.body).toBe(200);
      // Each request finds the job ended (certified by the gateway) or erased (certified by erasure);
      // one arriving while erasure commits may see the job row without a snapshot.
      for (const r of answers) {
        if (r.statusCode === 200) expect(r.json()).toEqual(REFUSED);
        else expect([404, 409]).toContain(r.statusCode);
      }
      expect(sent).toBe(calls);
      expect(await invoke(claimed.request)).toEqual(REFUSED);
      expect(await budgets(job.enrollmentId)).toMatchObject({ usd: 0, tokens: 0 });
      expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, released: ALLOWANCE, actual: null, settled: true }]);
      expect(await dispatches(claimed.operation.id)).toMatchObject([{ state: 'not_started', owner_id: claimed.ownerId }]);
    }
  }, 120000);

  it('racing a dispatch, cancellation and erasure: a sent call is never released, an unsent one is released once, budgets match the ledger', async () => {
    // ERASURE_RACE_REPEAT runs the sweep more times (stress runs); CI runs it once.
    const delays = Array.from({ length: Number(process.env.ERASURE_RACE_REPEAT ?? 1) }, () => [0, 2, 5, 10, 20, 40]).flat();
    for (const delay of delays) {
      const job = await prepare(), claimed = await claim(job), calls = sent;
      script.length = 0; script.push('ok');
      const live = post(claimed.request);
      await new Promise(resolve => setTimeout(resolve, delay));
      await halt(job);
      const [erased, ...late] = await Promise.all([eraseRequest(job), post(claimed.request), post(claimed.request)]);
      expect(erased!.statusCode, erased!.body).toBe(200);
      const first = await live;
      for (const r of [first, ...late]) expect([200, 404, 409]).toContain(r.statusCode);
      const [entry] = await ledger(job.enrollmentId), spent = await budgets(job.enrollmentId);
      expect(entry.settled).toBe(true);
      // Recorded as possibly sent exactly when the provider was called.
      expect((await dispatches(claimed.operation.id))[0].sent_at !== null).toBe(sent > calls);
      if (sent > calls) {
        expect(sent - calls).toBe(1);
        expect(['uncertain', 'unpriced']).toContain(entry.state);
        expect(entry).toMatchObject({ charged: ALLOWANCE, released: 0 });
      } else {
        expect(entry).toMatchObject({ state: 'not_started', charged: 0, released: ALLOWANCE });
      }
      expect(spent.usd).toBe(entry.charged);
      // A late answer or replay never moves money after erasure.
      expect([REFUSED.status, 'uncertain', 'succeeded']).toContain((await invoke(claimed.request)).status);
      expect(await ledger(job.enrollmentId)).toEqual([entry]);
      expect((await budgets(job.enrollmentId)).usd).toBe(entry.charged);
      expect((await dispatches(claimed.operation.id))[0].candidate).toBeNull();
      script.length = 0;
    }
    expect(await canaryHits()).toEqual([]);
  }, 180000);

  it('a priced completed call is reconciled at its actual cost and the rest of the reservation comes back', async () => {
    const ownerId = randomUUID();
    await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [ownerId, `test:${ownerId}`, 'Price operator']);
    // Synthetic operator price: 100 input and 20 output tokens cost ceil(100*0.3 + 20*2.5) = 80 micro-USD.
    await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
      effective_from,source_note,created_by) VALUES($1,$2,'gemini-test',1,'active','USD',300000,2500000,clock_timestamp()-interval '1 minute','Synthetic erasure price',$3)`,
      [randomUUID(), workspaceId, ownerId]);
    const job = await prepare(), claimed = await claim(job);
    script.length = 0; script.push('ok');
    const outcome = await invoke(claimed.request);
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: 80, tokens: 120 }, usageBasis: { microUsd: 'reported' } });
    await halt(job);
    expect((await erase(job)).counts).toMatchObject({ paidWorkSettled: 1 });
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'reconciled', reserved: ALLOWANCE, charged: 80, released: ALLOWANCE - 80, actual: 80, settled: true }]);
    expect(await budgets(job.enrollmentId)).toMatchObject({ usd: 80, tokens: 120 });
    expect((await db.query('SELECT micro_usd::int AS usd,tokens::int AS tokens FROM supervisor_job_spend WHERE job_id=$1', [job.ref.jobId])).rows[0]).toEqual({ usd: 80, tokens: 120 });
  }, 60000);
});
