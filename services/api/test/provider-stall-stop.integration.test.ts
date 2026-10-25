import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { once as onceEvent } from 'node:events';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { ProviderError } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';
import { HttpProviderGateway, type Outcome, type ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { registerProviderGateway } from '../src/provider-gateway.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { fixture } from './fixture.js';

// Stalled and stopped provider calls (live companion findings B-2, B-4, U2 on Core 0.1.57) through
// the real Google REST adapter, gateway, bridge, ledger and PostgreSQL, with the provider played by
// a local HTTP stub server over real sockets (the adapter's fixed origin is rewritten to it). No
// live provider is contacted; the stub's answers are synthetic.
const schema = `course_stall_stop_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const origin = 'http://127.0.0.1', MODEL = 'gemini-stub';
// The pilot's companion reservation and operator price ($0.75 / $3.75 per million input / output tokens).
const ALLOWANCE = 31_410, INPUT_PRICE = 750_000, OUTPUT_PRICE = 3_750_000, PROMPT = 2000;
const priced = (input: number, output: number) => Math.ceil((input * INPUT_PRICE + output * OUTPUT_PRICE) / 1_000_000);

type Mode = 'never' | 'stall' | 'stream' | 'stream-no-usage' | 'finish';
const stub = { modes: [] as Mode[], requests: 0, chunks: 0, lastOutput: 0, closedAt: [] as number[], open: new Set<ServerResponse>() };
const encoder = new TextEncoder();
const chunk = (text: string, output: number | null, finish = false) => encoder.encode(`data: ${JSON.stringify({
  candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, ...(finish ? { finishReason: 'STOP' } : {}) }],
  ...(output === null ? {} : { usageMetadata: { promptTokenCount: PROMPT, candidatesTokenCount: output, totalTokenCount: PROMPT + output } }) })}\n\n`);
const providerServer = createHttpServer((request, response) => {
  stub.requests += 1;
  const mode = stub.modes.shift() ?? 'never';
  // A response closed before it finished: the client (the gateway) dropped the connection.
  response.on('close', () => { stub.open.delete(response); if (!response.writableFinished) stub.closedAt.push(Date.now()); });
  stub.open.add(response);
  request.resume();
  if (mode === 'never') return;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const write = (text: string, output: number | null, finish = false) => { stub.chunks += 1; if (output !== null) stub.lastOutput = output; response.write(chunk(text, output, finish)); };
  if (mode === 'stall') { write('Compare the ', 3); write('two values ', 7); return; }
  if (mode === 'finish') {
    let n = 0;
    const timer = setInterval(() => { n += 1; if (n < 6) write(`part ${n} `, n * 4); else { clearInterval(timer); write('done.', 30, true); response.end(); } }, 40);
    response.on('close', () => clearInterval(timer));
    return;
  }
  let n = 0;
  const timer = setInterval(() => { n += 1; write(`piece ${n} `, mode === 'stream' ? n * 5 : null); }, 25);
  response.on('close', () => clearInterval(timer));
});
let providerOrigin = '';
const stubFetch: typeof fetch = (url, init) => globalThis.fetch(String(url).replace('https://generativelanguage.googleapis.com', providerOrigin), init);

let testDatabase: TestDatabase | undefined, db: Database, app: Awaited<ReturnType<typeof createServer>>, base = '', bridge: PostgresSupervisorBridge;
let gatewayOnly: ReturnType<typeof Fastify> | undefined, gatewayOnlyBase = '';
const ownerId = randomUUID(), instructorId = randomUUID();
const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: 500_000 } } };

beforeAll(async () => {
  providerServer.listen(0, '127.0.0.1'); await onceEvent(providerServer, 'listening');
  providerOrigin = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}`;
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture());
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3),($4,$5,$6)', [ownerId, `test:${ownerId}`, 'Owner', instructorId, `test:${instructorId}`, 'Instructor']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `stall-${workspaceId}`, 'Stall and stop']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'instructor')", [workspaceId, ownerId, instructorId]);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), ownerId]);
  await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
    effective_from,source_note,created_by) VALUES($1,$2,$3,1,'active','USD',$4,$5,clock_timestamp()-interval '1 day','Synthetic stub price',$6)`,
    [randomUUID(), workspaceId, MODEL, INPUT_PRICE, OUTPUT_PRICE, ownerId]);
  const providers = composeProviders({ registry: { revision: 'stall-stop', models: [
    { id: MODEL, providerId: 'google-stub', remoteModel: 'gemini-3.8-flash', enabled: true, capabilities: ['tutoring'], tools: [],
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000 }, limits: { maxInputCharacters: 20000, maxOutputTokens: 4096 } }] },
    adapters: [{ id: 'google-stub', kind: 'stub-google', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    // The production first-byte and idle bounds (20 s) are capped here by the adapter's short attempt bound.
    roles: { companion: { modelId: MODEL, maxInputCharacters: 12000, maxOutputTokens: 4096 } } },
  () => 'synthetic-key-only-in-test', {
    'stub-google': options => new GoogleProvider({ providerId: options.providerId, registry: options.registry, fetch: stubFetch,
      getApiKey: () => { const value = options.getCredential(); if (!value) throw new ProviderError('MISSING_CREDENTIAL'); return value; },
      settings: { maxAttempts: 1, attemptTimeoutMs: 600, totalTimeoutMs: 60000, baseDelayMs: 500, maxDelayMs: 1000 } }),
  });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor, providers });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 100_000_000 });
  // A second gateway with neither the commit wake-up nor a useful poll: only the worker's request
  // closing can tell it that a call should stop (the workflow/activity path, alone).
  gatewayOnly = Fastify();
  registerProviderGateway(gatewayOnly, db, providers, { serviceToken: token, workspaceIds: [workspaceId], cancellationPollMs: 600_000 });
  gatewayOnlyBase = await gatewayOnly.listen({ port: 0, host: '127.0.0.1' });
}, 60000);
afterAll(async () => {
  for (const response of stub.open) response.destroy();
  providerServer.close();
  await gatewayOnly?.close(); await app?.close(); await db?.end(); await testDatabase?.drop();
});

async function session(userId: string) {
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(login.statusCode, login.body).toBe(200);
  return { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken as string };
}
async function prepare(enrollmentBudget = 10_000_000) {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Synthetic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Synthetic' }), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
    [messageId, enrollmentId, 'Which classification is correct for a frozen feature stage?', JSON.stringify({ episodeId: 'min' })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested',
    payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const ref = await deliver(event.id);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: enrollmentBudget, tokens: 10_000_000 });
  return { ref, enrollmentId, messageId, learner: await session(studentId) };
}
async function deliver(eventId: string) {
  const lease = (await bridge.claimOutboxEvent(eventId, randomUUID(), 30000))!;
  expect(lease).toBeTruthy();
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  return ref!;
}
type Job = Awaited<ReturnType<typeof prepare>>;
async function claim(ref: Job['ref']) {
  const ownerId = randomUUID(), result = await bridge.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId, availability: { status: 'ready' } });
  expect(result.effect).toBe('invoke');
  const operation = result.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: result.snapshot.specification.key, role: 'companion',
    checkpoint: result.snapshot.specification.checkpoints[0]!, fence: result.snapshot.specification.fence };
  return { operation, request, ownerId };
}
async function invoke(body: ProviderRequest) {
  const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Outcome;
}
const settle = (ref: Job['ref'], claimed: Awaited<ReturnType<typeof claim>>, outcome: Outcome) =>
  bridge.transition({ type: 'settle', ref, operationId: claimed.operation.id, ownerId: claimed.ownerId, outcome });
const used = async (enrollmentId: string) => Number((await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [enrollmentId])).rows[0].used_micro_usd);
const ledger = async (enrollmentId: string) => (await db.query(`SELECT id,attempt,state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,
  released_micro_usd::int AS released,settled_at IS NOT NULL AS settled FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY reserved_at`, [enrollmentId])).rows;
const dispatch = async (operationId: string) => (await db.query(`SELECT state,failure_code,cost_micro_usd::int AS cost,outcome,provider_usage->'attempts' AS attempts
  FROM provider_dispatches WHERE operation_id=$1`, [operationId])).rows[0];
const artifacts = async (jobId: string) => (await db.query('SELECT content FROM supervisor_artifacts WHERE job_id=$1', [jobId])).rows.map(r => r.content);
async function until(read: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await read())) { if (Date.now() > deadline) throw new Error('condition not met in time'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const conversation = async (job: Job) => (await app.inject({ url: `/api/enrollments/${job.enrollmentId}/companion`, headers: job.learner })).json().messages as Record<string, unknown>[];
const revision = async (enrollmentId: string) => (await db.query('SELECT revision FROM enrollments WHERE id=$1', [enrollmentId])).rows[0].revision as number;
const stopReply = async (job: Job) => app.inject({ method: 'POST', url: `/api/enrollments/${job.enrollmentId}/companion/messages/${job.messageId}/cancel`,
  headers: job.learner, payload: { expectedRevision: await revision(job.enrollmentId), idempotencyKey: `stop-${randomUUID()}` } });
const owner = async () => session(ownerId);
const uncertainList = async (headers: Record<string, string>) => app.inject({ url: `/api/admin/workspaces/${workspaceId}/provider-spend/uncertain`, headers });
const settleCall = async (headers: Record<string, string>, ledgerId: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/admin/workspaces/${workspaceId}/provider-spend/uncertain/${ledgerId}/settle`, headers, payload: body });

