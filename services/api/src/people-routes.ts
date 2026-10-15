import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { issueLoginCode, membership, type Actor, type authService } from "./auth.js";
import { ApiError, requireCondition } from "./errors.js";
import { hashPassword, normalizeLoginName, storePassword, temporaryPassword } from "./passwords.js";
import { appendEvent } from "./events.js";
import { digestJson } from "./repository.js";
import { COURSE_SCOPED, GRANTABLE_COURSE_ROLES } from "./course-access.js";

const reasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const MAX_GRANT_DAYS = 366;
interface GrantRow {
  id: string; catalog_id: string; user_id: string; role: string; reason_code: string; granted_by: string; created_at: Date; expires_at: Date;
  revoked_at: Date | null; revoked_by: string | null; revoke_reason_code: string | null;
}
const grantView = (g: GrantRow, now = Date.now()) => ({
  grantId: g.id, catalogId: g.catalog_id, userId: g.user_id, role: g.role, reasonCode: g.reason_code, grantedBy: g.granted_by,
  createdAt: g.created_at.toISOString(), expiresAt: g.expires_at.toISOString(), revokedAt: g.revoked_at?.toISOString() ?? null,
  revokeReasonCode: g.revoke_reason_code, state: g.revoked_at ? "revoked" : g.expires_at.getTime() <= now ? "expired" : "active",
});

const ROLES = ["owner", "admin", "author", "instructor", "reviewer", "learner", "observer", "support_observer", "service", "course_scoped"] as const;
type Role = (typeof ROLES)[number];
/** Only owners assign or manage these. A service principal is an integration, not a person. */
const PRIVILEGED: readonly Role[] = ["owner", "admin", "service"];
const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
const loginName = z
  .string()
  .max(512)
  .transform((v, context) => {
    const normalized = normalizeLoginName(v);
    if (!normalized) context.addIssue({ code: "custom", message: "invalid login name" });
    return normalized ?? "";
  });
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v));
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  requireCondition(result.success, "INVALID_INPUT", 400);
  return result.data;
}
/** Owners manage everyone; admins manage non-privileged members only. Nobody
 * changes or revokes their own membership, so a workspace keeps an owner. */
function mayManage(actorRole: string, targetRole: string, nextRole?: string) {
  if (actorRole === "owner") return true;
  if (actorRole !== "admin") return false;
  return !PRIVILEGED.includes(targetRole as Role) && (!nextRole || !PRIVILEGED.includes(nextRole as Role));
}
async function manager(client: Database | PoolClient, actor: Actor, workspaceId: string) {
  const role = await membership(client, actor, workspaceId, ["owner", "admin"]);
  return role as Role;
}
async function target(client: PoolClient, workspaceId: string, userId: string) {
  const row = (
    await client.query<{ role: Role; subject: string; display_name: string }>(
      "SELECT m.role,u.subject,u.display_name FROM memberships m JOIN app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 FOR UPDATE OF m",
      [workspaceId, userId],
    )
  ).rows[0];
  requireCondition(row, "MEMBER_NOT_FOUND", 404);
  return row;
}
/** A one-time code or a password signs a person into EVERY workspace they belong
 * to. Issue either only for accounts invited into this workspace that belong
 * nowhere else, so an admin here cannot take over access granted elsewhere. */
async function linkEligible(client: PoolClient, workspaceId: string, userId: string, subject: string) {
  if (!subject.startsWith(`invite:${workspaceId}:`)) return false;
  const other = await client.query("SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id<>$2 LIMIT 1", [userId, workspaceId]);
  return other.rowCount === 0;
}
async function peopleCommand<T extends object>(
  db: Database,
  actor: Actor,
  workspaceId: string,
  operation: string,
  idempotencyKey: string,
  semantic: unknown,
  execute: (client: PoolClient, role: Role) => Promise<{ response: T; secret?: Record<string, unknown> }>,
): Promise<T & { replayed: boolean }> {
  return transaction(db, async (client) => {
    const role = await manager(client, actor, workspaceId);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["people:" + workspaceId]);
    const digest = digestJson({ actorId: actor.id, operation, semantic });
    const old = (
      await client.query(
        "SELECT request_digest,response FROM people_command_receipts WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspaceId, idempotencyKey],
      )
    ).rows[0];
    if (old) {
      requireCondition(old.request_digest === digest, "IDEMPOTENCY_CONFLICT", 409);
      return { ...(old.response as T), replayed: true };
    }
    const { response, secret } = await execute(client, role);
    await appendEvent(client, {
      workspaceId,
      actorId: actor.id,
      actorKind: "staff",
      type: operation,
      payload: response,
      idempotencyKey: "people:" + idempotencyKey,
    });
    // The receipt never contains a sign-in code; a replay cannot reveal one.
    await client.query(
      "INSERT INTO people_command_receipts(workspace_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,$5)",
      [workspaceId, idempotencyKey, digest, actor.id, JSON.stringify(response)],
    );
    return { ...response, ...(secret ?? {}), replayed: false };
  });
}

