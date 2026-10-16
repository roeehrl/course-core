import type { PoolClient } from 'pg';
import type { CourseManifest } from '@course-core/sdk';
import { appendEvent } from './events.js';
import { INDEPENDENT_CHECK_SQL } from './independence.js';

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
/** The decided outcome of a reviewed written answer; 'awaiting' while no decision exists yet, or
 * 'assisted' when the conversation stopped being independent work. A request for clarification
 * decides nothing: the learner's reply carries the conversation and its review decides, but only
 * while that reply is itself independent. A decision changed on appeal replaces the original. */
async function reviewedOutcome(client: PoolClient, enrollmentId: string, attemptId: string): Promise<Outcome | 'awaiting' | 'assisted'> {
  let id: string | null = attemptId;
  for (let turn = 0; id && turn <= 20; turn++) {
    const row: { decision: string | null; decided_at: Date | null; reply_id: string | null; reply_independent: boolean | null } | undefined = (await client.query(
      `SELECT COALESCE(p.decision,v.decision) AS decision,COALESCE(p.decided_at,v.created_at) AS decided_at,r.id AS reply_id,
         ${INDEPENDENT_CHECK_SQL('rc')} AS reply_independent
       FROM attempts a LEFT JOIN rubric_reviews v ON v.attempt_id=a.id
       LEFT JOIN rubric_appeals p ON p.attempt_id=a.id AND p.state='changed'
       LEFT JOIN LATERAL (SELECT r.id FROM attempts r WHERE r.continues_attempt_id=a.id AND r.enrollment_id=a.enrollment_id ORDER BY r.submitted_at,r.id LIMIT 1) r ON true
       LEFT JOIN assessment_challenges rc ON rc.attempt_id=r.id AND rc.enrollment_id=a.enrollment_id
       WHERE a.id=$1 AND a.enrollment_id=$2`, [id, enrollmentId])).rows[0];
    if (!row) return 'awaiting';
    if (row.decision === 'met' || row.decision === 'not_met') return { status: row.decision === 'met' ? 'passed' : 'failed', attemptId: id, resolvedAt: row.decided_at! };
    if (row.decision !== 'needs_clarification' || !row.reply_id) return 'awaiting';
    if (row.reply_independent !== true) return 'assisted';
    id = row.reply_id;
  }
  return 'awaiting';
}
/** Every check, with pending ones resolved from recorded independent attempts. With `persist`
 * (inside a write transaction) the resolution is stored; read-only views derive the same result.
 * A stored resolution is never rewritten: when an appeal later changes the review it came from,
 * the amendment is kept beside it (amendTransferChecksForAppeal) and `status` reports the
 * amended outcome, with `amendedFrom` naming the original. */
