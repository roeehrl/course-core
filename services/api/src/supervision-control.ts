import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  controlDeliverySchema, runRefSchema, supervisionStateSchema, uuid,
  type ControlDelivery, type RunRef, type SupervisionState,
} from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';

/**
 * Staff pause, stop and resume of one enrollment's AI supervision. The stored row is
 * authoritative for every supervisor-runtime role and for host-owned paid work; the change log
 * is also the queue of Temporal wake-up signals that the supervisor dispatcher delivers.
 * Callers authorize the staff actor; this module never decides who may control supervision.
 */
export type SupervisionAction = 'pause' | 'stop' | 'resume';
const TARGET: Record<SupervisionAction, SupervisionState> = { pause: 'paused', stop: 'stopped', resume: 'active' };
const TERMINAL = "('applied','cancelled','failed')";
/** Live jobs named in one change's wake-up signal. A larger backlog still obeys the stored state. */
const MAX_SIGNALLED_JOBS = 64;
const MAX_DELIVERY_ATTEMPTS = 8;
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const inputSchema = z.strictObject({
  workspaceId: uuid, enrollmentId: uuid, action: z.enum(['pause', 'stop', 'resume']),
  actorId: uuid.optional(), reasonCode: code.optional(),
  idempotencyKey: z.string().min(8).max(200),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export type SupervisionControlInput = z.input<typeof inputSchema>;
export interface SupervisionControl {
  state: SupervisionState; revision: number; reasonCode: string | null; changedBy: string | null; changedAt: string | null;
}
export interface SupervisionControlResult {
  state: SupervisionState; previousState: SupervisionState; revision: number;
  changed: boolean; replayed: boolean; cancelledJobs: number; signalledJobs: number;
}
interface ControlRow { state: SupervisionState; revision: number; reason_code: string | null; changed_by: string | null; changed_at: Date | null }
const ACTIVE: SupervisionControl = { state: 'active', revision: 0, reasonCode: null, changedBy: null, changedAt: null };
function view(row: ControlRow | undefined): SupervisionControl {
  return row ? { state: supervisionStateSchema.parse(row.state), revision: row.revision, reasonCode: row.reason_code,
    changedBy: row.changed_by, changedAt: row.changed_at?.toISOString() ?? null } : ACTIVE;
}

/** The control in force. Inside a transaction that holds the enrollment lock, `lock` keeps it
 * stable until commit (share lock; a change takes the row exclusively after the same enrollment lock). */
export async function supervisionStateWithin(client: PoolClient, enrollmentId: string, lock = true): Promise<SupervisionState> {
  const row = (await client.query<{ state: SupervisionState }>(
    `SELECT state FROM supervisor_controls WHERE enrollment_id=$1${lock ? ' FOR SHARE' : ''}`, [enrollmentId])).rows[0];
  return row?.state ?? 'active';
}
export async function readSupervisionControl(db: Database | PoolClient, enrollmentId: string): Promise<SupervisionControl> {
  const row = (await db.query<ControlRow>('SELECT state,revision,reason_code,changed_by,changed_at FROM supervisor_controls WHERE enrollment_id=$1',
    [uuid.parse(enrollmentId)])).rows[0];
  return view(row);
}

/** Changes the control inside the caller's transaction. Locks the enrollment first, the same order
 * the supervisor bridge uses, so a change and a job transition serialize. */
export async function setSupervisionControl(client: PoolClient, raw: SupervisionControlInput): Promise<SupervisionControlResult> {
  const parsed = inputSchema.safeParse(raw);
  requireCondition(parsed.success, 'INVALID_INPUT', 400);
  const input = parsed.data;
  const enrollment = await client.query('SELECT 1 FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [input.enrollmentId, input.workspaceId]);
  requireCondition(enrollment.rowCount === 1, 'SUPERVISOR_NOT_FOUND', 404);
  const prior = (await client.query<{ action: SupervisionAction; from_state: SupervisionState; to_state: SupervisionState; revision: number; jobs: unknown[] }>(
    'SELECT action,from_state,to_state,revision,jobs FROM supervisor_control_changes WHERE enrollment_id=$1 AND idempotency_key=$2',
    [input.enrollmentId, input.idempotencyKey])).rows[0];
  if (prior) {
    requireCondition(prior.action === input.action, 'IDEMPOTENCY_CONFLICT', 409);
    return { state: prior.to_state, previousState: prior.from_state, revision: prior.revision, changed: true, replayed: true,
      cancelledJobs: prior.action === 'stop' ? prior.jobs.length : 0, signalledJobs: prior.jobs.length };
  }
  const current = view((await client.query<ControlRow>(
    'SELECT state,revision,reason_code,changed_by,changed_at FROM supervisor_controls WHERE enrollment_id=$1 FOR UPDATE', [input.enrollmentId])).rows[0]);
  requireCondition(input.expectedRevision === undefined || input.expectedRevision === current.revision, 'SUPERVISION_CONTROL_STALE', 409);
  // A stop is undone only by an explicit resume, never silently weakened to a pause.
  requireCondition(!(current.state === 'stopped' && input.action === 'pause'), 'SUPERVISION_CONTROL_INVALID', 409);
  const target = TARGET[input.action];
  if (target === current.state)
    return { state: current.state, previousState: current.state, revision: current.revision, changed: false, replayed: false, cancelledJobs: 0, signalledJobs: 0 };
  const live = (await client.query<{ id: string; generation: number }>(
    `SELECT id,(runtime_snapshot->>'generation')::integer AS generation FROM supervisor_jobs
     WHERE enrollment_id=$1 AND workspace_id=$2 AND runtime_snapshot IS NOT NULL AND state NOT IN ${TERMINAL}
     ORDER BY created_at DESC,id LIMIT ${MAX_SIGNALLED_JOBS} FOR UPDATE`, [input.enrollmentId, input.workspaceId])).rows;
  const jobs: RunRef[] = live.map(j => runRefSchema.parse({ jobId: j.id, workspaceId: input.workspaceId, enrollmentId: input.enrollmentId, generation: j.generation }));
  let cancelledJobs = 0;
  if (input.action === 'stop') {
    // Every live job, not only the signalled ones: the bridge ends each at its next transition.
    cancelledJobs = (await client.query(`UPDATE supervisor_jobs SET cancellation_requested=true
      WHERE enrollment_id=$1 AND workspace_id=$2 AND state NOT IN ${TERMINAL} AND NOT cancellation_requested`,
      [input.enrollmentId, input.workspaceId])).rowCount ?? 0;
  }
  const revision = current.revision + 1;
  await client.query(`INSERT INTO supervisor_controls(enrollment_id,workspace_id,state,revision,reason_code,changed_by,changed_at)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())
    ON CONFLICT(enrollment_id) DO UPDATE SET state=EXCLUDED.state,revision=EXCLUDED.revision,reason_code=EXCLUDED.reason_code,
      changed_by=EXCLUDED.changed_by,changed_at=EXCLUDED.changed_at`,
    [input.enrollmentId, input.workspaceId, target, revision, input.reasonCode ?? null, input.actorId ?? null]);
  await client.query(`INSERT INTO supervisor_control_changes(id,enrollment_id,workspace_id,revision,action,from_state,to_state,reason_code,actor_id,idempotency_key,jobs)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), input.enrollmentId, input.workspaceId, revision, input.action,
    current.state, target, input.reasonCode ?? null, input.actorId ?? null, input.idempotencyKey, JSON.stringify(jobs)]);
  await appendEvent(client, { workspaceId: input.workspaceId, enrollmentId: input.enrollmentId, ...(input.actorId ? { actorId: input.actorId } : {}),
    actorKind: input.actorId ? 'staff' : 'system', type: 'supervision.control_changed',
    payload: { state: target, previousState: current.state, revision, reasonCode: input.reasonCode ?? null },
    idempotencyKey: `supervision-control:${input.enrollmentId}:${revision}`, supervise: false });
  return { state: target, previousState: current.state, revision, changed: true, replayed: false, cancelledJobs, signalledJobs: jobs.length };
}

/** For a staff supervision view: the control, the enrollment's live jobs and undelivered wake-ups. */
export async function supervisionOverview(db: Database, workspaceId: string, enrollmentId: string) {
  const ids = [uuid.parse(enrollmentId), uuid.parse(workspaceId)];
  return transaction(db, async client => {
    const exists = await client.query('SELECT 1 FROM enrollments WHERE id=$1 AND workspace_id=$2', ids);
    requireCondition(exists.rowCount === 1, 'SUPERVISOR_NOT_FOUND', 404);
    const control = await readSupervisionControl(client, enrollmentId);
    const jobs = (await client.query<{ id: string; role: string; state: string; reason: string | null; cancellationRequested: boolean; createdAt: Date }>(
      `SELECT id,role,state,runtime_snapshot->>'reason' AS reason,cancellation_requested AS "cancellationRequested",created_at AS "createdAt"
       FROM supervisor_jobs WHERE enrollment_id=$1 AND workspace_id=$2 AND state NOT IN ${TERMINAL} ORDER BY created_at DESC,id LIMIT 100`, ids)).rows;
    const pending = (await client.query<{ count: number }>(`SELECT count(*)::integer AS count FROM supervisor_control_changes
      WHERE enrollment_id=$1 AND workspace_id=$2 AND delivered_at IS NULL AND abandoned_at IS NULL`, ids)).rows[0]!.count;
    // Requests that never reached a job: refused on a permanent conflict, or quarantined by the
    // dispatcher after bounded retries. Withdrawn questions and erasure (no code) are not failures.
    const undelivered = (await client.query<{ eventId: string; eventType: string; outcome: 'refused' | 'quarantined'; reason: string; at: Date }>(
      `SELECT * FROM (
         SELECT p.event_id AS "eventId",e.event_type AS "eventType",'refused' AS outcome,p.reason_code AS reason,p.created_at AS at
           FROM supervisor_preparations p JOIN learning_events e ON e.id=p.event_id
          WHERE p.enrollment_id=$1 AND p.workspace_id=$2 AND p.disposition='refused'
         UNION ALL
         SELECT o.event_id,e.event_type,'quarantined',o.last_error_code,o.quarantined_at
           FROM outbox o JOIN learning_events e ON e.id=o.event_id
          WHERE o.payload->>'enrollmentId'=$1::uuid::text AND e.enrollment_id=$1 AND e.workspace_id=$2 AND o.kind='supervisor.event'
            AND o.quarantined_at IS NOT NULL AND o.last_error_code IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM supervisor_preparations r WHERE r.event_id=o.event_id AND r.disposition='refused')
       ) u ORDER BY at DESC,"eventId" LIMIT 20`, ids)).rows;
    return { control, pendingSignals: pending,
      undeliveredEvents: undelivered.map(u => ({ ...u, at: u.at.toISOString() })),
      jobs: jobs.map(j => ({ ...j, createdAt: j.createdAt.toISOString(), held: control.state === 'paused' && !j.cancellationRequested })) };
  });
}

/** Bridge RPC `control.claim`: leases undelivered changes in the authorized workspaces. */
export async function claimControlDeliveries(db: Database, workspaces: readonly string[], ownerId: string, limit: number, leaseMs: number): Promise<ControlDelivery[]> {
  uuid.parse(ownerId);
  return transaction(db, async client => {
    const rows = (await client.query<{ id: string; enrollment_id: string; workspace_id: string; revision: number; to_state: SupervisionState; jobs: unknown; attempts: number }>(
      `SELECT id,enrollment_id,workspace_id,revision,to_state,jobs,attempts FROM supervisor_control_changes
       WHERE workspace_id=ANY($1::uuid[]) AND delivered_at IS NULL AND abandoned_at IS NULL
         AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
       ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, [workspaces, limit])).rows;
    const result: ControlDelivery[] = [];
    for (const row of rows) {
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        // Only the wake-up is lost: held workflows still poll the stored control.
        await client.query('UPDATE supervisor_control_changes SET abandoned_at=clock_timestamp(),lease_token=NULL,claimed_until=NULL WHERE id=$1', [row.id]);
        continue;
      }
      const leaseToken = randomUUID();
      const delivery = controlDeliverySchema.parse({ changeId: row.id, leaseToken, attempts: row.attempts + 1, workspaceId: row.workspace_id,
        signal: { schemaVersion: 1, enrollmentId: row.enrollment_id, state: row.to_state, revision: row.revision }, jobs: row.jobs });
      await client.query(`UPDATE supervisor_control_changes SET attempts=attempts+1,lease_token=$2,
        claimed_until=clock_timestamp()+($3 * interval '1 millisecond') WHERE id=$1`, [row.id, leaseToken, leaseMs]);
      result.push(delivery);
    }
    return result;
  });
}
/** Bridge RPC `control.ack`. A failed delivery is retried after a bounded backoff. */
export async function ackControlDelivery(db: Database, workspaces: readonly string[], changeId: string, leaseToken: string, delivered: boolean): Promise<boolean> {
  const result = await db.query(`UPDATE supervisor_control_changes SET lease_token=NULL,
      delivered_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
      claimed_until=CASE WHEN $3 THEN NULL ELSE clock_timestamp()+(least(60000,1000*power(2,attempts)) * interval '1 millisecond') END
    WHERE id=$1 AND lease_token=$2 AND workspace_id=ANY($4::uuid[]) AND claimed_until>clock_timestamp()
      AND delivered_at IS NULL AND abandoned_at IS NULL`, [uuid.parse(changeId), uuid.parse(leaseToken), delivered, workspaces]);
  return result.rowCount === 1;
}
