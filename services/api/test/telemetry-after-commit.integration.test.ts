import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { ProviderAdapter, UsageReceipt } from '@course-core/providers';
import type { HostBridge, ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { afterCommitTransaction, onCommit } from '../src/after-commit.js';
import { issueLoginCode } from '../src/auth.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { fixture } from './fixture.js';

// Spend and usage counters must describe only what PostgreSQL kept. A deferred constraint
// trigger makes COMMIT itself fail after every write and every queued emission has happened,
// which is the latest point a transaction can still roll back.
const recorded = vi.hoisted(() => [] as { name: string; value: number; attributes: Record<string, unknown> }[]);
vi.mock('../src/telemetry.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/telemetry.js')>();
  const { disabledTelemetry } = await import('@course-core/supervisor/telemetry');
  const runtime = { ...disabledTelemetry, enabled: true,
    count: (name: string, value: number, attributes: Record<string, unknown> = {}) => { recorded.push({ name, value, attributes }); } };
  return { ...original, telemetry: () => runtime };
});

const schema = `after_commit_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const ALLOWANCE = 100_000;
let testDatabase: TestDatabase | undefined, db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: HostBridge, calls = 0;
const receipt = (accountingKey: string): UsageReceipt => ({ accounting: { accountingKey }, providerId: 'test-provider', modelId: 'model', operation: 'tutor',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 1000, output: 200, total: 1200, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 1000, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null });
const adapter: ProviderAdapter = { providerId: 'test-provider', validateModel: () => {}, ports: { tutoring: { async tutor(request) {
  calls += 1;
  return { output: { text: 'Compare each value with the smallest one seen so far.' }, usage: receipt(request.accounting.accountingKey) };
} } } };

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use a disposable TEST_DATABASE_URL and unset DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Use a disposable loopback test database without connection overrides.');
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture()), author = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [author, `test:${author}`, 'Author']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `after-commit-${workspaceId}`, 'After commit']);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), author]);
  // Synthetic operator price: (1000*0.3) + (200*2.5) = 800 micro-USD per scripted call.
  await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
    effective_from,source_note,created_by) VALUES($1,$2,'model',1,'active','USD',300000,2500000,clock_timestamp()-interval '1 minute','Synthetic test price',$3)`,
    [randomUUID(), workspaceId, author]);
  const providers = composeProviders({ registry: { revision: 'test-registry', models: [
    { id: 'model', providerId: 'test-provider', remoteModel: 'test/native/model', providerConfig: {}, enabled: true, capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'test-provider', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }], roles: { companion: { modelId: 'model', maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
    () => 'synthetic-key-only-in-test', { test: () => adapter });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: 100_000 } } };
  app = await createServer(db, { loginCodes: true, origin: 'http://localhost:4310', secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10_000_000, tokens: 10_000_000 });
  await db.query(`CREATE FUNCTION fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced commit failure'; END $$`);
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });
beforeEach(() => { recorded.length = 0; });

/** Makes every COMMIT that inserted or updated a row of `table` fail, after all statements ran. */
async function failCommits(table: string) {
  await db.query(`CREATE CONSTRAINT TRIGGER force_rollback AFTER INSERT OR UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_at_commit()`);
}
const allowCommits = (table: string) => db.query(`DROP TRIGGER force_rollback ON ${table}`);
const total = (name: string) => recorded.filter(r => r.name === name).reduce((sum, r) => sum + r.value, 0);
const points = (name: string) => recorded.filter(r => r.name === name).length;

async function prepare() {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Synthetic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Synthetic' }), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)',
    [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, new Date().toISOString()))]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
    [messageId, enrollmentId, 'How do I find the minimum?', JSON.stringify({ episodeId: 'min' })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested',
    payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutbox(randomUUID(), 100, 30000)).find(row => row.eventId === event.id)!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 1_000_000, tokens: 1_000_000 });
  return { ref: ref!, enrollmentId, studentId };
}
const claim = (job: Awaited<ReturnType<typeof prepare>>, ownerId = randomUUID()) =>
  bridge.transition({ type: 'claim', ref: job.ref, checkpointId: 'generate', ownerId, availability: { status: 'ready' } }).then(result => ({ result, ownerId }));
