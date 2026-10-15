import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { ProviderAdapter, TextRequest, UsageReceipt } from '@course-core/providers';
import type { HostBridge, ProviderRequest, RunRef } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { fixture } from './fixture.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';

// Real database/HTTP boundaries; only the external model is a deterministic test adapter.
const schema = `course_gateway_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), userId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: HostBridge;
let calls: TextRequest[] = [], blocker: Promise<void> | undefined, entered: (() => void) | undefined;
const usage: UsageReceipt = { accounting: { accountingKey: 'fake-model-call' }, providerId: 'test-provider', modelId: 'model', operation: 'tutor', attempts: [{ attempt: 1, status: 200, outcome: 'response',
  tokens: { input: 200, output: 20, total: 220, cachedInput: 0, thoughts: 0, toolInput: 0 } }], inputCharacters: 1000, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
const adapter: ProviderAdapter = { providerId: 'test-provider', validateModel: () => {}, ports: { tutoring: { async tutor(request) {
  calls.push(request); entered?.(); if (blocker) await blocker;
  return { output: { text: 'A minimum is a value no greater than the others. Try comparing their positions on a number line.' }, usage };
} } } };

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture());
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `test:${userId}`, 'Gateway learner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, 'gateway', 'Gateway']);
  // This suite covers unknown-cost accounting; priced receipts are in provider-costs.integration.test.ts.
  await allowUnpricedPaidWork(db, workspaceId);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, userId]);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), userId]);
  const providers = composeProviders({ registry: { revision: 'test-registry', models: [{ id: 'model', providerId: 'test-provider', remoteModel: 'test/native/model', providerConfig: {}, enabled: true, capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'test-provider', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }], roles: { companion: { modelId: 'model', maxInputCharacters: 12000, maxOutputTokens: 1000 } } }, () => 'fake-key-only-in-test', { test: () => adapter });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId] };
  app = await createServer(db, { origin: 'http://localhost:4310', secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
}, 30000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function prepare() {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Gateway learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Current profile canary' }), 'min']);
  const policy = initialPolicy(course, enrollmentId, studentId, now);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(policy)]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, 'How do I compare the numbers?', JSON.stringify({ episodeId: 'min' })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested', payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutbox(randomUUID(), 100, 30000)).find(row => row.eventId === event.id)!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10000000, tokens: 1000000 });
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 1000000, tokens: 100000 });
  const claim = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
  expect(claim.effect).toBe('invoke');
  const snapshot = claim.snapshot, operation = snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: snapshot.specification.key, role: 'companion', checkpoint: snapshot.specification.checkpoints[0]!, fence: snapshot.specification.fence };
  return { ref: ref!, request, operation, enrollmentId, messageId };
}
function invoke(body: ProviderRequest, authorization = `Bearer ${token}`) {
  return app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization, 'idempotency-key': body.operationId }, payload: body });
}
function transition(command: unknown) { return app.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: `Bearer ${token}` }, payload: { method: 'transition', command } }); }

describe('durable question to provider to advisory reply', () => {
  it('allows one model invocation, preserves explicit unknown-cost accounting, verifies separately and applies one message', async () => {
    const job = await prepare();
    let release!: () => void; blocker = new Promise(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = invoke(job.request); await started;
    const duplicate = await invoke(job.request);
    expect(duplicate.json()).toEqual({ status: 'uncertain' });
    release(); const response = await first; blocker = undefined; entered = undefined;
    expect(response.statusCode, response.body).toBe(200);
    const outcome = response.json(); expect(outcome.status).toBe('succeeded');
    expect(outcome.usageBasis).toEqual({ microUsd: 'reserved_ceiling', tokens: 'reported' });
    expect(outcome.usage).toEqual({ microUsd: 100000, tokens: 220 });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).toContain('Current profile canary');
    expect(JSON.stringify(calls)).not.toContain('fake-key-only-in-test');
    expect(JSON.stringify(calls)).not.toContain('correctOptionId');
    expect(JSON.stringify(calls)).not.toContain('4 is below 9.');
    expect((await invoke(job.request)).json()).toEqual(outcome); expect(calls).toHaveLength(1);
    await bridge.transition({ type: 'settle', ref: job.ref, operationId: job.operation.id, ownerId: job.operation.ownerId, outcome });
    const verified = await transition({ type: 'verify', ref: job.ref });
    expect(verified.statusCode, verified.body).toBe(200); expect(verified.json().snapshot.state).toBe('ready');
    const applied = await transition({ type: 'apply', ref: job.ref });
    expect(applied.statusCode, applied.body).toBe(200); expect(applied.json().snapshot.state).toBe('applied');
    const again = await transition({ type: 'apply', ref: job.ref });
    expect(again.json().snapshot.applicationReceiptId).toBe(applied.json().snapshot.applicationReceiptId);
    const messages = await db.query("SELECT content,context FROM companion_messages WHERE enrollment_id=$1 AND role='assistant'", [job.enrollmentId]);
    expect(messages.rowCount).toBe(1);
    expect(messages.rows[0].content).toContain('number line');
    expect((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1', [job.enrollmentId])).rows[0].count).toBe('0');
    // Completed receipts remain available for reconciliation after the job became terminal.
    expect((await invoke(job.request)).json()).toEqual(outcome); expect(calls).toHaveLength(1);
  });
  it('denies stale scope and service authentication before sending any new model input', async () => {
    const job = await prepare(), before = calls.length;
    expect((await invoke(job.request, 'Bearer wrong')).statusCode).toBe(401);
    expect((await invoke({ ...job.request, job: { ...job.request.job, workspaceId: randomUUID() } })).statusCode).toBe(403);
    await db.query('UPDATE enrollments SET profile_revision=profile_revision+1,revision=revision+1 WHERE id=$1', [job.enrollmentId]);
    // Fenced out before anything was sent: a certified refusal, never a provider call.
    const stale = await invoke(job.request);
    expect(stale.statusCode).toBe(200); expect(stale.json()).toEqual({ status: 'not_started', retryable: false }); expect(calls).toHaveLength(before);
  });
});
