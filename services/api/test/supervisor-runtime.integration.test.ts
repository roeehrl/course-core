import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { HostBridge, RunRef } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { appendEvent } from '../src/events.js';
import { initialPolicy } from '../src/policy-adapter.js';
import {
  configureSupervisorBudget, configureSupervisorPeriodBudget, createPostgresSupervisorBridge, MAX_EVENT_PAYLOAD_BYTES,
  parkSupervisorJob, resumeSupervisorJob, storeSupervisorArtifact,
} from '../src/supervisor-bridge.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { fixture } from './fixture.js';

const schema = `supervisor_runtime_${randomUUID().replaceAll('-', '')}`;
let db: Database, testDatabase: TestDatabase | undefined;
interface Seed { workspaceId: string; enrollmentId: string; userId: string }
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
}, 30_000);
afterAll(async () => { await db?.end(); await testDatabase?.drop(); });

async function seed(): Promise<Seed> {
  const userId = randomUUID(), enrollmentId = randomUUID(), workspaceId = randomUUID(), releaseId = randomUUID();
  const course = compileCourse(fixture());
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `synthetic:${userId}`, 'Synthetic learner']);
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
  return { workspaceId, enrollmentId, userId };
}
const bridge = (s: Seed) => createPostgresSupervisorBridge(db, { workspaceIds: [s.workspaceId],
  jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
async function event(s: Seed, payload: unknown = {}, type = 'learning.updated') {
  return transaction(db, async client => (await appendEvent(client, { workspaceId: s.workspaceId, enrollmentId: s.enrollmentId, actorId: s.userId,
    actorKind: 'learner', type, payload, idempotencyKey: randomUUID(), supervise: true })).id);
}
async function prepare(s: Seed, b: HostBridge, payload: unknown = {}) {
  const id = await event(s, payload);
  const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === id)!;
  const refs = await b.prepareOutbox(lease); await b.ackOutbox(lease);
  const preparation = (await db.query('SELECT disposition,coalesced_into FROM supervisor_preparations WHERE event_id=$1', [id])).rows[0];
  return { refs, ref: refs[0]!, preparation };
}
const claim = (b: HostBridge, ref: RunRef) => b.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
const job = async (id: string) => (await db.query('SELECT state,result,workflow_id,resume_requested_at,runtime_snapshot FROM supervisor_jobs WHERE id=$1', [id])).rows[0];
const finishJob = (b: HostBridge, ref: RunRef) => b.transition({ type: 'halt', ref, reason: 'cancel_requested' });

describe('job phases, coalescing and the event ceiling', () => {
  it('shows a supervisor call as analyzing and coalesces noisy events into a job that has not read its context', async () => {
    const s = await seed(), b = bridge(s);
    const first = await prepare(s, b);
    expect(first.preparation).toEqual({ disposition: 'prepared', coalesced_into: null });
    const second = await prepare(s, b);
    expect(second.refs).toEqual([]);
    expect(second.preparation).toEqual({ disposition: 'coalesced', coalesced_into: first.ref.jobId });
    await claim(b, first.ref);
    expect((await job(first.ref.jobId)).state).toBe('analyzing');
    // Its call has started (context read), so the next event gets its own job.
    const later = await prepare(s, b);
    expect(later.preparation.disposition).toBe('prepared');
    // Explicit companion questions are never coalesced.
    const messageId = randomUUID();
    await db.query(`INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner','Synthetic question',$3)`, [messageId, s.enrollmentId, JSON.stringify({ episodeId: 'min' })]);
    const asked = await event(s, { messageId, episodeId: 'min', requestKind: 'question' }, 'companion.requested');
    const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === asked)!;
    expect(await b.prepareOutbox(lease)).toHaveLength(1);
  });
  it('never prepares a job for an event over the payload ceiling', async () => {
    const s = await seed(), b = bridge(s);
    const big = await prepare(s, b, { note: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) });
    expect(big.refs).toEqual([]); expect(big.preparation.disposition).toBe('oversized');
    expect((await prepare(s, b, { note: 'x'.repeat(1000) })).preparation.disposition).toBe('prepared');
  });
});

