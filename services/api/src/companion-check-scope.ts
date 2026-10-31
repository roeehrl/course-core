import type { PoolClient } from 'pg';
import { retrieveConversation } from './context-capsule.js';
import { checkCoachingView, checkScope, courseChecksFor, matchGradedChecks, type CheckCoaching } from './companion-check-integrity.js';

/**
 * The graded checks one companion question is about (companion-check-integrity.ts), from the same
 * inputs wherever it is asked: the question, the learner's earlier questions in this lesson of this
 * course version, the lesson's and its neighbours' checks and the checks open now. The teaching
 * context asks it when the call is assembled (check-coaching mode); preparing the question asks it
 * first, so only a question in check-coaching mode reserves room for the check judge's call
 * (provider-setup.ts, role-reservation.ts). `earlier` is passed by a caller that already read the
 * conversation.
 */
export async function questionCheckCoaching(client: PoolClient, input: { enrollmentId: string; courseDigest: string; course: unknown; episodeId: string;
  blockId: string | null; messageId: string; question: string; before: Date; earlier?: readonly string[] }): Promise<CheckCoaching | undefined> {
  const earlier = input.earlier ?? (await retrieveConversation(client, { enrollmentId: input.enrollmentId, episodeId: input.episodeId, courseDigest: input.courseDigest,
    currentMessageId: input.messageId, before: input.before })).history.filter(turn => turn.role === 'learner').map(turn => turn.content);
  const open = (await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() LIMIT 20',
    [input.enrollmentId])).rows.map(row => row.assessment_id);
  const scope = checkScope(input.course, input.episodeId, input.blockId, open), known = courseChecksFor(input.courseDigest, input.course);
  return checkCoachingView(matchGradedChecks({ question: input.question, earlier, checks: known.checks, current: scope.current, nearby: scope.nearby,
    open: scope.open, courseText: known.text }));
}
