import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { authService } from './auth.js';
import { transaction, type Database } from './database.js';
import { appendEvent } from './events.js';
import { loadEnrollment } from './repository.js';
import { recordSessionEnded } from './teaching-hypotheses.js';

/**
 * Study sessions and trigger T10's "session ended" signal (design §4 trigger table, requirement B03).
 *
 * A session is a run of the learner's own learning events (migration 108 keeps one row per
 * enrollment, opened or extended by a database trigger on every learner event). It ends when the
 * learner leaves (the app reports it when the page is hidden for good or the learner signs out) or
 * after a quiet period, found by the wake-up scan. Ending is one guarded transition, so a session
 * ends once however many tabs, retries or scans report it. Each end is a `session.ended` event;
 * with the learner's supervision opt-in it is T10's signal to prepare what comes next (the next
 * unfinished lesson's objectives) within budget, coalescing with a review that came due for the
 * same objectives. Nothing here is evidence, and no notification is sent.
 */
export type SessionEndReason = 'learner_left' | 'idle';
/** How long without a learner event before a session counts as ended. */
export const SESSION_IDLE_MS = 30 * 60_000;

interface Bundle { chapters?: { episodes: { id: string; objectiveIds?: string[] }[] }[] }
/** The objectives of the first lesson the learner has not finished, in course order (at most 20). */
export function nextObjectives(bundle: Bundle, finished: ReadonlySet<string>) {
  const next = (bundle.chapters ?? []).flatMap(c => c.episodes).find(e => !finished.has(e.id));
  return { episodeId: next?.id ?? null, objectiveIds: [...new Set(next?.objectiveIds ?? [])].slice(0, 20) };
}

/**
 * Ends the enrollment's open session, at most once, inside the caller's transaction. Returns null
 * when there was no open session (already ended, or never started). An idle end only applies to a
 * session still quiet at `quietSince`, so activity that arrived meanwhile keeps it open.
 */
export async function endLearnerSession(client: PoolClient, enrollmentId: string, reason: SessionEndReason, options: { quietSince?: Date; actorId?: string } = {}) {
  const ended = (await client.query<{ workspace_id: string; started_at: Date; last_activity_at: Date; sessions: number }>(
    `UPDATE learner_sessions SET ended_at=clock_timestamp(),end_reason=$2 WHERE enrollment_id=$1 AND ended_at IS NULL
       AND ($3::timestamptz IS NULL OR last_activity_at<=$3) RETURNING workspace_id,started_at,last_activity_at,sessions`,
    [enrollmentId, reason, options.quietSince ?? null])).rows[0];
  if (!ended) return null;
  const event = await appendEvent(client, { workspaceId: ended.workspace_id, enrollmentId, actorKind: reason === 'learner_left' ? 'learner' : 'system',
    ...(reason === 'learner_left' && options.actorId ? { actorId: options.actorId } : {}), type: 'session.ended',
    payload: { reason, session: ended.sessions, startedAt: ended.started_at.toISOString(), lastActivityAt: ended.last_activity_at.toISOString() },
    idempotencyKey: `session-ended:${enrollmentId}:${ended.sessions}` });
  // Only an active enrollment prepares anything next.
  const release = (await client.query<{ digest: string; server_bundle: Bundle }>(`SELECT r.digest,r.server_bundle FROM enrollments e
    JOIN course_releases r ON r.id=e.course_release_id AND r.workspace_id=e.workspace_id WHERE e.id=$1 AND e.status='active'`, [enrollmentId])).rows[0];
  let decision: Awaited<ReturnType<typeof recordSessionEnded>> = null;
  if (release) {
    const finished = new Set((await client.query<{ episode_id: string }>(
      "SELECT episode_id FROM episode_progress WHERE enrollment_id=$1 AND state IN ('completed','placed')", [enrollmentId])).rows.map(r => r.episode_id));
    const next = nextObjectives(release.server_bundle, finished);
    decision = await recordSessionEnded(client, { enrollmentId, workspaceId: ended.workspace_id, courseDigest: release.digest, bundle: release.server_bundle,
      objectiveIds: next.objectiveIds, eventId: event.id, episodeId: next.episodeId, session: ended.sessions });
  }
  return { eventId: event.id, session: ended.sessions, reason, decision };
}

/** Open sessions that have been quiet for `idleMs`, oldest first (the wake-up scan ends them). */
export async function quietSessions(client: Pick<PoolClient, 'query'>, now: Date, idleMs: number, limit: number) {
  return (await client.query<{ enrollment_id: string }>(
    `SELECT s.enrollment_id FROM learner_sessions s JOIN enrollments e ON e.id=s.enrollment_id
     WHERE s.ended_at IS NULL AND s.last_activity_at<=$1 AND e.status<>'erased' ORDER BY s.last_activity_at,s.enrollment_id LIMIT $2`,
    [new Date(now.getTime() - idleMs), limit])).rows.map(r => r.enrollment_id);
}

/**
 * POST /api/enrollments/:enrollmentId/session/end: the learner app reports that the learner left
 * (the page was hidden for good, or they signed out). Only the enrollment's own learner may report
 * it. Repeats, other tabs and a later idle scan find the session already ended and change nothing.
 */
export function registerLearnerSessionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  app.post('/api/enrollments/:enrollmentId/session/end', {
    bodyLimit: 256,
    schema: {
      params: { type: 'object', additionalProperties: false, properties: { enrollmentId: { type: 'string', format: 'uuid' } }, required: ['enrollmentId'] },
      body: { type: 'object', additionalProperties: false, properties: {} },
    },
  }, async request => {
    const actor = await auth.authenticate(request);
    const { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async client => {
      await loadEnrollment(client, actor, enrollmentId);
      const ended = await endLearnerSession(client, enrollmentId, 'learner_left', { actorId: actor.id });
      return ended ? { ended: true, session: ended.session } : { ended: false };
    });
  });
}