describe('per-day and per-artifact ceilings', () => {
  it('stops at the daily ceiling and names it, counting reservations of other jobs that day', async () => {
    const s = await seed(), b = bridge(s);
    await configureSupervisorPeriodBudget(db, s, { daily: { microUsd: 150, tokens: 10_000 } });
    const a = await prepare(s, b);
    expect((await claim(b, a.ref)).effect).toBe('invoke');
    await finishJob(b, a.ref).catch(() => undefined);
    const c = await prepare(s, b);
    const stopped = await claim(b, c.ref);
    expect(stopped.snapshot).toMatchObject({ state: 'budget_wait', reason: 'budget_exhausted' });
    expect((await job(c.ref.jobId)).result).toMatchObject({ reason: 'budget_exhausted', ceiling: 'daily' });
    // Yesterday's use does not count.
    await db.query("UPDATE supervisor_jobs SET created_at=clock_timestamp()-interval '2 days' WHERE id=$1", [a.ref.jobId]);
    const d = await prepare(s, b);
    expect((await claim(b, d.ref)).effect).toBe('invoke');
  });
  it('limits spend per artifact scope (episode) per day without blocking other episodes', async () => {
    const s = await seed(), b = bridge(s);
    await configureSupervisorPeriodBudget(db, s, { artifact: { microUsd: 150, tokens: 10_000 } });
    const a = await prepare(s, b);
    expect((await claim(b, a.ref)).effect).toBe('invoke');
    const same = await prepare(s, b);
    expect((await claim(b, same.ref)).snapshot.state).toBe('budget_wait');
    expect((await job(same.ref.jobId)).result.ceiling).toBe('artifact');
    await db.query("UPDATE enrollments SET current_episode_id='max' WHERE id=$1", [s.enrollmentId]);
    const other = await prepare(s, b);
    expect((await claim(b, other.ref)).effect).toBe('invoke');
    await configureSupervisorPeriodBudget(db, s, { artifact: null });
    expect((await db.query('SELECT artifact_limit_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [s.enrollmentId])).rows[0].artifact_limit_micro_usd).toBeNull();
  });
});

describe('reconciliation from gateway receipts', () => {
  async function uncertain(s: Seed, b: HostBridge) {
    const prepared = await prepare(s, b), claimed = await claim(b, prepared.ref), op = claimed.snapshot.operations[0]!;
    await b.transition({ type: 'settle', ref: prepared.ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'uncertain' } });
    return { ref: prepared.ref, op };
  }
  async function receipt(ref: RunRef, op: { id: string; ownerId: string }, state: 'completed' | 'not_started' | 'in_flight', outcome: unknown) {
    await db.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,outcome,finished_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7='in_flight' THEN NULL ELSE now() END)`,
      [op.id, ref.jobId, ref.enrollmentId, ref.workspaceId, op.ownerId, 'd'.repeat(64), state, outcome === null ? null : JSON.stringify(outcome)]);
  }
  it('settles a finished receipt, charges its real use and restarts the job in a new generation once', async () => {
    const s = await seed(), b = bridge(s), { ref, op } = await uncertain(s, b);
    expect((await job(ref.jobId)).state).toBe('waiting');
    // A dispatch still running proves nothing.
    const running = await uncertain(s, b);
    await receipt(running.ref, running.op, 'in_flight', null);
    const artifact = await storeSupervisorArtifact(db, ref, op.id, op.ownerId, { kind: 'proposed_adaptation', summary: 'Offer one more synthetic practice example.' });
    await receipt(ref, op, 'completed', { status: 'succeeded', artifact, usage: { microUsd: 30, tokens: 40 } });
    const result = await b.reconcile(10);
    expect(result).toEqual({ settled: 1, resume: [{ ...ref, generation: 2 }] });
    const row = await job(ref.jobId);
    expect(row.runtime_snapshot).toMatchObject({ generation: 2, state: 'queued', operations: [{ status: 'succeeded' }] });
    expect(row.workflow_id).toBe(`supervisor-v1/${ref.workspaceId}/${ref.jobId}/2`);
    expect(row.resume_requested_at).not.toBeNull();
    expect((await db.query('SELECT micro_usd,tokens FROM supervisor_job_spend WHERE job_id=$1', [ref.jobId])).rows[0]).toEqual({ micro_usd: '30', tokens: '40' });
    expect((await db.query('SELECT outcome_status,resumed_generation FROM supervisor_reconciliations WHERE operation_id=$1', [op.id])).rows[0])
      .toEqual({ outcome_status: 'succeeded', resumed_generation: 2 });
    // Nothing to do again; the old generation is fenced out; the new workflow's load clears the restart mark.
    expect(await b.reconcile(10)).toEqual({ settled: 0, resume: [] });
    await expect(b.load(ref)).rejects.toMatchObject({ code: 'SUPERVISOR_STALE_GENERATION' });
    const next = { ...ref, generation: 2 };
    await b.load(next);
    expect((await job(ref.jobId)).resume_requested_at).toBeNull();
    expect((await claim(b, next)).effect).toBe('continue');
  });
  it('releases a cancelled job\'s reservation from a definite non-start, without restarting it', async () => {
    const s = await seed(), b = bridge(s), { ref, op } = await uncertain(s, b);
    await b.transition({ type: 'halt', ref, reason: 'cancel_requested' });
    expect((await db.query('SELECT micro_usd FROM supervisor_job_spend WHERE job_id=$1', [ref.jobId])).rows[0].micro_usd).toBe('100');
    await receipt(ref, op, 'not_started', { status: 'not_started', retryable: false });
    expect(await b.reconcile(10)).toEqual({ settled: 1, resume: [] });
    expect((await db.query('SELECT micro_usd FROM supervisor_job_spend WHERE job_id=$1', [ref.jobId])).rows[0].micro_usd).toBe('0');
    expect((await job(ref.jobId)).state).toBe('cancelled');
  });
  it('never settles a receipt for another owner of the operation', async () => {
    const s = await seed(), b = bridge(s), { ref, op } = await uncertain(s, b);
    await receipt(ref, { id: op.id, ownerId: randomUUID() }, 'not_started', { status: 'not_started', retryable: false });
    expect(await b.reconcile(10)).toEqual({ settled: 0, resume: [] });
    expect((await job(ref.jobId)).runtime_snapshot.operations[0].status).toBe('uncertain');
  });
});

describe('parked jobs', () => {
  it('waits for input or a due follow-up, then resumes in a new generation', async () => {
    const s = await seed(), b = bridge(s), a = await prepare(s, b);
    expect((await parkSupervisorJob(db, a.ref, 'needs_input')).snapshot).toMatchObject({ state: 'needs_input', reason: 'input_required' });
    expect(await b.reconcile(10)).toEqual({ settled: 0, resume: [] });
    expect(await resumeSupervisorJob(db, a.ref)).toEqual({ ...a.ref, generation: 2 });
    expect((await job(a.ref.jobId)).state).toBe('queued');
    // A stopped job never resumes (and a queued one would absorb the next noisy event).
    await finishJob(b, { ...a.ref, generation: 2 });
    expect(await resumeSupervisorJob(db, { ...a.ref, generation: 2 })).toBeNull();
    const f = await prepare(s, b);
    await parkSupervisorJob(db, f.ref, 'follow_up_due', { dueAtMs: Date.now() + 30_000 });
    expect((await b.reconcile(10)).resume).not.toContainEqual(expect.objectContaining({ jobId: f.ref.jobId }));
    await db.query("UPDATE supervisor_jobs SET runtime_snapshot=jsonb_set(runtime_snapshot,'{dueAtMs}',to_jsonb((extract(epoch FROM clock_timestamp())*1000)::bigint-1000)) WHERE id=$1", [f.ref.jobId]);
    expect((await b.reconcile(10)).resume).toContainEqual({ ...f.ref, generation: 2 });
  });
});
