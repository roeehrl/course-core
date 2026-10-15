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

/** A closed enrollment (completed or capped) keeps bounded explanatory questions when its
 * access policy keeps the material readable and its closed-course question budget has room.
 * Questions never reopen planning, create required work or grant credit. */
export async function assertClosedCourseQuestion(client: PoolClient, enrollmentId: string, scopeId: string, now: string) {
  const policy = await loadPolicy(client, enrollmentId);
  const since = policy.closure?.closedAt ?? now;
  const used = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM companion_messages WHERE enrollment_id=$1 AND role='learner' AND created_at>=$2",
    [enrollmentId, since])).rows[0]!.n;
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
