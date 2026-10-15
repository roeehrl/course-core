import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { ProviderError, type ProviderAdapter, type TokenUsage, type UsageReceipt } from '@course-core/providers';
import type { ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { pricingInForce } from '../src/provider-costs.js';
import { fixture } from './fixture.js';

// Real PostgreSQL, HTTP routes and supervisor transitions; only the model is a scripted adapter.
const schema = `course_costs_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), otherWorkspace = randomUUID(),
  releaseId = randomUUID(), token = randomUUID(), origin = 'http://localhost:4310';
const ALLOWANCE = 100_000;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge;
let owner: Session, learnerSession: Session, foreign: Session;
interface Session { id: string; cookie: string; csrf: string }
type Behavior = { kind: 'ok'; tokens: TokenUsage } | { kind: 'uncertain' };
let behavior: Behavior = { kind: 'ok', tokens: { input: 1000, output: 200, total: 1300, cachedInput: 400, thoughts: 100, toolInput: 0 } };
let calls = 0;
const receipt = (tokens: TokenUsage, outcome: 'response' | 'unknown' = 'response'): UsageReceipt => ({ accounting: { accountingKey: 'scripted' }, providerId: 'test-provider',
  modelId: 'model', operation: 'tutor', attempts: [{ attempt: 1, status: outcome === 'response' ? 200 : 500, outcome, tokens }], inputCharacters: 1000,
  requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null });
const adapter: ProviderAdapter = { providerId: 'test-provider', validateModel: () => {}, ports: { tutoring: { async tutor() {
  calls += 1;
  if (behavior.kind === 'uncertain') {
    const error = new ProviderError('NETWORK_ERROR', { submission: 'unknown' });
    error.usage = receipt({ input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null }, 'unknown'); throw error;
  }
  return { output: { text: 'Compare each value with the smallest one seen so far.' }, usage: receipt(behavior.tokens) };
} } } };
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
const pricingPath = (ws = workspaceId) => `/api/admin/workspaces/${ws}/provider-pricing`;

async function login(role: string, scope = workspaceId): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `test:${id}`, 'Cost test user']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [scope, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture()), author = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [author, `test:${author}`, 'Author']);
  for (const id of [workspaceId, otherWorkspace]) await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [id, `costs-${id}`, 'Costs']);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), author]);
  const providers = composeProviders({ registry: { revision: 'test-registry', models: [
    { id: 'model', providerId: 'test-provider', remoteModel: 'test/native/model', providerConfig: {}, enabled: true, capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } },
    { id: 'spare-model', providerId: 'test-provider', remoteModel: 'test/native/spare', providerConfig: {}, enabled: true, capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'test-provider', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }], roles: { companion: { modelId: 'model', maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
    () => 'synthetic-key-only-in-test', { test: () => adapter });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: 100_000 } } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  owner = await login('owner'); learnerSession = await login('learner'); foreign = await login('owner', otherWorkspace);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10_000_000, tokens: 10_000_000 });
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function prepare() {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Cost learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Synthetic' }), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, 'How do I find the minimum?', JSON.stringify({ episodeId: 'min' })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested', payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 1_000_000, tokens: 1_000_000 });
  return { ref: ref!, enrollmentId };
}
async function availability() {
  const r = await app.inject({ url: `/v1/capabilities?workspaceId=${workspaceId}`, headers: { authorization: `Bearer ${token}` } });
  expect(r.statusCode, r.body).toBe(200); return r.json().companion;
}
async function claim(job: Awaited<ReturnType<typeof prepare>>) {
  const ownerId = randomUUID(), result = await bridge.transition({ type: 'claim', ref: job.ref, checkpointId: 'generate', ownerId, availability: await availability() });
  const operation = result.snapshot.operations[0];
  const request: ProviderRequest | null = operation ? { schemaVersion: 1, operationId: operation.id, job: result.snapshot.specification.key, role: 'companion',
    checkpoint: result.snapshot.specification.checkpoints[0]!, fence: result.snapshot.specification.fence } : null;
  return { result, operation, request, ownerId };
}
function invoke(body: ProviderRequest) {
  return app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
}
async function used(enrollmentId: string) {
  const w = (await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [workspaceId])).rows[0].used_micro_usd;
  const e = (await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [enrollmentId])).rows[0].used_micro_usd;
  return { workspace: Number(w), enrollment: Number(e) };
}
async function ledger(enrollmentId: string) {
  return (await db.query('SELECT state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,actual_micro_usd::int AS actual,released_micro_usd::int AS released,pricing_version_id,model_id FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [enrollmentId])).rows;
}
const price = (extra: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), modelId: 'model', expectedVersion: 0, status: 'active', currency: 'USD',
  inputMicroUsdPerMillionTokens: 300_000, outputMicroUsdPerMillionTokens: 2_500_000, cachedInputMicroUsdPerMillionTokens: 75_000,
  microUsdPerRequest: null, microUsdPerOutputSecond: null, effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
  sourceNote: 'Synthetic operator test price', ...extra });
async function setRequirement(requirePricing: boolean) {
  const view = (await app.inject({ url: pricingPath(), headers: headers(owner) })).json();
  const r = await app.inject({ method: 'POST', url: `${pricingPath()}/settings`, headers: headers(owner),
    payload: { idempotencyKey: randomUUID(), expectedRevision: view.settingsRevision, requirePricing, ...(requirePricing ? {} : { acknowledgeConservativeCharge: true }) } });
  expect(r.statusCode, r.body).toBe(200);
}

describe('operator pricing, priced receipts and reconciliation', () => {
  it('refuses paid work for an unpriced model by default: nothing is reserved or sent', async () => {
    const view = await app.inject({ url: pricingPath(), headers: headers(owner) });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ requirePricing: true, builtInPrices: false, currency: 'USD' });
    expect(view.json().models.find((m: { modelId: string }) => m.modelId === 'model')).toMatchObject({ roles: ['companion'], inForce: null, coverage: [{ role: 'companion', priced: false }] });
    const job = await prepare(), before = calls;
    expect(await availability()).toEqual({ status: 'configuration_missing' });
    const claimed = await claim(job);
    expect(claimed.result.snapshot).toMatchObject({ state: 'waiting', reason: 'configuration_missing' });
    expect(claimed.operation).toBeUndefined();
    expect(await used(job.enrollmentId)).toEqual({ workspace: 0, enrollment: 0 });
    // A worker that skipped the availability check is refused again at the gateway.
    const job2 = await prepare();
    const forced = await bridge.transition({ type: 'claim', ref: job2.ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
    const op = forced.snapshot.operations[0]!;
    expect((await used(job2.enrollmentId)).enrollment).toBe(ALLOWANCE);
    const request: ProviderRequest = { schemaVersion: 1, operationId: op.id, job: forced.snapshot.specification.key, role: 'companion', checkpoint: forced.snapshot.specification.checkpoints[0]!, fence: forced.snapshot.specification.fence };
    const refused = await invoke(request);
    expect(refused.json()).toEqual({ status: 'not_started', retryable: false });
    expect(calls).toBe(before);
    expect((await db.query('SELECT failure_code,cost_micro_usd FROM provider_dispatches WHERE operation_id=$1', [op.id])).rows[0]).toEqual({ failure_code: 'PROVIDER_PRICING_REQUIRED', cost_micro_usd: null });
    await bridge.transition({ type: 'settle', ref: job2.ref, operationId: op.id, ownerId: op.ownerId, outcome: refused.json() });
    expect(await used(job2.enrollmentId)).toEqual({ workspace: 0, enrollment: 0 });
    expect(await ledger(job2.enrollmentId)).toEqual([{ state: 'not_started', reserved: ALLOWANCE, charged: 0, actual: null, released: ALLOWANCE, pricing_version_id: null, model_id: null }]);
  }, 60000);

  it('validates and versions operator prices, with idempotent and compare-and-swap writes', async () => {
    for (const s of [learnerSession, foreign]) expect((await app.inject({ url: pricingPath(), headers: headers(s) })).statusCode).toBe(403);
    const post = (payload: Record<string, unknown>, ws = workspaceId, s = owner) => app.inject({ method: 'POST', url: pricingPath(ws), headers: headers(s), payload });
    for (const bad of [price({ outputMicroUsdPerMillionTokens: null }), price({ inputMicroUsdPerMillionTokens: 0.5 }), price({ inputMicroUsdPerMillionTokens: -1 }),
      price({ currency: 'EUR' }), price({ sourceNote: 'x' }), price({ cachedInputMicroUsdPerMillionTokens: 1, inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, microUsdPerRequest: 5 }),
      price({ inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, cachedInputMicroUsdPerMillionTokens: null }),
      price({ effectiveFrom: new Date(Date.now() + 400 * 86_400_000).toISOString() }), price({ effectiveFrom: 'yesterday' }),
      price({ status: 'withdrawn' }), price({ microUsdPerRequest: 100_000_001 })]) {
      const r = await post(bad); expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(price({ modelId: 'not-configured' }))).statusCode).toBe(404);
    expect((await post(price(), workspaceId, learnerSession)).statusCode).toBe(403);
    expect((await post(price(), workspaceId, foreign)).statusCode).toBe(403);
    const first = price(), created = await post(first);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ version: 1, status: 'active', inForceNow: true, appliesToCallsAlreadyAdmitted: false });
    expect((await post(first)).json()).toEqual(created.json());
    expect((await post({ ...first, sourceNote: 'A different request' })).statusCode).toBe(409);
    expect((await post(price())).statusCode).toBe(409); // expected version 0 is stale now
    // A scheduled change does not replace the version in force until its time.
    const scheduled = await post(price({ expectedVersion: 1, inputMicroUsdPerMillionTokens: 600_000, effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() }));
    expect(scheduled.json()).toMatchObject({ version: 2, inForceNow: false });
    expect((await post(price({ expectedVersion: 2, effectiveFrom: new Date(Date.now() - 3_600_000).toISOString() }))).statusCode).toBe(400);
    const inForce = await pricingInForce(db, workspaceId, 'model');
    expect(inForce).toMatchObject({ versionId: created.json().id, inputMicroUsdPerMillionTokens: 300_000, cachedInputMicroUsdPerMillionTokens: 75_000 });
    const model = (await app.inject({ url: pricingPath(), headers: headers(owner) })).json().models.find((m: { modelId: string }) => m.modelId === 'model');
    expect(model).toMatchObject({ latestVersion: 2, inForce: { version: 1 }, coverage: [{ role: 'companion', priced: true }] });
    expect(model.history.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // Withdrawal makes a model unpriced again from its effective time.
    const spare = await post(price({ modelId: 'spare-model', microUsdPerRequest: 10 }));
    expect(spare.statusCode, spare.body).toBe(200);
    expect(await pricingInForce(db, workspaceId, 'spare-model')).not.toBeNull();
    const withdrawn = await post({ ...price({ modelId: 'spare-model', expectedVersion: 1, status: 'withdrawn', effectiveFrom: new Date().toISOString() }),
      inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, cachedInputMicroUsdPerMillionTokens: null });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(await pricingInForce(db, workspaceId, 'spare-model')).toBeNull();
    // Versions are append-only rows.
    expect((await db.query('SELECT count(*)::int AS n FROM provider_model_prices WHERE workspace_id=$1', [workspaceId])).rows[0].n).toBe(4);
  }, 60000);

  it('prices a call from reported usage, reconciles, and releases the remainder exactly once', async () => {
    behavior = { kind: 'ok', tokens: { input: 1000, output: 200, total: 1300, cachedInput: 400, thoughts: 100, toolInput: 0 } };
    expect(await availability()).toEqual({ status: 'ready' });
    const job = await prepare(), claimed = await claim(job), before = calls;
    expect(claimed.result.effect).toBe('invoke');
    expect(await used(job.enrollmentId)).toEqual({ workspace: ALLOWANCE, enrollment: ALLOWANCE });
    expect((await ledger(job.enrollmentId))[0]).toMatchObject({ state: 'reserved', reserved: ALLOWANCE, charged: ALLOWANCE });
    const response = await invoke(claimed.request!);
    expect(response.statusCode, response.body).toBe(200);
    // (1000-400)*0.3 + 400*0.075 + (200+100)*2.5 = 960 micro-USD
    expect(response.json()).toMatchObject({ status: 'succeeded', usage: { microUsd: 960, tokens: 1300 }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    expect(calls).toBe(before + 1);
    const version = (await pricingInForce(db, workspaceId, 'model'))!.versionId;
    const dispatch = (await db.query('SELECT model_id,pricing_version_id,cost_micro_usd::int AS cost,provider_usage->\'cost\' AS receipt FROM provider_dispatches WHERE operation_id=$1', [claimed.operation!.id])).rows[0];
    expect(dispatch).toMatchObject({ model_id: 'model', pricing_version_id: version, cost: 960 });
    expect(dispatch.receipt).toEqual({ currency: 'USD', microUsd: 960, pricingVersionId: version, basis: 'reported_usage',
      billable: { inputTokens: 600, cachedInputTokens: 400, outputTokens: 300, requests: 1, outputSeconds: 0 } });
    // Retried and concurrent settlements of the same outcome release the remainder once.
    const settle = () => bridge.transition({ type: 'settle', ref: job.ref, operationId: claimed.operation!.id, ownerId: claimed.ownerId, outcome: response.json() });
    const results = await Promise.allSettled([settle(), settle(), settle()]);
    expect(results.filter(r => r.status === 'fulfilled').length).toBeGreaterThan(0);
    await settle();
    expect(await used(job.enrollmentId)).toEqual({ workspace: 960, enrollment: 960 });
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', reserved: ALLOWANCE, charged: 960, actual: 960, released: ALLOWANCE - 960, pricing_version_id: version, model_id: 'model' }]);
    // A repeated gateway request returns the stored receipt without another call or charge.
    expect((await invoke(claimed.request!)).json()).toEqual(response.json());
    expect(calls).toBe(before + 1);
    expect((await db.query('SELECT micro_usd::int AS m FROM supervisor_job_spend WHERE job_id=$1', [job.ref.jobId])).rows[0].m).toBe(960);
  }, 60000);

  it('keeps the full reservation for uncertain calls and for unknown usage', async () => {
    behavior = { kind: 'uncertain' };
    const job = await prepare(), claimed = await claim(job);
    const response = await invoke(claimed.request!);
    expect(response.json()).toEqual({ status: 'uncertain' });
    await bridge.transition({ type: 'settle', ref: job.ref, operationId: claimed.operation!.id, ownerId: claimed.ownerId, outcome: response.json() });
    await bridge.transition({ type: 'halt', ref: job.ref, reason: 'deadline_exceeded' }).catch(() => undefined);
    expect(await used(job.enrollmentId)).toEqual({ workspace: 960 + ALLOWANCE, enrollment: ALLOWANCE });
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'uncertain', reserved: ALLOWANCE, charged: ALLOWANCE, actual: null, released: 0, pricing_version_id: null, model_id: null }]);
    // A response without input counts is billed at the ceiling even though a price exists.
    behavior = { kind: 'ok', tokens: { input: null, output: 5, total: null, cachedInput: null, thoughts: null, toolInput: null } };
    const unknown = await prepare(), second = await claim(unknown), done = await invoke(second.request!);
    expect(done.json()).toMatchObject({ status: 'succeeded', usage: { microUsd: ALLOWANCE }, usageBasis: { microUsd: 'reserved_ceiling' } });
    await bridge.transition({ type: 'settle', ref: unknown.ref, operationId: second.operation!.id, ownerId: second.ownerId, outcome: done.json() });
    expect(await ledger(unknown.enrollmentId)).toEqual([{ state: 'unpriced', reserved: ALLOWANCE, charged: ALLOWANCE, actual: null, released: 0, pricing_version_id: null, model_id: 'model' }]);
    expect((await used(unknown.enrollmentId)).enrollment).toBe(ALLOWANCE);
  }, 60000);

  it('lets an operator explicitly allow unpriced work at the full allowance, and reports reserved versus actual spend', async () => {
    const settings = `${pricingPath()}/settings`;
    expect((await app.inject({ method: 'POST', url: settings, headers: headers(owner), payload: { idempotencyKey: randomUUID(), expectedRevision: 0, requirePricing: false } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: settings, headers: headers(learnerSession), payload: { idempotencyKey: randomUUID(), expectedRevision: 0, requirePricing: false, acknowledgeConservativeCharge: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: settings, headers: headers(owner), payload: { idempotencyKey: randomUUID(), expectedRevision: 3, requirePricing: true } })).statusCode).toBe(409);
    const withdraw = await app.inject({ method: 'POST', url: pricingPath(), headers: headers(owner), payload: { ...price({ expectedVersion: 2, status: 'withdrawn',
      effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() }), inputMicroUsdPerMillionTokens: null, outputMicroUsdPerMillionTokens: null, cachedInputMicroUsdPerMillionTokens: null } });
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    // Bring the scheduled versions forward instead of waiting a day: the withdrawal (newest) is now in force.
    await db.query("UPDATE provider_model_prices SET effective_from=now()-interval '1 second' WHERE workspace_id=$1 AND model_id='model' AND version IN(2,3)", [workspaceId]);
    expect(await pricingInForce(db, workspaceId, 'model')).toBeNull();
    expect(await availability()).toEqual({ status: 'configuration_missing' });
    await setRequirement(false);
    expect(await availability()).toEqual({ status: 'ready' });
    behavior = { kind: 'ok', tokens: { input: 10, output: 10, total: 20, cachedInput: 0, thoughts: 0, toolInput: 0 } };
    const job = await prepare(), claimed = await claim(job), response = await invoke(claimed.request!);
    expect(response.json()).toMatchObject({ usage: { microUsd: ALLOWANCE }, usageBasis: { microUsd: 'reserved_ceiling' } });
    await bridge.transition({ type: 'settle', ref: job.ref, operationId: claimed.operation!.id, ownerId: claimed.ownerId, outcome: response.json() });
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'unpriced', reserved: ALLOWANCE, charged: ALLOWANCE, actual: null, released: 0, pricing_version_id: null, model_id: 'model' }]);
    await setRequirement(true);

    for (const s of [learnerSession, foreign]) expect((await app.inject({ url: `/api/admin/workspaces/${workspaceId}/provider-spend`, headers: headers(s) })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/admin/workspaces/${workspaceId}/provider-spend?period=week`, headers: headers(owner) })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/admin/workspaces/${workspaceId}/provider-spend?from=2020-01-01&to=2026-01-01`, headers: headers(owner) })).statusCode).toBe(400);
    const spend = await app.inject({ url: `/api/admin/workspaces/${workspaceId}/provider-spend?period=day`, headers: headers(owner) });
    expect(spend.statusCode, spend.body).toBe(200);
    const body = spend.json();
    // Calls: refused (0), reconciled (960 of 100000), uncertain (held), unknown usage and allowed unpriced (both at ceiling).
    expect(body.totals).toEqual({ calls: 5, reserved: String(5 * ALLOWANCE), charged: String(960 + 3 * ALLOWANCE), actual: '960',
      released: String(ALLOWANCE + ALLOWANCE - 960), held: String(ALLOWANCE), unpriced: String(2 * ALLOWANCE), uncertain: 1 });
    expect(body.byRole).toEqual([{ role: 'companion', ...body.totals }]);
    expect(body.byPeriod).toHaveLength(1);
    expect(body.byPeriod[0].period).toBe(new Date().toISOString().slice(0, 10));
    expect(body.byEnrollment).toHaveLength(5);
    const monthly = (await app.inject({ url: `/api/admin/workspaces/${workspaceId}/provider-spend?period=month`, headers: headers(owner) })).json();
    expect(monthly.byPeriod[0]).toMatchObject({ period: new Date().toISOString().slice(0, 7), charged: body.totals.charged });
    // The ledger agrees with the budget tables it mirrors.
    const budget = (await db.query('SELECT used_micro_usd::text AS used FROM supervisor_workspace_budgets WHERE workspace_id=$1', [workspaceId])).rows[0].used;
    expect(budget).toBe(body.totals.charged);
  }, 60000);
});
