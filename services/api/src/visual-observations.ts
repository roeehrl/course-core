import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { fromVisualExperience, VisualRuntime } from '@course-core/visuals/headless';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { requireAvailable } from './learning.js';
import { loadEnrollment } from './repository.js';

const sdkId = { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,127}$' };

/**
 * POST /api/enrollments/:enrollmentId/visual-completions (requirement L10).
 *
 * A learner reached the end of a visual block's timeline. Completion is an observation: it
 * appends one `visual.completed` learning event and nothing else. It changes no progress,
 * evidence, mastery or enrollment revision, so it cannot fence or replace any command.
 *
 * Replaying, scrubbing, remounting or retrying never adds a second observation: the event's
 * idempotency key is derived on the server from the enrollment, the course version and the
 * block, not from anything the client chooses. The visual player reports completion once
 * per runtime as well (CompletionLatch), so the server key is the guarantee, not the client.
 *
 * Only the enrollment's own learner may record it. The block must be a visual block of an
 * episode the learner can open, naming that block's visual, and the reported scene
 * fingerprint must be the released scene's, so a stale or forged scene is refused (409).
 * The first report also records its playback context (playback_contexts).
 */
export function registerVisualObservationRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  app.post('/api/enrollments/:enrollmentId/visual-completions', {
    bodyLimit: 4096,
    schema: {
      params: { type: 'object', properties: { enrollmentId: { type: 'string', format: 'uuid' } }, required: ['enrollmentId'] },
      body: {
        type: 'object', additionalProperties: false, required: ['episodeId', 'blockId', 'visualId', 'sceneFingerprint'],
        properties: {
          episodeId: { type: 'string', minLength: 1, maxLength: 200 },
          blockId: { type: 'string', minLength: 1, maxLength: 200 },
          visualId: sdkId,
          sceneFingerprint: { type: 'string', pattern: '^[0-9]{1,7}-[a-f0-9]{1,8}-[a-f0-9]{1,8}$' },
        },
      },
    },
  }, async request => {
    const actor = await auth.authenticate(request);
    const { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as { episodeId: string; blockId: string; visualId: string; sceneFingerprint: string };
    return transaction(db, async client => {
      // The row lock serializes concurrent reports of one enrollment, so a duplicate is
      // answered as such rather than failing on the unique idempotency key.
      const context = await loadEnrollment(client, actor, enrollmentId, true);
      const { release } = context;
      const episode = requireAvailable(release.server_bundle, release.digest, context.progress, context.evidence, input.episodeId);
      const block = episode.blocks.find(row => row.id === input.blockId);
      requireCondition(block?.type === 'visual' && block.visualId === input.visualId, 'VISUAL_COMPLETION_OUT_OF_SCOPE');
      const visual = release.server_bundle.visuals.find(row => row.id === input.visualId);
      let fingerprint: string | undefined;
      try { fingerprint = visual && new VisualRuntime(fromVisualExperience(visual)).exportReplay().sceneFingerprint; }
      catch { fingerprint = undefined; }
      requireCondition(fingerprint !== undefined, 'VISUAL_COMPLETION_OUT_OF_SCOPE');
      requireCondition(fingerprint === input.sceneFingerprint, 'VISUAL_COMPLETION_STALE', 409);
      // Event keys are unique per workspace, so the key names the enrollment too.
      const idempotencyKey = `${enrollmentId}:visual-completed:${release.digest}:${input.episodeId}:${input.blockId}`;
      const prior = (await client.query<{ id: string }>('SELECT id FROM learning_events WHERE enrollment_id=$1 AND idempotency_key=$2',
        [enrollmentId, idempotencyKey])).rows[0];
      if (prior) return { recorded: true, duplicate: true, eventId: prior.id, grantsMastery: false };
      const event = await appendEvent(client, {
        workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'visual.completed',
        payload: { episodeId: input.episodeId, blockId: input.blockId, visualId: input.visualId, observation: true, grantsMastery: false },
        idempotencyKey,
      });
      // The playback context (M02): which course version, block, renderer build and scene
      // were played. Informational, like the event; never mastery evidence.
      const renderer = release.server_bundle.extensions?.find(row => row.id === visual!.rendererId);
      await client.query(`INSERT INTO playback_contexts(id,enrollment_id,workspace_id,course_digest,episode_id,block_id,resource_kind,resource_id,
          renderer_id,renderer_version,renderer_integrity,scene_fingerprint,outcome,event_id)
        VALUES($1,$2,$3,$4,$5,$6,'visual',$7,$8,$9,$10,$11,'completed',$12) ON CONFLICT DO NOTHING`,
        [randomUUID(), enrollmentId, context.enrollment.workspace_id, release.digest, input.episodeId, input.blockId, input.visualId,
          visual!.rendererId, renderer?.version ?? null, /^sha256-[a-f0-9]{64}$/.test(renderer?.integrity ?? '') ? renderer!.integrity : null,
          input.sceneFingerprint, event.id]);
      return { recorded: true, duplicate: false, eventId: event.id, grantsMastery: false };
    });
  });
}