export async function transferChecks(client: PoolClient, enrollmentId: string, course: CourseManifest, persist = false) {
  const rows = (await client.query<{ proposal_id: string; objective_id: string; status: TransferStatus; delivered_at: Date; resolved_at: Date | null; attempt_id: string | null; expired: boolean;
    amended_status: 'passed' | 'failed' | null; amended_at: Date | null }>(
    `SELECT proposal_id,objective_id,status,delivered_at,resolved_at,attempt_id,delivered_at<clock_timestamp()-($2 * interval '1 day') AS expired,amended_status,amended_at
     FROM adaptation_transfer_checks WHERE enrollment_id=$1 ORDER BY delivered_at,proposal_id,objective_id${persist ? ' FOR UPDATE' : ''}`,
    [enrollmentId, TRANSFER_WINDOW_DAYS])).rows;
  const result = [];
  for (const row of rows) {
    let status = row.status, resolvedAt = row.resolved_at, attemptId: string | null = row.attempt_id;
    if (status === 'pending') {
      const items = course.assessments.filter(a => a.objectiveIds.includes(row.objective_id)).map(a => a.id);
      // Only independent work counts: the check it answered was issued independent-eligible and
      // stayed unassisted. A reply to a reviewer's clarification request continues an earlier
      // answer; it is not a new attempt.
      const attempts = items.length ? (await client.query<{ id: string; passed: boolean | null; pending_review: boolean; submitted_at: Date }>(
        `SELECT a.id,(a.result->>'passed')::boolean AS passed,a.result->>'status' IS NOT DISTINCT FROM 'pending_review' AS pending_review,a.submitted_at
         FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id
         WHERE a.enrollment_id=$1 AND a.assessment_id=ANY($2::text[])
         AND a.mode='independent' AND ${INDEPENDENT_CHECK_SQL('c')} AND a.submitted_at>$3 AND a.continues_attempt_id IS NULL
         -- "I don't know yet" gives no answer, so it neither passes nor fails the transfer check.
         AND a.result->'abstained' IS DISTINCT FROM 'true'::jsonb ORDER BY a.submitted_at,a.id LIMIT 50`, [enrollmentId, items, row.delivered_at])).rows : [];
      // A written answer awaiting review stays pending (and does not expire) until a reviewer
      // decides; a conversation that became assisted is passed over for the next attempt.
      let outcome: Outcome | 'awaiting' | null = null;
      for (const attempt of attempts) {
        const found = attempt.pending_review ? await reviewedOutcome(client, enrollmentId, attempt.id)
          : { status: attempt.passed === true ? 'passed' as const : 'failed' as const, attemptId: attempt.id, resolvedAt: attempt.submitted_at };
        if (found !== 'assisted') { outcome = found; break; }
      }
      if (outcome && outcome !== 'awaiting') ({ status, attemptId, resolvedAt } = outcome);
      else if (!outcome && row.expired) { status = 'expired'; resolvedAt = new Date(); }
      if (persist && status !== 'pending') await client.query(`UPDATE adaptation_transfer_checks SET status=$4,attempt_id=$5,resolved_at=clock_timestamp()
        WHERE enrollment_id=$1 AND proposal_id=$2 AND objective_id=$3 AND status='pending'`, [enrollmentId, row.proposal_id, row.objective_id, status, attemptId]);
    }
    const amended = row.amended_status && row.amended_status !== status ? { amendedFrom: status, amendedAt: row.amended_at!.toISOString() } : {};
    result.push({ proposalId: row.proposal_id, objectiveId: row.objective_id, status: row.amended_status ?? status, ...amended,
      deliveredAt: row.delivered_at.toISOString(), resolvedAt: resolvedAt?.toISOString() ?? null, attemptId });
  }
  return result;
}

/**
 * An appeal changed the decision on a reviewed written answer. A transfer check already resolved
 * from that answer is amended, never rewritten: its original resolution stays as stored, the
 * amended outcome is recorded beside it with the appeal that caused it, and a system audit event
 * (adaptation.transfer_check_amended) records the change, like a closed record's amendment
 * (enrollment.closed_record_amended). Call in the appeal's transaction, after the decision.
 */
export async function amendTransferChecksForAppeal(client: PoolClient, input: { workspaceId: string; enrollmentId: string; attemptId: string; appealId: string; decision: 'met' | 'not_met' }) {
  const amended: TransferStatus = input.decision === 'met' ? 'passed' : 'failed';
  const rows = (await client.query<{ proposal_id: string; objective_id: string; status: TransferStatus }>(
    `UPDATE adaptation_transfer_checks SET amended_status=$3,amended_at=clock_timestamp(),amended_by_appeal_id=$4
     WHERE enrollment_id=$1 AND attempt_id=$2 AND status IN ('passed','failed') AND status<>$3 AND amended_status IS NULL
     RETURNING proposal_id,objective_id,status`, [input.enrollmentId, input.attemptId, amended, input.appealId])).rows;
  for (const row of rows)
    await appendEvent(client, { workspaceId: input.workspaceId, enrollmentId: input.enrollmentId, actorKind: 'system', type: 'adaptation.transfer_check_amended',
      payload: { proposalId: row.proposal_id, objectiveId: row.objective_id, attemptId: input.attemptId, appealId: input.appealId,
        statusBefore: row.status, statusAfter: amended, originalKept: true },
      idempotencyKey: `transfer-check-amended:${input.appealId}:${row.proposal_id}:${row.objective_id}` });
  return rows.length;
}
