import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { membership, type Actor } from './auth.js';
import { requireCondition } from './errors.js';

type Sql = Database | PoolClient;

export type AdminPermission =
  | "course.read"
  | "course.write"
  | "release.review"
  | "release.publish"
  | "enrollment.read"
  | "enrollment.write"
  | "evidence.review"
  | "policy.read"
  | "policy.write"
  | "extension.propose"
  | "provider.configure"
  | "run.inspect"
  /** Reveal one supervisor run's payload, with an audit receipt (owner/admin only). */
  | "run.payload"
  /** Read-only, audited "view as learner" (owner/admin only). */
  | "learner.view"
  /** The workspace audit log (staff/system payloads only; learner and agent payloads withheld). */
  | "audit.read"
  /** Pause, stop and resume one enrollment's AI supervision. */
  | "supervision.control"
  /** Re-queue, once and with a reason, a supervisor request quarantined after an outage (owner/admin
   * only: it restarts delivery the dispatcher gave up on, which may spend provider budget). */
  | "supervision.requeue"
  /** Retry one supervisor run that failed or ended uncertain (owner/admin only: a new run may
   * spend provider budget). */
  | "run.retry"
  /** Regrade one automated or rubric attempt: a new decision linked to the one it supersedes. */
  | "evidence.regrade"
  /** Aggregate study state: definitions, arm balance and consent counts (no participant rows). */
  | "study.read"
  /** Define, open and close an educational evaluation study (owner/admin only). */
  | "study.manage"
  /** Download a study's pseudonymous research export, audit-logged (owner/admin only). */
  | "study.export";
export const adminPermissionMatrix: Record<string, readonly AdminPermission[]> =
  {
    owner: [
      "course.read",
      "course.write",
      "release.review",
      "release.publish",
      "enrollment.read",
      "enrollment.write",
      "evidence.review",
      "policy.read",
      "policy.write",
      "extension.propose",
      "provider.configure",
      "run.inspect",
      "run.payload",
      "learner.view",
      "audit.read",
      "supervision.control",
      "supervision.requeue",
      "run.retry",
      "evidence.regrade",
      "study.read",
      "study.manage",
      "study.export",
    ],
    admin: [
      "course.read",
      "course.write",
      "release.review",
      "release.publish",
      "enrollment.read",
      "enrollment.write",
      "evidence.review",
      "policy.read",
      "policy.write",
      "extension.propose",
      "provider.configure",
      "run.inspect",
      "run.payload",
      "learner.view",
      "audit.read",
      "supervision.control",
      "supervision.requeue",
      "run.retry",
      "evidence.regrade",
      "study.read",
      "study.manage",
      "study.export",
    ],
    author: ["course.read", "course.write"],
    instructor: [
      "course.read",
      "enrollment.read",
      "enrollment.write",
      "evidence.review",
      "policy.read",
      "extension.propose",
      "run.inspect",
      "supervision.control",
      "evidence.regrade",
      "study.read",
    ],
    reviewer: [
      "course.read",
      "release.review",
      "enrollment.read",
      "evidence.review",
      "policy.read",
      "run.inspect",
      "study.read",
    ],
    observer: ["course.read"],
    /** Read-only support: course, enrollment and policy state plus the audit log. Never
     * evidence decisions, the learner view, exports or anything learner-private. */
    support_observer: ["course.read", "enrollment.read", "policy.read", "audit.read"],
    /** A non-human integration principal: read-only course and enrollment state. */
    service: ["course.read", "enrollment.read"],
    learner: [],
    // course_scoped has no entry: its permissions come only from a course grant's role.
  };

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
 * One authorization rule for every staff route. Any route that lets someone other than the
 * enrollment's own learner act or read must take its role from here (courseRole, permitCourse,
 * enrollmentRole, releaseRole, workspaceRole) and never from membership() directly, so course
 * scope, grant expiry and revocation are honoured everywhere. A test fails when a source file
 * outside this module calls membership().
 *
 * The role that governs what `actor` may do on one course (or, with no course, in the
 * workspace). A workspace role applies to every course. A course_scoped member gets the role
 * of their active grant on that course and nothing anywhere else: an expired or revoked grant
 * ends access on the next request. Null when there is no role at all.
 */
