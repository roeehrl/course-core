import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { anthropicAdapterFactory, composeProviders } from '../src/provider-composition.js';
import { anthropicModelDraft } from '../src/anthropic-model-setup.js';
import type { ModelCatalog } from '../src/provider-metadata.js';
import { fixture } from './fixture.js';
import { anthropicStream } from './streamed-provider-fixture.js';

// Real PostgreSQL, HTTP routes, supervisor transitions and the real Anthropic adapter. The only
// substitute is the network: a scripted Anthropic-compatible HTTP server on loopback answers
// POST /v1/messages with documented Messages API shapes. No real key and no live call.
const schema = `course_anthropic_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(),
  token = randomUUID(), origin = 'http://localhost:4310', KEY = 'synthetic-anthropic-integration-canary', ALLOWANCE = 200_000;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, owner: Session, scripted: Server;
interface Session { id: string; cookie: string; csrf: string }
interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: Record<string, any> }
type Reply = { status?: number; headers?: Record<string, string>; json: unknown };
const seen: Seen[] = [], replies: ((request: Seen) => Reply)[] = [];

function message(content: unknown[], usage: Record<string, unknown> = { input_tokens: 1200, output_tokens: 150 }, extra: Record<string, unknown> = {}) {
  return { id: `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content,
    stop_reason: 'end_turn', stop_sequence: null, stop_details: null, usage: { service_tier: 'standard', ...usage }, ...extra };
}
const text = (value: string, usage?: Record<string, unknown>, extra?: Record<string, unknown>) => message([{ type: 'text', text: value }], usage, extra);
const apiError = (status: number, type: string, headers: Record<string, string> = {}): Reply =>
  ({ status, headers, json: { type: 'error', error: { type, message: `scripted ${type} ${KEY}` }, request_id: 'req_scripted' } });

/** Trusted test transport: the adapter still builds https://api.anthropic.com/v1/messages with its
 * own headers; only the socket is redirected to the scripted loopback server. */
function loopbackFetch(): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.anthropic.com') throw new Error('Unexpected origin from the adapter');
    const port = (scripted.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
}
function serve(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const entry: Seen = { method: request.method!, url: request.url!, headers: request.headers, body: raw ? JSON.parse(raw) : {} };
    seen.push(entry);
    const next = replies.shift();
    const reply = next ? next(entry) : apiError(500, 'api_error');
    // A streamed companion call gets the scripted message as its event stream.
    if (entry.body.stream === true && (reply.status ?? 200) === 200) {
      response.writeHead(200, { 'content-type': 'text/event-stream', ...reply.headers });
      response.end(anthropicStream(reply.json as Parameters<typeof anthropicStream>[0]));
      return;
    }
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    response.end(JSON.stringify(reply.json));
  });
}

// What a Models API inspection reports for these ids (shape per GET /v1/models; values synthetic).
const catalog: ModelCatalog = { pages: 1, truncated: false, generationPerformed: false, capabilitiesVerified: false, models: [
  { remoteModel: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', description: '', inputTokenLimit: 1_000_000, outputTokenLimit: 128_000,
    methods: ['messages', 'structured_outputs', 'web_search', 'effort_low', 'thinking_disabled'] },
  { remoteModel: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', description: '', inputTokenLimit: 1_000_000, outputTokenLimit: 128_000,
    methods: ['messages', 'structured_outputs', 'web_search', 'effort_low'] },
] };
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
const pricingPath = `/api/admin/workspaces/${workspaceId}/provider-pricing`;

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  scripted = createHttpServer(serve); await new Promise<void>(resolve => scripted.listen(0, '127.0.0.1', resolve));
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture()), author = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [author, `test:${author}`, 'Author']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `anthropic-${workspaceId}`, 'Anthropic']);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), author]);
  // The configuration the admin guide builds from inspected metadata.
  const configuration = anthropicModelDraft({ configuration: { registry: { revision: 'anthropic-it', models: [] },
    adapters: [{ id: 'claude', kind: 'anthropic', credentialEnv: 'COURSE_PROVIDER_CLAUDE_API_KEY' }], roles: {} },
    adapterId: 'claude', catalog, assignments: { companion: 'claude-haiku-5-5', supervisor: 'claude-haiku-5-5', research: 'claude-sonnet-5-5' } });
  const providers = composeProviders(configuration, name => name === 'COURSE_PROVIDER_CLAUDE_API_KEY' ? KEY : undefined,
    { anthropic: anthropicAdapterFactory(loopbackFetch()) });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: 1_000_000 } } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `test:${id}`, 'Anthropic owner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, id]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  owner = { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 100_000_000 });
}, 60000);
afterAll(async () => {
  await app?.close(); await db?.end(); scripted?.close();
  await testDatabase?.drop();
});
beforeEach(() => { seen.length = 0; replies.length = 0; });

