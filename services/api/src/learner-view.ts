import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { Actor, authService } from './auth.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { loadEnrollment, type Enrollment } from './repository.js';
import { learnerSnapshot } from './learner-snapshot.js';
import { personalChanges } from './personal-changes.js';
import { learnerReviews } from './rubric-review.js';
import { WITHHELD_FROM_STAFF } from './learner-privacy.js';
import { activeAttachment, attachedMedia, sendAsset } from './media-jobs.js';

/** Roles that may open a learner's view. Instructors, reviewers and other staff
 * keep their scoped evidence/review access but never the whole learner view. */
export const LEARNER_VIEW_ROLES = ['owner', 'admin'] as const;

const params = { type: 'object', additionalProperties: false, required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
const mediaParams = { type: 'object', additionalProperties: false, required: ['enrollmentId', 'viewId', 'attachmentId'],
  properties: { enrollmentId: { type: 'string', format: 'uuid' }, viewId: { type: 'string', format: 'uuid' }, attachmentId: { type: 'string', format: 'uuid' } } };
/** How long the media of one recorded view stays playable from it. Reopening the view
 * records a new view and gives fresh links. */
export const LEARNER_VIEW_MEDIA_WINDOW_MINUTES = 60;

/** Outside the enrollment's workspace the enrollment does not exist (404). Inside
 * it, only owners and admins may view (403). Erased learning data stays gone (410). */
async function authorizeView(client: PoolClient, actor: Actor, enrollmentId: string, lock: boolean) {
  const enrollment = (await client.query<Enrollment>(`SELECT * FROM enrollments WHERE id=$1 ${lock ? 'FOR SHARE' : ''}`, [enrollmentId])).rows[0];
  requireCondition(enrollment, 'ENROLLMENT_NOT_FOUND', 404);
  const role = (await client.query<{ role: string }>('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [enrollment.workspace_id, actor.id])).rows[0]?.role;
  requireCondition(role, 'ENROLLMENT_NOT_FOUND', 404);
  requireCondition((LEARNER_VIEW_ROLES as readonly string[]).includes(role), 'FORBIDDEN', 403);
  requireCondition(enrollment.status !== 'erased', 'ENROLLMENT_ERASED', 410);
  return { enrollment, role: role as (typeof LEARNER_VIEW_ROLES)[number] };
}

/** Staff views of one enrollment, oldest first, for the learner and their export. */
export async function staffViewsOf(client: Database | PoolClient, enrollmentId: string) {
  return (await client.query<{ id: string; viewed_at: Date; viewer_id: string; viewer_name: string; viewer_role: string }>(
    `SELECT v.id,v.created_at AS viewed_at,v.viewer_id,u.display_name AS viewer_name,v.viewer_role
     FROM staff_learner_views v JOIN app_users u ON u.id=v.viewer_id WHERE v.enrollment_id=$1 ORDER BY v.created_at,v.id`, [enrollmentId])).rows
    .map(row => ({ id: row.id, viewedAt: row.viewed_at.toISOString(), viewerId: row.viewer_id, viewerName: row.viewer_name, viewerRole: row.viewer_role }));
}

/** Downloads of one enrollment's data by owners or admins (append-only
 * data_exports rows), oldest first. Exports recorded before roles were stored
 * report the role as "staff". The learner's own downloads are not listed. */
export async function staffExportsOf(client: Database | PoolClient, enrollmentId: string) {
  return (await client.query<{ id: string; exported_at: Date; exporter_id: string; exporter_name: string; exporter_role: string | null; digest: string }>(
    `SELECT x.id,x.created_at AS exported_at,x.requested_by AS exporter_id,u.display_name AS exporter_name,x.requester_role AS exporter_role,x.digest
     FROM data_exports x JOIN app_users u ON u.id=x.requested_by WHERE x.enrollment_id=$1 AND x.actor_kind='staff' ORDER BY x.created_at,x.id`, [enrollmentId])).rows
    .map(row => ({ id: row.id, exportedAt: row.exported_at.toISOString(), exporterId: row.exporter_id, exporterName: row.exporter_name,
      exporterRole: row.exporter_role ?? 'staff', digest: row.digest }));
}

export function registerLearnerViewRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  /** Read-only "view as learner". Records the view first, then reads the
   * learner's snapshot in a read-only transaction. It issues no session or
   * cookie for the learner and the actor stays the staff member, so every
   * learner command still refuses them. */
  app.get('/api/admin/enrollments/:enrollmentId/learner-view', { schema: { params } }, async (request, reply) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const audit = await transaction(db, async client => {
      const { enrollment, role } = await authorizeView(client, actor, enrollmentId, true);
      const id = randomUUID();
      const saved = (await client.query<{ created_at: Date }>(
        'INSERT INTO staff_learner_views(id,enrollment_id,workspace_id,viewer_id,viewer_role,enrollment_revision) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at',
        [id, enrollment.id, enrollment.workspace_id, actor.id, role, enrollment.revision])).rows[0]!;
      // Workspace audit stream; no learner content and not part of the learner's
      // activity feed or supervision (the learner sees views through their own list).
      await appendEvent(client, { workspaceId: enrollment.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'learner.viewed_by_staff',
        payload: { enrollmentId: enrollment.id, viewId: id, viewerRole: role }, idempotencyKey: `staff-view:${id}` });
      return { id, viewedAt: saved.created_at.toISOString(), role };
    });
    const view = await transaction(db, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await authorizeView(client, actor, enrollmentId, false);
      const context = await loadEnrollment(client, actor, enrollmentId, false, true);
      // Course-made media the learner is shown, with links that only play under this recorded view.
      const base = `/api/admin/enrollments/${enrollmentId}/learner-view/${audit.id}/media`;
      return {
        snapshot: await learnerSnapshot(client, context),
        personalChanges: await personalChanges(client, context),
        reviews: (await learnerReviews(client, context, 'staff')).reviews,
        generatedMedia: (await attachedMedia(client, context.enrollment.id, context.enrollment.workspace_id)).map(item => ({
          ...item, state: 'available' as const, assetUrl: `${base}/${item.id}/asset`, captionsUrl: item.captions ? `${base}/${item.id}/captions.vtt` : null,
        })),
      };
    });
    reply.header('Cache-Control', 'no-store');
    return {
      readOnly: true as const,
      view: { id: audit.id, viewedAt: audit.viewedAt, viewer: { id: actor.id, name: actor.displayName, role: audit.role }, visibleToLearner: true },
      learner: { displayName: typeof view.snapshot.profile.displayName === 'string' ? view.snapshot.profile.displayName : 'Learner' },
      ...view,
      // The shared staff privacy rule (learner-privacy.ts): never read, listed here.
      withheld: WITHHELD_FROM_STAFF,
    };
  });
  /** The clip and captions of media shown in a read-only learner view. They play only under a
   * view this staff member opened (and that was recorded) within the last hour, for media the
   * learner can currently see; the view record is the audit entry for what was shown. */
  async function viewedAttachment(request: { params: unknown }, actor: Actor) {
    const { enrollmentId, viewId, attachmentId } = request.params as { enrollmentId: string; viewId: string; attachmentId: string };
    return transaction(db, async client => {
      await authorizeView(client, actor, enrollmentId, false);
      const recorded = await client.query(
        `SELECT 1 FROM staff_learner_views WHERE id=$1 AND enrollment_id=$2 AND viewer_id=$3 AND created_at>clock_timestamp()-make_interval(mins => $4)`,
        [viewId, enrollmentId, actor.id, LEARNER_VIEW_MEDIA_WINDOW_MINUTES]);
      requireCondition(recorded.rowCount, 'LEARNER_VIEW_REQUIRED', 403);
      return activeAttachment(client, enrollmentId, attachmentId);
    });
  }
  app.get('/api/admin/enrollments/:enrollmentId/learner-view/:viewId/media/:attachmentId/asset', { schema: { params: mediaParams } }, async (request, reply) => {
    const row = await viewedAttachment(request, await auth.authenticate(request));
    reply.header('Cache-Control', 'no-store');
    return sendAsset(db, row.job_id, request.headers.range, reply);
  });
  app.get('/api/admin/enrollments/:enrollmentId/learner-view/:viewId/media/:attachmentId/captions.vtt', { schema: { params: mediaParams } }, async (request, reply) => {
    const row = await viewedAttachment(request, await auth.authenticate(request));
    requireCondition(row.captions_vtt, 'MEDIA_NOT_FOUND', 404);
    return reply.header('Cache-Control', 'no-store').header('Content-Type', 'text/vtt; charset=utf-8').send(row.captions_vtt);
  });
  /** The learner's own list of staff access to their record: read-only views
   * and data downloads by owners and admins. */
  app.get('/api/enrollments/:enrollmentId/staff-views', { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const context = await loadEnrollment(db, actor, enrollmentId);
    return {
      views: (await staffViewsOf(db, context.enrollment.id)).map(({ viewerId: _id, ...row }) => row),
      exports: (await staffExportsOf(db, context.enrollment.id)).map(({ exporterId: _id, digest: _digest, ...row }) => row),
    };
  });
}
