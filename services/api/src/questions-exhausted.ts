import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { loadEnrollment } from './repository.js';
import { requireCondition } from './errors.js';
import { readRelease } from './release-cache.js';
import { adaptationSummary } from './adaptation-store.js';
import { assessmentRecovery } from './assessment-recovery.js';
import { appendEvent } from './events.js';
import { notifyStaffOfExhaustedQuestions } from './notifications.js';

/**
 * A learner whose lesson needs another independent question while none is left: the lesson's own
 * items were all used and no approved fresh family covers what is missing (assessment-recovery.ts).
 * The learner app reports it when it shows that state; the server checks the state itself, records
 * it once per lesson and course version (`assessment.questions_exhausted`) and tells the staff who
 * can add questions (`questions_exhausted`). Nothing about progress or credit changes.
 */
const params = { type: 'object', additionalProperties: false, required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
const body = { type: 'object', additionalProperties: false, required: ['episodeId'], properties: { episodeId: { type: 'string', pattern: '^[a-z][a-z0-9._:-]{0,127}$' } } };
export function registerQuestionsExhaustedRoute(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  app.post('/api/enrollments/:enrollmentId/recovery/exhausted', { schema: { params, body } }, async request => {
    const actor = await auth.authenticate(request);
    const { enrollmentId } = request.params as { enrollmentId: string }, { episodeId } = request.body as { episodeId: string };
    return transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, true);
      requireCondition(context.enrollment.user_id === actor.id, 'ENROLLMENT_NOT_FOUND', 404);
      const told = await recordExhaustedQuestions(client, context, episodeId);
      return { told };
    });
  });
}
type Context = Awaited<ReturnType<typeof loadEnrollment>>;
async function recordExhaustedQuestions(client: PoolClient, context: Context, episodeId: string) {
  const enrollment = context.enrollment;
  const base = (await readRelease(client, enrollment.course_release_id, enrollment.workspace_id))!;
  const registry = await adaptationSummary(client, enrollment, base, context.release.server_bundle);
  const exposed = (await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1 AND course_digest=$2',
    [enrollment.id, base.digest])).rows.map(row => row.assessment_id);
  const entry = assessmentRecovery(context.release.server_bundle, base.digest, context.progress, context.evidence, exposed, registry.approvedFamilies)
    .find(row => row.episodeId === episodeId);
  // Only the real state is reported: a lesson with a fresh question to offer, or none needed, is refused.
  requireCondition(entry && !entry.freshCheck, 'QUESTIONS_AVAILABLE', 409);
  const idempotencyKey = `questions-exhausted:${episodeId}:${base.digest}`;
  const seen = (await client.query('SELECT 1 FROM learning_events WHERE enrollment_id=$1 AND idempotency_key=$2', [enrollment.id, idempotencyKey])).rowCount;
  if (!seen) {
    await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: enrollment.user_id, actorKind: 'learner',
      type: 'assessment.questions_exhausted', payload: { episodeId, courseDigest: base.digest }, idempotencyKey });
    await notifyStaffOfExhaustedQuestions(client, enrollment.workspace_id);
  }
  return true;
}
