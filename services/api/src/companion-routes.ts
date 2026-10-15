import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from './database.js';
import { authService } from './auth.js';
import { enrollmentCommand, loadEnrollment, policyEpisodeId, type CommandInput } from './repository.js';
import { requireCondition } from './errors.js';
import { requireAvailable } from './learning.js';
import { activateWindows, assertPolicyAction, loadPolicy } from './policy-adapter.js';
import { checkAction } from '@course-core/policy';
import { appendEvent } from './events.js';
import { resolveInteractiveContext } from './interactive-context.js';
import { recordCompanionSignal } from './teaching-hypotheses.js';
import type { RuntimeExtension } from './publication.js';

const path = '/api/enrollments/:enrollmentId/companion';
const params = { type: 'object', required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
export function registerCompanionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installedExtensions: RuntimeExtension[] = []) {
  app.get(path, { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    await loadEnrollment(db, actor, enrollmentId);
    const messages = (await db.query(`SELECT m.id,m.role,m.content,m.context,m.created_at,m.job_id,j.state AS job_state,j.result->>'reason' AS job_reason
      FROM companion_messages m LEFT JOIN supervisor_jobs j ON j.id=m.job_id
      WHERE m.enrollment_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 100`, [enrollmentId])).rows.reverse();
    return { messages };
  });
  app.post(path, { schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['expectedRevision', 'idempotencyKey', 'episodeId', 'content'], properties: {
      expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
      episodeId: { type: 'string', minLength: 1, maxLength: 200 }, blockId: { type: 'string', minLength: 1, maxLength: 200 },
      content: { type: 'string', minLength: 1, maxLength: 4000 }, allowAssessmentAssistance: { type: 'boolean' },
      interactiveContext: { type: 'object' },
    } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as CommandInput & { episodeId: string; blockId?: string; content: string; allowAssessmentAssistance?: boolean; interactiveContext?: unknown };
    return enrollmentCommand(db, actor, enrollmentId, 'companion', input, async (client, context) => {
      requireCondition(input.content.trim(), 'EMPTY_MESSAGE');
      const episode = requireAvailable(context.release.server_bundle, context.release.digest, context.progress, context.evidence, input.episodeId);
      if (input.blockId) requireCondition(episode.blocks.some(block => block.id === input.blockId), 'BLOCK_OUT_OF_SCOPE');
      if (input.interactiveContext !== undefined) requireCondition(input.blockId, 'INTERACTIVE_CONTEXT_OUT_OF_SCOPE');
      const interactiveContext = input.interactiveContext === undefined ? undefined : resolveInteractiveContext({ input: input.interactiveContext,
        enrollment: context, scope: { episodeId: input.episodeId, blockId: input.blockId! }, installedExtensions });
      // A completed course keeps bounded explanatory questions when its policy
      // keeps material readable; it never reopens planning or required work.
      const closedCourse = context.enrollment.status === 'completed';
      let currentPolicy;
      if (closedCourse) {
        currentPolicy = await loadPolicy(client, enrollmentId);
        const read = checkAction(currentPolicy, { scopeId: `episode:${policyEpisodeId(context.release, input.episodeId)}`, kind: 'read', now: new Date().toISOString(), expectedPolicyRevision: currentPolicy.policyRevision });
        requireCondition(read.allowed, 'ACCESS_CLOSED', 409);
      } else {
        currentPolicy = await activateWindows(client, context.release.server_bundle, enrollmentId, policyEpisodeId(context.release, input.episodeId), new Date().toISOString());
        await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, input.episodeId), 'plan', new Date().toISOString());
      }
      const pending = await client.query<{ id: string }>("SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL AND expires_at>now() AND independent_eligible=true FOR UPDATE", [enrollmentId]);
      requireCondition(!pending.rowCount || input.allowAssessmentAssistance === true, 'ASSESSMENT_HELP_CONSENT_REQUIRED', 409);
      const downgradedChallengeIds = pending.rows.map(row => row.id);
      if (pending.rowCount) await client.query("UPDATE assessment_challenges SET assistance='hint',independent_eligible=false WHERE id=ANY($1::uuid[])", [downgradedChallengeIds]);
      const messageId = randomUUID();
      const capsule = { episodeId: input.episodeId, blockId: input.blockId ?? null, courseDigest: context.release.digest, profileRevision: context.enrollment.profile_revision, policyRevision: currentPolicy.policyRevision,
        enrollmentRevision: context.enrollment.revision + 1, downgradedChallengeIds, ...(interactiveContext ? { interactiveContext } : {}) };
      await client.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, input.content.trim(), JSON.stringify(capsule)]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'companion.requested', payload: { messageId, episodeId: input.episodeId, blockId: input.blockId ?? null, requestKind: 'question', downgradedChallengeIds }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      // Repeated questions can recommend another representation; a question never lowers evidence.
      await recordCompanionSignal(client, context, { eventId: event.id, episodeId: input.episodeId });
      return { messageId, eventId: event.id, revision: context.enrollment.revision + 1, state: 'queued', downgradedChallengeIds };
    });
  });
}