export async function resolveRole(client: Sql, actor: Pick<Actor, 'id'>, workspaceId: string, catalogId?: string | null): Promise<string | null> {
  const role = (await client.query<{ role: string }>('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actor.id])).rows[0]?.role;
  if (!role) return null;
  if (role !== COURSE_SCOPED) return role;
  if (!catalogId) return null;
  return (await activeCourseGrant(client, actor.id, catalogId))?.role ?? null;
}

/** resolveRole, or 403 FORBIDDEN when there is no role (optionally: none of `allowed`). */
export async function effectiveRole(client: Sql, actor: Pick<Actor, 'id'>, workspaceId: string, catalogId?: string | null, allowed?: readonly string[]) {
  const role = await resolveRole(client, actor, workspaceId, catalogId);
  requireCondition(role && (!allowed || allowed.includes(role)), 'FORBIDDEN', 403);
  return role;
}

/**
 * The actor's own membership role, for a learner acting on their own records or for routes
 * that never serve staff. It is not staff authorization: a course_scoped member's raw role
 * carries no permission. 403 FORBIDDEN when not a member (or not one of `allowed`).
 */
export const memberRole = (client: Sql, actor: Actor, workspaceId: string, allowed?: string[]) => membership(client, actor, workspaceId, allowed);

/** Whether the actor holds any membership in the workspace (course_scoped included). */
export const isMember = async (client: Sql, actor: Pick<Actor, 'id'>, workspaceId: string) =>
  ((await client.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actor.id])).rowCount ?? 0) > 0;

/** Whether a role (as resolved above) carries an administration permission. */
export const roleCan = (role: string | null | undefined, permission: AdminPermission) => !!role && (adminPermissionMatrix[role]?.includes(permission) ?? false);

/** The governing role on one course, which must carry `permission` (403 otherwise). */
export async function permitCourse(client: Sql, actor: Pick<Actor, 'id'>, workspaceId: string, catalogId: string | null, permission: AdminPermission) {
  const role = await resolveRole(client, actor, workspaceId, catalogId);
  requireCondition(roleCan(role, permission), 'FORBIDDEN', 403);
  return role!;
}

/** A workspace-wide role (a course grant never confers one), optionally limited to `allowed`. */
export const workspaceRole = (client: Sql, actor: Pick<Actor, 'id'>, workspaceId: string, allowed?: readonly string[]) =>
  effectiveRole(client, actor, workspaceId, null, allowed);

/** The role governing one enrollment: the workspace role, or the grant on its course. */
export async function enrollmentRole(client: Sql, actor: Pick<Actor, 'id'>, enrollment: { workspace_id: string; course_release_id: string }) {
  return resolveRole(client, actor, enrollment.workspace_id, await catalogOfEnrollment(client, enrollment));
}

/** The catalog entry of a release's course in its workspace (null before it is catalogued). */
export async function catalogOfRelease(client: Sql, release: { id: string; workspace_id: string }) {
  return (await client.query<{ id: string }>(
    `SELECT c.id FROM admin_course_catalog c JOIN course_releases r ON r.workspace_id=c.workspace_id AND r.course_key=c.course_key
      WHERE r.id=$1 AND c.workspace_id=$2`, [release.id, release.workspace_id])).rows[0]?.id ?? null;
}

/** The governing role on a release's course, which must carry `permission` (403 otherwise). */
export async function permitRelease(client: Sql, actor: Pick<Actor, 'id'>, release: { id: string; workspace_id: string }, permission: AdminPermission) {
  const role = await releaseRole(client, actor, release);
  requireCondition(roleCan(role, permission), 'FORBIDDEN', 403);
  return role!;
}

/** The role governing one release's course: the workspace role, or the grant on that course. */
export async function releaseRole(client: Sql, actor: Pick<Actor, 'id'>, release: { id: string; workspace_id: string }) {
  return resolveRole(client, actor, release.workspace_id, await catalogOfRelease(client, release));
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
