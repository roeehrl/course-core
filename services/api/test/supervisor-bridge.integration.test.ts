import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { dispatchOnce, type HostBridge, type RunRef, type Command } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { appendEvent } from '../src/events.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { closeEnrollment, previewClosure } from '@course-core/policy';
import {
  configureSupervisorBudget, createPostgresSupervisorBridge, loadSupervisorInput, recordSupervisorVerification,
  registerSupervisorBridge, resolveSupervisorOperation, storeSupervisorArtifact, type SupervisorBridgeOptions,
} from '../src/supervisor-bridge.js';
import { fixture } from './fixture.js';

const schema = `supervisor_test_${randomUUID().replaceAll('-', '')}`;
const serviceToken = 'synthetic-test-service-token-not-a-credential';
let db: Database;
const apps: FastifyInstance[] = [];
interface Seed { workspaceId: string; enrollmentId: string; userId: string; releaseId: string }
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema, { migrated: false });
  db = createDatabase(testDatabase.url);
  expect(await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)))).toContain('004_supervisor_runtime.sql');
  expect(await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)))).toEqual([]);
}, 30_000);
afterAll(async () => {
  await Promise.all(apps.map(a => a.close())); await db?.end();
  await testDatabase?.drop();
});
async function seed(workspace?: Seed): Promise<Seed> {
  const userId = randomUUID(), enrollmentId = randomUUID(), workspaceId = workspace?.workspaceId ?? randomUUID(), releaseId = workspace?.releaseId ?? randomUUID();
  const course = compileCourse(fixture());
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `synthetic:${userId}`, 'Synthetic learner']);
  if (!workspace) {
    await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `w-${workspaceId}`, 'Synthetic workspace']);
    await db.query(`INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
      VALUES ($1,$2,$3,'1.0.0',$4,$5,$6,'published',$7)`, [releaseId, workspaceId, course.server.id, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), userId]);
  }
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, userId]);
  const policy = initialPolicy(course.server, enrollmentId, userId, new Date().toISOString());
  await db.query(`INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,current_episode_id) VALUES ($1,$2,$3,$4,$5,'min')`, [enrollmentId, workspaceId, releaseId, userId, JSON.stringify(course.server.policy)]);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(policy)]);
  return { workspaceId, enrollmentId, releaseId, userId };
}
function options(s: Seed): SupervisorBridgeOptions {
  return { serviceToken, workspaceIds: [s.workspaceId], jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } };
}
function bridge(s: Seed) { return createPostgresSupervisorBridge(db, options(s)); }
function app(s: Seed, overrides: Partial<SupervisorBridgeOptions> = {}) {
  const a = Fastify({ logger: false }); registerSupervisorBridge(a, db, { ...options(s), ...overrides }); apps.push(a); return a;
}
function rpc(a: FastifyInstance, payload: unknown, authorization = `Bearer ${serviceToken}`) {
  return a.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization }, payload: payload as object });
}
async function event(s: Seed, companion = false, actorKind: 'learner' | 'agent' = 'learner') {
  return transaction(db, async client => {
    const messageId = randomUUID();
    if (companion) await client.query(`INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)`, [messageId, s.enrollmentId, 'Synthetic question text never sent to Temporal', JSON.stringify({ episodeId: 'min', blockId: 'min-text' })]);
    const result = await appendEvent(client, { workspaceId: s.workspaceId, enrollmentId: s.enrollmentId, actorId: s.userId, actorKind,
      type: companion ? 'companion.requested' : 'learning.updated', payload: companion ? { messageId, episodeId: 'min', blockId: 'min-text', requestKind: 'question' } : {}, idempotencyKey: randomUUID(), supervise: true });
    return { id: result.id, messageId };
  });
}
async function prepare(s: Seed, companion = false) {
  const b = bridge(s), e = await event(s, companion);
  const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === e.id)!; expect(lease).toBeDefined();
  const refs = await b.prepareOutbox(lease); expect(refs).toHaveLength(1); await b.ackOutbox(lease);
  return { b, ref: refs[0]!, lease, messageId: e.messageId };
}
async function fund(s: Seed, workspace = 10_000, enrollment = 10_000) {
  await configureSupervisorBudget(db, { workspaceId: s.workspaceId }, { microUsd: workspace, tokens: workspace });
  await configureSupervisorBudget(db, s, { microUsd: enrollment, tokens: enrollment });
}
function claim(b: HostBridge, ref: RunRef) { return b.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } }); }
async function complete(s: Seed, companion = false) {
  const job = await prepare(s, companion); await fund(s);
  const claimed = await claim(job.b, job.ref); expect(claimed.effect).toBe('invoke'); const op = claimed.snapshot.operations[0]!;
  const output = await storeSupervisorArtifact(db, job.ref, op.id, op.ownerId, companion ? { kind: 'companion_message', text: 'Verified synthetic answer.' } : { kind: 'proposed_adaptation', summary: 'Propose another practice example; no credit granted.' });
  await job.b.transition({ type: 'settle', ref: job.ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'succeeded', artifact: output, usage: { microUsd: 25, tokens: 40 } } });
  return { ...job, op, output };
}
async function authority(s: Seed, companion = true, adaptation = true) {
  const id = randomUUID();
  await db.query(`INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,'Synthetic independent verifier',$3,$4)`, [id, s.workspaceId, companion, adaptation]); return id;
}
async function verify(s: Seed, job: { b: HostBridge; ref: RunRef }) {
  const verifierId = await authority(s), receiptId = await recordSupervisorVerification(db, job.ref, verifierId, 'verified');
  expect((await job.b.transition({ type: 'verify', ref: job.ref })).snapshot.state).toBe('ready'); return { verifierId, receiptId };
}
async function count(table: string, where: string, values: unknown[]) {
  // Identifiers are static test literals only.
  return Number((await db.query(`SELECT count(*) FROM ${table} WHERE ${where}`, values)).rows[0].count);
}