describe('a call that gets no reply (B-2)', () => {
  it('ends at the first-byte bound as uncertain and held; the question is asked once more within the budget; a second stall reads as unavailable', async () => {
    const job = await prepare(), first = await claim(job.ref);
    stub.modes = ['never'];
    const requests = stub.requests, closed = stub.closedAt.length, started = Date.now();
    const outcome = await invoke(first.request);
    // The adapter's attempt bound (600 ms here, below the 20 s production bound) ends it, not the 60 s call bound.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcome).toEqual({ status: 'uncertain' });
    expect(stub.requests - requests).toBe(1);
    await until(() => stub.closedAt.length > closed);
    const row = await dispatch(first.operation.id);
    expect(row).toMatchObject({ state: 'uncertain', failure_code: 'NO_RESPONSE', cost: null });
    expect(row.attempts).toMatchObject([{ status: null, outcome: 'unknown' }]);
    // The request was sent, so it may have been billed: the whole reservation stays held.
    const settled = await settle(job.ref, first, outcome);
    expect(settled.snapshot).toMatchObject({ state: 'cancelled', reason: 'cancel_requested' });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'uncertain', reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, settled: false }]);
    // Asked once more, automatically: the question is queued again, never shown twice.
    let messages = await conversation(job);
    expect(messages.filter(m => m.role === 'learner')).toHaveLength(1);
    expect(messages.find(m => m.id === job.messageId)).toMatchObject({ job_id: null, job_state: null, job_stalled: null });
    const retry = (await db.query("SELECT id,actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.retry_requested'", [job.enrollmentId])).rows;
    expect(retry).toMatchObject([{ actor_kind: 'system', payload: { messageId: job.messageId, retryOfJobId: job.ref.jobId } }]);
    const second = await deliver(retry[0].id);
    expect(second.jobId).not.toBe(job.ref.jobId);
    expect((await db.query('SELECT job_id FROM companion_messages WHERE id=$1', [job.messageId])).rows[0].job_id).toBe(second.jobId);
    // The second call stalls too: no third call; the learner is told and can ask again.
    const again = await claim(second);
    stub.modes = ['never'];
    const repeat = await invoke(again.request);
    expect(repeat).toEqual({ status: 'uncertain' });
    expect((await settle(second, again, repeat)).snapshot).toMatchObject({ state: 'waiting', reason: 'provider_uncertain' });
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.retry_requested'", [job.enrollmentId])).rows[0].n).toBe(1);
    messages = await conversation(job);
    expect(messages.find(m => m.id === job.messageId)).toMatchObject({ job_id: second.jobId, job_state: 'waiting', job_reason: 'provider_uncertain', job_stalled: true });
    expect(await used(job.enrollmentId)).toBe(2 * ALLOWANCE);
    // Both held calls wait for the owner, explained.
    const list = await uncertainList(await owner());
    expect(list.statusCode, list.body).toBe(200);
    const mine = list.json().calls.filter((c: { enrollmentId: string }) => c.enrollmentId === job.enrollmentId);
    expect(mine).toHaveLength(2);
    for (const call of mine) expect(call).toMatchObject({ role: 'companion', modelId: MODEL, reservedMicroUsd: ALLOWANCE, happened: 'no_response', settleable: true });
  }, 60000);

  it('is not asked again when the learner budget cannot hold a second reservation', async () => {
    const job = await prepare(ALLOWANCE + 1000), claimed = await claim(job.ref);
    stub.modes = ['never'];
    const outcome = await invoke(claimed.request);
    expect((await settle(job.ref, claimed, outcome)).snapshot).toMatchObject({ state: 'waiting', reason: 'provider_uncertain' });
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.retry_requested'", [job.enrollmentId])).rows[0].n).toBe(0);
    expect((await conversation(job)).find(m => m.id === job.messageId)).toMatchObject({ job_state: 'waiting', job_stalled: true });
  }, 60000);
});

