import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import type { authService } from './auth.js';
import { enrollmentPlacement } from './placement-settings.js';
import { enrollmentCommand, policyEpisodeId, type CommandInput, type EnrollmentContext } from './repository.js';
import { requireCondition } from './errors.js';
import { requireAvailable } from './learning.js';
import { activateWindows, assertPolicyAction } from './policy-adapter.js';
import { assertClosedCourseQuestion } from './closure.js';
import { appendEvent } from './events.js';
import { resolveInteractiveContext } from './interactive-context.js';
import { recordCompanionSignal } from './teaching-hypotheses.js';
import type { RuntimeExtension } from './publication.js';
import { learnerMediaSchema, learnerSelectionSchema, resolveMedia, resolveSelection } from './context-capsule.js';
import { armOffersRole, studyArmWithin } from './study.js';
import { gateLearningSnapshot } from './gate-decisions.js';
import { checkOrdinal } from './check-ordinal.js';

const path = '/api/enrollments/:enrollmentId/companion';
const params = { type: 'object', required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };

/** An open question of this enrollment with its number in its lesson's check, or INVALID_REQUEST. */
async function attachedCheckOf(client: PoolClient, context: EnrollmentContext, challengeId: string, ordinals: (episodeId: string) => Promise<number>) {
  const challenge = (await client.query<{ episode_id: string }>(
    'SELECT episode_id FROM assessment_challenges WHERE id=$1 AND enrollment_id=$2 AND attempt_id IS NULL AND expires_at>now()',
    [challengeId, context.enrollment.id])).rows[0];
  requireCondition(challenge, 'INVALID_REQUEST');
  return { challengeId, ordinal: await ordinals(challenge.episode_id) };
}

/**
 * Which open counted questions a companion message turns into practice (docs/companion-check-integrity.md):
 * those of the lesson it is asked from, and the question the learner attached to it, wherever it
 * is. Open counted questions of other lessons stay counted; the withheld-answer gate and check
 * coaching still cover them. The learner app previews the same rule (connected/credit/creditScope.ts).
 */
export function companionCreditScope<T extends { id: string; episode_id: string }>(open: readonly T[], episodeId: string, attachedChallengeId?: string): T[] {
  return open.filter(row => row.episode_id === episodeId || row.id === attachedChallengeId);
}

