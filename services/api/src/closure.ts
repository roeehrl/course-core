import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closeEnrollment, previewClosure } from '@course-core/policy';
import type { EnrollmentContext } from './repository.js';
import { loadPolicy } from './policy-adapter.js';
import { episodes, gateDecision } from './learning.js';
import { requireCondition } from './errors.js';

/** Coverage and demonstrated understanding are derived from persisted evidence, never request flags. */
export async function closeCompletedCourse(client: PoolClient, context: EnrollmentContext) {
  const policy = await loadPolicy(client, context.enrollment.id);
  if (policy.status === 'closed') return policy.closure;
  const course = context.release.server_bundle, now = new Date().toISOString();
  const covered = episodes(course).filter(episode => context.progress.some(progress => progress.episode_id === episode.id && ['completed', 'placed'].includes(progress.state))).flatMap(episode => episode.objectiveIds);
  const demonstrated = course.gates.flatMap(gate => gateDecision(gate, context.evidence, context.release.digest).objectives.filter(row => row.passed).map(row => row.id));
  const command = { now, reason: 'completed' as const, coveredObjectiveIds: [...new Set(covered)].filter(id => policy.coreObjectiveIds.includes(id)), demonstratedConceptIds: [...new Set(demonstrated)] };
  const preview = previewClosure(policy, command);
  const transition = closeEnrollment(policy, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: policy.policyRevision, expectedLedgerRevision: policy.ledgerRevision,
    idempotencyKey: `completion:${context.enrollment.id}`, authorityReceipt: { receiptId: randomUUID(), actorId: 'system:verified-course-coverage', enrollmentId: context.enrollment.id, scopeId: 'course', permission: 'close_enrollment', termsDigest: preview.previewDigest, authorizedAt: now } });
  const saved = await client.query('UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1 AND policy_revision=$5 AND ledger_revision=$6',
    [context.enrollment.id, JSON.stringify(transition.state), transition.state.policyRevision, transition.state.ledgerRevision, policy.policyRevision, policy.ledgerRevision]);
  requireCondition(saved.rowCount === 1, 'STALE_POLICY_REVISION', 409);
  await client.query("UPDATE enrollments SET status='completed',policy_revision=$2,closed_at=now() WHERE id=$1", [context.enrollment.id, transition.state.policyRevision]);
  return transition.state.closure;
}