describe('a reply that stalls part way', () => {
  it('ends at the idle bound and is settled at the usage reported up to the stall; the rest is released and the learner is told', async () => {
    const job = await prepare(), claimed = await claim(job.ref);
    stub.modes = ['stall'];
    const outcome = await invoke(claimed.request);
    const cost = priced(PROMPT, 7);
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: cost, tokens: PROMPT + 7 }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    expect(await dispatch(claimed.operation.id)).toMatchObject({ state: 'completed', failure_code: 'STREAM_STALLED', cost });
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'output_refusal', role: 'companion', reason: 'provider_stream_stalled' }]);
    await settle(job.ref, claimed, outcome);
    expect(await used(job.enrollmentId)).toBe(cost);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'reconciled', charged: cost, released: ALLOWANCE - cost }]);
    // Nothing of the reply is kept: the verifier refuses the record and the question reads as unavailable.
    const verified = await app.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: `Bearer ${token}` }, payload: { method: 'transition', command: { type: 'verify', ref: job.ref } } });
    expect(verified.json().snapshot).toMatchObject({ state: 'failed', reason: 'verification_rejected' });
    expect((await conversation(job)).find(m => m.id === job.messageId)).toMatchObject({ job_state: 'failed', refusal_reason: 'provider_stream_stalled' });
  }, 60000);
});

