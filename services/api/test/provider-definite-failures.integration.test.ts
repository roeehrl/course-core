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

// Real PostgreSQL, gateway HTTP route, supervisor transitions, spend ledger and the real Google
// REST adapter. Only the provider endpoint is scripted: each step is the HTTP answer one request gets.
const schema = `course_failures_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const ALLOWANCE = 100_000;
type Step = { status: number; headers?: Record<string, string> } | 'ok' | 'reset' | 'hang' | 'broken_body';
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
  // The request left the host; the connection then failed before any status arrived.
  if (step === 'reset') throw new TypeError('socket hang up');
  if (step === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  if (step === 'broken_body') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"candidates":[')); c.error(new Error('reset')); } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
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
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `failures-${workspaceId}`, 'Failures']);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), author]);
  const providers = composeProviders({ registry: { revision: 'test-registry', models: [
    { id: 'gemini-test', providerId: 'google-test', remoteModel: 'synthetic-text-model', enabled: true, capabilities: ['tutoring'], tools: [],
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000 }, limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'google-test', kind: 'scripted-google', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    roles: { companion: { modelId: 'gemini-test', maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
  () => 'synthetic-key-only-in-test', {
    // The production Google settings (one attempt per durable operation) with a short attempt timeout.
    'scripted-google': options => new GoogleProvider({ providerId: options.providerId, registry: options.registry, fetch: scriptedFetch,
      getApiKey: () => { const value = options.getCredential(); if (!value) throw new ProviderError('MISSING_CREDENTIAL'); return value; },
      settings: { maxAttempts: 1, attemptTimeoutMs: 300, totalTimeoutMs: 1000, baseDelayMs: 500, maxDelayMs: 1000 } }),
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
  const operation = result.snapshot.operations[0];
  const request: ProviderRequest | null = operation && result.effect === 'invoke' ? { schemaVersion: 1, operationId: operation.id, job: result.snapshot.specification.key, role: 'companion',
    checkpoint: result.snapshot.specification.checkpoints[0]!, fence: result.snapshot.specification.fence } : null;
  return { result, operation, request, ownerId };
}
async function invoke(body: ProviderRequest) {
  const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Outcome;
}
const settle = (job: Job, claimed: Awaited<ReturnType<typeof claim>>, outcome: Outcome) =>
  bridge.transition({ type: 'settle', ref: job.ref, operationId: claimed.operation!.id, ownerId: claimed.ownerId, outcome });
async function used(enrollmentId: string) {
  const e = (await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [enrollmentId])).rows[0].used_micro_usd;
  return Number(e);
}
async function ledger(enrollmentId: string) {
  return (await db.query('SELECT attempt,state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,actual_micro_usd::int AS actual,released_micro_usd::int AS released FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [enrollmentId])).rows;
}
async function dispatch(operationId: string) {
  return (await db.query("SELECT state,failure_code,cost_micro_usd,outcome,provider_usage->'attempts' AS attempts FROM provider_dispatches WHERE operation_id=$1", [operationId])).rows[0];
}
/** One job through claim -> gateway -> settle with a single scripted provider answer. */
async function once(step: Step) {
  const job = await prepare(), claimed = await claim(job);
  expect(claimed.result.effect).toBe('invoke');
  expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
  script.length = 0; script.push(step);
  const before = sent, outcome = await invoke(claimed.request!);
  expect(sent - before).toBe(1);
  const settled = await settle(job, claimed, outcome);
  return { job, claimed, outcome, settled };
}

describe('definite provider refusals release the reservation; ambiguous outcomes stay held', () => {
  it.each([
    [400, 'UPSTREAM_REJECTED'], [401, 'AUTHENTICATION'], [402, 'UPSTREAM_REJECTED'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [413, 'UPSTREAM_REJECTED'],
  ] as const)('HTTP %i is a permanent rejection: released, no cost, job fails without another call', async (status, code) => {
    const { job, claimed, outcome, settled } = await once({ status, headers: { 'retry-after': '5' } });
    expect(outcome).toEqual({ status: 'not_started', retryable: false });
    expect(settled.snapshot).toMatchObject({ state: 'failed', reason: 'provider_rejected' });
    expect(await used(job.enrollmentId)).toBe(0);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, actual: null, released: ALLOWANCE }]);
    // The receipt keeps the refusal: code, the one rejected attempt, and no cost.
    expect(await dispatch(claimed.operation!.id)).toMatchObject({ state: 'not_started', failure_code: code, cost_micro_usd: null, outcome,
      attempts: [{ attempt: 1, status, outcome: 'rejected' }] });
    // Neither a repeated gateway request (refused: the job is terminal) nor a new claim reaches the provider again.
    const before = sent;
    const repeated = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': claimed.request!.operationId }, payload: claimed.request! });
    expect(repeated.statusCode, repeated.body).toBe(409);
    expect((await claim(job)).result.effect).toBe('stop');
    expect(sent).toBe(before);
    expect(await used(job.enrollmentId)).toBe(0);
  }, 60000);

  it('HTTP 429 with Retry-After is a retryable throttle: released, retried as a new attempt, then charged once', async () => {
    const { job, claimed, outcome, settled } = await once({ status: 429, headers: { 'retry-after': '7' } });
    expect(outcome).toEqual({ status: 'not_started', retryable: true, retryAfterMs: 7000 });
    expect(settled.effect).toBe('retry');
    expect(settled.snapshot.operations[0]).toMatchObject({ attempt: 1, status: 'not_started', outcome });
    expect(await used(job.enrollmentId)).toBe(0);
    expect(await dispatch(claimed.operation!.id)).toMatchObject({ state: 'not_started', failure_code: 'THROTTLED', cost_micro_usd: null,
      attempts: [{ attempt: 1, status: 429, outcome: 'rejected' }] });
    // The workflow's next activity is a new owner of the same logical operation.
    const second = await claim(job);
    expect(second.result.effect).toBe('invoke');
    expect(second.operation).toMatchObject({ id: claimed.operation!.id, attempt: 2 });
    script.length = 0; script.push('ok');
    const before = sent, done = await invoke(second.request!);
    expect(sent - before).toBe(1);
    expect(done).toMatchObject({ status: 'succeeded', usage: { microUsd: ALLOWANCE, tokens: 120 } });
    await settle(job, second, done);
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toEqual([
      { attempt: 1, state: 'not_started', reserved: ALLOWANCE, charged: 0, actual: null, released: ALLOWANCE },
      { attempt: 2, state: 'unpriced', reserved: ALLOWANCE, charged: ALLOWANCE, actual: null, released: 0 }]);
  }, 60000);

  it('HTTP 429 without a hint is still retryable; an oversized hint is bounded', async () => {
    const bare = await once({ status: 429 });
    expect(bare.outcome).toEqual({ status: 'not_started', retryable: true });
    expect(bare.settled.effect).toBe('retry');
    const long = await once({ status: 429, headers: { 'retry-after': '86400' } });
    expect(long.outcome).toEqual({ status: 'not_started', retryable: true, retryAfterMs: 600_000 });
    // Retries stop at the checkpoint's attempt limit, each released.
    const job = bare.job;
    for (let attempt = 2; attempt <= 3; attempt++) {
      const next = await claim(job);
      script.length = 0; script.push({ status: 429 });
      const result = await settle(job, next, await invoke(next.request!));
      expect(result.effect).toBe(attempt < 3 ? 'retry' : 'stop');
    }
    expect((await claim(job)).result.snapshot).toMatchObject({ state: 'failed', reason: 'attempts_exhausted' });
    expect(await used(job.enrollmentId)).toBe(0);
    expect((await ledger(job.enrollmentId)).map(r => [r.attempt, r.state, r.charged])).toEqual([[1, 'not_started', 0], [2, 'not_started', 0], [3, 'not_started', 0]]);
  }, 60000);

  it.each([
    ['HTTP 500', { status: 500 }, 'UPSTREAM_UNAVAILABLE'], ['HTTP 503', { status: 503, headers: { 'retry-after': '1' } }, 'UPSTREAM_UNAVAILABLE'],
    ['HTTP 504', { status: 504 }, 'UPSTREAM_UNAVAILABLE'], ['HTTP 529 overloaded', { status: 529 }, 'UPSTREAM_UNAVAILABLE'],
    ['HTTP 408', { status: 408 }, 'UPSTREAM_UNAVAILABLE'], ['HTTP 409', { status: 409 }, 'UPSTREAM_REJECTED'],
    ['a connection reset after sending', 'reset', 'NETWORK_ERROR'], ['a timeout after sending', 'hang', 'TIMEOUT'],
    ['a body cut off after HTTP 200', 'broken_body', null],
  ] as const)('%s stays uncertain: the reservation is held and the call is never replayed', async (_label, step, code) => {
    const { job, claimed, outcome, settled } = await once(step as Step);
    expect(outcome).toEqual({ status: 'uncertain' });
    expect(settled.snapshot).toMatchObject({ state: 'waiting', reason: 'provider_uncertain' });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toEqual([{ attempt: 1, state: 'uncertain', reserved: ALLOWANCE, charged: ALLOWANCE, actual: null, released: 0 }]);
    const row = await dispatch(claimed.operation!.id);
    expect(row).toMatchObject({ state: 'uncertain', cost_micro_usd: null });
    if (code) expect(row.failure_code).toBe(code);
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0].outcome).not.toBe('rejected');
    const before = sent;
    expect(await invoke(claimed.request!)).toEqual({ status: 'uncertain' });
    expect((await claim(job)).result.snapshot).toMatchObject({ state: 'waiting', reason: 'provider_uncertain' });
    expect(sent).toBe(before);
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
  }, 60000);
});
