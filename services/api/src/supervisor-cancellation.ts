import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { cancellationDeliverySchema, runRefSchema, uuid, type CancellationDelivery, type CancellationReason, type RunRef } from '@course-core/supervisor';
import { transaction, type Database } from './database.js';

const TERMINAL = "('applied','cancelled','failed')";
/** Jobs named in one delivery row; larger sets are split across rows. */
const MAX_JOBS_PER_DELIVERY = 64;
const MAX_DELIVERY_ATTEMPTS = 8;

export interface CancellationScope { workspaceId: string; enrollmentId?: string | undefined;
  /** Only these jobs (a learner stopping one reply); omitted: every live job in scope. */
  jobIds?: readonly string[] | undefined }
export interface CancellationRequest {
  /** Non-terminal jobs in scope, including ones whose cancellation was already recorded. */
  live: number;
  /** Jobs this call newly marked. */
  newlyCancelled: number;
}

/**
 * Records a host cancellation of every live supervisor job in scope and queues the Temporal
 * signals that stop work already under way, inside the caller's transaction. The flag is
 * authoritative: every bridge step of a flagged job stops it before any provider call, and the
 * dispatcher's reconciliation halts flagged jobs that have no workflow to take that step. The
 * signal only makes a running call, retry wait or hold end now instead of at its next step.
 * Takes job row locks only, the same locks the plain flag update took before.
 */
export async function requestSupervisorCancellation(client: PoolClient, scope: CancellationScope, reason: CancellationReason): Promise<CancellationRequest> {
  const workspaceId = uuid.parse(scope.workspaceId), enrollmentId = scope.enrollmentId === undefined ? null : uuid.parse(scope.enrollmentId);
  const live = (await client.query<{ id: string; enrollment_id: string; generation: number | null; flagged: boolean }>(
    `SELECT id,enrollment_id,(runtime_snapshot->>'generation')::integer AS generation,cancellation_requested AS flagged FROM supervisor_jobs
     WHERE workspace_id=$1 AND ($2::uuid IS NULL OR enrollment_id=$2) AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])) AND state NOT IN ${TERMINAL} ORDER BY enrollment_id,id FOR UPDATE`,
    [workspaceId, enrollmentId, scope.jobIds ? scope.jobIds.map(id => uuid.parse(id)) : null])).rows;
  const fresh = live.filter(j => !j.flagged);
  if (fresh.length) await client.query('UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=ANY($1::uuid[])', [fresh.map(j => j.id)]);
  // Signal every live job with a workflow, also ones flagged earlier: their signal may have been lost.
  const byEnrollment = new Map<string, RunRef[]>();
  for (const job of live) if (job.generation !== null) {
    const refs = byEnrollment.get(job.enrollment_id) ?? [];
    refs.push(runRefSchema.parse({ jobId: job.id, workspaceId, enrollmentId: job.enrollment_id, generation: job.generation }));
    byEnrollment.set(job.enrollment_id, refs);
  }
  for (const [enrollment, refs] of byEnrollment) for (let i = 0; i < refs.length; i += MAX_JOBS_PER_DELIVERY) {
    await client.query('INSERT INTO supervisor_job_cancellations(id,enrollment_id,workspace_id,reason,jobs) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), enrollment, workspaceId, reason, JSON.stringify(refs.slice(i, i + MAX_JOBS_PER_DELIVERY))]);
  }
  return { live: live.length, newlyCancelled: fresh.length };
}

/** Bridge RPC `cancel.claim`: leases undelivered cancellations in the authorized workspaces. */
export async function claimCancellationDeliveries(db: Database, workspaces: readonly string[], ownerId: string, limit: number, leaseMs: number): Promise<CancellationDelivery[]> {
  uuid.parse(ownerId);
  return transaction(db, async client => {
    const rows = (await client.query<{ id: string; enrollment_id: string; workspace_id: string; reason: CancellationReason; jobs: unknown; attempts: number }>(
      `SELECT id,enrollment_id,workspace_id,reason,jobs,attempts FROM supervisor_job_cancellations
       WHERE workspace_id=ANY($1::uuid[]) AND delivered_at IS NULL AND abandoned_at IS NULL
         AND (claimed_until IS NULL OR claimed_until<=clock_timestamp())
       ORDER BY created_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, [workspaces, limit])).rows;
    const result: CancellationDelivery[] = [];
    for (const row of rows) {
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        // Only the wake-up is lost: the stored flag still stops each job at its next step.
        await client.query('UPDATE supervisor_job_cancellations SET abandoned_at=clock_timestamp(),lease_token=NULL,claimed_until=NULL WHERE id=$1', [row.id]);
        continue;
      }
      const leaseToken = randomUUID();
      result.push(cancellationDeliverySchema.parse({ cancellationId: row.id, leaseToken, attempts: row.attempts + 1, workspaceId: row.workspace_id,
        enrollmentId: row.enrollment_id, reason: row.reason, jobs: row.jobs }));
      await client.query(`UPDATE supervisor_job_cancellations SET attempts=attempts+1,lease_token=$2,
        claimed_until=clock_timestamp()+($3 * interval '1 millisecond') WHERE id=$1`, [row.id, leaseToken, leaseMs]);
    }
    return result;
  });
}
/** Bridge RPC `cancel.ack`. A failed delivery is retried after a bounded backoff. */
export async function ackCancellationDelivery(db: Database, workspaces: readonly string[], cancellationId: string, leaseToken: string, delivered: boolean): Promise<boolean> {
  const result = await db.query(`UPDATE supervisor_job_cancellations SET lease_token=NULL,
      delivered_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
      claimed_until=CASE WHEN $3 THEN NULL ELSE clock_timestamp()+(least(60000,1000*power(2,attempts)) * interval '1 millisecond') END
    WHERE id=$1 AND lease_token=$2 AND workspace_id=ANY($4::uuid[]) AND claimed_until>clock_timestamp()
      AND delivered_at IS NULL AND abandoned_at IS NULL`, [uuid.parse(cancellationId), uuid.parse(leaseToken), delivered, workspaces]);
  return result.rowCount === 1;
}