describe('Stop while a reply is being written (B-4)', () => {
  it('the learner stop aborts the provider stream at once; the call is settled at the usage reported up to the stop and the rest released', async () => {
    const job = await prepare(), claimed = await claim(job.ref);
    stub.modes = ['stream'];
    const closed = stub.closedAt.length, chunks = stub.chunks;
    const call = invoke(claimed.request);
    await until(() => stub.chunks - chunks >= 4);
    const stoppedAt = Date.now(), atStop = stub.lastOutput;
    const stop = await stopReply(job);
    expect(stop.statusCode, stop.body).toBe(200);
    // The commit wakes the gateway, which aborts its request to the provider: the stub sees the close.
    await until(() => stub.closedAt.length > closed, 3000);
    expect(stub.closedAt.at(-1)! - stoppedAt).toBeLessThan(1500);
    const outcome = await call;
    const row = await dispatch(claimed.operation.id);
    const reported = row.attempts[0].tokens.output as number;
    expect(row.attempts[0].outcome).toBe('partial');
    expect(reported).toBeGreaterThanOrEqual(atStop);
    expect(reported).toBeLessThanOrEqual(stub.lastOutput);
    const cost = priced(PROMPT, reported);
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: cost }, usageBasis: { microUsd: 'reported' } });
    expect(row).toMatchObject({ state: 'completed', failure_code: 'JOB_CANCELLED', cost });
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'output_refusal', role: 'companion', reason: 'provider_stream_stopped' }]);
    const settled = await settle(job.ref, claimed, outcome);
    expect(settled.snapshot).toMatchObject({ state: 'cancelled', reason: 'cancel_requested' });
    expect(await used(job.enrollmentId)).toBe(cost);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'reconciled', charged: cost, released: ALLOWANCE - cost }]);
    // Stopping ended the provider's work: no more chunks were written after the close.
    const after = stub.chunks; await new Promise(resolve => setTimeout(resolve, 150));
    expect(stub.chunks).toBe(after);
  }, 60000);

  it('the worker aborting its gateway request (Temporal cancelled the activity) stops the provider stream; the receipt is then reconciled', async () => {
    const job = await prepare(), claimed = await claim(job.ref);
    stub.modes = ['stream'];
    const closed = stub.closedAt.length, chunks = stub.chunks, activity = new AbortController();
    const client = new HttpProviderGateway(gatewayOnlyBase, token);
    const call = client.invoke(claimed.request, activity.signal);
    await until(() => stub.chunks - chunks >= 3);
    // The host records the cancellation first (no wake-up reaches this gateway), then the activity is cancelled.
    await db.query('UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1', [job.ref.jobId]);
    const abortedAt = Date.now();
    activity.abort();
    expect(await call).toEqual({ status: 'uncertain' });
    await until(() => stub.closedAt.length > closed, 3000);
    expect(stub.closedAt.at(-1)! - abortedAt).toBeLessThan(1500);
    // The activity settles what it saw; the gateway's receipt then settles the real usage.
    await settle(job.ref, claimed, { status: 'uncertain' });
    await until(async () => (await dispatch(claimed.operation.id))?.state === 'completed');
    const row = await dispatch(claimed.operation.id), cost = priced(PROMPT, row.attempts[0].tokens.output);
    expect(row).toMatchObject({ failure_code: 'JOB_CANCELLED', cost });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect((await bridge.reconcile(100)).settled).toBeGreaterThanOrEqual(1);
    expect(await used(job.enrollmentId)).toBe(cost);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'reconciled', charged: cost, released: ALLOWANCE - cost }]);
  }, 60000);

  it('a worker that only went away (no cancellation) does not stop the call: it finishes and its receipt is reconciled', async () => {
    const job = await prepare(), claimed = await claim(job.ref);
    stub.modes = ['finish'];
    const closed = stub.closedAt.length, chunks = stub.chunks, activity = new AbortController();
    const call = new HttpProviderGateway(gatewayOnlyBase, token).invoke(claimed.request, activity.signal);
    await until(() => stub.chunks - chunks >= 1);
    activity.abort();
    expect(await call).toEqual({ status: 'uncertain' });
    await settle(job.ref, claimed, { status: 'uncertain' });
    await until(async () => (await dispatch(claimed.operation.id))?.state === 'completed');
    expect(stub.closedAt.length).toBe(closed);
    const cost = priced(PROMPT, 30);
    expect(await dispatch(claimed.operation.id)).toMatchObject({ failure_code: null, cost });
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text: 'part 1 part 2 part 3 part 4 part 5 done.' }]);
    // Until it is reconciled the owner cannot settle it: its receipt will.
    const list = (await uncertainList(await owner())).json();
    const listed = list.calls.find((c: { enrollmentId: string }) => c.enrollmentId === job.enrollmentId);
    expect(listed).toMatchObject({ settleable: false });
    const early = await settleCall(await owner(), listed.id, { idempotencyKey: `early-${randomUUID()}`, decision: 'zero', expectedReservedMicroUsd: ALLOWANCE, reason: 'Checked the console' });
    expect(early.statusCode).toBe(409); expect(early.json().error).toBe('PROVIDER_SPEND_STILL_SETTLING');
    await bridge.reconcile(100);
    expect(await used(job.enrollmentId)).toBe(cost);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'reconciled', charged: cost }]);
  }, 60000);

  it('a stop before the provider reported any usage stays uncertain and held for the owner (never guessed)', async () => {
    const job = await prepare(), claimed = await claim(job.ref);
    stub.modes = ['stream-no-usage'];
    const chunks = stub.chunks, call = invoke(claimed.request);
    await until(() => stub.chunks - chunks >= 3);
    expect((await stopReply(job)).statusCode).toBe(200);
    expect(await call).toEqual({ status: 'uncertain' });
    expect(await dispatch(claimed.operation.id)).toMatchObject({ state: 'uncertain', failure_code: 'JOB_CANCELLED', cost: null });
    expect((await settle(job.ref, claimed, { status: 'uncertain' })).snapshot.state).toBe('cancelled');
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    const listed = (await uncertainList(await owner())).json().calls.find((c: { enrollmentId: string }) => c.enrollmentId === job.enrollmentId);
    expect(listed).toMatchObject({ happened: 'stopped', settleable: true, reservedMicroUsd: ALLOWANCE });
  }, 60000);
});

