import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { membership, type Actor } from './auth.js';
import { requireCondition } from './errors.js';

type Sql = Database | PoolClient;

/** A member with no workspace-wide role. Their only access is through course grants. */
export const COURSE_SCOPED = 'course_scoped';
/** Roles a course grant may confer. Owner, admin and service stay workspace-wide only. */
export const GRANTABLE_COURSE_ROLES = ['author', 'instructor', 'reviewer', 'observer', 'support_observer'] as const;

/** The active (unrevoked, unexpired) course grant role of a person on one course, or null. */
export async function activeCourseGrant(client: Sql, userId: string, catalogId: string) {
  return (await client.query<{ id: string; role: string; expires_at: Date }>(
    `SELECT id,role,expires_at FROM course_access_grants
      WHERE catalog_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > clock_timestamp()`, [catalogId, userId])).rows[0] ?? null;
}

/**
 * The role that governs what `actor` may do on one course (or, with no course, in the
 * workspace). A workspace role applies to every course. A course_scoped member gets the role
 * of their active grant on that course and nothing anywhere else: an expired or revoked grant
 * ends access on the next request. Throws 403 FORBIDDEN when there is no role at all.
 */
export async function effectiveRole(client: Sql, actor: Actor, workspaceId: string, catalogId?: string | null) {
  const role = await membership(client, actor, workspaceId);
  if (role !== COURSE_SCOPED) return role;
  requireCondition(catalogId, 'FORBIDDEN', 403);
  const grant = await activeCourseGrant(client, actor.id, catalogId);
  requireCondition(grant, 'FORBIDDEN', 403);
  return grant.role;
}

/** The catalog entry an enrollment belongs to (its release's course key in its workspace). */
export async function catalogOfEnrollment(client: Sql, enrollment: { workspace_id: string; course_release_id: string }) {
  return (await client.query<{ id: string }>(
    `SELECT c.id FROM admin_course_catalog c JOIN course_releases r ON r.workspace_id=c.workspace_id AND r.course_key=c.course_key
      WHERE r.id=$1 AND c.workspace_id=$2`, [enrollment.course_release_id, enrollment.workspace_id])).rows[0]?.id ?? null;
}

/** Courses an actor may open in administration: every course of a workspace where they hold
 * a staff role, plus each course of an active grant where they are course_scoped. */
export async function sessionCourses(client: Sql, actorId: string) {
  return (await client.query<{ id: string; title: string; description: string; workspace_id: string; workspace_title: string; role: string; grant_expires_at: Date | null }>(
    `SELECT c.id,c.title,c.description,c.workspace_id,w.title AS workspace_title,m.role,NULL::timestamptz AS grant_expires_at
       FROM admin_course_catalog c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.user_id=$1 JOIN workspaces w ON w.id=c.workspace_id
      WHERE m.role NOT IN ('learner','course_scoped')
     UNION ALL
     SELECT c.id,c.title,c.description,c.workspace_id,w.title,g.role,g.expires_at
       FROM course_access_grants g JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.user_id AND m.role='course_scoped'
       JOIN admin_course_catalog c ON c.id=g.catalog_id JOIN workspaces w ON w.id=c.workspace_id
      WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
     ORDER BY workspace_title,title`, [actorId])).rows;
}