describe('service authentication and scoped contracts', () => {
  it('requires service bearer; absent config is closed; learner cookies and supplied flags cannot authenticate', async () => {
    const s = await seed(), a = app(s), missing = app(s, { serviceToken: '' });
    const body = { method: 'outbox.claim', ownerId: randomUUID(), limit: 1, leaseMs: 30_000 };
    expect((await rpc(missing, body)).statusCode).toBe(503); expect((await rpc(a, body, 'Bearer wrong')).statusCode).toBe(401);
    expect((await a.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { cookie: 'course_session=synthetic' }, payload: body })).statusCode).toBe(401);
    expect((await rpc(a, { ...body, grantMastery: true })).statusCode).toBe(400);
    expect((await rpc(a, body)).json()).toEqual([]); expect((await rpc(app(s, { workspaceIds: [] }), body)).json()).toEqual([]);
  });
  it('matches job, enrollment and workspace identity and rejects foreign scoped references', async () => {
    const s = await seed(), foreign = await seed(), j = await prepare(s), f = await prepare(foreign), a = app(s);
    expect((await rpc(a, { method: 'load', ref: f.ref })).statusCode).toBe(403);
    expect((await rpc(a, { method: 'load', ref: { ...j.ref, enrollmentId: foreign.enrollmentId } })).statusCode).toBe(404);
    expect((await rpc(a, { method: 'load', ref: { ...j.ref, jobId: f.ref.jobId } })).statusCode).toBe(404);
    const inputRef = (await f.b.load(f.ref)).specification.checkpoints[0]!.inputRef;
    await expect(loadSupervisorInput(db, j.ref, inputRef)).rejects.toMatchObject({ code: 'SUPERVISOR_INPUT_NOT_FOUND' });
    await expect(db.query(`INSERT INTO supervisor_inputs (id,job_id,enrollment_id,workspace_id,checkpoint_id,fence,context) VALUES ($1,$2,$3,$4,'other','{}','{}')`, [randomUUID(), j.ref.jobId, foreign.enrollmentId, s.workspaceId])).rejects.toMatchObject({ code: '23503' });
  });
  it('maps companion.requested to companion with server-held message references only', async () => {
    const s = await seed(), j = await prepare(s, true), snapshot = await j.b.load(j.ref);
    expect(snapshot.specification.role).toBe('companion');
    const input = await loadSupervisorInput(db, j.ref, snapshot.specification.checkpoints[0]!.inputRef);
    expect(input.context).toMatchObject({ messageId: j.messageId, eventId: j.lease.eventId, episodeId: 'min', blockId: 'min-text' });
    expect(JSON.stringify(input)).not.toContain('Synthetic question text');
    const other = await prepare(s); expect((await other.b.load(other.ref)).specification.role).toBe('supervisor');
    expect(snapshot.specification.deadlineAtMs - Date.now()).toBeLessThanOrEqual(60_000);
  });
  it('links learner messages at prepare so queued/waiting/failed state stays visible across duplicate prepare', async () => {
    const s = await seed(), b = bridge(s), e = await event(s, true), lease = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!;
    const refs = await Promise.all(Array.from({ length: 4 }, () => b.prepareOutbox(lease))), ref = refs[0]![0]!;
    const visible = async () => (await db.query(`SELECT m.job_id,j.state,j.runtime_snapshot->>'reason' AS reason
      FROM companion_messages m JOIN supervisor_jobs j ON j.id=m.job_id AND j.enrollment_id=m.enrollment_id
      WHERE m.id=$1 AND m.enrollment_id=$2 AND j.workspace_id=$3`, [e.messageId, s.enrollmentId, s.workspaceId])).rows[0];
    expect(refs.every(value => JSON.stringify(value) === JSON.stringify([ref]))).toBe(true);
    expect(await visible()).toEqual({ job_id: ref.jobId, state: 'queued', reason: null });
    await b.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'configuration_missing' } });
    expect(await b.prepareOutbox(lease)).toEqual([ref]);
    expect(await visible()).toEqual({ job_id: ref.jobId, state: 'waiting', reason: 'configuration_missing' });
    await b.transition({ type: 'halt', ref, reason: 'activity_exhausted' });
    expect(await b.prepareOutbox(lease)).toEqual([ref]);
    expect(await visible()).toEqual({ job_id: ref.jobId, state: 'failed', reason: 'activity_exhausted' });
    expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [ref.jobId])).toBe(0);
  });
  it('refuses to steal a learner message already linked to another job and rolls back the new preparation', async () => {
    const s = await seed(), previous = await prepare(s, true), e = await event(s, true), b = bridge(s);
    await db.query('UPDATE companion_messages SET job_id=$2 WHERE id=$1', [e.messageId, previous.ref.jobId]);
    const lease = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!;
    await expect(b.prepareOutbox(lease)).rejects.toMatchObject({ code: 'SUPERVISOR_MESSAGE_JOB_CONFLICT' });
    expect((await db.query('SELECT job_id FROM companion_messages WHERE id=$1', [e.messageId])).rows[0].job_id).toBe(previous.ref.jobId);
    expect(await count('supervisor_jobs', 'input_event_id=$1', [e.id])).toBe(0);
    expect(await count('supervisor_preparations', 'event_id=$1', [e.id])).toBe(0);
  });
  it('constructs a fresh job/input fence when policy revision advances after the source event', async () => {
    const s = await seed(), b = bridge(s), e = await event(s, true);
    await transaction(db, async client => {
      await client.query('UPDATE enrollments SET policy_revision=2 WHERE id=$1', [s.enrollmentId]);
      await client.query("UPDATE policy_states SET policy_revision=2,snapshot=jsonb_set(snapshot,'{policyRevision}','2') WHERE enrollment_id=$1", [s.enrollmentId]);
    });
    const lease = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!; expect(lease.eventId).toBe(e.id);
    const ref = (await b.prepareOutbox(lease))[0]!, snapshot = await b.load(ref);
    expect(snapshot.specification.fence.policyRevision).toBe(2);
    const input = await loadSupervisorInput(db, ref, snapshot.specification.checkpoints[0]!.inputRef);
    expect(input.fence.policyRevision).toBe(2);
    await fund(s); expect((await claim(b, ref)).effect).toBe('invoke');
  });
  it('rejects a companion event pointing to a foreign enrollment message', async () => {
    const s = await seed(), other = await seed(s), foreign = await event(other, true), e = await event(s, true), b = bridge(s);
    await db.query("UPDATE learning_events SET payload=jsonb_set(payload,'{messageId}',to_jsonb($2::text)) WHERE id=$1", [e.id, foreign.messageId]);
    const lease = (await b.claimOutbox(randomUUID(), 10, 30_000)).find(row => row.eventId === e.id)!;
    await expect(b.prepareOutbox(lease)).rejects.toMatchObject({ code: 'SUPERVISOR_COMPANION_CONTEXT_INVALID' });
    expect(await count('supervisor_jobs', 'input_event_id=$1', [e.id])).toBe(0);
  });
  it('resolves a neutral provider request to the persisted owner/generation and rejects altered caps', async () => {
    const s = await seed(), j = await prepare(s, true); await fund(s);
    const result = await claim(j.b, j.ref), spec = result.snapshot.specification, op = result.snapshot.operations[0]!;
    const request = { schemaVersion: 1 as const, job: spec.key, role: spec.role, checkpoint: spec.checkpoints[0]!, fence: spec.fence, operationId: op.id };
    const resolved = await resolveSupervisorOperation(db, request);
    expect(resolved.ref).toEqual(j.ref); expect(resolved.ownerId).toBe(op.ownerId); expect(resolved.operationStatus).toBe('in_flight');
    expect(resolved.input.context.messageId).toBe(j.messageId);
    await expect(resolveSupervisorOperation(db, { ...request, checkpoint: { ...request.checkpoint, allowance: { microUsd: 999, tokens: 999 } } })).rejects.toMatchObject({ code: 'SUPERVISOR_OPERATION_MISMATCH' });
  });
});