const request = (snapshot: Awaited<ReturnType<HostBridge['transition']>>['snapshot']): ProviderRequest => ({ schemaVersion: 1, operationId: snapshot.operations[0]!.id,
  job: snapshot.specification.key, role: 'companion', checkpoint: snapshot.specification.checkpoints[0]!, fence: snapshot.specification.fence });
const invoke = (body: ProviderRequest) => app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
const ledger = async (enrollmentId: string) => (await db.query('SELECT state,charged_micro_usd::int AS charged FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt', [enrollmentId])).rows;
const used = async (enrollmentId: string) => Number((await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [enrollmentId])).rows[0].used_micro_usd);

describe('afterCommitTransaction', () => {
  it('runs queued effects once after COMMIT and never after a rollback', async () => {
    const ran: string[] = [];
    await db.query('CREATE TABLE commit_probe (id int)');
    expect(await afterCommitTransaction(db, async client => { await client.query('INSERT INTO commit_probe VALUES (1)'); onCommit(client, () => ran.push('kept')); return 'ok'; })).toBe('ok');
    expect(ran).toEqual(['kept']);
    // The body fails after queueing.
    await expect(afterCommitTransaction(db, async client => { onCommit(client, () => ran.push('body failed')); throw new Error('boom'); })).rejects.toThrow('boom');
    // COMMIT itself fails after the body returned.
    await failCommits('commit_probe');
    await expect(afterCommitTransaction(db, async client => { await client.query('INSERT INTO commit_probe VALUES (2)'); onCommit(client, () => ran.push('commit failed')); }))
      .rejects.toThrow('forced commit failure');
    await allowCommits('commit_probe');
    expect(ran).toEqual(['kept']);
    expect((await db.query('SELECT id FROM commit_probe ORDER BY id')).rows).toEqual([{ id: 1 }]);
    // A throwing effect cannot fail committed work, and later effects still run.
    expect(await afterCommitTransaction(db, async client => { onCommit(client, () => { throw new Error('exporter down'); }); onCommit(client, () => ran.push('after')); return 2; })).toBe(2);
    expect(ran).toEqual(['kept', 'after']);
    // Outside a transaction there is nothing to wait for: queueing is a programming error.
    const loose = await db.connect();
    try { expect(() => onCommit(loose, () => ran.push('loose'))).toThrow(/inside afterCommitTransaction/); } finally { loose.release(); }
    await db.query('DROP TABLE commit_probe');
  });
});

describe('supervisor spend counters follow the committed ledger', () => {
  it('emits nothing for a rolled-back reservation or settlement and exactly once for the committed retry', async () => {
    const job = await prepare();
    // Reservation: the claim writes the ledger row and budgets, then COMMIT fails.
    await failCommits('provider_spend_ledger');
    await expect(claim(job)).rejects.toThrow();
    await allowCommits('provider_spend_ledger');
    expect(await ledger(job.enrollmentId)).toEqual([]);
    expect(await used(job.enrollmentId)).toBe(0);
    expect(points('course.provider.cost.reserved')).toBe(0);
    // The committed retry reserves and counts once.
    const claimed = await claim(job);
    expect(claimed.result.effect).toBe('invoke');
    expect(total('course.provider.cost.reserved')).toBe(ALLOWANCE);
    expect(points('course.provider.cost.reserved')).toBe(1);

    const body = request(claimed.result.snapshot), response = await invoke(body);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'succeeded', usage: { microUsd: 800 } });
    const settle = () => bridge.transition({ type: 'settle', ref: job.ref, operationId: body.operationId, ownerId: claimed.ownerId, outcome: response.json() });
    // Settlement: reconciliation and release are written, then COMMIT fails.
    await failCommits('provider_spend_ledger');
    await expect(settle()).rejects.toThrow();
    await allowCommits('provider_spend_ledger');
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reserved', charged: ALLOWANCE }]);
    expect(points('course.provider.cost.actual') + points('course.provider.cost.released')).toBe(0);
    // Committed retry, then a duplicate settlement: actual and released are each counted once.
    await settle(); await settle();
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', charged: 800 }]);
    expect(await used(job.enrollmentId)).toBe(800);
    expect(recorded.filter(r => r.name === 'course.provider.cost.actual')).toEqual([{ name: 'course.provider.cost.actual', value: 800,
      attributes: { 'course.supervisor.role': 'companion', 'gen_ai.request.model': 'model', 'course.cost.basis': 'reported' } }]);
    expect(recorded.filter(r => r.name === 'course.provider.cost.released').map(r => r.value)).toEqual([ALLOWANCE - 800]);
  }, 60000);
});

