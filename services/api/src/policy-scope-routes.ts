import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { applyAccommodation, previewAccommodation } from "@course-core/policy";
import type { CourseManifest } from "@course-core/sdk";
import { authService } from "./auth.js";
import { permitCourse } from "./course-access.js";
import { transaction, type Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson } from "./repository.js";
import {
  DEFAULT_ORGANIZATION_CEILINGS, loadPolicy, organizationCeilings, organizationCeilingsSchema, publicationPolicyCheck,
} from "./policy-adapter.js";
import { catalogFor, savePolicy } from "./admin-routes.js";

/**
 * Policy levels and cross-learner allowance administration:
 *
 * - organization ceilings (the outermost level of organization → course → enrollment →
 *   chapter → episode), previewed against every course before saving;
 * - the saved history of organization and course policy settings, and each enrollment's
 *   policy revisions;
 * - one reviewed accommodation or outage adjustment applied to many learners at once,
 *   with a batch audit trail and each learner's own ledger entry;
 * - one view across learners of extension offers waiting for approval, grants,
 *   accommodations and allowance use.
 */
type Auth = ReturnType<typeof authService>;
const uuid = z.uuid();
const reason = z.string().trim().min(1).max(300);
const digestText = z.string().regex(/^[a-f0-9]{64}$/);
const PREVIEW_MINUTES = 15;
/** Most learners one batch reaches; a larger cohort is adjusted in several batches. */
export const BATCH_LIMIT = 500;
const COURSE_PREVIEW_LIMIT = 50;
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, "INVALID_REQUEST");
  return parsed.data;
}
const params = (request: FastifyRequest) => request.params as Record<string, string>;
const codeOf = (error: unknown) => (error as { code?: unknown })?.code;

const ceilingsInput = organizationCeilingsSchema.superRefine((value, context) => {
  if (value.hardDeadline && Number.isNaN(Date.parse(value.hardDeadline))) context.addIssue({ code: "custom", message: "Invalid date", path: ["hardDeadline"] });
});
const batchChange = z.strictObject({
  deadline: z.strictObject({ kind: z.enum(["absolute", "window"]), calendarDays: z.number().int().min(1).max(366) }).optional(),
  work: z.strictObject({ additionalMinutes: z.number().int().min(1).max(100_000).optional(), additionalEpisodes: z.number().int().min(1).max(1_000).optional() }).optional(),
}).refine((c) => c.deadline || c.work?.additionalMinutes || c.work?.additionalEpisodes, "Empty change");

async function workspaceFor(client: PoolClient, actor: { id: string }, workspaceId: string, permission: "policy.read" | "policy.write") {
  parse(uuid, workspaceId);
  const found = (await client.query("SELECT 1 FROM workspaces WHERE id=$1", [workspaceId])).rowCount;
  requireCondition(found, "WORKSPACE_NOT_FOUND", 404);
  // A course grant never confers a workspace-wide permission.
  return permitCourse(client, actor, workspaceId, null, permission);
}

