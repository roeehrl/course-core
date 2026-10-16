import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { checkClosedQuestion, closeEnrollment, coverageSummary, previewClosure, type PolicyState } from '@course-core/policy';
import { RECOGNITION_TYPES, type CourseManifest } from '@course-core/sdk';
import type { EnrollmentContext } from './repository.js';
import { DEFAULT_COURSE_POLICY_SETTINGS, loadPolicy } from './policy-adapter.js';
import { episodes, gateDecision } from './learning.js';
import { ApiError, requireCondition } from './errors.js';

/** Objectives a closure report may call demonstrated. Choosing among given answers alone
 * never demonstrates an objective, even under a 0.4 gate whose pass rule still unlocks the
 * next lesson; such an objective is reported as a gap, never as mastery. */
export function demonstratedObjectiveIds(course: CourseManifest, context: Pick<EnrollmentContext, 'evidence' | 'release'>) {
  const assessments = new Map(course.assessments.map(a => [a.id, a]));
  const evidence = new Map(context.evidence.map(row => [row.id, row]));
  const producedBeyondRecognition = (ids: readonly string[]) => ids.some(id => {
    const item = assessments.get(evidence.get(id)?.assessment_id ?? '');
    return item === undefined || !RECOGNITION_TYPES.has(item.type);
  });
  return [...new Set(course.gates.flatMap(gate => gateDecision(course, gate, context.evidence, context.release.digest).objectives
    .filter(row => row.passed && producedBeyondRecognition(row.evidenceIds)).map(row => row.id)))];
}

/** The stable coverage denominator (core objectives fixed at enrollment), how many are covered,
 * and personal extras on their own counter. Inserted personal episodes never change it. */
export function coverageView(course: CourseManifest, context: Pick<EnrollmentContext, 'progress'>, policy: PolicyState) {
  const summary = coverageSummary(policy);
  const covered = new Set(episodes(course).filter(episode => context.progress.some(progress => progress.episode_id === episode.id && ['completed', 'placed'].includes(progress.state)))
    .flatMap(episode => episode.objectiveIds).filter(id => summary.coreObjectiveIds.includes(id)));
  return { denominator: summary.denominator, coveredCoreObjectives: covered.size, personalExtras: summary.personalExtras, headroom: summary.headroom };
}

/** A learner question (companion_messages row aliased `m`) that will never be answered: the
 * supervisor refused its request (inactive, policy denied, stopped, oversized), its delivery
 * was quarantined, or its job ended failed or cancelled. None of these can produce an answer
 * later (terminal jobs never resume; refusals and quarantine are final). A question still
 * queued or being answered is not refused, so concurrent questions cannot exceed a budget. */
export const REFUSED_QUESTION_SQL = `(EXISTS (SELECT 1 FROM supervisor_jobs rj WHERE rj.id=m.job_id AND rj.state IN ('failed','cancelled'))
  OR (m.job_id IS NULL AND EXISTS (SELECT 1 FROM learning_events re WHERE re.enrollment_id=m.enrollment_id AND re.event_type='companion.requested'
    AND re.payload->>'messageId'=m.id::text AND (EXISTS (SELECT 1 FROM supervisor_preparations rp WHERE rp.event_id=re.id AND rp.disposition<>'prepared')
      OR EXISTS (SELECT 1 FROM outbox ro WHERE ro.event_id=re.id AND ro.quarantined_at IS NOT NULL)))))`;
/** A closed enrollment (completed or capped) keeps bounded explanatory questions when its
 * access policy keeps the material readable and its closed-course question budget has room.
 * Questions never reopen planning, create required work or grant credit. */
/** Learner questions asked since the course closed (the closed-course budget's usage). A
 * question is charged when asked and refunded if it is refused or ends unanswered. */
