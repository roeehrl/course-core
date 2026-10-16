import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';

/**
 * Transfer-check outcome records for delivered generated teaching. One row per objective the
 * teaching addressed; it resolves from the learner's first independent attempt on an item of
 * that objective after delivery (passed or failed; an "I don't know yet" is skipped, since it
 * gives no answer), or expires unresolved. It is an outcome record for staff and the
 * supervisor, never evidence and never a grade.
 */
export type TransferStatus = 'pending' | 'passed' | 'failed' | 'expired';
export const TRANSFER_WINDOW_DAYS = 30;
export async function recordTransferChecks(client: PoolClient, enrollmentId: string, workspaceId: string, proposalId: string, objectiveIds: readonly string[]) {
  for (const objectiveId of [...new Set(objectiveIds)].sort())
    await client.query(`INSERT INTO adaptation_transfer_checks(enrollment_id,workspace_id,proposal_id,objective_id) VALUES($1,$2,$3,$4)
      ON CONFLICT (enrollment_id,proposal_id,objective_id) DO NOTHING`, [enrollmentId, workspaceId, proposalId, objectiveId]);
}
/** Every check, with pending ones resolved from recorded independent attempts. With `persist`
 * (inside a write transaction) the resolution is stored; read-only views derive the same result. */
export async function transferChecks(client: PoolClient, enrollmentId: string, course: CourseManifest, persist = false) {
  const rows = (await client.query<{ proposal_id: string; objective_id: string; status: TransferStatus; delivered_at: Date; resolved_at: Date | null; expired: boolean }>(
    `SELECT proposal_id,objective_id,status,delivered_at,resolved_at,delivered_at<clock_timestamp()-($2 * interval '1 day') AS expired
     FROM adaptation_transfer_checks WHERE enrollment_id=$1 ORDER BY delivered_at,proposal_id,objective_id${persist ? ' FOR UPDATE' : ''}`,
    [enrollmentId, TRANSFER_WINDOW_DAYS])).rows;
  const result = [];
  for (const row of rows) {
    let status = row.status, resolvedAt = row.resolved_at, attemptId: string | null = null;
    if (status === 'pending') {
      const items = course.assessments.filter(a => a.objectiveIds.includes(row.objective_id)).map(a => a.id);
      const attempt = items.length ? (await client.query<{ id: string; passed: boolean | null; submitted_at: Date }>(
        `SELECT id,(result->>'passed')::boolean AS passed,submitted_at FROM attempts WHERE enrollment_id=$1 AND assessment_id=ANY($2::text[])
         AND mode='independent' AND submitted_at>$3
         -- "I don't know yet" gives no answer, so it neither passes nor fails the transfer check.
         AND result->'abstained' IS DISTINCT FROM 'true'::jsonb ORDER BY submitted_at,id LIMIT 1`, [enrollmentId, items, row.delivered_at])).rows[0] : undefined;
      if (attempt) { status = attempt.passed === true ? 'passed' : 'failed'; attemptId = attempt.id; resolvedAt = attempt.submitted_at; }
      else if (row.expired) { status = 'expired'; resolvedAt = new Date(); }
      if (persist && status !== 'pending') await client.query(`UPDATE adaptation_transfer_checks SET status=$4,attempt_id=$5,resolved_at=clock_timestamp()
        WHERE enrollment_id=$1 AND proposal_id=$2 AND objective_id=$3 AND status='pending'`, [enrollmentId, row.proposal_id, row.objective_id, status, attemptId]);
    }
    result.push({ proposalId: row.proposal_id, objectiveId: row.objective_id, status, deliveredAt: row.delivered_at.toISOString(), resolvedAt: resolvedAt?.toISOString() ?? null });
  }
  return result;
}