describe('multi-worker outbox leases', () => {
  it('claims each row once concurrently and actually skips a row held by another transaction', async () => {
    const s = await seed(), b = bridge(s); for (let i = 0; i < 12; i++) await event(s);
    const client = await db.connect(); await client.query('BEGIN');
    const held = (await client.query('SELECT event_id FROM outbox o JOIN learning_events e ON e.id=o.event_id WHERE e.workspace_id=$1 ORDER BY event_id LIMIT 1 FOR UPDATE OF o', [s.workspaceId])).rows[0].event_id;
    try {
      const ids = (await Promise.all(Array.from({ length: 6 }, () => b.claimOutbox(randomUUID(), 3, 30_000)))).flat().map(r => r.eventId);
      expect(ids).toHaveLength(11); expect(new Set(ids).size).toBe(11); expect(ids).not.toContain(held);
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect((await b.claimOutbox(randomUUID(), 10, 30_000)).map(r => r.eventId)).toEqual([held]);
  });
  it('prepares exactly once, reclaims expired leases and CAS-rejects stale ack/nack', async () => {
    const s = await seed(), b = bridge(s); await event(s); const first = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!;
    expect(await b.ackOutbox(first)).toBe(false);
    const results = await Promise.all(Array.from({ length: 6 }, () => b.prepareOutbox(first)));
    expect(new Set(results.map(r => JSON.stringify(r))).size).toBe(1);
    expect(await count('supervisor_jobs', 'input_event_id=$1', [first.eventId])).toBe(1);
    await db.query("UPDATE outbox SET claimed_until=clock_timestamp()-interval '1 second' WHERE event_id=$1", [first.eventId]);
    const second = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!;
    expect(second.leaseToken).not.toBe(first.leaseToken); expect(second.attempts).toBe(2);
    expect(await b.ackOutbox(first)).toBe(false); expect(await b.nackOutbox(first, 'dispatch_unavailable', 0, true)).toBe(false);
    await expect(b.prepareOutbox(first)).rejects.toMatchObject({ code: 'SUPERVISOR_LEASE_LOST' });
    expect(await b.prepareOutbox(second)).toEqual(results[0]); expect(await b.ackOutbox(second)).toBe(true); expect(await b.ackOutbox(second)).toBe(true);
    expect(await b.claimOutbox(randomUUID(), 10, 30_000)).toEqual([]);
  });
  it('quarantines malformed/exhausted rows, respects backoff and excludes foreign tenants', async () => {
    const s = await seed(), foreign = await seed(), b = bridge(s), bad = await event(s), exhausted = await event(s), good = await event(s); await event(foreign);
    await db.query("UPDATE outbox SET payload='{}' WHERE event_id=$1", [bad.id]); await db.query('UPDATE outbox SET attempts=8 WHERE event_id=$1', [exhausted.id]);
    const rows = await b.claimOutbox(randomUUID(), 10, 30_000); expect(rows.map(r => r.eventId)).toEqual([good.id]);
    expect(await count('outbox', 'event_id=ANY($1::uuid[]) AND quarantined_at IS NOT NULL', [[bad.id, exhausted.id]])).toBe(2);
    expect(await b.nackOutbox(rows[0]!, 'dispatch_unavailable', 60_000, false)).toBe(true); expect(await b.claimOutbox(randomUUID(), 10, 30_000)).toEqual([]);
    expect((await db.query('SELECT attempts,delivered_at,last_error_code FROM outbox WHERE event_id=$1', [good.id])).rows[0]).toEqual({ attempts: 1, delivered_at: null, last_error_code: 'dispatch_unavailable' });
  });
  it('a targeted claim leases only its own event, behind any backlog, and never touches another', async () => {
    const s = await seed(), neighbour = await seed(s), foreign = await seed(), b = bridge(s);
    // A backlog larger than any bounded batch, from another enrollment in the same workspace.
    for (let i = 0; i < 105; i++) await event(neighbour);
    const mine = await event(s), theirs = await event(foreign);
    const lease = await b.claimOutboxEvent(mine.id, randomUUID(), 30_000);
    expect(lease).toMatchObject({ eventId: mine.id, attempts: 1 });
    // No other row was leased, counted or quarantined.
    expect((await db.query(`SELECT count(*)::int AS n FROM outbox o JOIN learning_events e ON e.id=o.event_id WHERE e.enrollment_id=$1
      AND (o.attempts<>0 OR o.lease_token IS NOT NULL OR o.quarantined_at IS NOT NULL)`, [neighbour.enrollmentId])).rows[0].n).toBe(0);
    // Leased, foreign-tenant and unknown events are not claimable.
    expect(await b.claimOutboxEvent(mine.id, randomUUID(), 30_000)).toBeNull();
    expect(await b.claimOutboxEvent(theirs.id, randomUUID(), 30_000)).toBeNull();
    expect(await b.claimOutboxEvent(randomUUID(), randomUUID(), 30_000)).toBeNull();
    await expect(b.claimOutboxEvent('not-a-uuid', randomUUID(), 30_000)).rejects.toThrow();
    expect(await b.prepareOutbox(lease!)).toHaveLength(1); expect(await b.ackOutbox(lease!)).toBe(true);
    // The same attempt accounting as a batch claim: an exhausted event is quarantined, not leased.
    const exhausted = await event(s); await db.query('UPDATE outbox SET attempts=8 WHERE event_id=$1', [exhausted.id]);
    expect(await b.claimOutboxEvent(exhausted.id, randomUUID(), 30_000)).toBeNull();
    expect((await db.query('SELECT last_error_code FROM outbox WHERE event_id=$1 AND quarantined_at IS NOT NULL', [exhausted.id])).rows[0]?.last_error_code).toBe('attempts_exhausted');
    // The backlog is still there for the dispatcher, oldest first.
    expect((await b.claimOutbox(randomUUID(), 100, 30_000)).every(row => row.payload.enrollmentId === neighbour.enrollmentId)).toBe(true);
  });
  it('production dispatch is first-in first-out across workspaces: a quiet workspace waits only for the backlog ahead of it', async () => {
    const busy = await seed(), quiet = await Promise.all(Array.from({ length: 5 }, () => seed()));
    const b = createPostgresSupervisorBridge(db, { ...options(busy), workspaceIds: [busy.workspaceId, ...quiet.map(q => q.workspaceId)] });
    for (let i = 0; i < 40; i++) await event(busy);
    const late = []; for (const q of quiet) late.push((await event(q)).id);
    const started: string[] = [], starter = { async start(ref: RunRef) { started.push(ref.enrollmentId); } };
    const rounds: number[] = [];
    for (let round = 1; round <= 10 && rounds.length < late.length; round++) {
      expect((await dispatchOnce(b, starter, { limit: 10, leaseMs: 30_000 })).claimed).toBeLessThanOrEqual(10);
      const delivered = (await db.query('SELECT count(*)::int AS n FROM outbox WHERE event_id=ANY($1::uuid[]) AND delivered_at IS NOT NULL', [late])).rows[0].n;
      while (rounds.length < delivered) rounds.push(round);
    }
    // 45 events, 10 per round: the quiet workspaces' events go in round 5, none starves.
    expect(rounds).toEqual([5, 5, 5, 5, 5]);
    expect(new Set(started.slice(-5))).toEqual(new Set(quiet.map(q => q.enrollmentId)));
  });
  it('durably records no-op preparation for feedback and inactive enrollment', async () => {
    const s = await seed(), b = bridge(s), e = await event(s, false, 'agent'), lease = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!;
    expect(await b.prepareOutbox(lease)).toEqual([]); expect(await b.ackOutbox(lease)).toBe(true);
    expect((await db.query('SELECT disposition FROM supervisor_preparations WHERE event_id=$1', [e.id])).rows[0].disposition).toBe('agent_event');
    await db.query("UPDATE enrollments SET status='paused' WHERE id=$1", [s.enrollmentId]); await event(s);
    expect(await b.prepareOutbox((await b.claimOutbox(randomUUID(), 1, 30_000))[0]!)).toEqual([]);
  });
});

describe('shared reservations and authoritative fences', () => {
  it('denies calls with default zero budgets, and never resets usage on configuration', async () => {
    const s = await seed(), j = await prepare(s); expect((await claim(j.b, j.ref)).snapshot.reason).toBe('budget_exhausted');
    expect((await j.b.load(j.ref)).operations).toEqual([]); await fund(s); expect((await claim(j.b, j.ref)).effect).toBe('invoke'); await fund(s, 50, 50);
    expect((await db.query('SELECT used_micro_usd,limit_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0]).toEqual({ used_micro_usd: '100', limit_micro_usd: '50' });
  });
  it('prevents workspace oversubscription between different enrollment locks', async () => {
    const s = await seed(), other = await seed(s), a = await prepare(s), b = await prepare(other);
    await fund(s, 150, 1_000); await configureSupervisorBudget(db, other, { microUsd: 1_000, tokens: 1_000 });
    const results = await Promise.all([claim(a.b, a.ref), claim(b.b, b.ref)]);
    expect(results.map(r => r.effect).sort()).toEqual(['invoke', 'stop']); expect(results.find(r => r.effect === 'stop')!.snapshot.reason).toBe('budget_exhausted');
    expect((await db.query('SELECT used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0]).toEqual({ used_micro_usd: '100', used_tokens: '100' });
  });
  it('prevents enrollment oversubscription across separate logical jobs', async () => {
    const s = await seed(), a = await prepare(s), b = await prepare(s); await fund(s, 10_000, 150);
    expect((await Promise.all([claim(a.b, a.ref), claim(b.b, b.ref)])).filter(r => r.effect === 'invoke')).toHaveLength(1);
    expect((await db.query('SELECT used_tokens FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [s.enrollmentId])).rows[0].used_tokens).toBe('100');
  });
  it('replay retains one uncertain reservation and definitive non-start releases it exactly once', async () => {
    const s = await seed(), j = await prepare(s); await fund(s); const op = (await claim(j.b, j.ref)).snapshot.operations[0]!;
    const repeat = await Promise.all(Array.from({ length: 8 }, () => claim(j.b, j.ref))); expect(repeat.every(r => r.snapshot.reason === 'provider_uncertain')).toBe(true);
    expect((await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0].used_micro_usd).toBe('100');
    const command: Command = { type: 'settle', ref: j.ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'not_started', retryable: true } };
    await Promise.all(Array.from({ length: 6 }, () => j.b.transition(command)));
    expect((await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0].used_micro_usd).toBe('0');
    expect((await claim(j.b, j.ref)).snapshot.operations[0]!.attempt).toBe(2);
  });
  it('persists explicit unknown-usage ceilings over RPC without releasing shared reservations on success/replay', async () => {
    const s = await seed(), j = await prepare(s, true); await fund(s); const op = (await claim(j.b, j.ref)).snapshot.operations[0]!;
    const artifact = await storeSupervisorArtifact(db, j.ref, op.id, op.ownerId, { kind: 'companion_message', text: 'Synthetic answer with unknown billing.' });
    const usageBasis = { microUsd: 'reserved_ceiling' as const, tokens: 'reserved_ceiling' as const };
    const command = { type: 'settle', ref: j.ref, operationId: op.id, ownerId: op.ownerId,
      outcome: { status: 'succeeded', artifact, usage: { ...op.reservation }, usageBasis } };
    const a = app(s);
    const bad = await rpc(a, { method: 'transition', command: { ...command, outcome: { ...command.outcome, usage: { microUsd: 0, tokens: 0 } } } });
    expect(bad.statusCode).toBe(409);
    for (let i = 0; i < 2; i++) {
      const result = await rpc(a, { method: 'transition', command }); expect(result.statusCode, result.body).toBe(200);
      expect(result.json().snapshot.operations[0].outcome.usageBasis).toEqual(usageBasis);
    }
    expect((await j.b.load(j.ref)).operations[0]!.outcome).toEqual(command.outcome);
    expect((await db.query('SELECT used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0]).toEqual({ used_micro_usd: '100', used_tokens: '100' });
    expect((await db.query('SELECT used_micro_usd,used_tokens FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [s.enrollmentId])).rows[0]).toEqual({ used_micro_usd: '100', used_tokens: '100' });
  });
  for (const field of ['enrollment', 'profile', 'policy', 'ledger', 'course'] as const) it(`re-reads ${field} revision before issuing a permit`, async () => {
    const s = await seed(), j = await prepare(s); await fund(s);
    if (field === 'enrollment') await db.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [s.enrollmentId]);
    if (field === 'profile') await db.query('UPDATE enrollments SET profile_revision=profile_revision+1 WHERE id=$1', [s.enrollmentId]);
    if (field === 'course') {
      const revised = fixture(); revised.version = '1.1.0'; revised.title = 'A reviewed new release';
      const compiled = compileCourse(revised), releaseId = randomUUID();
      await db.query(`INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)`, [releaseId, s.workspaceId, revised.id, revised.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), s.userId]);
      // Isolate the digest fence: move the enrollment to an immutable new release,
      // rather than attempting to mutate a published release in place.
      await db.query('UPDATE enrollments SET course_release_id=$2 WHERE id=$1', [s.enrollmentId, releaseId]);
    }
    if (field === 'policy') {
      await db.query('UPDATE enrollments SET policy_revision=policy_revision+1 WHERE id=$1', [s.enrollmentId]);
      await db.query("UPDATE policy_states SET policy_revision=policy_revision+1,snapshot=jsonb_set(snapshot,'{policyRevision}',to_jsonb(policy_revision+1)) WHERE enrollment_id=$1", [s.enrollmentId]);
    }
    if (field === 'ledger') await db.query("UPDATE policy_states SET ledger_revision=ledger_revision+1,snapshot=jsonb_set(snapshot,'{ledgerRevision}',to_jsonb(ledger_revision+1)) WHERE enrollment_id=$1", [s.enrollmentId]);
    const result = await claim(j.b, j.ref); expect(result.snapshot.reason).toBe('stale_revision'); expect(result.snapshot.operations).toEqual([]);
  });
  it('uses persisted cancellation and policy deadlines at transition time', async () => {
    const s = await seed(), j = await prepare(s); await fund(s); await db.query('UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1', [j.ref.jobId]);
    expect((await claim(j.b, j.ref)).snapshot.reason).toBe('cancel_requested');
    const next = await prepare(s), row = (await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [s.enrollmentId])).rows[0];
    row.snapshot.scopes[0].hardDeadline = { at: new Date(Date.now() - 1000).toISOString(), timeZone: 'UTC', disambiguation: 'reject' };
    await db.query('UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1', [s.enrollmentId, JSON.stringify(row.snapshot)]);
    expect((await claim(next.b, next.ref)).effect).toBe('stop');
  });
});

describe('membership revocation and independent login sessions', () => {
  async function removeMembership(s: Seed) {
    await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [s.workspaceId, s.userId]);
  }
  it('does not admit a queued event after the enrollment owner loses workspace membership', async () => {
    const s = await seed(), b = bridge(s), e = await event(s, true); await fund(s); await removeMembership(s);
    const lease = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!;
    expect(await b.prepareOutbox(lease)).toEqual([]); expect(await b.ackOutbox(lease)).toBe(true);
    expect((await db.query('SELECT disposition FROM supervisor_preparations WHERE event_id=$1', [e.id])).rows[0].disposition).toBe('inactive');
    expect(await count('supervisor_jobs', 'input_event_id=$1', [e.id])).toBe(0);
    expect((await db.query('SELECT status FROM enrollments WHERE id=$1', [s.enrollmentId])).rows[0].status).toBe('active');
  });
  it('cancels a prepared job before any provider permit if membership was deleted', async () => {
    const s = await seed(), j = await prepare(s, true); await fund(s); await removeMembership(s);
    const result = await claim(j.b, j.ref);
    expect(result.effect).toBe('stop'); expect(result.snapshot.state).toBe('cancelled');
    expect(result.snapshot.reason).toBe('inactive_enrollment'); expect(result.snapshot.operations).toEqual([]);
    expect((await db.query('SELECT used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0]).toEqual({ used_micro_usd: '0', used_tokens: '0' });
  });
  it('denies fresh provider context/operation access for a removed member even after a permit existed', async () => {
    const s = await seed(), j = await prepare(s, true); await fund(s);
    const result = await claim(j.b, j.ref), spec = result.snapshot.specification, op = result.snapshot.operations[0]!;
    await removeMembership(s);
    await expect(loadSupervisorInput(db, j.ref, spec.checkpoints[0]!.inputRef)).rejects.toMatchObject({ code: 'SUPERVISOR_INPUT_STALE' });
    await expect(resolveSupervisorOperation(db, { schemaVersion: 1, job: spec.key, role: spec.role,
      checkpoint: spec.checkpoints[0]!, fence: spec.fence, operationId: op.id })).rejects.toMatchObject({ code: 'SUPERVISOR_INPUT_STALE' });
    expect((await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0].used_micro_usd).toBe('100');
  });
  for (const basis of ['reported', 'reserved_ceiling'] as const) it(`settles and replays completed ${basis} provider receipts after removal without authorizing publication`, async () => {
    const s = await seed(), j = await prepare(s, true); await fund(s);
    const op = (await claim(j.b, j.ref)).snapshot.operations[0]!;
    await removeMembership(s);
    // This is an already-completed operation's receipt, not a new provider invocation.
    const artifact = await storeSupervisorArtifact(db, j.ref, op.id, op.ownerId, { kind: 'companion_message', text: 'Synthetic late result.' });
    const usage = basis === 'reported' ? { microUsd: 25, tokens: 40 } : { ...op.reservation };
    const command: Command = { type: 'settle', ref: j.ref, operationId: op.id, ownerId: op.ownerId,
      outcome: { status: 'succeeded', artifact, usage, usageBasis: { microUsd: basis, tokens: basis } } };
    for (let i = 0; i < 2; i++) {
      const settled = await j.b.transition(command);
      expect(settled.snapshot.state).toBe('cancelled'); expect(settled.snapshot.reason).toBe('inactive_enrollment');
      expect(settled.snapshot.operations[0]!.outcome).toEqual(command.outcome);
    }
    const expected = { used_micro_usd: String(usage.microUsd), used_tokens: String(usage.tokens) };
    expect((await db.query('SELECT used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0]).toEqual(expected);
    expect((await db.query('SELECT used_micro_usd,used_tokens FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [s.enrollmentId])).rows[0]).toEqual(expected);
    await expect(recordSupervisorVerification(db, j.ref, await authority(s), 'verified')).rejects.toMatchObject({ code: 'SUPERVISOR_VERIFICATION_STALE' });
    expect((await j.b.transition({ type: 'apply', ref: j.ref })).snapshot.state).toBe('cancelled');
    expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(0);
    expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [j.ref.jobId])).toBe(0);
  });
  it('fences application even when verification completed before membership removal', async () => {
    const s = await seed(), j = await complete(s, true); await verify(s, j); await removeMembership(s);
    const result = await j.b.transition({ type: 'apply', ref: j.ref });
    expect(result.snapshot.state).toBe('cancelled'); expect(result.snapshot.reason).toBe('inactive_enrollment');
    expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(0);
    expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [j.ref.jobId])).toBe(0);
  });
  it('serializes authorization against an uncommitted membership deletion, then observes its commit', async () => {
    const s = await seed(), j = await prepare(s); await fund(s);
    const revoker = await db.connect(); await revoker.query('BEGIN');
    const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await revoker.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [s.workspaceId, s.userId]);
    const pending = claim(j.b, j.ref);
    let blocked = false;
    try {
      for (let i = 0; i < 100; i++) {
        blocked = (await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked`, [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { await revoker.query('COMMIT'); revoker.release(); }
    const result = await pending;
    expect(blocked).toBe(true); expect(result.effect).toBe('stop'); expect(result.snapshot.reason).toBe('inactive_enrollment');
    expect(result.snapshot.operations).toEqual([]);
  });
  it('continues background admission and verified application after sign-out alone', async () => {
    const s = await seed(), b = bridge(s), e = await event(s, true), sessionId = randomUUID(); await fund(s);
    await db.query(`INSERT INTO auth_sessions (id,user_id,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour')`,
      [sessionId, s.userId, 'a'.repeat(64), 'b'.repeat(64)]);
    await db.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [sessionId]);
    const lease = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!; expect(lease.eventId).toBe(e.id);
    const ref = (await b.prepareOutbox(lease))[0]!, result = await claim(b, ref); expect(result.effect).toBe('invoke');
    const op = result.snapshot.operations[0]!;
    const artifact = await storeSupervisorArtifact(db, ref, op.id, op.ownerId, { kind: 'companion_message', text: 'Synthetic background answer after sign-out.' });
    await b.transition({ type: 'settle', ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'succeeded', artifact, usage: { microUsd: 25, tokens: 40 } } });
    await verify(s, { b, ref }); expect((await b.transition({ type: 'apply', ref })).snapshot.state).toBe('applied');
    expect(await count('auth_sessions', 'id=$1 AND revoked_at IS NOT NULL', [sessionId])).toBe(1);
    expect(await count('memberships', 'workspace_id=$1 AND user_id=$2', [s.workspaceId, s.userId])).toBe(1);
    expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [ref.jobId])).toBe(1);
  });
});

describe('verifier receipts and narrow application', () => {
  it('runs a trusted RPC verifier after scoped authorization, then consumes its stored receipt', async () => {
    const s = await seed(), j = await complete(s, true), verifierId = await authority(s), seen: RunRef[] = [];
    const a = app(s, { beforeVerify: async ref => {
      seen.push(ref); await recordSupervisorVerification(db, ref, verifierId, 'verified');
    } });
    const response = await rpc(a, { method: 'transition', command: { type: 'verify', ref: j.ref } });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().snapshot.state).toBe('ready');
    expect(seen).toEqual([j.ref]);
    expect(await count('supervisor_verifications', 'job_id=$1', [j.ref.jobId])).toBe(1);
    expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [j.ref.jobId])).toBe(0);
  });
  it('never calls the trusted verifier for unauthorized scope or caller-supplied verifier flags', async () => {
    const s = await seed(), foreign = await seed(), j = await complete(foreign, true); let calls = 0;
    const a = app(s, { beforeVerify: async () => { calls++; } });
    expect((await rpc(a, { method: 'transition', command: { type: 'verify', ref: j.ref } })).statusCode).toBe(403);
    const local = await complete(s, true);
    expect((await rpc(a, { method: 'transition', command: { type: 'verify', ref: local.ref, verdict: 'verified' } })).statusCode).toBe(400);
    expect(calls).toBe(0);
  });
  it('rechecks fences after the trusted verifier callback and leaves stronger-review proposals waiting', async () => {
    const s = await seed(), j = await complete(s, true), verifierId = await authority(s);
    const a = app(s, { beforeVerify: async ref => {
      await recordSupervisorVerification(db, ref, verifierId, 'verified');
      await db.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [ref.enrollmentId]);
    } });
    const response = await rpc(a, { method: 'transition', command: { type: 'verify', ref: j.ref } });
    expect(response.statusCode, response.body).toBe(200); expect(response.json().snapshot.reason).toBe('stale_revision');
    expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(0);
    const proposal = await complete(s);
    const noDecision = app(s, { beforeVerify: async () => {} });
    const waiting = await rpc(noDecision, { method: 'transition', command: { type: 'verify', ref: proposal.ref } });
    expect(waiting.statusCode, waiting.body).toBe(200); expect(waiting.json().snapshot.reason).toBe('verification_required');
  });
  it('provider success or worker-supplied pass flags cannot verify or publish', async () => {
    const s = await seed(), j = await complete(s, true), a = app(s);
    expect((await j.b.transition({ type: 'verify', ref: j.ref })).snapshot.reason).toBe('verification_required');
    expect((await rpc(a, { method: 'transition', command: { type: 'verify', ref: j.ref, passed: true } })).statusCode).toBe(400);
    await expect(j.b.transition({ type: 'apply', ref: j.ref })).rejects.toBeDefined();
    await expect(recordSupervisorVerification(db, j.ref, randomUUID(), 'verified')).rejects.toMatchObject({ code: 'SUPERVISOR_VERIFIER_FORBIDDEN' });
    await expect(storeSupervisorArtifact(db, j.ref, j.op.id, j.op.ownerId, { kind: 'companion_message', text: 'Claimed pass', mastery: true } as never)).rejects.toMatchObject({ code: 'SUPERVISOR_INVALID_ARTIFACT' });
    expect(await count('companion_messages', "enrollment_id=$1 AND role='assistant'", [s.enrollmentId])).toBe(0);
  });
  it('applies companion text once across racing retries without touching mastery or progression', async () => {
    const s = await seed(), j = await complete(s, true); await verify(s, j);
    const results = await Promise.all(Array.from({ length: 8 }, () => j.b.transition({ type: 'apply', ref: j.ref })));
    expect(results.every(r => r.snapshot.state === 'applied')).toBe(true); expect(new Set(results.map(r => r.snapshot.applicationReceiptId)).size).toBe(1);
    expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(1); expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [j.ref.jobId])).toBe(1);
    expect(await count('learning_events', "enrollment_id=$1 AND event_type='supervisor.applied'", [s.enrollmentId])).toBe(1);
    expect(await count('outbox', "kind='supervisor.applied' AND event_id IN (SELECT id FROM learning_events WHERE enrollment_id=$1)", [s.enrollmentId])).toBe(1);
    for (const table of ['evidence', 'attempts', 'episode_progress', 'extension_grants']) expect(await count(table, 'enrollment_id=$1', [s.enrollmentId])).toBe(0);
    expect((await db.query('SELECT revision,policy_revision,status FROM enrollments WHERE id=$1', [s.enrollmentId])).rows[0]).toEqual({ revision: 1, policy_revision: 1, status: 'active' });
    expect((await db.query('SELECT used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0]).toEqual({ used_micro_usd: '25', used_tokens: '40' });
  });
  it('keeps adaptations as proposals and requires separately authorized review', async () => {
    const s = await seed(), j = await complete(s), id = await authority(s, true, false);
    await expect(recordSupervisorVerification(db, j.ref, id, 'verified')).rejects.toMatchObject({ code: 'SUPERVISOR_VERIFIER_FORBIDDEN' });
    await verify(s, j); expect((await j.b.transition({ type: 'apply', ref: j.ref })).snapshot.state).toBe('applied');
    expect((await db.query('SELECT state,summary FROM supervisor_adaptations WHERE job_id=$1', [j.ref.jobId])).rows[0]).toEqual({ state: 'reviewed_proposal', summary: 'Propose another practice example; no credit granted.' });
    expect(await count('companion_messages', 'job_id=$1', [j.ref.jobId])).toBe(0); expect((await db.query('SELECT revision FROM enrollments WHERE id=$1', [s.enrollmentId])).rows[0].revision).toBe(1);
  });
  it('rechecks artifact hash and verifier revocation after verification', async () => {
    const s = await seed(), j = await complete(s, true), v = await verify(s, j);
    await db.query('UPDATE supervisor_verifier_authorities SET enabled=false WHERE id=$1', [v.verifierId]);
    await expect(j.b.transition({ type: 'apply', ref: j.ref })).rejects.toMatchObject({ code: 'SUPERVISOR_VERIFICATION_REQUIRED' });
    await db.query('UPDATE supervisor_verifier_authorities SET enabled=true WHERE id=$1', [v.verifierId]);
    await db.query(`UPDATE supervisor_artifacts SET content='{"kind":"companion_message","text":"tampered"}' WHERE id=$1`, [j.output.artifactId]);
    await expect(j.b.transition({ type: 'apply', ref: j.ref })).rejects.toMatchObject({ code: 'SUPERVISOR_ARTIFACT_MISMATCH' }); expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(0);
  });
  it('fences application when learner state changes after verification', async () => {
    const s = await seed(), j = await complete(s, true); await verify(s, j); await db.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [s.enrollmentId]);
    expect((await j.b.transition({ type: 'apply', ref: j.ref })).snapshot.reason).toBe('stale_revision'); expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(0);
  });
  it('rejects another job artifact and conflicting restaging under an operation ID', async () => {
    const s = await seed(), a = await complete(s), b = await prepare(s), op = (await claim(b.b, b.ref)).snapshot.operations[0]!;
    await expect(b.b.transition({ type: 'settle', ref: b.ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'succeeded', artifact: a.output, usage: { microUsd: 1, tokens: 1 } } })).rejects.toMatchObject({ code: 'SUPERVISOR_ARTIFACT_MISMATCH' });
    await expect(storeSupervisorArtifact(db, a.ref, a.op.id, a.op.ownerId, { kind: 'proposed_adaptation', summary: 'changed' })).rejects.toMatchObject({ code: 'SUPERVISOR_ARTIFACT_CONFLICT' });
  });
  it('does not release a reservation on a false non-start after an artifact was staged', async () => {
    const s = await seed(), j = await prepare(s); await fund(s); const op = (await claim(j.b, j.ref)).snapshot.operations[0]!;
    await storeSupervisorArtifact(db, j.ref, op.id, op.ownerId, { kind: 'proposed_adaptation', summary: 'Provider work already exists.' });
    await expect(j.b.transition({ type: 'settle', ref: j.ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'not_started', retryable: true } })).rejects.toMatchObject({ code: 'SUPERVISOR_OUTCOME_CONFLICT' });
    expect((await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0].used_micro_usd).toBe('100');
  });
  it('refreshes database time after waiting on an authoritative verification lock', async () => {
    const s = await seed(), j = await complete(s, true), v = await verify(s, j);
    const client = await db.connect(); await client.query('BEGIN');
    await client.query('SELECT id FROM supervisor_verifier_authorities WHERE id=$1 FOR UPDATE', [v.verifierId]);
    await db.query(`UPDATE supervisor_jobs SET runtime_snapshot=jsonb_set(runtime_snapshot,'{specification,deadlineAtMs}',to_jsonb($2::bigint)),
      specification=jsonb_set(specification,'{deadlineAtMs}',to_jsonb($2::bigint)) WHERE id=$1`, [j.ref.jobId, Date.now() + 150]);
    const pending = j.b.transition({ type: 'apply', ref: j.ref });
    try { await new Promise(resolve => setTimeout(resolve, 250)); }
    finally { await client.query('COMMIT'); client.release(); }
    expect((await pending).snapshot.state).toBe('failed');
    expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(0);
  });
});

describe('real transaction rollback on storage faults', () => {
  it('rolls back job/input creation when preparation receipt insertion fails', async () => {
    const s = await seed(), b = bridge(s), e = await event(s, true); const lease = (await b.claimOutbox(randomUUID(), 1, 30_000))[0]!;
    await db.query(`CREATE FUNCTION fail_supervisor_prepare() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected private failure'; END $$`);
    await db.query('CREATE TRIGGER fail_supervisor_prepare BEFORE INSERT ON supervisor_preparations FOR EACH ROW EXECUTE FUNCTION fail_supervisor_prepare()');
    try {
      await expect(b.prepareOutbox(lease)).rejects.toBeDefined(); expect(await count('supervisor_jobs', 'input_event_id=$1', [lease.eventId])).toBe(0);
      expect((await db.query('SELECT job_id FROM companion_messages WHERE id=$1', [e.messageId])).rows[0].job_id).toBeNull();
    }
    finally { await db.query('DROP TRIGGER fail_supervisor_prepare ON supervisor_preparations'); await db.query('DROP FUNCTION fail_supervisor_prepare()'); }
    const refs = await b.prepareOutbox(lease); expect(refs).toHaveLength(1);
    expect((await db.query('SELECT job_id FROM companion_messages WHERE id=$1', [e.messageId])).rows[0].job_id).toBe(refs[0]!.jobId);
  });
  it('rolls back budget reservations if snapshot persistence fails', async () => {
    const s = await seed(), j = await prepare(s); await fund(s);
    await db.query(`CREATE FUNCTION fail_supervisor_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected private failure'; END $$`);
    await db.query('CREATE TRIGGER fail_supervisor_snapshot BEFORE UPDATE ON supervisor_jobs FOR EACH ROW EXECUTE FUNCTION fail_supervisor_snapshot()');
    try {
      const response = await rpc(app(s), { method: 'transition', command: { type: 'claim', ref: j.ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } } });
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain('injected');
      expect((await db.query('SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1', [s.workspaceId])).rows[0].used_micro_usd).toBe('0'); expect((await j.b.load(j.ref)).operations).toEqual([]);
    } finally { await db.query('DROP TRIGGER fail_supervisor_snapshot ON supervisor_jobs'); await db.query('DROP FUNCTION fail_supervisor_snapshot()'); }
    expect((await claim(j.b, j.ref)).effect).toBe('invoke');
  });
  it('rolls back reply, receipt, event and snapshot together when event append fails', async () => {
    const s = await seed(), j = await complete(s, true); await verify(s, j);
    await db.query(`CREATE FUNCTION fail_supervisor_application_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='supervisor.applied' THEN RAISE EXCEPTION 'injected private failure'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER fail_supervisor_application_event BEFORE INSERT ON learning_events FOR EACH ROW EXECUTE FUNCTION fail_supervisor_application_event()');
    try {
      const response = await rpc(app(s), { method: 'transition', command: { type: 'apply', ref: j.ref } }); expect(response.statusCode).toBe(500); expect(response.body).not.toContain('injected');
      expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [j.ref.jobId])).toBe(0);
      expect(await count('companion_messages', "job_id=$1 AND role='learner'", [j.ref.jobId])).toBe(1);
      expect(await count('supervisor_applications', 'job_id=$1', [j.ref.jobId])).toBe(0); expect((await j.b.load(j.ref)).state).toBe('ready');
    } finally { await db.query('DROP TRIGGER fail_supervisor_application_event ON learning_events'); await db.query('DROP FUNCTION fail_supervisor_application_event()'); }
    expect((await j.b.transition({ type: 'apply', ref: j.ref })).snapshot.state).toBe('applied'); expect(await count('companion_messages', "job_id=$1 AND role='assistant'", [j.ref.jobId])).toBe(1);
  });
});

describe('completed-course questions', () => {
  async function complete(s: Seed, access: 'read_only' | 'closed' = 'read_only') {
    const row = (await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [s.enrollmentId])).rows[0];
    for (const scope of row.snapshot.scopes) scope.existingMaterialAccess = access;
    // Use the policy engine's real closure transition, as course completion does.
    const policy = row.snapshot, now = new Date().toISOString();
    const command = { now, reason: 'completed' as const, coveredObjectiveIds: policy.coreObjectiveIds, demonstratedConceptIds: [] };
    const preview = previewClosure(policy, command);
    const closed = closeEnrollment(policy, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: policy.policyRevision, expectedLedgerRevision: policy.ledgerRevision,
      idempotencyKey: 'completion:' + s.enrollmentId, authorityReceipt: { receiptId: randomUUID(), actorId: 'system:test', enrollmentId: s.enrollmentId, scopeId: 'course', permission: 'close_enrollment', termsDigest: preview.previewDigest, authorizedAt: now } });
    await db.query('UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1', [s.enrollmentId, JSON.stringify(closed.state), closed.state.policyRevision, closed.state.ledgerRevision]);
    await db.query("UPDATE enrollments SET status='completed',policy_revision=$2,closed_at=now() WHERE id=$1", [s.enrollmentId, closed.state.policyRevision]);
  }
  async function disposition(s: Seed, companion: boolean) {
    const b = bridge(s), e = await event(s, companion);
    const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === e.id)!;
    const refs = await b.prepareOutbox(lease); await b.ackOutbox(lease);
    return { refs, value: (await db.query('SELECT disposition FROM supervisor_preparations WHERE event_id=$1', [e.id])).rows[0].disposition };
  }
  it('admits only companion answers after completion while material stays readable', async () => {
    const s = await seed(); await fund(s); await complete(s);
    const asked = await disposition(s, true);
    expect(asked.value).toBe('prepared');
    expect(asked.refs).toHaveLength(1);
    const job = (await db.query('SELECT role,runtime_snapshot FROM supervisor_jobs WHERE id=$1', [asked.refs[0]!.jobId])).rows[0];
    expect(job.role).toBe('companion');
    const inputRef = job.runtime_snapshot.specification.checkpoints[0].inputRef;
    await expect(loadSupervisorInput(db, asked.refs[0]!, inputRef)).resolves.toBeTruthy();
    // Planning, research and adaptation never resume on a completed enrollment.
    expect((await disposition(s, false)).value).toBe('inactive');
  });
  it('refuses completed-course questions when the course policy closed existing material', async () => {
    const s = await seed(); await fund(s); await complete(s, 'closed');
    const asked = await disposition(s, true);
    expect(asked.value).toBe('policy_denied');
    expect(asked.refs).toEqual([]);
  });
});