describe('provider gateway counters follow the stored receipt', () => {
  it('counts an operation only once its receipt is stored, and not again for a repeated request', async () => {
    const job = await prepare(), claimed = await claim(job), body = request(claimed.result.snapshot);
    // The provider answers but the receipt cannot be stored: the call is reported as failed and not counted.
    await db.query(`CREATE TRIGGER refuse_receipt BEFORE UPDATE ON provider_dispatches FOR EACH ROW WHEN (NEW.state <> 'in_flight') EXECUTE FUNCTION fail_at_commit()`);
    const before = calls, refused = await invoke(body);
    await db.query('DROP TRIGGER refuse_receipt ON provider_dispatches');
    expect(calls).toBe(before + 1);
    expect(refused.statusCode).toBe(500);
    expect(points('course.provider.operations') + points('course.provider.cost.estimate')).toBe(0);
    // Without a stored receipt the outcome stays unknown and the provider is not called again.
    expect((await invoke(body)).json()).toEqual({ status: 'uncertain' });
    expect(calls).toBe(before + 1);
    expect(points('course.provider.operations')).toBe(0);

    const second = await prepare(), next = await claim(second), nextBody = request(next.result.snapshot);
    const stored = await invoke(nextBody);
    expect(stored.json()).toMatchObject({ status: 'succeeded', usage: { microUsd: 800 } });
    expect(await invoke(nextBody).then(r => r.json())).toEqual(stored.json());
    expect(calls).toBe(before + 2);
    expect(recorded.filter(r => r.name === 'course.provider.operations').map(r => r.attributes['course.supervisor.outcome'])).toEqual(['succeeded']);
    expect(recorded.filter(r => r.name === 'course.provider.cost.estimate').map(r => r.value)).toEqual([800]);
  }, 60000);
});

describe('erasure spend counters follow the committed erasure', () => {
  it('a rolled-back erasure releases and emits nothing; the committed retry emits the release once', async () => {
    const job = await prepare();
    await claim(job);
    // Cancelled before the worker reached the gateway: erasure releases the never-dispatched reservation.
    await bridge.transition({ type: 'halt', ref: job.ref, reason: 'cancel_requested' });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin: 'http://localhost:4310' }, payload: { token: await issueLoginCode(db, job.studentId) } });
    const headers = { origin: 'http://localhost:4310', cookie: r.cookies.map(c => c.name + '=' + c.value).join('; '), 'x-csrf-token': r.json().csrfToken as string };
    const erase = () => app.inject({ method: 'POST', url: `/api/enrollments/${job.enrollmentId}/erase`, headers,
      payload: { confirmation: `ERASE ${job.enrollmentId.slice(0, 8)}`, reason: 'Synthetic learner asked for erasure.' } });
    recorded.length = 0;
    await failCommits('provider_spend_ledger');
    expect((await erase()).statusCode).toBe(500);
    await allowCommits('provider_spend_ledger');
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'uncertain', charged: ALLOWANCE }]);
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
    expect(points('course.provider.cost.released')).toBe(0);
    const erased = await erase();
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await erase()).json()).toMatchObject({ replayed: true });
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'not_started', charged: 0 }]);
    expect(recorded.filter(e => e.name === 'course.provider.cost.released').map(e => e.value)).toEqual([ALLOWANCE]);
  }, 60000);
});
