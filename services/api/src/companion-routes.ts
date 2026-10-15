import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from './database.js';
import { authService } from './auth.js';
import { enrollmentCommand, loadEnrollment, policyEpisodeId, type CommandInput } from './repository.js';
import { requireCondition } from './errors.js';
import { requireAvailable } from './learning.js';
import { activateWindows, assertPolicyAction } from './policy-adapter.js';
import { assertClosedCourseQuestion } from './closure.js';
import { appendEvent } from './events.js';
import { resolveInteractiveContext } from './interactive-context.js';
import { recordCompanionSignal } from './teaching-hypotheses.js';
import type { RuntimeExtension } from './publication.js';
import { contextUsedView, learnerMediaSchema, learnerSelectionSchema, resolveMedia, resolveSelection, revokeCapsuleSources, type CompanionCapsule } from './context-capsule.js';
import { revokeProposalsCitingEvents } from './learner-model.js';

const path = '/api/enrollments/:enrollmentId/companion';
const params = { type: 'object', required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
export function registerCompanionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installedExtensions: RuntimeExtension[] = []) {
  app.get(path, { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    await loadEnrollment(db, actor, enrollmentId);
    const rows = (await db.query<{ id: string; role: string; content: string; context: Record<string, unknown>; created_at: Date; job_id: string | null; job_state: string | null; job_reason: string | null; capsule: CompanionCapsule | null }>(
      // An answer recorded before it carried its lesson takes the lesson of the question it answers.
      `SELECT m.id,m.role,m.content,CASE WHEN m.role='assistant' AND m.context->>'episodeId' IS NULL AND q.context->>'episodeId' IS NOT NULL
          THEN m.context||jsonb_build_object('episodeId',q.context->'episodeId','blockId',COALESCE(q.context->'blockId','null'::jsonb)) ELSE m.context END AS context,m.created_at,m.job_id,j.state AS job_state,j.result->>'reason' AS job_reason,
        CASE WHEN m.role='assistant' THEN c.capsule END AS capsule
      FROM companion_messages m LEFT JOIN supervisor_jobs j ON j.id=m.job_id LEFT JOIN companion_context_capsules c ON c.job_id=m.job_id AND c.enrollment_id=m.enrollment_id
        LEFT JOIN LATERAL (SELECT q.context FROM companion_messages q WHERE m.role='assistant' AND q.job_id=m.job_id AND q.enrollment_id=m.enrollment_id AND q.role='learner' LIMIT 1) q ON true
      WHERE m.enrollment_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 100`, [enrollmentId])).rows.reverse();
    // Short excerpts of the learner's own earlier messages that an answer used, and which of them they excluded.
    const referenced = [...new Set(rows.flatMap(row => row.capsule?.historyRefs?.map(ref => ref.messageId) ?? []))].slice(0, 400);
    const excerpts = new Map((await db.query<{ id: string; excerpt: string }>("SELECT id,left(content,160) AS excerpt FROM companion_messages WHERE enrollment_id=$1 AND id=ANY($2::uuid[])",
      [enrollmentId, referenced])).rows.map(row => [row.id, row.excerpt]));
    const excluded = new Set((await db.query<{ message_id: string }>('SELECT message_id FROM companion_context_exclusions WHERE enrollment_id=$1 AND ended_at IS NULL LIMIT 500', [enrollmentId])).rows.map(row => row.message_id));
    const messages = rows.map(({ capsule, ...row }) => ({ ...row, ...(row.role === 'assistant' ? { context_used: contextUsedView(capsule, excerpts, excluded) } : { excluded: excluded.has(row.id) }) }));
    return { messages };
  });
  /** The learner deletes one of their questions. Its text and the answer to it are removed, an answer
   * still being prepared is cancelled and fenced, and what was derived from it is revoked: capsules of
   * other answers drop it, and learner-model suggestions citing it are revoked (C08). */
  app.post(`${path}/messages/:messageId/delete`, { schema: { params: { type: 'object', required: ['enrollmentId', 'messageId'],
    properties: { enrollmentId: { type: 'string', format: 'uuid' }, messageId: { type: 'string', format: 'uuid' } } },
    body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'idempotencyKey'], properties: {
      expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, messageId } = request.params as { enrollmentId: string; messageId: string };
    const input = request.body as CommandInput;
    return enrollmentCommand(db, actor, enrollmentId, 'companion.delete', { ...input, messageId }, async (client, context) => {
      const message = (await client.query<{ job_id: string | null; content: string }>("SELECT job_id,content FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='learner' FOR UPDATE",
        [messageId, enrollmentId])).rows[0];
      requireCondition(message, 'MESSAGE_NOT_FOUND', 404);
      requireCondition(message.content !== '[deleted]', 'MESSAGE_ALREADY_DELETED', 409);
      const requested = (await client.query<{ id: string }>("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.requested' AND payload->>'messageId'=$2::text",
        [enrollmentId, messageId])).rows.map(row => row.id);
      // A real context change: an answer still being prepared from it is fenced as well as cancelled.
      context.enrollment.revision = (await client.query<{ revision: number }>('UPDATE enrollments SET revision=revision+1 WHERE id=$1 RETURNING revision', [enrollmentId])).rows[0]!.revision;
      await client.query("UPDATE companion_messages SET content='[deleted]',context='{}'::jsonb WHERE id=$1 AND enrollment_id=$2", [messageId, enrollmentId]);
      const answers = message.job_id ? (await client.query("UPDATE companion_messages SET content='[deleted]',context='{}'::jsonb WHERE enrollment_id=$1 AND job_id=$2 AND role='assistant'",
        [enrollmentId, message.job_id])).rowCount ?? 0 : 0;
      const cancelled = message.job_id ? (await client.query("UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1 AND enrollment_id=$2 AND state NOT IN ('applied','cancelled','failed')",
        [message.job_id, enrollmentId])).rowCount ?? 0 : 0;
      await client.query('UPDATE outbox SET quarantined_at=clock_timestamp() WHERE event_id=ANY($1::uuid[]) AND delivered_at IS NULL AND quarantined_at IS NULL', [requested]);
      const capsules = await revokeCapsuleSources(client, enrollmentId, messageId, requested);
      const revokedProposalIds = await revokeProposalsCitingEvents(client, context, actor, requested, input.idempotencyKey);
      const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'companion.message.deleted',
        payload: { messageId, answersDeleted: answers, jobCancelled: cancelled > 0, capsulesRevised: capsules, revokedProposalIds }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { messageId, deleted: true, eventId: event.id, revision: context.enrollment.revision, answersDeleted: answers, jobCancelled: cancelled > 0, capsulesRevised: capsules, revokedProposalIds };
    });
  });
  app.post(path, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['expectedRevision', 'idempotencyKey', 'episodeId', 'content'], properties: {
      expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
      episodeId: { type: 'string', minLength: 1, maxLength: 200 }, blockId: { type: 'string', minLength: 1, maxLength: 200 },
      content: { type: 'string', minLength: 1, maxLength: 4000 }, allowAssessmentAssistance: { type: 'boolean' },
      interactiveContext: { type: 'object' }, selection: { type: 'object' }, media: { type: 'object' }, uiRevision: { type: 'integer', minimum: 1 },
    } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as CommandInput & { episodeId: string; blockId?: string; content: string; allowAssessmentAssistance?: boolean; interactiveContext?: unknown;
      selection?: unknown; media?: unknown; uiRevision?: number };
    const selection = input.selection === undefined ? undefined : learnerSelectionSchema.safeParse(input.selection);
    const media = input.media === undefined ? undefined : learnerMediaSchema.safeParse(input.media);
    requireCondition((!selection || selection.success) && (!media || media.success), 'INVALID_REQUEST');
    return enrollmentCommand(db, actor, enrollmentId, 'companion', input, async (client, context) => {
      requireCondition(input.content.trim(), 'EMPTY_MESSAGE');
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
      const pending = await client.query<{ id: string }>("SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() AND independent_eligible=true FOR UPDATE", [enrollmentId]);
      requireCondition(!pending.rowCount || input.allowAssessmentAssistance === true, 'ASSESSMENT_HELP_CONSENT_REQUIRED', 409);
      const downgradedChallengeIds = pending.rows.map(row => row.id);
      if (pending.rowCount) await client.query("UPDATE assessment_challenges SET assistance='hint',independent_eligible=false WHERE id=ANY($1::uuid[])", [downgradedChallengeIds]);
      const messageId = randomUUID();
      // Asking is a conversation-only change (navigation_revision): it never fences another answer in preparation.
      const head = (await client.query<{ revision: number; navigation_revision: number }>('UPDATE enrollments SET revision=revision+1,navigation_revision=navigation_revision+1 WHERE id=$1 RETURNING revision,navigation_revision', [enrollmentId])).rows[0]!;
      const capsule = { episodeId: input.episodeId, blockId: input.blockId ?? null, courseDigest: context.release.digest, profileRevision: context.enrollment.profile_revision, policyRevision: currentPolicy.policyRevision,
        enrollmentRevision: head.revision, contextRevision: head.revision - head.navigation_revision, ...(input.uiRevision ? { uiRevision: input.uiRevision } : {}),
        downgradedChallengeIds, ...(interactiveContext ? { interactiveContext } : {}), ...(selectedAnchor ? { selectedAnchor } : {}), ...(mediaRef ? { mediaRef } : {}) };
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