/** The learner asks the companion: the question is saved and a supervised request is queued. */
export function registerCompanionAskRoute(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installedExtensions: RuntimeExtension[] = []) {
  app.post(path, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['expectedRevision', 'idempotencyKey', 'episodeId', 'content'], properties: {
      expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
      episodeId: { type: 'string', minLength: 1, maxLength: 200 }, blockId: { type: 'string', minLength: 1, maxLength: 200 },
      content: { type: 'string', minLength: 1, maxLength: 4000 }, allowAssessmentAssistance: { type: 'boolean' },
      interactiveContext: { type: 'object' }, selection: { type: 'object' }, media: { type: 'object' }, uiRevision: { type: 'integer', minimum: 1 },
      challengeId: { type: 'string', format: 'uuid' },
    } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as CommandInput & { episodeId: string; blockId?: string; content: string; allowAssessmentAssistance?: boolean; interactiveContext?: unknown;
      selection?: unknown; media?: unknown; uiRevision?: number; challengeId?: string };
    const selection = input.selection === undefined ? undefined : learnerSelectionSchema.safeParse(input.selection);
    const media = input.media === undefined ? undefined : learnerMediaSchema.safeParse(input.media);
    requireCondition((!selection || selection.success) && (!media || media.success), 'INVALID_REQUEST');
    return enrollmentCommand(db, actor, enrollmentId, 'companion', input, async (client, context) => {
      requireCondition(input.content.trim(), 'EMPTY_MESSAGE');
      // A study arm without the companion (the fixed path) takes no questions; nothing is stored.
      const arm = await studyArmWithin(client, enrollmentId);
      requireCondition(!arm || armOffersRole(arm.behaviour, 'companion'), 'STUDY_ARM_NO_COMPANION', 409);
      const episode = requireAvailable(context.release.server_bundle, context.release.digest, context.progress, context.evidence, input.episodeId);
      if (input.blockId) requireCondition(episode.blocks.some(block => block.id === input.blockId), 'BLOCK_OUT_OF_SCOPE');
      if (input.interactiveContext !== undefined) requireCondition(input.blockId, 'INTERACTIVE_CONTEXT_OUT_OF_SCOPE');
      const interactiveContext = input.interactiveContext === undefined ? undefined : resolveInteractiveContext({ input: input.interactiveContext,
        enrollment: context, scope: { episodeId: input.episodeId, blockId: input.blockId! }, installedExtensions });
      // What the learner pointed at, resolved against the current course; a stale selection is refused.
      const selectedAnchor = selection?.data ? await resolveSelection(client, context, episode, selection.data) : undefined;
      const mediaRef = media?.data ? resolveMedia(context, episode, media.data) : undefined;
      // A completed or capped course keeps bounded explanatory questions when its policy keeps
      // material readable and its closed-course budget has room; it never reopens planning or required work.
      const closedCourse = context.enrollment.status === 'completed' || context.enrollment.status === 'closed';
      let currentPolicy;
      if (closedCourse) {
        currentPolicy = (await assertClosedCourseQuestion(client, enrollmentId, `episode:${policyEpisodeId(context.release, input.episodeId)}`, new Date().toISOString())).policy;
      } else {
        currentPolicy = await activateWindows(client, context.release.server_bundle, enrollmentId, policyEpisodeId(context.release, input.episodeId), new Date().toISOString());
        await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'plan', new Date().toISOString());
      }
      // Every open counted question is locked, so a concurrent answer or help waits for this message.
      const open = await client.query<{ id: string; mode: string; episode_id: string }>("SELECT id,mode,episode_id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() AND independent_eligible=true FOR UPDATE", [enrollmentId]);
      // Placement the author declared unassisted-only takes no companion help while an item is open,
      // whichever lesson the question is asked from.
      if (open.rows.some(row => row.mode === 'placement'))
        requireCondition(!(await enrollmentPlacement(client, context.enrollment, context.release.server_bundle)).unassistedOnly, 'PLACEMENT_UNASSISTED_ONLY', 409);
      // A question's number in its lesson's check ("Question 2"), read once per lesson.
      let gate: Awaited<ReturnType<typeof gateLearningSnapshot>> | undefined;
      const ordinals = async (episodeId: string) => {
        gate ??= await gateLearningSnapshot(client, context);
        return checkOrdinal(gate.lessons.find(row => row.id === episodeId)?.gate?.objectives ?? []);
      };
      // A check the learner attached to the message (the check's own "Ask the companion"): an open
      // question of this enrollment, stored with its number in the lesson ("Question 2"). Anything
      // else is refused and nothing is stored.
      const attachedCheck = input.challengeId === undefined ? undefined : await attachedCheckOf(client, context, input.challengeId, ordinals);
      const pending = companionCreditScope(open.rows, input.episodeId, attachedCheck?.challengeId);
      requireCondition(!pending.length || input.allowAssessmentAssistance === true, 'ASSESSMENT_HELP_CONSENT_REQUIRED', 409);
      const downgradedChallengeIds = pending.map(row => row.id);
      // Stored with the message, so the conversation can say later which question became practice.
      const downgraded: { challengeId: string; ordinal: number }[] = [];
      for (const row of pending) downgraded.push({ challengeId: row.id, ordinal: await ordinals(row.episode_id) });
      if (pending.length) await client.query("UPDATE assessment_challenges SET assistance='hint',assistance_reason='companion',independent_eligible=false WHERE id=ANY($1::uuid[])", [downgradedChallengeIds]);
      const messageId = randomUUID();
      // Asking is a conversation-only change (navigation_revision): it never fences another answer in preparation.
      const head = (await client.query<{ revision: number; navigation_revision: number }>('UPDATE enrollments SET revision=revision+1,navigation_revision=navigation_revision+1 WHERE id=$1 RETURNING revision,navigation_revision', [enrollmentId])).rows[0]!;
      const capsule = { episodeId: input.episodeId, blockId: input.blockId ?? null, courseDigest: context.release.digest, profileRevision: context.enrollment.profile_revision, policyRevision: currentPolicy.policyRevision,
        enrollmentRevision: head.revision, contextRevision: head.revision - head.navigation_revision, ...(input.uiRevision ? { uiRevision: input.uiRevision } : {}),
        downgradedChallengeIds, ...(downgraded.length ? { downgraded } : {}), ...(interactiveContext ? { interactiveContext } : {}), ...(selectedAnchor ? { selectedAnchor } : {}), ...(mediaRef ? { mediaRef } : {}),
        ...(attachedCheck ? { attachedCheck } : {}) };
      await client.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, input.content.trim(), JSON.stringify(capsule)]);
      const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'companion.requested', payload: { messageId, episodeId: input.episodeId, blockId: input.blockId ?? null, requestKind: 'question', downgradedChallengeIds }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      // The answer's context must be at least this new.
      await client.query(`UPDATE companion_messages SET context=context||jsonb_build_object('recentEventCursor',$2::text) WHERE id=$1`, [messageId, event.cursor]);
      // Repeated questions can recommend another representation; a question never lowers evidence.
      await recordCompanionSignal(client, context, { eventId: event.id, episodeId: input.episodeId });
      return { messageId, eventId: event.id, revision: head.revision, contextRevision: head.revision - head.navigation_revision, state: 'queued', downgradedChallengeIds,
        ...(selectedAnchor ? { selectedAnchor: { kind: selectedAnchor.kind } } : {}), ...(mediaRef ? { mediaRef: { mediaId: mediaRef.mediaId, playbackSeconds: mediaRef.playbackSeconds } } : {}) };
    });
  });
}
