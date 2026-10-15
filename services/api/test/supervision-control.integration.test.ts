import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { HostBridge, RunRef } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { appendEvent } from '../src/events.js';
import { initialPolicy } from '../src/policy-adapter.js';
import {
  configureSupervisorBudget, createPostgresSupervisorBridge, paidWorkPolicy, recordSupervisorVerification,
  registerSupervisorBridge, storeSupervisorArtifact, type SupervisorBridgeOptions,
} from '../src/supervisor-bridge.js';
import { readSupervisionControl, setSupervisionControl, supervisionOverview, type SupervisionControlInput } from '../src/supervision-control.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { fixture } from './fixture.js';

const schema = `supervision_control_${randomUUID().replaceAll('-', '')}`;
const serviceToken = 'synthetic-test-service-token-not-a-credential';
let db: Database, testDatabase: TestDatabase | undefined;
const apps: FastifyInstance[] = [];
interface Seed { workspaceId: string; enrollmentId: string; userId: string; staffId: string }
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
}, 30_000);
afterAll(async () => {
  await Promise.all(apps.map(a => a.close())); await db?.end();
  await testDatabase?.drop();
});
async function seed(): Promise<Seed> {
  const userId = randomUUID(), staffId = randomUUID(), enrollmentId = randomUUID(), workspaceId = randomUUID(), releaseId = randomUUID();
  const course = compileCourse(fixture());
  for (const [id, name] of [[userId, 'Synthetic learner'], [staffId, 'Synthetic staff']] as const)
    await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [id, `synthetic:${id}`, name]);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `w-${workspaceId}`, 'Synthetic workspace']);
  await db.query(`INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
    VALUES ($1,$2,$3,'1.0.0',$4,$5,$6,'published',$7)`, [releaseId, workspaceId, course.server.id, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), userId]);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, userId]);
  const policy = initialPolicy(course.server, enrollmentId, userId, new Date().toISOString());
  await db.query(`INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,current_episode_id) VALUES ($1,$2,$3,$4,$5,'min')`,
    [enrollmentId, workspaceId, releaseId, userId, JSON.stringify(course.server.policy)]);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(policy)]);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 10_000, tokens: 10_000 });
  return { workspaceId, enrollmentId, userId, staffId };
}
const options = (s: Seed): SupervisorBridgeOptions => ({ serviceToken, workspaceIds: [s.workspaceId],
  jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
const bridge = (s: Seed) => createPostgresSupervisorBridge(db, options(s));
function app(s: Seed) { const a = Fastify({ logger: false }); registerSupervisorBridge(a, db, options(s)); apps.push(a); return a; }
const rpc = (a: FastifyInstance, payload: object) => a.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: `Bearer ${serviceToken}` }, payload });
async function event(s: Seed) {
  return transaction(db, async client => (await appendEvent(client, { workspaceId: s.workspaceId, enrollmentId: s.enrollmentId, actorId: s.userId,
    actorKind: 'learner', type: 'learning.updated', payload: {}, idempotencyKey: randomUUID(), supervise: true })).id);
}
async function prepare(s: Seed, b: HostBridge = bridge(s)) {
  const id = await event(s);
  const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === id)!;
  expect(lease).toBeDefined();
  const refs = await b.prepareOutbox(lease); await b.ackOutbox(lease);
  return { b, ref: refs[0]!, refs, eventId: id };
}
const claim = (b: HostBridge, ref: RunRef) => b.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
function control(s: Seed, action: SupervisionControlInput['action'], extra: Partial<SupervisionControlInput> = {}) {
  return transaction(db, client => setSupervisionControl(client, { workspaceId: s.workspaceId, enrollmentId: s.enrollmentId, action,
    actorId: s.staffId, idempotencyKey: randomUUID(), ...extra }));
}
async function settled(s: Seed, b: HostBridge, ref: RunRef) {
  const claimed = await claim(b, ref); expect(claimed.effect).toBe('invoke');
  const op = claimed.snapshot.operations[0]!;
  const artifact = await storeSupervisorArtifact(db, ref, op.id, op.ownerId, { kind: 'proposed_adaptation', summary: 'Offer one more synthetic practice example.' });
  return b.transition({ type: 'settle', ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'succeeded', artifact, usage: { microUsd: 25, tokens: 40 } } });
}
async function verifier(s: Seed) {
  const id = randomUUID();
  await db.query(`INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,'Synthetic verifier',true,true)`, [id, s.workspaceId]);
  return id;
}