async function prepare(role: 'companion' | 'supervisor') {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Anthropic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Synthetic goal' }), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  if (role === 'companion') await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
    [messageId, enrollmentId, 'How do I find the minimum of a list?', JSON.stringify({ episodeId: 'min' })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner',
    type: role === 'companion' ? 'companion.requested' : 'learning.updated',
    payload: role === 'companion' ? { messageId, episodeId: 'min', requestKind: 'question' } : {}, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 10_000_000, tokens: 10_000_000 });
  const availability = (await capabilities())[role];
  const ownerId = randomUUID(), claimed = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'generate', ownerId, availability });
  const operation = claimed.snapshot.operations[0];
  const request: ProviderRequest | null = operation ? { schemaVersion: 1, operationId: operation.id, job: claimed.snapshot.specification.key, role,
    checkpoint: claimed.snapshot.specification.checkpoints[0]!, fence: claimed.snapshot.specification.fence } : null;
  return { ref: ref!, enrollmentId, claimed, operation, request, ownerId };
}
async function capabilities() {
  const r = await app.inject({ url: `/v1/capabilities?workspaceId=${workspaceId}`, headers: { authorization: `Bearer ${token}` } });
  expect(r.statusCode, r.body).toBe(200); return r.json();
}
async function invoke(job: Awaited<ReturnType<typeof prepare>>) {
  const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': job.request!.operationId }, payload: job.request! });
  expect(r.statusCode, r.body).toBe(200);
  await bridge.transition({ type: 'settle', ref: job.ref, operationId: job.operation!.id, ownerId: job.ownerId, outcome: r.json() });
  return r.json();
}
async function ledger(enrollmentId: string) {
  return (await db.query('SELECT state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,actual_micro_usd::int AS actual,model_id FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [enrollmentId])).rows;
}
async function dispatch(operationId: string) {
  return (await db.query('SELECT failure_code,cost_micro_usd::int AS cost,model_id,provider_usage,outcome FROM provider_dispatches WHERE operation_id=$1', [operationId])).rows[0];
}
async function price(modelId: string, expectedVersion = 0, extra: Record<string, unknown> = {}) {
  const r = await app.inject({ method: 'POST', url: pricingPath, headers: headers(owner), payload: { idempotencyKey: randomUUID(), modelId, expectedVersion,
    status: 'active', currency: 'USD', inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 5_000_000, cachedInputMicroUsdPerMillionTokens: 100_000,
    microUsdPerRequest: null, microUsdPerOutputSecond: null, effectiveFrom: new Date(Date.now() - 60_000).toISOString(), sourceNote: 'Synthetic operator test price', ...extra } });
  expect(r.statusCode, r.body).toBe(200); return r.json();
}
function expectMessagesRequest(request: Seen, streamed = false) {
  expect(request.method).toBe('POST'); expect(request.url).toBe('/v1/messages');
  expect(request.headers['x-api-key']).toBe(KEY); expect(request.headers['anthropic-version']).toBe('2023-06-01');
  expect(request.headers.authorization).toBeUndefined(); expect(request.headers['content-type']).toBe('application/json');
  // No sampling parameters, no prefill: current models reject them.
  for (const field of ['temperature', 'top_p', 'top_k', 'fallbacks']) expect(request.body[field]).toBeUndefined();
  // Companion replies stream (docs/streamed-replies.md); every other role asks for one whole answer.
  expect(request.body.stream).toBe(streamed ? true : undefined);
  expect(request.body.messages.at(-1).role).toBe('user');
}
const noKey = (value: unknown) => expect(JSON.stringify(value)).not.toContain(KEY);

describe('Anthropic Messages API through the real role paths (scripted loopback endpoint)', () => {
  it('refuses paid work for an unpriced Anthropic model: nothing is reserved or sent', async () => {
    expect(await capabilities()).toMatchObject({ companion: { status: 'configuration_missing' }, supervisor: { status: 'configuration_missing' } });
    const job = await prepare('companion');
    expect(job.claimed.snapshot).toMatchObject({ state: 'waiting', reason: 'configuration_missing' });
    expect(job.operation).toBeUndefined();
    expect(seen).toHaveLength(0);
  }, 60000);

  it('companion: one Messages call, reported usage priced from the operator version and reconciled', async () => {
    const version = (await price('claude:companion')).id;
    expect((await capabilities()).companion).toEqual({ status: 'ready' });
    replies.push(() => ({ json: text('Keep the smallest value seen so far and compare each new value with it.',
      { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 }) }));
    const job = await prepare('companion');
    const outcome = await invoke(job);
    expect(seen).toHaveLength(1); expectMessagesRequest(seen[0]!, true);
    const body = seen[0]!.body;
    expect(body).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 1000, output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
    expect(typeof body.system).toBe('string'); expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain('How do I find the minimum of a list?');
    expect(body.tools).toBeUndefined(); expect(body.output_config.format).toBeUndefined();
    // 1200 input at 1.0 + 300 cached at 0.1 + 150 output at 5.0 = 1200 + 30 + 750.
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: 1980, tokens: 1650 }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', reserved: ALLOWANCE, charged: 1980, actual: 1980, model_id: 'claude:companion' }]);
    const row = await dispatch(job.operation!.id);
    expect(row).toMatchObject({ cost: 1980, model_id: 'claude:companion' });
    expect(row.provider_usage.cost).toMatchObject({ microUsd: 1980, pricingVersionId: version,
      billable: { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 150, requests: 1, outputSeconds: 0 } });
    expect(row.provider_usage.attempts[0].tokens).toMatchObject({ input: 1500, cachedInput: 300, cacheWriteInput: 0, output: 150, total: 1650 });
    noKey(row);
    // The host verifies and applies the candidate; only then does the learner see the reply.
    for (const [type, state] of [['verify', 'ready'], ['apply', 'applied']] as const) {
      const r = await app.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: `Bearer ${token}` }, payload: { method: 'transition', command: { type, ref: job.ref } } });
      expect(r.statusCode, r.body).toBe(200); expect(r.json().snapshot.state).toBe(state);
    }
    const reply = await db.query("SELECT content FROM companion_messages WHERE enrollment_id=$1 AND role='assistant'", [job.enrollmentId]);
    expect(reply.rows.map(r => r.content)).toEqual(['Keep the smallest value seen so far and compare each new value with it.']);
  }, 60000);

  it('supervisor: the bounded tool loop sends json_schema structured output each round and prices every round', async () => {
    await price('claude:supervisor');
    const decisions = [{ decision: 'tool', tool: 'list_support', argumentsJson: '{}', summary: '' },
      { decision: 'finish', tool: 'none', argumentsJson: '{}', summary: 'No reviewed support applies; keep practising comparisons.' }];
    for (const decision of decisions) replies.push(() => ({ json: text(JSON.stringify(decision), { input_tokens: 2000, output_tokens: 100 }) }));
    const job = await prepare('supervisor');
    expect(job.request).not.toBeNull();
    const outcome = await invoke(job);
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expectMessagesRequest(request);
      const format = request.body.output_config.format;
      expect(request.body.output_config.effort).toBe('low');
      expect(format.type).toBe('json_schema');
      expect(format.schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect([...format.schema.required].sort()).toEqual(['argumentsJson', 'decision', 'summary', 'tool']);
      expect(JSON.stringify(format.schema)).not.toMatch(/maxLength|minimum|maximum|\$schema/);
      expect(request.body.tool_choice).toBeUndefined();
    }
    // The second round sees the first round's tool result.
    expect(seen[1]!.body.messages[0].content).toContain('list_support');
    // Two rounds: 2 * (2000 * 1.0 + 100 * 5.0) = 5000 micro-USD.
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: 5000, tokens: 4200 }, usageBasis: { microUsd: 'reported' } });
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', reserved: ALLOWANCE, charged: 5000, actual: 5000, model_id: 'claude:supervisor' }]);
  }, 60000);

  it('supervisor: a structured answer cut off by max_tokens is never applied and keeps the reservation', async () => {
    replies.push(() => ({ json: text('{"decision":"finish","tool":"none","argumentsJson":"{}","summ', { input_tokens: 2000, output_tokens: 1000 },
      { stop_reason: 'max_tokens' }) }));
    const job = await prepare('supervisor');
    expect(await invoke(job)).toEqual({ status: 'uncertain' });
    expect(seen).toHaveLength(1);
    expect((await dispatch(job.operation!.id)).failure_code).toBe('INCOMPLETE_OUTPUT');
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'uncertain', charged: ALLOWANCE, actual: null }]);
  }, 60000);

  it('529 overloaded, 500 and 504 are outages with an uncertain outcome: one request, never replayed, reservation held', async () => {
    for (const reply of [apiError(529, 'overloaded_error'), apiError(500, 'api_error'), apiError(504, 'timeout_error')]) {
      seen.length = 0; replies.length = 0; replies.push(() => reply, () => ({ json: text('must not be requested') }));
      const job = await prepare('companion');
      expect(await invoke(job)).toEqual({ status: 'uncertain' });
      expect(seen).toHaveLength(1);
      const row = await dispatch(job.operation!.id);
      expect(row.failure_code).toBe('UPSTREAM_UNAVAILABLE'); noKey(row);
      expect(JSON.stringify(row)).not.toContain('scripted');
      expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'uncertain', charged: ALLOWANCE }]);
    }
    replies.length = 0;
  }, 60000);

  it('documented refusals are certified non-starts in one request: released, no cost, the worker sees the provider code, no body text', async () => {
    const spendCap: Reply = { status: 429, headers: {}, json: { type: 'error', error: { type: 'rate_limit_error', message: `scripted spend cap ${KEY}`,
      details: { error_code: 'enforced_spend_limit_reached' } }, request_id: 'req_scripted' } };
    for (const [reply, code] of [[apiError(401, 'authentication_error'), 'AUTHENTICATION'], [apiError(403, 'permission_error'), 'PERMISSION_DENIED'],
      [apiError(400, 'invalid_request_error'), 'UPSTREAM_REJECTED'], [apiError(404, 'not_found_error'), 'NOT_FOUND'],
      [apiError(413, 'request_too_large'), 'UPSTREAM_REJECTED'], [apiError(402, 'billing_error'), 'UPSTREAM_REJECTED'],
      // A tier spend-cap 429 keeps failing until access resumes: permanent, not a throttle.
      [spendCap, 'UPSTREAM_REJECTED']] as const) {
      seen.length = 0; replies.length = 0; replies.push(() => reply, () => ({ json: text('must not be requested') }));
      const job = await prepare('companion');
      const outcome = await invoke(job);
      expect(outcome, code).toEqual({ status: 'not_started', retryable: false });
      expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'not_started', reserved: ALLOWANCE, charged: 0, actual: null }]);
      expect(seen).toHaveLength(1);
      const row = await dispatch(job.operation!.id);
      expect(row.failure_code).toBe(code); expect(row.cost).toBeNull(); noKey(row); expect(JSON.stringify(row)).not.toContain('scripted');
      expect(row.provider_usage.attempts).toEqual([{ attempt: 1, status: reply.status, outcome: 'rejected',
        tokens: { input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null } }]);
      // The job fails; a new claim never reaches the provider.
      const again = await bridge.transition({ type: 'claim', ref: job.ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
      expect(again.effect).toBe('stop'); expect(again.snapshot.reason).toBe('provider_rejected');
      expect(seen).toHaveLength(1);
    }
  }, 60000);

  it('a 429 rate limit with retry-after is a released, retryable non-start; the next attempt reuses the operation and is charged once', async () => {
    replies.push(() => apiError(429, 'rate_limit_error', { 'retry-after': '30' }), () => ({ json: text('Track the smallest value seen so far.') }));
    const job = await prepare('companion');
    const outcome = await invoke(job);
    expect(outcome).toEqual({ status: 'not_started', retryable: true, retryAfterMs: 30_000 });
    expect(seen).toHaveLength(1);
    expect(await ledger(job.enrollmentId)).toMatchObject([{ state: 'not_started', charged: 0 }]);
    const row = await dispatch(job.operation!.id);
    expect(row.failure_code).toBe('THROTTLED'); expect(row.cost).toBeNull(); noKey(row);
    const ownerId = randomUUID(), retried = await bridge.transition({ type: 'claim', ref: job.ref, checkpointId: 'generate', ownerId, availability: { status: 'ready' } });
    expect(retried.effect).toBe('invoke');
    const operation = retried.snapshot.operations[0]!;
    expect(operation).toMatchObject({ id: job.operation!.id, attempt: 2 });
    const done = await invoke({ ...job, ownerId, operation });
    expect(done).toMatchObject({ status: 'succeeded' });
    expect(seen).toHaveLength(2);
    const rows = await ledger(job.enrollmentId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: 'not_started', charged: 0 });
    expect(rows[1].charged).toBe(done.usage.microUsd);
  }, 60000);

  it('a refusal stop is blocked, never shown to the learner, and its reported usage is kept on the dispatch', async () => {
    replies.push(() => ({ json: text('I cannot help with that.', { input_tokens: 900, output_tokens: 4 },
      { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'Declined.' } }) }));
    const job = await prepare('companion');
    expect(await invoke(job)).toEqual({ status: 'uncertain' });
    const row = await dispatch(job.operation!.id);
    expect(row.failure_code).toBe('BLOCKED');
    expect(row.provider_usage.attempts[0]).toMatchObject({ status: 200, outcome: 'response', tokens: { input: 900, output: 4 } });
    expect(JSON.stringify(row)).not.toContain('Declined');
    const reply = await db.query("SELECT 1 FROM companion_messages WHERE enrollment_id=$1 AND role='assistant'", [job.enrollmentId]);
    expect(reply.rowCount).toBe(0);
  }, 60000);

  it('operators can price web searches per request; the pricing view flags research without that price', async () => {
    const before = (await app.inject({ url: pricingPath, headers: headers(owner) })).json();
    const research = before.models.find((m: { modelId: string }) => m.modelId === 'claude:research');
    expect(research).toMatchObject({ roles: ['research'], coverage: [{ role: 'research', priced: false, serverToolsUnpriced: true }] });
    const bad = await app.inject({ method: 'POST', url: pricingPath, headers: headers(owner), payload: { idempotencyKey: randomUUID(), modelId: 'claude:research',
      expectedVersion: 0, status: 'active', currency: 'USD', inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, cachedInputMicroUsdPerMillionTokens: null,
      microUsdPerRequest: null, microUsdPerOutputSecond: null, microUsdPerServerToolRequest: 10_000, effectiveFrom: new Date().toISOString(), sourceNote: 'Search price alone' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: pricingPath, headers: headers(owner), payload: { idempotencyKey: randomUUID(), modelId: 'claude:research',
      expectedVersion: 0, status: 'active', currency: 'USD', inputMicroUsdPerMillionTokens: 1, outputMicroUsdPerMillionTokens: 1, cachedInputMicroUsdPerMillionTokens: null,
      microUsdPerRequest: null, microUsdPerOutputSecond: null, microUsdPerServerToolRequest: 100_000_001, effectiveFrom: new Date().toISOString(), sourceNote: 'Too large' } })).statusCode).toBe(400);
    await price('claude:research', 0, { microUsdPerServerToolRequest: 10_000 });
    const after = (await app.inject({ url: pricingPath, headers: headers(owner) })).json().models.find((m: { modelId: string }) => m.modelId === 'claude:research');
    expect(after.coverage).toEqual([{ role: 'research', priced: true, serverToolsUnpriced: false }]);
    expect(after.inForce).toMatchObject({ microUsdPerServerToolRequest: 10_000 });
    expect((await capabilities()).research).toEqual({ status: 'ready' });
  }, 60000);
});