export function registerPolicyScopeRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  const workspace = "/api/admin/workspaces/:workspaceId/policy-ceilings";
  const course = "/api/admin/courses/:courseId";

  // ---------------------------------------------------------------- organization ceilings
  /** How the ceilings would affect a learner enrolling in each course now: whether the required
   * path still fits, and which course or chapter settings the ceilings now clip. */
  async function ceilingsView(client: PoolClient, workspaceId: string, proposed?: z.infer<typeof organizationCeilingsSchema>) {
    const current = await organizationCeilings(client, workspaceId);
    const courses = (await client.query<{ id: string; title: string; release_id: string; server_bundle: CourseManifest }>(
      `SELECT c.id,c.title,r.id AS release_id,r.server_bundle FROM admin_course_catalog c
       JOIN LATERAL (SELECT id,server_bundle FROM course_releases r WHERE r.workspace_id=c.workspace_id AND r.course_key=c.course_key
         AND (c.active_release_id IS NULL OR r.id=c.active_release_id) ORDER BY (r.id=c.active_release_id) DESC NULLS LAST,r.created_at DESC LIMIT 1) r ON true
       WHERE c.workspace_id=$1 ORDER BY c.title,c.id LIMIT ${COURSE_PREVIEW_LIMIT + 1}`, [workspaceId])).rows;
    const now = new Date().toISOString();
    const impact = [];
    for (const row of courses.slice(0, COURSE_PREVIEW_LIMIT)) {
      try {
        const check = await publicationPolicyCheck(client, row.release_id, row.server_bundle, now, undefined, proposed ?? current.ceilings);
        impact.push({ courseId: row.id, title: row.title, feasible: check.feasibility.feasible,
          issues: check.feasibility.issues.map((i) => ({ severity: i.severity, code: i.code, scopeId: i.scopeId, deadline: i.deadline ?? null })) });
      } catch (error) {
        const code = codeOf(error);
        if (typeof code !== "string") throw error;
        impact.push({ courseId: row.id, title: row.title, feasible: false, issues: [{ severity: "error", code, scopeId: "organization", deadline: null }] });
      }
    }
    return { workspaceId, source: current.source, revision: current.revision, changedAt: current.changedAt, ceilings: current.ceilings,
      defaults: DEFAULT_ORGANIZATION_CEILINGS, preview: proposed ? { ceilings: proposed } : null, impact, moreCourses: courses.length > COURSE_PREVIEW_LIMIT,
      appliesTo: "new_enrollments" as const };
  }
  app.get(workspace, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      await workspaceFor(client, actor, params(request).workspaceId!, "policy.read");
      return ceilingsView(client, params(request).workspaceId!);
    });
  });
  app.post(`${workspace}/preview`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(z.strictObject({ ceilings: ceilingsInput }), request.body);
    return transaction(db, async (client) => {
      await workspaceFor(client, actor, params(request).workspaceId!, "policy.write");
      return ceilingsView(client, params(request).workspaceId!, input.ceilings);
    });
  });
  app.put(workspace, async (request) => {
    const actor = await auth.authenticate(request);
    const input = parse(z.strictObject({ expectedRevision: z.number().int().min(0), ceilings: ceilingsInput, reason: z.string().trim().min(1).max(1000) }), request.body);
    const workspaceId = params(request).workspaceId!;
    return transaction(db, async (client) => {
      await workspaceFor(client, actor, workspaceId, "policy.write");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`policy-ceilings:${workspaceId}`]);
      const current = await organizationCeilings(client, workspaceId);
      requireCondition(current.revision === input.expectedRevision, "STALE_REVISION", 409);
      const revision = current.revision + 1;
      const ceilings = { ...input.ceilings, hardDeadline: input.ceilings.hardDeadline && new Date(input.ceilings.hardDeadline).toISOString() };
      await client.query(`INSERT INTO organization_policy_ceilings(workspace_id,revision,ceilings,changed_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision,ceilings=EXCLUDED.ceilings,changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp()`,
      [workspaceId, revision, JSON.stringify(ceilings), actor.id]);
      await client.query("INSERT INTO policy_setting_revisions(workspace_id,level,revision,settings,reason,changed_by) VALUES($1,'organization',$2,$3,$4,$5)",
        [workspaceId, revision, JSON.stringify(ceilings), input.reason, actor.id]);
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: "staff", type: "policy.ceilings_changed",
        payload: { revision, ceilings, reason: input.reason }, idempotencyKey: `policy-ceilings:${workspaceId}:${revision}` });
      return { ...(await ceilingsView(client, workspaceId)), outcome: "saved" as const };
    });
  });

  // ---------------------------------------------------------------- policy revision history
  app.get(`${course}/policy-history`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.read");
      const rows = (await client.query<{ level: string; revision: number; settings: unknown; reason: string | null; changed_by: string | null; display_name: string | null; changed_at: Date }>(
        `SELECT h.level,h.revision,h.settings,h.reason,h.changed_by,u.display_name,h.changed_at FROM policy_setting_revisions h LEFT JOIN app_users u ON u.id=h.changed_by
         WHERE h.workspace_id=$1 AND (h.catalog_id=$2 OR h.level='organization') ORDER BY h.changed_at DESC,h.id DESC LIMIT 100`, [catalog.workspace_id, catalog.id])).rows;
      return { courseId: catalog.id, revisions: rows.map((r) => ({ level: r.level, revision: r.revision, settings: r.settings, reason: r.reason,
        changedBy: r.changed_by ? { id: r.changed_by, displayName: r.display_name } : null, changedAt: r.changed_at.toISOString() })) };
    });
  });
  app.get("/api/admin/enrollments/:enrollmentId/policy-revisions", async (request) => {
    const actor = await auth.authenticate(request), enrollmentId = parse(uuid, params(request).enrollmentId);
    return transaction(db, async (client) => {
      const enrollment = (await client.query<{ workspace_id: string; course_release_id: string }>("SELECT workspace_id,course_release_id FROM enrollments WHERE id=$1", [enrollmentId])).rows[0];
      requireCondition(enrollment, "ENROLLMENT_NOT_FOUND", 404);
      const catalog = (await client.query<{ id: string }>(`SELECT c.id FROM admin_course_catalog c JOIN course_releases r ON r.workspace_id=c.workspace_id AND r.course_key=c.course_key
        WHERE r.id=$1`, [enrollment.course_release_id])).rows[0];
      await permitCourse(client, actor, enrollment.workspace_id, catalog?.id ?? null, "policy.read");
      const rows = (await client.query<{ policy_revision: number; ledger_revision: number; cause: string; scopes: unknown; recorded_at: Date }>(
        "SELECT policy_revision,ledger_revision,cause,scopes,recorded_at FROM learning_policy_revisions WHERE enrollment_id=$1 ORDER BY policy_revision DESC LIMIT 100", [enrollmentId])).rows;
      return { enrollmentId, revisions: rows.map((r) => ({ policyRevision: r.policy_revision, ledgerRevision: r.ledger_revision, cause: r.cause, scopes: r.scopes, recordedAt: r.recorded_at.toISOString() })) };
    });
  });

  // ---------------------------------------------------------------- batch accommodations and outage adjustments
  async function cohort(client: PoolClient, catalog: { workspace_id: string; course_key: string }, ids: string[] | null, lock: boolean) {
    return (await client.query<{ id: string; revision: number; profile: { displayName?: string } }>(
      `SELECT e.id,e.revision,e.profile FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id
       WHERE r.workspace_id=$1 AND r.course_key=$2 AND e.status='active' AND ($3::uuid[] IS NULL OR e.id=ANY($3::uuid[]))
       ORDER BY e.id LIMIT ${BATCH_LIMIT + 1} ${lock ? "FOR UPDATE OF e" : ""}`, [catalog.workspace_id, catalog.course_key, ids])).rows;
  }
  const batchPreviewInput = z.strictObject({
    scopeId: z.string().min(1).max(200),
    kind: z.enum(["accommodation", "outage"]),
    change: batchChange,
    /** Omitted: every active learner in the course. */
    enrollmentIds: z.array(uuid).min(1).max(BATCH_LIMIT).optional(),
  });
  app.post(`${course}/accommodations/batch/preview`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(batchPreviewInput, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write", true);
      const rows = await cohort(client, catalog, input.enrollmentIds ?? null, false);
      requireCondition(rows.length <= BATCH_LIMIT, "COHORT_TOO_LARGE", 409);
      requireCondition(!input.enrollmentIds || rows.length === new Set(input.enrollmentIds).size, "ENROLLMENT_NOT_FOUND", 404);
      requireCondition(rows.length > 0, "NO_ACTIVE_LEARNERS", 409);
      const batchId = randomUUID(), enrollments = [], refused = [];
      for (const row of rows) {
        const state = await loadPolicy(client, row.id);
        try {
          const preview = previewAccommodation(state, { scopeId: input.scopeId, accommodationId: randomUUID(), reasonRef: batchId, kind: input.kind, change: input.change, batchId });
          enrollments.push({ enrollmentId: row.id, displayName: row.profile?.displayName ?? null, enrollmentRevision: row.revision,
            policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision, accommodationId: preview.accommodationId, previewDigest: preview.previewDigest,
            effectiveDeadlineBefore: preview.effectiveDeadlineBefore, effectiveDeadlineAfter: preview.effectiveDeadlineAfter, bindingAfter: preview.bindingAfter.deadline });
        } catch (error) {
          const code = codeOf(error);
          if (typeof code !== "string") throw error;
          refused.push({ enrollmentId: row.id, displayName: row.profile?.displayName ?? null, code });
        }
      }
      const body = { courseId: catalog.id, kind: input.kind, scopeId: input.scopeId, change: input.change, enrollments, refused };
      const previewDigest = digestJson(body), expiresAt = new Date(Date.now() + PREVIEW_MINUTES * 60_000).toISOString();
      await client.query(`INSERT INTO policy_accommodation_batches(id,catalog_id,workspace_id,actor_id,kind,scope_id,change,preview,preview_digest,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [batchId, catalog.id, catalog.workspace_id, actor.id, input.kind, input.scopeId, JSON.stringify(input.change), JSON.stringify(body), previewDigest, expiresAt]);
      return { ...body, batchId, previewDigest, expiresAt };
    });
  });
  app.post(`${course}/accommodations/batch/apply`, async (request) => {
    const actor = await auth.authenticate(request);
    // A reference such as an incident or approval ticket, never health or personal details.
    const input = parse(z.strictObject({ batchId: uuid, previewDigest: digestText, reason }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write", true);
      const stored = (await client.query("SELECT * FROM policy_accommodation_batches WHERE id=$1 AND catalog_id=$2 AND actor_id=$3 FOR UPDATE", [input.batchId, catalog.id, actor.id])).rows[0];
      requireCondition(stored, "STALE_PREVIEW", 409);
      if (stored.state === "applied") {
        requireCondition(stored.preview_digest === input.previewDigest, "IDEMPOTENCY_CONFLICT", 409);
        return { batchId: stored.id, applied: stored.applied_count, refused: stored.preview.refused, replayed: true, outcome: "applied" as const };
      }
      requireCondition(stored.preview_digest === input.previewDigest && new Date(stored.expires_at).getTime() > Date.now(), "STALE_PREVIEW", 409);
      type Previewed = { enrollmentId: string; enrollmentRevision: number; policyRevision: number; ledgerRevision: number; accommodationId: string; previewDigest: string };
      const previewed: Previewed[] = stored.preview.enrollments;
      const rows = await cohort(client, catalog, previewed.map((e) => e.enrollmentId), true);
      const now = new Date().toISOString();
      // All or nothing: every learner must be exactly as previewed, or the whole batch is reviewed again.
      for (const entry of previewed) {
        const row = rows.find((r) => r.id === entry.enrollmentId);
        const state = row && await loadPolicy(client, entry.enrollmentId);
        requireCondition(row && state && row.revision === entry.enrollmentRevision && state.policyRevision === entry.policyRevision
          && state.ledgerRevision === entry.ledgerRevision, "STALE_PREVIEW", 409);
        const event = await appendEvent(client, { workspaceId: catalog.workspace_id, enrollmentId: entry.enrollmentId, actorId: actor.id, actorKind: "staff",
          type: "policy.accommodation_authorized",
          payload: { accommodationId: entry.accommodationId, kind: stored.kind, scopeId: stored.scope_id, previewDigest: entry.previewDigest, reasonRef: stored.id, batchId: stored.id, reason: input.reason },
          idempotencyKey: `accommodation-batch:${stored.id}:${entry.enrollmentId}`, supervise: true });
        const transition = applyAccommodation(state, { scopeId: stored.scope_id, accommodationId: entry.accommodationId, reasonRef: stored.id, kind: stored.kind, change: stored.change,
          batchId: stored.id, now, previewDigest: entry.previewDigest, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
          idempotencyKey: `accommodation-batch:${stored.id}`,
          authorityReceipt: { receiptId: event.id, actorId: actor.id, enrollmentId: entry.enrollmentId, scopeId: stored.scope_id, permission: "accommodate", termsDigest: entry.previewDigest, authorizedAt: now } });
        await savePolicy(client, entry.enrollmentId, transition);
      }
      await client.query("UPDATE policy_accommodation_batches SET state='applied',applied_at=clock_timestamp(),reason=$2,applied_count=$3 WHERE id=$1", [stored.id, input.reason, previewed.length]);
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: "staff", type: "policy.accommodation_batch_applied",
        payload: { batchId: stored.id, courseId: catalog.id, kind: stored.kind, scopeId: stored.scope_id, change: stored.change, applied: previewed.length,
          refused: stored.preview.refused.length, reason: input.reason }, idempotencyKey: `accommodation-batch:${stored.id}` });
      return { batchId: stored.id, applied: previewed.length, refused: stored.preview.refused, replayed: false, outcome: "applied" as const };
    });
  });
  app.get(`${course}/accommodations/batches`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.read");
      const rows = (await client.query(`SELECT b.id,b.kind,b.scope_id,b.change,b.reason,b.applied_count,b.applied_at,u.display_name FROM policy_accommodation_batches b
        JOIN app_users u ON u.id=b.actor_id WHERE b.catalog_id=$1 AND b.state='applied' ORDER BY b.applied_at DESC LIMIT 50`, [catalog.id])).rows;
      return { courseId: catalog.id, batches: rows.map((r) => ({ batchId: r.id, kind: r.kind, scopeId: r.scope_id, change: r.change, reason: r.reason,
        applied: r.applied_count, appliedAt: r.applied_at.toISOString(), appliedBy: r.display_name })) };
    });
  });

  // ---------------------------------------------------------------- allowances across learners
  const allowancesQuery = z.strictObject({ view: z.enum(["pending", "all"]).default("pending") });
  app.get(`${course}/allowances`, async (request) => {
    const actor = await auth.authenticate(request), query = parse(allowancesQuery, request.query ?? {});
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.read");
      const scope = `FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE r.workspace_id=$1 AND r.course_key=$2`;
      const args = [catalog.workspace_id, catalog.course_key];
      const offers = (await client.query(
        `SELECT o.enrollment_id,e.revision,e.status,e.profile->>'displayName' AS display_name,o.offer_id,o.scope_id,o.state,o.change,o.pool_debits,o.required_approvals,
           o.created_at,o.expires_at,o.last_transition_at,o.accepted_at
         FROM extension_offers o JOIN enrollments e ON e.id=o.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
         WHERE r.workspace_id=$1 AND r.course_key=$2 AND e.status<>'erased'
           AND ($3::boolean=false OR (o.state='accepted_pending_admin' AND e.status='active' AND o.expires_at>clock_timestamp()))
         ORDER BY (o.state='accepted_pending_admin') DESC,o.last_transition_at DESC LIMIT 200`, [...args, query.view === "pending"])).rows;
      const accommodations = query.view === "pending" ? [] : (await client.query(
        `SELECT a.enrollment_id,e.profile->>'displayName' AS display_name,a.accommodation_id,a.kind,a.scope_id,a.adjustment,a.batch_id,a.authorized_at
         FROM accommodation_overrides a JOIN enrollments e ON e.id=a.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
         WHERE r.workspace_id=$1 AND r.course_key=$2 AND e.status<>'erased' ORDER BY a.authorized_at DESC LIMIT 200`, args)).rows;
      const pools = (await client.query(
        `SELECT p.pool_id,p.unit,count(*)::int AS learners,sum(p.total)::int AS total,sum(p.debited-p.refunded)::int AS used,sum(p.grants_used)::int AS grants
         FROM extension_pools p WHERE p.enrollment_id IN (SELECT e.id ${scope} AND e.status='active') GROUP BY p.pool_id,p.unit ORDER BY p.pool_id LIMIT 200`, args)).rows;
      const learner = (r: { enrollment_id: string; display_name: string | null }) => ({ enrollmentId: r.enrollment_id, displayName: r.display_name });
      return {
        courseId: catalog.id, view: query.view,
        offers: offers.map((r) => ({ ...learner(r), enrollmentRevision: r.revision, enrollmentStatus: r.status, offerId: r.offer_id, scopeId: r.scope_id, state: r.state,
          change: r.change, poolDebits: r.pool_debits, requiredApprovals: r.required_approvals, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(),
          lastTransitionAt: r.last_transition_at.toISOString(), acceptedAt: r.accepted_at?.toISOString() ?? null })),
        accommodations: accommodations.map((r) => ({ ...learner(r), accommodationId: r.accommodation_id, kind: r.kind, scopeId: r.scope_id, adjustment: r.adjustment,
          batchId: r.batch_id, authorizedAt: r.authorized_at.toISOString() })),
        pools: pools.map((r) => ({ poolId: r.pool_id, unit: r.unit, learners: r.learners, total: r.total, used: r.used, grants: r.grants })),
      };
    });
  });
}
