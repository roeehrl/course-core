import type { PoolClient } from 'pg';
import { appendEvent } from './events.js';

/**
 * Evidence withdrawn after a course closed.
 *
 * The design keeps outcomes orthogonal: a course that reached closure ("completed and
 * demonstrated" or "ended with gaps") is never silently reopened, the closure report is a
 * record of that moment, and a defective item is invalidated explicitly with a reason. So
 * when evidence of a completed or closed enrollment is invalidated later (a defective item, a
 * staff evidence rejection), the enrollment is NOT reopened and no new required work appears.
 * Instead:
 * - the learner sees each withdrawn piece of evidence with its reason next to their closure
 *   report (closedRecordNotices in the learner snapshot), so the record is not changed silently;
 * - an audit event (enrollment.closed_record_amended, system) records that the closed record was
 *   amended, by which path, and that the enrollment was not reopened.
 * Any further check after closure stays a separate, optional choice.
 */
export interface ClosedRecordNotice { evidenceId: string; assessmentId: string; objectiveId: string; reason: string | null; withdrawnAt: string }

export async function closedRecordNotices(client: PoolClient, enrollmentId: string): Promise<ClosedRecordNotice[]> {
  const rows = (await client.query<{ id: string; assessment_id: string; objective_id: string; invalidation_reason: string | null; invalidated_at: Date }>(
    `SELECT ev.id,a.assessment_id,ev.objective_id,ev.invalidation_reason,ev.invalidated_at FROM evidence ev
       JOIN attempts a ON a.id=ev.attempt_id AND a.enrollment_id=ev.enrollment_id JOIN enrollments e ON e.id=ev.enrollment_id
      WHERE ev.enrollment_id=$1 AND e.closed_at IS NOT NULL AND ev.invalidated_at >= e.closed_at
      ORDER BY ev.invalidated_at,ev.id LIMIT 50`, [enrollmentId])).rows;
  return rows.map(row => ({ evidenceId: row.id, assessmentId: row.assessment_id, objectiveId: row.objective_id, reason: row.invalidation_reason, withdrawnAt: row.invalidated_at.toISOString() }));
}

/** Audit that a closed enrollment's record was amended without reopening it. A no-op for an
 * enrollment that has not closed. Call after the evidence is invalidated, in the same transaction. */
export async function auditClosedRecordAmended(client: PoolClient, input: { workspaceId: string; enrollmentId: string; source: 'item_defective' | 'evidence_rejected'; assessmentId: string; evidence: number; idempotencyKey: string }) {
  const enrollment = (await client.query<{ status: string; closed_at: Date | null }>('SELECT status,closed_at FROM enrollments WHERE id=$1', [input.enrollmentId])).rows[0];
  if (!enrollment?.closed_at || !['completed', 'closed'].includes(enrollment.status)) return false;
  await appendEvent(client, { workspaceId: input.workspaceId, enrollmentId: input.enrollmentId, actorKind: 'system', type: 'enrollment.closed_record_amended',
    payload: { source: input.source, assessmentId: input.assessmentId, evidence: input.evidence, statusBefore: enrollment.status, reopened: false, closureReportKept: true, learnerNotified: true },
    idempotencyKey: input.idempotencyKey });
  return true;
}