describe('supervision control state', () => {
  it('pauses, resumes and stops with revisions, idempotent replay, no-ops and an audit event that never wakes the supervisor', async () => {
    const s = await seed();
    expect(await readSupervisionControl(db, s.enrollmentId)).toMatchObject({ state: 'active', revision: 0 });
    const key = randomUUID();
    const paused = await control(s, 'pause', { idempotencyKey: key, reasonCode: 'cost_review' });
    expect(paused).toMatchObject({ state: 'paused', previousState: 'active', revision: 1, changed: true, replayed: false });
    expect(await control(s, 'pause', { idempotencyKey: key })).toMatchObject({ state: 'paused', revision: 1, replayed: true });
    await expect(control(s, 'stop', { idempotencyKey: key })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await control(s, 'pause')).toMatchObject({ state: 'paused', revision: 1, changed: false });
    await expect(control(s, 'resume', { expectedRevision: 0 })).rejects.toMatchObject({ code: 'SUPERVISION_CONTROL_STALE' });
    expect(await control(s, 'stop', { expectedRevision: 1 })).toMatchObject({ state: 'stopped', previousState: 'paused', revision: 2 });
    await expect(control(s, 'pause')).rejects.toMatchObject({ code: 'SUPERVISION_CONTROL_INVALID' });
    expect(await control(s, 'resume')).toMatchObject({ state: 'active', previousState: 'stopped', revision: 3 });
    expect(await readSupervisionControl(db, s.enrollmentId)).toMatchObject({ state: 'active', revision: 3, reasonCode: null, changedBy: s.staffId });
    const events = (await db.query(`SELECT e.actor_kind,e.payload,(SELECT count(*)::integer FROM outbox o WHERE o.event_id=e.id) AS queued
      FROM learning_events e WHERE e.enrollment_id=$1 AND e.event_type='supervision.control_changed' ORDER BY e.sequence`, [s.enrollmentId])).rows;
    expect(events.map(e => e.payload.state)).toEqual(['paused', 'stopped', 'active']);
    expect(events.every(e => e.actor_kind === 'staff' && e.queued === 0)).toBe(true);
    expect(events[0].payload).toEqual({ state: 'paused', previousState: 'active', revision: 1, reasonCode: 'cost_review' });
  });
  it('rejects free-text reasons, unknown enrollments and foreign workspaces', async () => {
    const s = await seed(), other = await seed();
    await expect(control(s, 'pause', { reasonCode: 'Learner said something private' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(control(s, 'pause', { enrollmentId: randomUUID() })).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_FOUND' });
    await expect(control(s, 'pause', { workspaceId: other.workspaceId })).rejects.toMatchObject({ code: 'SUPERVISOR_NOT_FOUND' });
    expect(await readSupervisionControl(db, s.enrollmentId)).toMatchObject({ state: 'active', revision: 0 });
  });
});

describe('pause', () => {
  it('holds new provider calls and publication, keeps events queued without spending attempts, and resumes them', async () => {
    const s = await seed(), b = bridge(s);
    const running = await prepare(s, b);
    await control(s, 'pause');
    const held = await claim(b, running.ref);
    expect(held.effect).toBe('hold'); expect(held.snapshot.operations).toEqual([]);
    expect((await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [s.enrollmentId])).rows[0].used_micro_usd).toBe('0');
    const waiting = await event(s);
    expect((await b.claimOutbox(randomUUID(), 100, 30_000)).map(e => e.eventId)).not.toContain(waiting);
    expect((await db.query('SELECT attempts FROM outbox WHERE event_id=$1', [waiting])).rows[0].attempts).toBe(0);
    const overview = await supervisionOverview(db, s.workspaceId, s.enrollmentId);
    expect(overview.control.state).toBe('paused'); expect(overview.pendingSignals).toBe(1);
    expect(overview.jobs).toEqual([expect.objectContaining({ id: running.ref.jobId, held: true, cancellationRequested: false })]);
    await control(s, 'resume');
    expect((await b.claimOutbox(randomUUID(), 100, 30_000)).map(e => e.eventId)).toContain(waiting);
    expect((await claim(b, running.ref)).effect).toBe('invoke');
  });
  it('lets an in-flight call settle while paused, then holds application until resume', async () => {
    const s = await seed(), b = bridge(s), job = await prepare(s, b);
    const claimed = await claim(b, job.ref); const op = claimed.snapshot.operations[0]!;
    await control(s, 'pause');
    const artifact = await storeSupervisorArtifact(db, job.ref, op.id, op.ownerId, { kind: 'proposed_adaptation', summary: 'Offer one more synthetic practice example.' });
    const result = await b.transition({ type: 'settle', ref: job.ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'succeeded', artifact, usage: { microUsd: 25, tokens: 40 } } });
    expect(result.effect).toBe('continue');
    await recordSupervisorVerification(db, job.ref, await verifier(s), 'verified');
    expect((await b.transition({ type: 'verify', ref: job.ref })).snapshot.state).toBe('ready');
    expect((await b.transition({ type: 'apply', ref: job.ref })).effect).toBe('hold');
    expect((await db.query('SELECT count(*)::integer AS n FROM supervisor_adaptations WHERE job_id=$1', [job.ref.jobId])).rows[0].n).toBe(0);
    await control(s, 'resume');
    expect((await b.transition({ type: 'apply', ref: job.ref })).snapshot.state).toBe('applied');
  });
  it('refuses host-owned paid work while paused or stopped', async () => {
    const s = await seed();
    const check = () => transaction(db, client => paidWorkPolicy(client, { workspaceId: s.workspaceId, enrollmentId: s.enrollmentId, episodeId: null }, 'admit_job'));
    expect((await check()).allowed).toBe(true);
    await control(s, 'pause');
    expect(await check()).toMatchObject({ allowed: false, active: true, violations: expect.arrayContaining(['supervision_paused']) });
    await control(s, 'stop');
    expect(await check()).toMatchObject({ allowed: false, violations: expect.arrayContaining(['supervision_stopped']) });
    await control(s, 'resume');
    expect((await check()).allowed).toBe(true);
  });
});

describe('stop', () => {
  it('cancels every live job with its own reason, never publishes late output and consumes new events', async () => {
    const s = await seed(), b = bridge(s);
    const verified = await prepare(s, b);
    await settled(s, b, verified.ref);
    const queued = await prepare(s, b);
    await recordSupervisorVerification(db, verified.ref, await verifier(s), 'verified');
    expect((await b.transition({ type: 'verify', ref: verified.ref })).snapshot.state).toBe('ready');
    const stopped = await control(s, 'stop', { reasonCode: 'staff_stop' });
    expect(stopped).toMatchObject({ state: 'stopped', cancelledJobs: 2, signalledJobs: 2 });
    const applied = await b.transition({ type: 'apply', ref: verified.ref });
    expect(applied.snapshot).toMatchObject({ state: 'cancelled', reason: 'supervision_stopped' });
    expect((await claim(b, queued.ref)).snapshot).toMatchObject({ state: 'cancelled', reason: 'supervision_stopped' });
    expect((await db.query('SELECT count(*)::integer AS n FROM supervisor_adaptations WHERE enrollment_id=$1', [s.enrollmentId])).rows[0].n).toBe(0);
    // Events that arrive while stopped are consumed without a job.
    const dropped = await prepare(s, b);
    expect(dropped.refs).toEqual([]);
    expect((await db.query('SELECT disposition FROM supervisor_preparations WHERE event_id=$1', [dropped.eventId])).rows[0].disposition).toBe('supervision_stopped');
    // Resume never resurrects a stopped job, but new events start new ones.
    await control(s, 'resume');
    expect((await b.load(verified.ref)).state).toBe('cancelled');
    const fresh = await prepare(s, b);
    expect(fresh.refs).toHaveLength(1);
    expect((await claim(b, fresh.ref)).effect).toBe('invoke');
  });
  it('records a signalled halt as a stop and requests cancellation', async () => {
    const s = await seed(), b = bridge(s), job = await prepare(s, b);
    const halted = await b.transition({ type: 'halt', ref: job.ref, reason: 'supervision_stopped' });
    expect(halted.snapshot).toMatchObject({ state: 'cancelled', reason: 'supervision_stopped' });
    expect((await db.query('SELECT cancellation_requested FROM supervisor_jobs WHERE id=$1', [job.ref.jobId])).rows[0].cancellation_requested).toBe(true);
  });
});

describe('signal delivery over the bridge', () => {
  it('leases each change with its live jobs, retries a failed delivery after a backoff and acknowledges once', async () => {
    const s = await seed(), other = await seed(), a = app(s);
    const job = await prepare(s);
    await prepare(other); await transaction(db, client => setSupervisionControl(client, { workspaceId: other.workspaceId, enrollmentId: other.enrollmentId, action: 'pause', idempotencyKey: randomUUID() }));
    const change = await control(s, 'pause');
    const first = await rpc(a, { method: 'control.claim', ownerId: randomUUID(), limit: 10, leaseMs: 30_000 });
    expect(first.statusCode).toBe(200);
    const deliveries = first.json();
    expect(deliveries).toHaveLength(1); // The other workspace's change is not visible to this service.
    expect(deliveries[0]).toMatchObject({ attempts: 1, workspaceId: s.workspaceId, jobs: [job.ref],
      signal: { schemaVersion: 1, enrollmentId: s.enrollmentId, state: 'paused', revision: change.revision } });
    expect((await rpc(a, { method: 'control.claim', ownerId: randomUUID(), limit: 10, leaseMs: 30_000 })).json()).toEqual([]);
    expect((await rpc(a, { method: 'control.ack', changeId: deliveries[0].changeId, leaseToken: randomUUID(), delivered: true })).json()).toEqual({ accepted: false });
    expect((await rpc(a, { method: 'control.ack', changeId: deliveries[0].changeId, leaseToken: deliveries[0].leaseToken, delivered: false })).json()).toEqual({ accepted: true });
    expect((await rpc(a, { method: 'control.claim', ownerId: randomUUID(), limit: 10, leaseMs: 30_000 })).json()).toEqual([]); // Backing off.
    await db.query('UPDATE supervisor_control_changes SET claimed_until=clock_timestamp() WHERE id=$1', [deliveries[0].changeId]);
    const second = (await rpc(a, { method: 'control.claim', ownerId: randomUUID(), limit: 10, leaseMs: 30_000 })).json();
    expect(second).toMatchObject([{ changeId: deliveries[0].changeId, attempts: 2 }]);
    expect((await rpc(a, { method: 'control.ack', changeId: second[0].changeId, leaseToken: second[0].leaseToken, delivered: true })).json()).toEqual({ accepted: true });
    expect((await rpc(a, { method: 'control.ack', changeId: second[0].changeId, leaseToken: second[0].leaseToken, delivered: true })).json()).toEqual({ accepted: false });
    expect((await supervisionOverview(db, s.workspaceId, s.enrollmentId)).pendingSignals).toBe(0);
    expect((await rpc(a, { method: 'control.ack', changeId: second[0].changeId, leaseToken: second[0].leaseToken, delivered: true, extra: 1 })).statusCode).toBe(400);
  });
  it('abandons a change after the attempt limit; the stored control still applies', async () => {
    const s = await seed(), b = bridge(s);
    await prepare(s, b);
    const change = await control(s, 'pause');
    await db.query('UPDATE supervisor_control_changes SET attempts=8 WHERE enrollment_id=$1 AND revision=$2', [s.enrollmentId, change.revision]);
    expect(await b.claimControls(randomUUID(), 10, 30_000)).toEqual([]);
    expect((await db.query('SELECT abandoned_at FROM supervisor_control_changes WHERE enrollment_id=$1', [s.enrollmentId])).rows[0].abandoned_at).not.toBeNull();
    expect((await readSupervisionControl(db, s.enrollmentId)).state).toBe('paused');
  });
});
