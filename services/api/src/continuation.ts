import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { checkContinuation } from '@course-core/policy';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { enrollmentCommand, loadEnrollment, type CommandInput } from './repository.js';
import { assertPolicyAction, loadPolicy } from './policy-adapter.js';

/**
 * The optional continuation track after a course closes (completed, or ended at its cap with
 * gaps). A learner who opts in explicitly keeps spaced review checks on what they learned and
 * reading access; nothing on the track is required, it adds no work, grants no credit, and the
 * closed enrollment and its closure report stay exactly as they were. The learner may stop at
 * any time. Bounded explanatory questions after closure keep their own closed-course budget.
 */
export interface ContinuationTrack { state: 'active' | 'stopped'; optedInAt: string; stoppedAt: string | null; revision: number }

export async function continuationTrack(client: PoolClient, enrollmentId: string): Promise<ContinuationTrack | null> {
  const row = (await client.query<{ state: 'active' | 'stopped'; opted_in_at: Date; stopped_at: Date | null; revision: number }>(
    'SELECT state,opted_in_at,stopped_at,revision FROM continuation_tracks WHERE enrollment_id=$1', [enrollmentId])).rows[0];
  return row ? { state: row.state, optedInAt: row.opted_in_at.toISOString(), stoppedAt: row.stopped_at?.toISOString() ?? null, revision: row.revision } : null;
}

/** A review step (a spaced retention check and its answer). On an open enrollment it is the
 * ordinary policy check; on a closed one it is allowed only on an active continuation track. */
export async function assertReviewAllowed(client: PoolClient, enrollmentId: string, episodeId: string, kind: 'plan' | 'submit', now: string) {
  const policy = await loadPolicy(client, enrollmentId);
  if (policy.status !== 'closed') return assertPolicyAction(client, enrollmentId, episodeId, kind, now);
  const track = await continuationTrack(client, enrollmentId);
  const result = checkContinuation(policy, { scopeId: `episode:${episodeId}`, now, kind: 'review', track: track && { state: track.state, optedInAt: track.optedInAt } });
  if (!result.allowed) throw new ApiError(409, result.violations[0]!);
  return undefined;
}

/** The learner's continuation view: whether they can opt in, and what the track would cover. */
async function view(client: PoolClient, enrollmentId: string, revision: number) {
  const policy = await loadPolicy(client, enrollmentId), track = await continuationTrack(client, enrollmentId);
  const closure = policy.closure;
  return { revision, available: policy.status === 'closed', track,
    // What review can still help with: the objectives the closure left unproven (from the report).
    reviewFocus: closure ? { unprovenConceptIds: closure.unprovenConceptIds, uncoveredObjectiveIds: closure.uncoveredObjectiveIds } : null,
    terms: { requiredWork: false, credit: false, reopensCourse: false, canStopAnytime: true } };
}

export function registerContinuationRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const path = '/api/enrollments/:enrollmentId/continuation';
  const params = { type: 'object', additionalProperties: false, required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
  const base = { expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 } };
  app.get(path, { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId);
      return view(client, enrollmentId, context.enrollment.revision);
    });
  });
  app.post(path, { schema: { params, body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'idempotencyKey', 'explicitConsent'],
    properties: { ...base, explicitConsent: { const: true } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as CommandInput & { explicitConsent: true };
    return enrollmentCommand(db, actor, enrollmentId, 'continuation.opt_in', input, async (client, context) => {
      // Only the learner chooses this for themselves; staff cannot opt a learner in.
      requireCondition(context.enrollment.user_id === actor.id, 'FORBIDDEN', 403);
      const policy = await loadPolicy(client, enrollmentId);
      requireCondition(policy.status === 'closed', 'ENROLLMENT_NOT_CLOSED', 409);
      const current = await continuationTrack(client, enrollmentId);
      requireCondition(current?.state !== 'active', 'CONTINUATION_ALREADY_ACTIVE', 409);
      await client.query(`INSERT INTO continuation_tracks(enrollment_id,workspace_id,state) VALUES($1,$2,'active')
        ON CONFLICT(enrollment_id) DO UPDATE SET state='active',opted_in_at=clock_timestamp(),stopped_at=NULL,revision=continuation_tracks.revision+1`,
      [enrollmentId, context.enrollment.workspace_id]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'continuation.opted_in',
        payload: { focus: 'review', closureReason: policy.closure?.reason ?? null }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return view(client, enrollmentId, context.enrollment.revision + 1);
    });
  });
  app.post(`${path}/stop`, { schema: { params, body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'idempotencyKey'], properties: base } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const input = request.body as CommandInput;
    return enrollmentCommand(db, actor, enrollmentId, 'continuation.stop', input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, 'FORBIDDEN', 403);
      const stopped = await client.query("UPDATE continuation_tracks SET state='stopped',stopped_at=clock_timestamp(),revision=revision+1 WHERE enrollment_id=$1 AND state='active'", [enrollmentId]);
      requireCondition(stopped.rowCount === 1, 'CONTINUATION_NOT_ACTIVE', 409);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'continuation.stopped',
        payload: {}, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return view(client, enrollmentId, context.enrollment.revision + 1);
    });
  });
}
