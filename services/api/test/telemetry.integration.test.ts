import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ProviderAdapter, UsageReceipt } from '@course-core/providers';
import { createActivities, dispatchOnce, HttpHostBridge, HttpProviderGateway, type RunRef } from '@course-core/supervisor';
import { ATTRIBUTE_RULES } from '@course-core/supervisor/telemetry';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { startTelemetry, telemetry } from '../src/telemetry.js';
import { supervisorSupportFixture } from './supervisor-support-fixture.js';
import { otlpReceiver, type ExportedSpan } from './otlp-receiver.js';

// Real PostgreSQL, real HTTP between the supervisor activities and the API, real OTLP/HTTP export
// to an in-process receiver. Only the external model is a scripted, deterministic adapter.
const schema = `telemetry_${randomUUID().replaceAll('-', '')}`, workspace = randomUUID(), token = randomUUID(), origin = 'http://localhost:4310';
const CANARY = 'Canary learner text: Dana Example wrote 4 < 9 because quartz';
const NAME = 'Canary Display Name Dana';
const fixture = supervisorSupportFixture(), prompts: string[] = [];
const jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
const usage: UsageReceipt = { accounting: { accountingKey: 'synthetic' }, providerId: 'test', modelId: 'planner', operation: 'assess',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
const script = [
  { decision: 'tool', tool: 'list_support', argumentsJson: '{}', summary: '' },
  { decision: 'tool', tool: 'choose_support', argumentsJson: JSON.stringify({ profileId: 'ordering-support-profile', entryId: 'number-line-support' }), summary: '' },
  { decision: 'finish', tool: 'none', argumentsJson: '{}', summary: 'Use the reviewed number-line explanation.' },
];
const adapter: ProviderAdapter = { providerId: 'test', validateModel() {}, ports: { structured_assessment: { async assess(request) {
  prompts.push(request.messages[0]!.text);
  const round = Number(request.accounting.accountingKey.split(':round-')[1]);
  return { usage: { ...usage, accounting: request.accounting }, output: script[round]! };
} } } };
let db: Database, app: Awaited<ReturnType<typeof createServer>>, base: string;
let receiver: Awaited<ReturnType<typeof otlpReceiver>>;
const headers = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
const secrets: string[] = [CANARY, NAME, token, 'synthetic-credential', 'You supervise an adaptive course'];

async function login(role: string, displayName = 'Telemetry person') {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `test:${id}`, displayName]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  const session = { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken as string };
  secrets.push(id, session.csrf, ...r.cookies.map(c => c.value));
  return session;
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  receiver = await otlpReceiver();
  // Telemetry is enabled exactly as a deployment would: standard OTLP variables only.
  const runtime = await startTelemetry({ serviceName: 'course-core-api', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url } });
  expect(runtime.enabled).toBe(true);
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders({ registry: { revision: 'telemetry-test', models: [{ id: 'planner', providerId: 'test', remoteModel: 'planner', providerConfig: {}, enabled: true,
    capabilities: ['structured_assessment'], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
  adapters: [{ id: 'test', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
  roles: { supervisor: { modelId: 'planner', maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 } } }, () => 'synthetic-credential', { test: () => adapter });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: fixture.runtime, providers,
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'telemetry', 'Telemetry qualification']);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 30000);
afterAll(async () => {
  await telemetry().shutdown(); await receiver?.close();
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

it('exports allowlisted spans for a learner request and a scripted supervisor run, with no learner text', async () => {
  // Author publishes a course; a learner enrolls, opts in and saves profile text through the HTTP API.
  const owner = await login('owner');
  // An operator price for the planner (synthetic numbers): each scripted round reports 10 input
  // and 20 output tokens, so three rounds cost ceil(30*0.3 + 60*2.5) = 159 micro-USD.
  await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
    effective_from,source_note,created_by) VALUES($1,$2,'planner',1,'active','USD',300000,2500000,clock_timestamp()-interval '1 minute','Synthetic telemetry price',$3)`,
    [randomUUID(), workspace, owner.id]);
  const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace}/releases`, headers: headers(owner), payload: fixture.course });
  expect(imported.statusCode, imported.body).toBe(200);
  const releaseId = imported.json().id;
  expect((await app.inject({ method: 'POST', url: `/api/releases/${releaseId}/publish`, headers: headers(owner) })).statusCode).toBe(200);
  const approved = await app.inject({ method: 'POST', url: `/api/admin/releases/${releaseId}/adaptation-registry`, headers: headers(owner),
    payload: { expectedRegistryRevision: 0, configuration: fixture.config } });
  expect(approved.statusCode, approved.body).toBe(200);
  const learner = await login('learner', NAME);
  // Use real HTTP for the learner path so the server spans come from the network stack, not inject().
  const call = async (method: string, path: string, payload?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...headers(learner), ...(payload ? { 'content-type': 'application/json' } : {}),
      // A browser-supplied trace header must not be continued.
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200); return body;
  };
  const enrollment = await call('POST', '/api/enrollments', { releaseId });
  const enrollmentId = enrollment.id as string; secrets.push(enrollmentId);
  const revision = async () => (await call('GET', `/api/enrollments/${enrollmentId}`)).revision;
  await call('POST', `/api/enrollments/${enrollmentId}/supervision`, { expectedRevision: await revision(), idempotencyKey: randomUUID(), adaptiveTeaching: true });
  await call('POST', `/api/enrollments/${enrollmentId}/learner-model/profile`, { expectedRevision: await revision(), idempotencyKey: randomUUID(),
    profile: { preferences: { explanationStyle: 'worked_example', goal: CANARY }, priorKnowledge: [], thoughts: CANARY } });
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [randomUUID(), enrollmentId, CANARY, JSON.stringify({ episodeId: 'min' })]);
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId }, { microUsd: 1000000, tokens: 2000000 });
  await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId, actorId: learner.id, actorKind: 'learner',
    type: 'learning.review_requested', payload: { episodeId: 'min' }, idempotencyKey: randomUUID(), supervise: true }));

  // The real dispatcher and worker activities, over HTTP, with the workflow's order of steps.
  const hostBridge = new HttpHostBridge(base, token), gateway = new HttpProviderGateway(base, token);
  const refs: RunRef[] = [];
  const dispatched = await dispatchOnce(hostBridge, { start: async ref => { refs.push(ref); } });
  expect(dispatched.delivered).toBeGreaterThanOrEqual(1); expect(refs.length).toBeGreaterThanOrEqual(1);
  const activities = createActivities(hostBridge, gateway, () => ({ signal: new AbortController().signal, heartbeat() {} }));
  const runs: { role: string; state: string }[] = [];
  for (const ref of refs) {
    secrets.push(ref.jobId);
    const spec = await activities.loadJob(ref);
    let stopped = false;
    for (const checkpoint of spec.checkpoints) {
      const step = await activities.executeCheckpoint(ref, checkpoint.id);
      if (step.effect === 'stop') { runs.push({ role: spec.role, state: step.snapshot.state }); stopped = true; break; }
      expect(step.effect).toBe('continue');
    }
    if (stopped) continue;
    expect((await activities.verifyJob(ref)).effect).toBe('continue');
    runs.push({ role: spec.role, state: (await activities.applyJob(ref)).snapshot.state });
  }
  expect(runs.filter(run => run.role === 'supervisor' && run.state === 'applied')).toHaveLength(1);
  expect(prompts).toHaveLength(3);
  // The learner's text did reach the model through the traced path, so its absence below is meaningful.
  expect(prompts.some(prompt => prompt.includes(CANARY))).toBe(true);

  await telemetry().shutdown();
  const spans = receiver.spans(), byId = new Map(spans.map(span => [span.spanId, span]));
  const named = (name: string) => spans.filter(span => span.name === name);
  const parent = (span: ExportedSpan) => span.parentSpanId ? byId.get(span.parentSpanId) : undefined;

  // Every exported attribute key is allowlisted; no free-form status messages.
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) expect(Object.hasOwn(ATTRIBUTE_RULES, key), `${span.name}: ${key}`).toBe(true);
    expect(span.status?.message ?? '').toBe('');
    expect(span.resource).toEqual({ 'service.name': 'course-core-api', 'service.namespace': 'course-core' });
  }
  // Learner request: a server span named by route template, with DB transactions as children.
  const profile = named('POST /api/enrollments/:enrollmentId/learner-model/profile');
  expect(profile).toHaveLength(1);
  expect(profile[0]!.attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/api/enrollments/:enrollmentId/learner-model/profile', 'http.response.status_code': 200 });
  expect(profile[0]!.kind).toBe(2);
  expect(profile[0]!.traceId).not.toBe('0af7651916cd43dd8448eb211c80319c');
  expect(profile[0]!.parentSpanId ?? '').toBe('');
  const profileTransactions = named('db.transaction').filter(span => span.parentSpanId === profile[0]!.spanId);
  expect(profileTransactions.length).toBeGreaterThanOrEqual(1);
  expect(profileTransactions[0]!.attributes).toEqual({ 'db.system.name': 'postgresql', 'db.operation.name': 'transaction', 'course.db.outcome': 'commit' });
  expect(named('POST /api/enrollments')).toHaveLength(1);
  // Supervisor run: worker activity spans continue into API service spans over HTTP.
  const supervised = named('supervisor.activity').filter(span => span.attributes['course.supervisor.role'] === 'supervisor');
  expect(new Set(supervised.map(span => span.attributes['course.supervisor.activity']))).toEqual(new Set(['apply_job', 'execute_checkpoint', 'load_job', 'verify_job']));
  expect(supervised.filter(span => span.attributes['course.supervisor.activity'] === 'apply_job')[0]!.attributes['course.supervisor.state']).toBe('applied');
  const execute = supervised.find(span => span.attributes['course.supervisor.activity'] === 'execute_checkpoint' && span.attributes['course.supervisor.outcome'] === 'succeeded')!;
  expect(execute.attributes).toMatchObject({ 'course.supervisor.role': 'supervisor', 'course.supervisor.outcome': 'succeeded', 'course.supervisor.effect': 'continue' });
  const operationsRoute = named('POST /v1/operations');
  expect(operationsRoute).toHaveLength(1);
  expect(parent(operationsRoute[0]!)).toBe(execute);
  expect(named('POST /v1/supervisor/bridge').filter(span => span.traceId === execute.traceId).length).toBeGreaterThanOrEqual(2);
  const operation = named('provider.operation');
  expect(operation).toHaveLength(1);
  expect(parent(operation[0]!)).toBe(operationsRoute[0]);
  expect(operation[0]!.attributes).toMatchObject({ 'course.supervisor.role': 'supervisor', 'course.supervisor.outcome': 'succeeded',
    'course.cost.estimate_micro_usd': 159, 'course.cost.basis': 'reported', 'course.cost.pricing': 'priced', 'course.usage.total_tokens': 90, 'course.usage.tokens_basis': 'reported' });
  const calls = named('provider.call');
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(parent(call)).toBe(operation[0]);
    expect(call.attributes).toEqual({ 'gen_ai.operation.name': 'generate_content', 'gen_ai.request.model': 'planner', 'course.provider.operation': 'assess',
      'gen_ai.provider.name': 'test', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 20, 'course.usage.total_tokens': 30,
      'course.provider.outcome': 'response', 'course.provider.attempts': 1 });
  }
  const tools = named('supervisor.tool');
  expect(tools.map(span => span.attributes['gen_ai.tool.name'])).toEqual(['list_support', 'choose_support']);
  for (const tool of tools) expect(parent(tool)).toBe(operation[0]);
  // The dispatcher's idle-safe claim is unsampled; delivery work is traced.
  expect(named('supervisor.dispatch')).toHaveLength(1);

  const metrics = receiver.metrics();
  const points = (name: string) => metrics.filter(metric => metric.name === name).flatMap(metric => metric.points);
  expect(points('http.server.request.duration').some(p => p['http.route'] === '/api/enrollments/:enrollmentId/learner-model/profile' && p['http.response.status_code'] === 200)).toBe(true);
  expect(points('course.provider.cost.estimate')).toContainEqual({ 'course.supervisor.role': 'supervisor', 'course.cost.basis': 'reported' });
  // Reserved at admission, actual from reported usage times the operator price, and the unused remainder released.
  expect(points('course.provider.cost.reserved')).toContainEqual({ 'course.supervisor.role': 'supervisor' });
  expect(points('course.provider.cost.actual')).toContainEqual({ 'course.supervisor.role': 'supervisor', 'gen_ai.request.model': 'planner' });
  expect(points('course.provider.cost.released')).toContainEqual({ 'course.supervisor.role': 'supervisor' });
  expect(points('course.provider.operations')).toContainEqual({ 'course.supervisor.role': 'supervisor', 'course.supervisor.outcome': 'succeeded', 'course.cost.pricing': 'priced' });
  expect(points('course.supervisor.run.outcomes').some(p => p['course.supervisor.role'] === 'supervisor' && p['course.supervisor.state'] === 'applied')).toBe(true);
  expect(points('gen_ai.client.token.usage').map(p => p['gen_ai.token.type']).sort()).toEqual(['input', 'output']);

  // Nothing learner-identifying or secret appears anywhere in any exported payload.
  const raw = receiver.received.map(entry => entry.raw).join('\n');
  expect(raw.length).toBeGreaterThan(1000);
  for (const secret of [...secrets, 'Dana', 'quartz', 'dana@', 'Bearer']) expect(raw.includes(secret), secret).toBe(false);
}, 60000);