export function registerPeopleRoutes(
  app: FastifyInstance,
  db: Database,
  auth: ReturnType<typeof authService>,
  origin: string,
) {
  const uuid = { type: "string", format: "uuid" };
  const params = (...names: string[]) => ({
    type: "object",
    additionalProperties: false,
    required: names,
    properties: Object.fromEntries(names.map((n) => [n, uuid])),
  });
  /** A server-generated temporary password, shown once and never stored in a
   * receipt. The account must choose a new password at its next sign-in, and every
   * existing session of the account ends. */
  const temporary = async (client: PoolClient, userId: string, login: string) => {
    const password = temporaryPassword();
    await storePassword(client, userId, await hashPassword(password), { mustChange: true, loginName: login });
    return { password: { loginName: login, temporaryPassword: password, mustChangeOnNextSignIn: true, adminPath: "/admin/", learnerUrl: new URL(origin).toString() } };
  };
  const signIn = async (client: PoolClient, userId: string) => {
    const code = await issueLoginCode(client as unknown as Database, userId);
    const url = new URL(origin);
    url.hash = "signin=" + code;
    return { signIn: { code, learnerUrl: url.toString(), adminPath: "/admin/", expiresInMinutes: 10 } };
  };
  app.get(
    "/api/admin/workspaces/:workspaceId/people",
    { schema: { params: params("workspaceId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId } = request.params as { workspaceId: string };
      return transaction(db, async (client) => {
        const role = await manager(client, actor, workspaceId);
        const rows = (
          await client.query(
            `SELECT m.user_id,m.role,m.created_at,u.display_name,u.subject,u.login_name,a.display_name AS added_by_name,
               c.must_change,(c.user_id IS NOT NULL) AS has_password,
               (SELECT count(*)::int FROM enrollments e WHERE e.user_id=m.user_id AND e.workspace_id=m.workspace_id) AS enrollments,
               (SELECT max(s.created_at) FROM auth_sessions s WHERE s.user_id=m.user_id) AS last_sign_in,
               EXISTS(SELECT 1 FROM memberships o WHERE o.user_id=m.user_id AND o.workspace_id<>m.workspace_id) AS elsewhere
             FROM memberships m JOIN app_users u ON u.id=m.user_id LEFT JOIN app_users a ON a.id=m.added_by
               LEFT JOIN password_credentials c ON c.user_id=m.user_id
             WHERE m.workspace_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.display_name,m.user_id LIMIT 1000`,
            [workspaceId],
          )
        ).rows;
        return {
          actorRole: role,
          roles: ROLES,
          loginCodes: auth.loginCodes,
          people: rows.map((r) => {
            const self = r.user_id === actor.id;
            const credentialEligible =
              !self && mayManage(role, r.role) && !r.elsewhere && String(r.subject).startsWith(`invite:${workspaceId}:`);
            return {
              userId: r.user_id,
              displayName: r.display_name,
              role: r.role,
              joinedAt: r.created_at.toISOString(),
              addedBy: r.added_by_name ?? null,
              enrollments: r.enrollments,
              lastSignInAt: r.last_sign_in?.toISOString() ?? null,
              self,
              canChangeRole: !self && mayManage(role, r.role),
              canRevoke: !self && mayManage(role, r.role),
              loginName: r.login_name ?? null,
              hasPassword: r.has_password,
              mustChangePassword: r.must_change === true,
              canIssueSignIn: auth.loginCodes && credentialEligible,
              canSetPassword: credentialEligible,
            };
          }),
        };
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:workspaceId/people",
    { schema: { params: params("workspaceId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId } = request.params as { workspaceId: string },
        input = parse(
          z.strictObject({ displayName: name, role: z.enum(ROLES), loginName: loginName.optional(), idempotencyKey: key }),
          request.body,
        );
      return peopleCommand(db, actor, workspaceId, "people.invited", input.idempotencyKey, input, async (client, role) => {
        requireCondition(mayManage(role, "learner", input.role), "ROLE_NOT_ASSIGNABLE", 403);
        // With sign-in codes off (the default), an invitation needs a login name for its temporary password.
        requireCondition(input.loginName !== undefined || auth.loginCodes, "LOGIN_NAME_REQUIRED", 400);
        const userId = randomUUID();
        await client.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [
          userId,
          `invite:${workspaceId}:${userId}`,
          input.displayName,
        ]);
        await client.query("INSERT INTO memberships(workspace_id,user_id,role,added_by) VALUES($1,$2,$3,$4)", [
          workspaceId,
          userId,
          input.role,
          actor.id,
        ]);
        const password = input.loginName !== undefined ? await temporary(client, userId, input.loginName) : {};
        return {
          response: { userId, role: input.role, ...(input.loginName !== undefined ? { loginName: input.loginName } : {}) },
          secret: { ...password, ...(auth.loginCodes ? await signIn(client, userId) : {}) },
        };
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:workspaceId/people/:userId/role",
    { schema: { params: params("workspaceId", "userId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId, userId } = request.params as { workspaceId: string; userId: string },
        input = parse(
          z.strictObject({ role: z.enum(ROLES), expectedRole: z.enum(ROLES), idempotencyKey: key }),
          request.body,
        );
      return peopleCommand(db, actor, workspaceId, "people.role_changed", input.idempotencyKey, { userId, ...input }, async (client, role) => {
        requireCondition(userId !== actor.id, "SELF_CHANGE_FORBIDDEN", 409);
        const current = await target(client, workspaceId, userId);
        requireCondition(current.role === input.expectedRole, "STALE_ROLE", 409);
        requireCondition(mayManage(role, current.role, input.role), "ROLE_NOT_ASSIGNABLE", 403);
        requireCondition(current.role !== input.role, "ROLE_UNCHANGED", 409);
        await client.query("UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId, input.role]);
        return { response: { userId, previousRole: current.role, role: input.role } };
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:workspaceId/people/:userId/sign-in",
    { schema: { params: params("workspaceId", "userId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId, userId } = request.params as { workspaceId: string; userId: string },
        input = parse(z.strictObject({ idempotencyKey: key }), request.body);
      requireCondition(auth.loginCodes, "LOGIN_CODES_DISABLED", 409);
      return peopleCommand(db, actor, workspaceId, "people.sign_in_issued", input.idempotencyKey, { userId }, async (client, role) => {
        requireCondition(userId !== actor.id, "SELF_CHANGE_FORBIDDEN", 409);
        const current = await target(client, workspaceId, userId);
        requireCondition(mayManage(role, current.role), "ROLE_NOT_ASSIGNABLE", 403);
        requireCondition(await linkEligible(client, workspaceId, userId, current.subject), "SIGN_IN_NOT_ISSUABLE", 409);
        return { response: { userId }, secret: await signIn(client, userId) };
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:workspaceId/people/:userId/password",
    { schema: { params: params("workspaceId", "userId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId, userId } = request.params as { workspaceId: string; userId: string },
        input = parse(z.strictObject({ loginName: loginName.optional(), idempotencyKey: key }), request.body);
      return peopleCommand(db, actor, workspaceId, "people.password_reset", input.idempotencyKey, { userId, ...input }, async (client, role) => {
        requireCondition(userId !== actor.id, "SELF_CHANGE_FORBIDDEN", 409);
        const current = await target(client, workspaceId, userId);
        requireCondition(mayManage(role, current.role), "ROLE_NOT_ASSIGNABLE", 403);
        requireCondition(await linkEligible(client, workspaceId, userId, current.subject), "PASSWORD_NOT_SETTABLE", 409);
        const existing = (await client.query<{ login_name: string | null }>("SELECT login_name FROM app_users WHERE id=$1", [userId])).rows[0]?.login_name ?? undefined;
        const login = input.loginName ?? existing;
        if (login === undefined) throw new ApiError(400, "LOGIN_NAME_REQUIRED");
        return { response: { userId, loginName: login, mustChangePassword: true }, secret: await temporary(client, userId, login) };
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:workspaceId/people/:userId/revoke",
    { schema: { params: params("workspaceId", "userId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId, userId } = request.params as { workspaceId: string; userId: string },
        input = parse(
          z.strictObject({ expectedRole: z.enum(ROLES), reason: z.string().trim().min(10).max(1000), idempotencyKey: key }),
          request.body,
        );
      return peopleCommand(db, actor, workspaceId, "people.revoked", input.idempotencyKey, { userId, ...input }, async (client, role) => {
        requireCondition(userId !== actor.id, "SELF_CHANGE_FORBIDDEN", 409);
        const current = await target(client, workspaceId, userId);
        requireCondition(current.role === input.expectedRole, "STALE_ROLE", 409);
        requireCondition(mayManage(role, current.role), "ROLE_NOT_ASSIGNABLE", 403);
        // Learning records are retained; access ends because every read and
        // command re-checks workspace membership.
        // Course grants end with the membership; their rows stay as the access record.
        await client.query(`UPDATE course_access_grants SET revoked_at=clock_timestamp(),revoked_by=$3,revoke_reason_code='membership_revoked'
          WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [workspaceId, userId, actor.id]);
        await client.query("DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
        if (!(await client.query("SELECT 1 FROM memberships WHERE user_id=$1 LIMIT 1", [userId])).rowCount)
          await client.query(
            "UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL",
            [userId],
          );
        return { response: { userId, previousRole: current.role, reason: input.reason, recordsRetained: true } };
      });
    },
  );
  /** Course grants: one role on one course for a course_scoped member, until expiry or revocation. */
  app.get(
    "/api/admin/workspaces/:workspaceId/course-grants",
    { schema: { params: params("workspaceId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId } = request.params as { workspaceId: string };
      return transaction(db, async (client) => {
        await manager(client, actor, workspaceId);
        const rows = (await client.query<GrantRow>(
          "SELECT * FROM course_access_grants WHERE workspace_id=$1 ORDER BY (revoked_at IS NULL) DESC,expires_at DESC,id LIMIT 1000", [workspaceId])).rows;
        return { grantableRoles: GRANTABLE_COURSE_ROLES, grants: rows.map((g) => grantView(g)) };
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:workspaceId/course-grants",
    { schema: { params: params("workspaceId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId } = request.params as { workspaceId: string },
        input = parse(
          z.strictObject({ userId: z.uuid(), catalogId: z.uuid(), role: z.enum(GRANTABLE_COURSE_ROLES), expiresAt: z.iso.datetime({ offset: true }),
            reasonCode, idempotencyKey: key }),
          request.body,
        );
      return peopleCommand(db, actor, workspaceId, "people.course_grant_created", input.idempotencyKey, input, async (client) => {
        requireCondition(input.userId !== actor.id, "SELF_CHANGE_FORBIDDEN", 409);
        const expires = Date.parse(input.expiresAt), now = Date.now();
        requireCondition(expires > now && expires <= now + MAX_GRANT_DAYS * 86_400_000, "GRANT_EXPIRY_INVALID", 400);
        const current = await target(client, workspaceId, input.userId);
        // A workspace role already covers every course; grants are only for course-scoped members.
        requireCondition(current.role === COURSE_SCOPED, "COURSE_SCOPED_MEMBER_REQUIRED", 409);
        requireCondition((await client.query("SELECT 1 FROM admin_course_catalog WHERE id=$1 AND workspace_id=$2", [input.catalogId, workspaceId])).rowCount, "COURSE_NOT_FOUND", 404);
        // An expired grant is closed before a new one opens (one open grant per person and course).
        await client.query(`UPDATE course_access_grants SET revoked_at=clock_timestamp(),revoked_by=$3,revoke_reason_code='expired'
          WHERE catalog_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at <= clock_timestamp()`, [input.catalogId, input.userId, actor.id]);
        requireCondition(!(await client.query("SELECT 1 FROM course_access_grants WHERE catalog_id=$1 AND user_id=$2 AND revoked_at IS NULL", [input.catalogId, input.userId])).rowCount,
          "COURSE_GRANT_EXISTS", 409);
        const grant = (await client.query<GrantRow>(
          `INSERT INTO course_access_grants(id,workspace_id,catalog_id,user_id,role,reason_code,granted_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [randomUUID(), workspaceId, input.catalogId, input.userId, input.role, input.reasonCode, actor.id, new Date(expires)])).rows[0]!;
        return { response: grantView(grant) };
      });
    },
  );
  app.post(
    "/api/admin/workspaces/:workspaceId/course-grants/:grantId/revoke",
    { schema: { params: params("workspaceId", "grantId") } },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId, grantId } = request.params as { workspaceId: string; grantId: string },
        input = parse(z.strictObject({ reasonCode, idempotencyKey: key }), request.body);
      return peopleCommand(db, actor, workspaceId, "people.course_grant_revoked", input.idempotencyKey, { grantId, ...input }, async (client) => {
        const grant = (await client.query<GrantRow>("SELECT * FROM course_access_grants WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [grantId, workspaceId])).rows[0];
        requireCondition(grant, "COURSE_GRANT_NOT_FOUND", 404);
        requireCondition(grant.revoked_at === null, "COURSE_GRANT_REVOKED", 409);
        const revoked = (await client.query<GrantRow>(
          "UPDATE course_access_grants SET revoked_at=clock_timestamp(),revoked_by=$2,revoke_reason_code=$3 WHERE id=$1 RETURNING *", [grantId, actor.id, input.reasonCode])).rows[0]!;
        return { response: grantView(revoked) };
      });
    },
  );
}
