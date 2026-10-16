import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';

/**
 * Transfer-check outcome records for delivered generated teaching. One row per objective the
 * teaching addressed; it resolves from the learner's first independent attempt on an item of
 * that objective after delivery (passed or failed; an "I don't know yet" is skipped, since it
 * gives no answer), or expires unresolved. A written answer awaiting review is not a wrong
 * answer: the record stays pending until its review decides, then takes that outcome. It is an
 * outcome record for staff and the supervisor, never evidence and never a grade.
 */
export type TransferStatus = 'pending' | 'passed' | 'failed' | 'expired';
export const TRANSFER_WINDOW_DAYS = 30;
export async function recordTransferChecks(client: PoolClient, enrollmentId: string, workspaceId: string, proposalId: string, objectiveIds: readonly string[]) {
  for (const objectiveId of [...new Set(objectiveIds)].sort())
    await client.query(`INSERT INTO adaptation_transfer_checks(enrollment_id,workspace_id,proposal_id,objective_id) VALUES($1,$2,$3,$4)
      ON CONFLICT (enrollment_id,proposal_id,objective_id) DO NOTHING`, [enrollmentId, workspaceId, proposalId, objectiveId]);
}
type Outcome = { status: 'passed' | 'failed'; attemptId: string; resolvedAt: Date };
/** The decided outcome of a reviewed written answer, or null while no decision exists yet. A
 * request for clarification decides nothing: the learner's reply carries the conversation and
 * its review decides. A decision changed on appeal replaces the original. */
async function reviewedOutcome(client: PoolClient, enrollmentId: string, attemptId: string): Promise<Outcome | null> {
  let id: string | null = attemptId;
  for (let turn = 0; id && turn <= 20; turn++) {
    const row: { decision: string | null; decided_at: Date | null; reply_id: string | null } | undefined = (await client.query(
      `SELECT COALESCE(p.decision,v.decision) AS decision,COALESCE(p.decided_at,v.created_at) AS decided_at,
         (SELECT r.id FROM attempts r WHERE r.continues_attempt_id=a.id AND r.enrollment_id=a.enrollment_id ORDER BY r.submitted_at,r.id LIMIT 1) AS reply_id
       FROM attempts a LEFT JOIN rubric_reviews v ON v.attempt_id=a.id
       LEFT JOIN rubric_appeals p ON p.attempt_id=a.id AND p.state='changed'
       WHERE a.id=$1 AND a.enrollment_id=$2`, [id, enrollmentId])).rows[0];
    if (!row) return null;
    if (row.decision === 'met' || row.decision === 'not_met') return { status: row.decision === 'met' ? 'passed' : 'failed', attemptId: id, resolvedAt: row.decided_at! };
    id = row.decision === 'needs_clarification' ? row.reply_id : null;
  }
  return null;
}
/** Every check, with pending ones resolved from recorded independent attempts. With `persist`
 * (inside a write transaction) the resolution is stored; read-only views derive the same result. */
export async function transferChecks(client: PoolClient, enrollmentId: string, course: CourseManifest, persist = false) {
  const rows = (await client.query<{ proposal_id: string; objective_id: string; status: TransferStatus; delivered_at: Date; resolved_at: Date | null; attempt_id: string | null; expired: boolean }>(
    `SELECT proposal_id,objective_id,status,delivered_at,resolved_at,attempt_id,delivered_at<clock_timestamp()-($2 * interval '1 day') AS expired
     FROM adaptation_transfer_checks WHERE enrollment_id=$1 ORDER BY delivered_at,proposal_id,objective_id${persist ? ' FOR UPDATE' : ''}`,
    [enrollmentId, TRANSFER_WINDOW_DAYS])).rows;
  const result = [];
  for (const row of rows) {
    let status = row.status, resolvedAt = row.resolved_at, attemptId: string | null = row.attempt_id;
    if (status === 'pending') {
      const items = course.assessments.filter(a => a.objectiveIds.includes(row.objective_id)).map(a => a.id);
      // A reply to a reviewer's clarification request continues an earlier answer; it is not a new attempt.
      const attempt = items.length ? (await client.query<{ id: string; passed: boolean | null; pending_review: boolean; submitted_at: Date }>(
        `SELECT id,(result->>'passed')::boolean AS passed,result->>'status' IS NOT DISTINCT FROM 'pending_review' AS pending_review,submitted_at
         FROM attempts WHERE enrollment_id=$1 AND assessment_id=ANY($2::text[])
         AND mode='independent' AND submitted_at>$3 AND continues_attempt_id IS NULL
         -- "I don't know yet" gives no answer, so it neither passes nor fails the transfer check.
         AND result->'abstained' IS DISTINCT FROM 'true'::jsonb ORDER BY submitted_at,id LIMIT 1`, [enrollmentId, items, row.delivered_at])).rows[0] : undefined;
      // A written answer awaiting review stays pending (and does not expire) until a reviewer decides.
      const outcome: Outcome | null = !attempt ? null : attempt.pending_review ? await reviewedOutcome(client, enrollmentId, attempt.id)
        : { status: attempt.passed === true ? 'passed' : 'failed', attemptId: attempt.id, resolvedAt: attempt.submitted_at };
      if (outcome) ({ status, attemptId, resolvedAt } = outcome);
      else if (!attempt && row.expired) { status = 'expired'; resolvedAt = new Date(); }
      if (persist && status !== 'pending') await client.query(`UPDATE adaptation_transfer_checks SET status=$4,attempt_id=$5,resolved_at=clock_timestamp()
        WHERE enrollment_id=$1 AND proposal_id=$2 AND objective_id=$3 AND status='pending'`, [enrollmentId, row.proposal_id, row.objective_id, status, attemptId]);
    }
    result.push({ proposalId: row.proposal_id, objectiveId: row.objective_id, status, deliveredAt: row.delivered_at.toISOString(), resolvedAt: resolvedAt?.toISOString() ?? null, attemptId });
  }
  return result;
}