describe('the owner settles a call whose cost stayed unknown', () => {
  /** An older Core's no-reply row exactly as the pilot holds it: CANCELLED at the 60 s bound, no
   * status at all, the full reservation charged, and the learner's "Cancel and ask again" after. */
  async function pilotRow() {
    const job = await prepare(ALLOWANCE), claimed = await claim(job.ref);
    stub.modes = ['never'];
    const outcome = await invoke(claimed.request);
    await settle(job.ref, claimed, outcome);
    await db.query("UPDATE provider_dispatches SET failure_code='CANCELLED' WHERE operation_id=$1", [claimed.operation.id]);
    expect((await stopReply(job)).statusCode).toBe(200);
    await bridge.reconcile(100);
    expect((await db.query('SELECT state FROM supervisor_jobs WHERE id=$1', [job.ref.jobId])).rows[0].state).toBe('cancelled');
    const [row] = await ledger(job.enrollmentId);
    expect(row).toMatchObject({ state: 'uncertain', charged: ALLOWANCE, settled: false });
    return { job, claimed, ledgerId: row.id as string };
  }

  it('lists the pilot-shaped row as "no reply", settles it at zero once (audited) and releases the reservation', async () => {
    const { job, ledgerId } = await pilotRow(), headers = await owner();
    const list = (await uncertainList(headers)).json();
    const call = list.calls.find((c: { id: string }) => c.id === ledgerId);
    expect(call).toMatchObject({ happened: 'no_response', settleable: true, reservedMicroUsd: ALLOWANCE });
    expect(list.heldMicroUsd).toBeGreaterThanOrEqual(ALLOWANCE);
    const workspaceBefore = Number((await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [workspaceId])).rows[0].used_micro_usd);
    const body = { idempotencyKey: `settle-${randomUUID()}`, decision: 'zero', expectedReservedMicroUsd: ALLOWANCE, reason: 'AI Studio usage shows no request at 22:51 UTC' };
    const settled = await settleCall(headers, ledgerId, body);
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toMatchObject({ ledgerId, decision: 'zero', chargedMicroUsd: 0, releasedMicroUsd: ALLOWANCE });
    expect(await used(job.enrollmentId)).toBe(0);
    expect(Number((await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [workspaceId])).rows[0].used_micro_usd)).toBe(workspaceBefore - ALLOWANCE);
    expect((await db.query('SELECT micro_usd::int AS spent FROM supervisor_job_spend WHERE job_id=$1', [job.ref.jobId])).rows[0].spent).toBe(0);
    // Still "uncertain" (the provider's outcome is unknown), but closed and no longer held.
    expect(await ledger(job.enrollmentId)).toMatchObject([{ id: ledgerId, state: 'uncertain', charged: 0, released: ALLOWANCE, settled: true }]);
    const resolution = (await db.query('SELECT decision,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,actor_id,reason FROM provider_spend_resolutions WHERE ledger_id=$1', [ledgerId])).rows;
    expect(resolution).toEqual([{ decision: 'zero', reserved: ALLOWANCE, charged: 0, actor_id: ownerId, reason: body.reason }]);
    const audit = await app.inject({ url: `/api/admin/workspaces/${workspaceId}/audit?type=provider.spend_settled&limit=20`, headers });
    expect(audit.statusCode, audit.body).toBe(200);
    expect(audit.json().events.find((e: { payload: { ledgerId?: string } | null }) => e.payload?.ledgerId === ledgerId)).toMatchObject({
      actorKind: 'staff', actor: 'Owner', payload: { decision: 'zero', happened: 'no_response', reservedMicroUsd: ALLOWANCE, chargedMicroUsd: 0, releasedMicroUsd: ALLOWANCE, reason: body.reason } });
    // The same request again answers the same; any other decision on the settled call is refused.
    const repeat = await settleCall(headers, ledgerId, body);
    expect(repeat.statusCode).toBe(200); expect(repeat.json()).toEqual(settled.json());
    const other = await settleCall(headers, ledgerId, { ...body, idempotencyKey: `settle-${randomUUID()}`, decision: 'reservation' });
    expect(other.statusCode).toBe(409); expect(other.json().error).toBe('PROVIDER_SPEND_ALREADY_SETTLED');
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE event_type='provider.spend_settled' AND payload->>'ledgerId'=$1", [ledgerId])).rows[0].n).toBe(1);
    expect((await uncertainList(headers)).json().calls.some((c: { id: string }) => c.id === ledgerId)).toBe(false);
    // The decision names its call as the list did: the job and the time it was sent.
    expect((await uncertainList(headers)).json().recent[0]).toMatchObject({ ledgerId, decision: 'zero', decidedBy: 'Owner', reason: body.reason,
      role: call.role, reservedAt: call.reservedAt });
  }, 60000);

  it('settles a call at the reservation: it stays charged and is no longer held', async () => {
    const { job, ledgerId } = await pilotRow(), headers = await owner();
    const before = (await uncertainList(headers)).json().heldMicroUsd;
    const settled = await settleCall(headers, ledgerId, { idempotencyKey: `keep-${randomUUID()}`, decision: 'reservation', expectedReservedMicroUsd: ALLOWANCE, reason: 'Console shows it was billed' });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toMatchObject({ decision: 'reservation', chargedMicroUsd: ALLOWANCE, releasedMicroUsd: 0 });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'uncertain', charged: ALLOWANCE, released: 0, settled: true }]);
    expect((await uncertainList(headers)).json().heldMicroUsd).toBe(before - ALLOWANCE);
    const spend = (await app.inject({ url: `/api/admin/workspaces/${workspaceId}/provider-spend`, headers })).json();
    expect(Number(spend.totals.held)).toBe(before - ALLOWANCE);
  }, 60000);

  it('refuses other roles, invalid and stale requests, and unknown calls, changing nothing', async () => {
    const { job, ledgerId } = await pilotRow(), headers = await owner(), body = { idempotencyKey: `deny-${randomUUID()}`, decision: 'zero', expectedReservedMicroUsd: ALLOWANCE, reason: 'Checked' };
    for (const actor of [await session(instructorId), job.learner]) {
      expect((await uncertainList(actor)).statusCode).toBe(403);
      expect((await settleCall(actor, ledgerId, body)).statusCode).toBe(403);
    }
    for (const invalid of [{ ...body, decision: 'half' }, { ...body, reason: 'x' }, { ...body, extra: true }, { decision: 'zero' }])
      expect((await settleCall(headers, ledgerId, invalid)).statusCode).toBe(400);
    const stale = await settleCall(headers, ledgerId, { ...body, expectedReservedMicroUsd: ALLOWANCE - 1 });
    expect(stale.statusCode).toBe(409); expect(stale.json().error).toBe('STALE_PROVIDER_SPEND_CALL');
    const unknown = await settleCall(headers, randomUUID(), body);
    expect(unknown.statusCode).toBe(404);
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'uncertain', charged: ALLOWANCE, settled: false }]);
    expect((await db.query('SELECT count(*)::int AS n FROM provider_spend_resolutions WHERE ledger_id=$1', [ledgerId])).rows[0].n).toBe(0);
  }, 60000);
});