async function closedQuestionsUsed(client: PoolClient, enrollmentId: string, policy: PolicyState, now: string) {
  const since = policy.closure?.closedAt ?? now;
  return (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM companion_messages m WHERE m.enrollment_id=$1 AND m.role='learner' AND m.created_at>=$2
    AND NOT ${REFUSED_QUESTION_SQL}`, [enrollmentId, since])).rows[0]!.n;
}
/** The learner's view of a closed course's question allowance, counted exactly as
 * assertClosedCourseQuestion counts it; undefined while the course is open. */
export async function closedQuestionAllowance(client: PoolClient, enrollmentId: string, policy: PolicyState, now = new Date().toISOString()) {
  if (policy.status !== 'closed') return undefined;
  const used = await closedQuestionsUsed(client, enrollmentId, policy, now);
  const budget = policy.afterClosure?.questionBudget ?? DEFAULT_COURSE_POLICY_SETTINGS.closedQuestionBudget;
  return { budget, used, remaining: Math.max(0, budget - used) };
}
export async function assertClosedCourseQuestion(client: PoolClient, enrollmentId: string, scopeId: string, now: string) {
  const policy = await loadPolicy(client, enrollmentId);
  const used = await closedQuestionsUsed(client, enrollmentId, policy, now);
  const allowance = checkClosedQuestion(policy, { scopeId, now, questionsUsed: used, defaultBudget: DEFAULT_COURSE_POLICY_SETTINGS.closedQuestionBudget });
  if (!allowance.allowed) throw new ApiError(409, allowance.violations[0]!, allowance.violations[0]!, { budget: allowance.budget, used: allowance.used, remaining: allowance.remaining });
  return { policy, allowance };
}

/** Coverage and demonstrated understanding are derived from persisted evidence, never request flags. */
export async function closeCompletedCourse(client: PoolClient, context: EnrollmentContext) {
  return closeWith(client, context, 'completed');
}
/** A reached course cap closes the enrollment with an honest gaps report: what was
 * covered and demonstrated, and what was not. The policy refuses unless the cap
 * (binding deadline or an exhausted work quota) has actually been reached at `now`. */
export async function closeCappedCourse(client: PoolClient, context: EnrollmentContext, now: Date = new Date()) {
  return closeWith(client, context, 'cap', now);
}
async function closeWith(client: PoolClient, context: EnrollmentContext, reason: 'completed' | 'cap', at: Date = new Date()) {
  const policy = await loadPolicy(client, context.enrollment.id);
  if (policy.status === 'closed') return policy.closure;
  const course = context.release.server_bundle, now = at.toISOString();
  const covered = episodes(course).filter(episode => context.progress.some(progress => progress.episode_id === episode.id && ['completed', 'placed'].includes(progress.state))).flatMap(episode => episode.objectiveIds);
  const demonstrated = demonstratedObjectiveIds(course, context);
  const command = { now, reason, coveredObjectiveIds: [...new Set(covered)].filter(id => policy.coreObjectiveIds.includes(id)), demonstratedConceptIds: [...new Set(demonstrated)] };
  const preview = previewClosure(policy, command);
  const transition = closeEnrollment(policy, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: policy.policyRevision, expectedLedgerRevision: policy.ledgerRevision,
    idempotencyKey: `${reason === 'cap' ? 'cap' : 'completion'}:${context.enrollment.id}`, authorityReceipt: { receiptId: randomUUID(), actorId: reason === 'cap' ? 'system:reached-course-cap' : 'system:verified-course-coverage', enrollmentId: context.enrollment.id, scopeId: 'course', permission: 'close_enrollment', termsDigest: preview.previewDigest, authorizedAt: now } });
  const saved = await client.query('UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1 AND policy_revision=$5 AND ledger_revision=$6',
    [context.enrollment.id, JSON.stringify(transition.state), transition.state.policyRevision, transition.state.ledgerRevision, policy.policyRevision, policy.ledgerRevision]);
  requireCondition(saved.rowCount === 1, 'STALE_POLICY_REVISION', 409);
  await client.query("UPDATE enrollments SET status=$3,policy_revision=$2,closed_at=now() WHERE id=$1", [context.enrollment.id, transition.state.policyRevision, reason === 'cap' ? 'closed' : 'completed']);
  return transition.state.closure;
}
