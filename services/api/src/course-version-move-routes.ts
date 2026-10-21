/**
 * Moving enrolled learners to a newer version of their course (course-version-moves.ts, K13).
 * `:courseId` is the admin catalog id.
 *
 * GET  /api/admin/courses/:courseId/version-moves                    enrollment.read: versions with
 *        learner counts and the newer versions each can move to; recent moves.
 * GET  /api/admin/courses/:courseId/version-moves/learners?releaseId  enrollment.read: learners on a version.
 * POST /api/admin/courses/:courseId/version-moves/preview            policy.write + enrollment.write:
 *        {fromReleaseId, toReleaseId, enrollmentId?}: what the move does to each learner. Stored for 15 minutes.
 * GET  /api/admin/courses/:courseId/version-moves/:moveId            enrollment.read: a confirmed move, per learner.
 * POST /api/admin/courses/:courseId/version-moves/:moveId/confirm    {previewDigest, reason, acknowledgeLostCredit}.
 * POST /api/admin/courses/:courseId/version-moves/:moveId/undo       {reason, enrollmentIds?}: back where safe.
 * POST /api/admin/courses/:courseId/version-moves/:moveId/cancel     cancels the moves still waiting.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { authService, Actor } from './auth.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { roleCan } from './course-access.js';
import { catalogFor } from './admin-routes.js';
import type { RuntimeExtension } from './publication.js';
import { cancelWaiting, confirmMove, moveDetail, previewMove, undoMove, versionLearners, versionMovesView, withNames } from './course-version-moves.js';

type Auth = ReturnType<typeof authService>;
const uuid = z.uuid();
const reason = z.string().trim().min(1).max(1000);
const params = (request: FastifyRequest) => request.params as Record<string, string>;
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}

export function registerCourseVersionMoveRoutes(app: FastifyInstance, db: Database, auth: Auth, options: { installedExtensions?: RuntimeExtension[] } = {}) {
  const base = '/api/admin/courses/:courseId/version-moves';
  const installed = options.installedExtensions ?? [];
  /** Moving learners changes their enrollment and their policy: it needs both permissions. */
  async function writer(client: PoolClient, actor: Actor, courseId: string) {
    const { catalog, role } = await catalogFor(client, actor, courseId, 'policy.write', true);
    requireCondition(roleCan(role, 'enrollment.write'), 'FORBIDDEN', 403);
    return catalog;
  }
  async function ownMove(client: PoolClient, catalogId: string, moveId: string) {
    parse(uuid, moveId);
    requireCondition((await client.query('SELECT 1 FROM course_version_moves WHERE id=$1 AND catalog_id=$2', [moveId, catalogId])).rowCount, 'MOVE_NOT_FOUND', 404);
  }

  app.get(base, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!, 'enrollment.read');
      return { ...(await versionMovesView(client, catalog)), permissions: { move: roleCan(role, 'policy.write') && roleCan(role, 'enrollment.write') } };
    });
  });
  app.get(`${base}/learners`, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, 'enrollment.read');
      const { releaseId } = parse(z.strictObject({ releaseId: uuid }), request.query);
      return { learners: await versionLearners(client, catalog, releaseId) };
    });
  });
  app.post(`${base}/preview`, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const catalog = await writer(client, actor, params(request).courseId!);
      const input = parse(z.strictObject({ fromReleaseId: uuid, toReleaseId: uuid, enrollmentId: uuid.optional() }), request.body);
      return withNames(client, await previewMove(client, catalog, actor.id, input, installed));
    });
  });
  app.get(`${base}/:moveId`, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, 'enrollment.read');
      await ownMove(client, catalog.id, params(request).moveId!);
      return moveDetail(client, params(request).moveId!);
    });
  });
  app.post(`${base}/:moveId/confirm`, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const catalog = await writer(client, actor, params(request).courseId!);
      const input = parse(z.strictObject({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/), reason, acknowledgeLostCredit: z.boolean().default(false) }), request.body);
      await ownMove(client, catalog.id, params(request).moveId!);
      return confirmMove(client, catalog, actor.id, { moveId: params(request).moveId!, ...input }, installed);
    });
  });
  app.post(`${base}/:moveId/undo`, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const catalog = await writer(client, actor, params(request).courseId!);
      const input = parse(z.strictObject({ reason, enrollmentIds: z.array(uuid).min(1).max(500).optional() }), request.body);
      await ownMove(client, catalog.id, params(request).moveId!);
      const result = await undoMove(client, catalog, actor.id, { moveId: params(request).moveId!, ...input });
      return { ...result, move: await moveDetail(client, result.moveId) };
    });
  });
  app.post(`${base}/:moveId/cancel`, async request => {
    const actor = await auth.authenticate(request);
    return transaction(db, async client => {
      const catalog = await writer(client, actor, params(request).courseId!);
      parse(z.strictObject({}), request.body ?? {});
      await ownMove(client, catalog.id, params(request).moveId!);
      const result = await cancelWaiting(client, catalog, actor.id, params(request).moveId!);
      return { ...result, move: await moveDetail(client, result.moveId) };
    });
  });
}
