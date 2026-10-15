import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  applyPolicyChange, disposeOffer, grantExceptional, grantExtension, previewExceptionalGrant,
  previewPolicyChange, previewRefund, previewRevocation, refundAllowance, revokeGrant, validateScopePolicy,
  type AuthorityReceipt, type PolicyState, type ScopePolicy,
} from "@course-core/policy";
import { authService, type Actor } from "./auth.js";
import { transaction, type Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, type EnrollmentContext } from "./repository.js";
import {
  ADMIN_APPROVAL, coursePolicySettings, coursePolicySettingsSchema, DEFAULT_COURSE_POLICY_SETTINGS, loadPolicy, publicationPolicyCheck,
} from "./policy-adapter.js";
import { coverageView } from "./closure.js";
import { catalogFor, enrollmentCommand, enrollmentFor, policyView, savePolicy } from "./admin-routes.js";

type Auth = ReturnType<typeof authService>;
const uuid = z.uuid();
const key = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const command = z.strictObject({ expectedRevision: z.number().int().positive(), idempotencyKey: key });
const reason = z.string().trim().min(1).max(1000);
const digestText = z.string().regex(/^[a-f0-9]{64}$/);
const PREVIEW_MINUTES = 15;
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, "INVALID_REQUEST");
  return parsed.data;
}
const params = (request: FastifyRequest) => request.params as Record<string, string>;

/** Ledger fields the admin policy page shows beside offers and grants. */
export function policyLedgerView(policy: PolicyState, context: Pick<EnrollmentContext, "progress" | "release">) {
  return {
    refunds: policy.refunds,
    exceptionalGrants: policy.exceptionalGrants,
    pendingApprovals: policy.offers.filter((o) => o.state === "accepted_pending_admin").map((o) => o.terms.offerId),
    afterClosure: policy.afterClosure ?? { questionBudget: DEFAULT_COURSE_POLICY_SETTINGS.closedQuestionBudget },
    coverage: coverageView(context.release.server_bundle, context, policy),
  };
}

function authority(actorReceipt: string, context: EnrollmentContext, scopeId: string, permission: AuthorityReceipt["permission"], termsDigest: string, now: string, actorId: string): AuthorityReceipt {
  return { receiptId: actorReceipt, actorId, enrollmentId: context.enrollment.id, scopeId, permission, termsDigest, authorizedAt: now };
}
async function storePreview(client: PoolClient, context: EnrollmentContext, actor: Actor, state: PolicyState, preview: { previewDigest: string } & Record<string, unknown>) {
  const previewId = randomUUID(), expiresAt = new Date(Date.now() + PREVIEW_MINUTES * 60_000).toISOString();
  await client.query(
    "INSERT INTO admin_policy_previews(id,enrollment_id,actor_id,enrollment_revision,policy_revision,ledger_revision,preview_digest,preview,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [previewId, context.enrollment.id, actor.id, context.enrollment.revision, state.policyRevision, state.ledgerRevision, preview.previewDigest, JSON.stringify(preview), expiresAt]);
  return { ...preview, previewId, revision: context.enrollment.revision, expiresAt };
}
async function storedPreview(client: PoolClient, context: EnrollmentContext, actor: Actor, previewId: string, previewDigest: string, kind: string) {
  const stored = (await client.query("SELECT * FROM admin_policy_previews WHERE id=$1 AND enrollment_id=$2 AND actor_id=$3", [previewId, context.enrollment.id, actor.id])).rows[0];
  requireCondition(stored && stored.preview?.previewKind === kind && stored.preview_digest === previewDigest && new Date(stored.expires_at).getTime() > Date.now(), "STALE_PREVIEW", 409);
  const state = await loadPolicy(client, context.enrollment.id);
  requireCondition(stored.enrollment_revision === context.enrollment.revision && stored.policy_revision === state.policyRevision
    && stored.ledger_revision === state.ledgerRevision, "STALE_PREVIEW", 409);
  return { preview: stored.preview, state };
}

const changeSchema = z.strictObject({
  deadline: z.strictObject({ kind: z.enum(["absolute", "window"]), calendarDays: z.number().int().min(1).max(366) }).optional(),
  work: z.strictObject({ additionalMinutes: z.number().int().min(1).max(100_000).optional(), additionalEpisodes: z.number().int().min(1).max(1_000).optional() }).optional(),
});
const cohortChangeSchema = z.strictObject({
  scopeId: z.string().min(1).max(200),
  hardDeadline: z.iso.datetime({ offset: true }).optional(),
  targetDate: z.iso.datetime({ offset: true }).optional(),
  ultimateDeadline: z.iso.datetime({ offset: true }).optional(),
  work: z.strictObject({
    additionalMinutes: z.number().int().min(0).max(100_000).optional(),
    additionalEpisodes: z.number().int().min(0).max(1_000).optional(),
    remediationCyclesPerConcept: z.number().int().min(0).max(100).optional(),
  }).optional(),
  existingMaterialAccess: z.enum(["read_only", "closed"]).optional(),
}).refine((c) => c.hardDeadline || c.targetDate || c.ultimateDeadline || c.work || c.existingMaterialAccess, "Empty change");
type CohortChange = z.infer<typeof cohortChangeSchema>;

/** One enrollment's scopes with a cohort change applied. The hard deadline keeps the
 * enrollment's own time zone and disambiguation; anchors and windows never change. */
function changedScopes(state: PolicyState, change: CohortChange, settings: typeof DEFAULT_COURSE_POLICY_SETTINGS): ScopePolicy[] {
  const scopes = structuredClone(state.scopes);
  const scope = scopes.find((s) => s.scopeId === change.scopeId);
  requireCondition(scope, "UNKNOWN_SCOPE", 404);
  if (change.hardDeadline) scope.hardDeadline = { at: new Date(change.hardDeadline).toISOString(), timeZone: scope.hardDeadline?.timeZone ?? settings.timeZone,
    disambiguation: scope.hardDeadline?.disambiguation ?? settings.disambiguation };
  if (change.targetDate) scope.targetDate = new Date(change.targetDate).toISOString();
  if (change.ultimateDeadline) scope.ultimateDeadline = new Date(change.ultimateDeadline).toISOString();
  if (change.work) scope.work = { ...scope.work, ...change.work };
  if (change.existingMaterialAccess) scope.existingMaterialAccess = change.existingMaterialAccess;
  return scopes.map((s) => validateScopePolicy(s));
}

export function registerPolicyAdminRoutes(app: FastifyInstance, db: Database, auth: Auth) {
  const course = "/api/admin/courses/:courseId";
  const enrollment = "/api/admin/enrollments/:enrollmentId";

  // ---------------------------------------------------------------- course policy settings
  async function activeRelease(client: PoolClient, catalog: { id: string; workspace_id: string; course_key: string; active_release_id: string | null }) {
    return (await client.query<{ id: string; server_bundle: import("@course-core/sdk").CourseManifest }>(
      `SELECT id,server_bundle FROM course_releases WHERE workspace_id=$1 AND course_key=$2 AND ($3::uuid IS NULL OR id=$3)
       ORDER BY (id=$3) DESC NULLS LAST, created_at DESC LIMIT 1`, [catalog.workspace_id, catalog.course_key, catalog.active_release_id])).rows[0] ?? null;
  }
  async function settingsView(client: PoolClient, catalog: { id: string; workspace_id: string; course_key: string; active_release_id: string | null }, override?: typeof DEFAULT_COURSE_POLICY_SETTINGS) {
    const current = await coursePolicySettings(client, catalog.workspace_id, catalog.course_key);
    const release = await activeRelease(client, catalog);
    const check = release ? await publicationPolicyCheck(client, release.id, release.server_bundle, new Date().toISOString(), override ?? current.settings) : null;
    return { courseId: catalog.id, source: current.source, revision: current.revision, changedAt: current.changedAt,
      settings: current.settings, defaults: DEFAULT_COURSE_POLICY_SETTINGS, releaseId: release?.id ?? null,
      preview: check && { settings: check.settings, feasibility: check.feasibility, calendar: check.calendar },
      appliesTo: "new_enrollments" as const };
  }
  app.get(`${course}/policy-settings`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.read");
      return settingsView(client, catalog);
    });
  });
  app.post(`${course}/policy-settings/preview`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(z.strictObject({ settings: coursePolicySettingsSchema }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write");
      return settingsView(client, catalog, input.settings);
    });
  });
  app.put(`${course}/policy-settings`, async (request) => {
    const actor = await auth.authenticate(request);
    const input = parse(z.strictObject({ expectedRevision: z.number().int().min(0), settings: coursePolicySettingsSchema, reason }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write", true);
      const current = await coursePolicySettings(client, catalog.workspace_id, catalog.course_key);
      requireCondition(current.revision === input.expectedRevision, "STALE_REVISION", 409);
      const revision = current.revision + 1;
      await client.query(`INSERT INTO course_policy_settings(catalog_id,workspace_id,revision,settings,changed_by) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(catalog_id) DO UPDATE SET revision=EXCLUDED.revision,settings=EXCLUDED.settings,changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp()`,
        [catalog.id, catalog.workspace_id, revision, JSON.stringify(input.settings), actor.id]);
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: "staff", type: "policy.settings_changed",
        payload: { courseId: catalog.id, revision, settings: input.settings, reason: input.reason }, idempotencyKey: `policy-settings:${catalog.id}:${revision}` });
      return { ...(await settingsView(client, catalog)), message: "Policy settings saved. They apply to new enrollments; existing learners keep their current terms." };
    });
  });

  // ---------------------------------------------------------------- admin approval of accepted offers
  const offerAction = command.extend({ reason: reason.optional() });
  app.post(`${enrollment}/extensions/:offerId/grant`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(offerAction, request.body), offerId = parse(uuid, params(request).offerId);
    const { expectedRevision, idempotencyKey, ...semantic } = input;
    return enrollmentCommand(db, actor, params(request).enrollmentId!, "policy.write", "admin.extension.grant", { expectedRevision, idempotencyKey }, { offerId, ...semantic },
      async (client, context) => {
        const state = await loadPolicy(client, context.enrollment.id), now = new Date().toISOString();
        const offer = state.offers.find((o) => o.terms.offerId === offerId);
        requireCondition(offer, "UNKNOWN_OFFER", 404);
        requireCondition(offer.state === "accepted_pending_admin" && offer.acceptance, "LEARNER_ACCEPTANCE_REQUIRED", 409);
        requireCondition(offer.terms.requiredApprovals.every((id) => id === ADMIN_APPROVAL), "UNSUPPORTED_APPROVAL", 409);
        const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: "staff",
          type: "extension.approved", payload: { offerId, termsDigest: offer.termsDigest, approvedBy: actor.id, reason: input.reason ?? null },
          idempotencyKey: `${context.enrollment.id}:${idempotencyKey}:approval` });
        const transition = grantExtension(state, { now, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision, idempotencyKey,
          offerId, grantId: randomUUID(), atomicLedgerTransactionId: randomUUID(),
          authorityReceipts: offer.terms.requiredApprovals.map((id) => authority(event.id, context, offer.terms.scopeId, "grant_extension", offer.termsDigest, now, id)) });
        await savePolicy(client, context.enrollment.id, transition);
        const grant = transition.state.grants.find((g) => g.offerId === offerId)!;
        await client.query(`INSERT INTO extension_grants (id,enrollment_id,offer_id,terms_digest,learner_id,consent_receipt,ledger_transaction_id,idempotency_key,grant_data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [grant.grantId, context.enrollment.id, offerId, offer.termsDigest, state.learnerId, JSON.stringify(grant.learnerAcceptanceReceipt), grant.atomicLedgerTransactionId, idempotencyKey, JSON.stringify(grant)]);
        await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: "staff",
          type: "extension.granted", payload: { offerId, termsDigest: offer.termsDigest, grantId: grant.grantId, approvalEventId: event.id },
          idempotencyKey: `${context.enrollment.id}:${idempotencyKey}`, supervise: true });
        return { policy: await policyView(client, await enrollmentFor(client, actor, context.enrollment.id, "policy.read")),
          receipt: { id: event.id, authority: "server", outcome: "granted" }, message: "Approved. The learner's accepted terms were granted and the allowance was debited once." };
      });
  });
  app.post(`${enrollment}/extensions/:offerId/reject`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(command.extend({ reason }), request.body), offerId = parse(uuid, params(request).offerId);
    const { expectedRevision, idempotencyKey, ...semantic } = input;
    return enrollmentCommand(db, actor, params(request).enrollmentId!, "policy.write", "admin.extension.reject", { expectedRevision, idempotencyKey }, { offerId, ...semantic },
      async (client, context) => {
        const state = await loadPolicy(client, context.enrollment.id), now = new Date().toISOString();
        const offer = state.offers.find((o) => o.terms.offerId === offerId);
        requireCondition(offer, "UNKNOWN_OFFER", 404);
        const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: "staff",
          type: "extension.rejected", payload: { offerId, reason: input.reason }, idempotencyKey: `${context.enrollment.id}:${idempotencyKey}`, supervise: true });
        const transition = disposeOffer(state, { now, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision, idempotencyKey,
          offerId, state: "rejected", authorityReceipt: authority(event.id, context, offer.terms.scopeId, "manage_offers", offer.termsDigest, now, actor.id) });
        await savePolicy(client, context.enrollment.id, transition);
        return { policy: await policyView(client, await enrollmentFor(client, actor, context.enrollment.id, "policy.read")),
          receipt: { id: event.id, authority: "server", outcome: "rejected" }, message: "Offer rejected. No allowance was used." };
      });
  });

  // ---------------------------------------------------------------- revocation, refund and exceptional grants
  type Kind = "revocation" | "refund" | "exception";
  function previewRoute(path: string, kind: Kind, body: z.ZodType, build: (state: PolicyState, input: never, request: FastifyRequest) => { previewDigest: string } & Record<string, unknown>) {
    app.post(path, async (request) => {
      const actor = await auth.authenticate(request), input = parse(body, request.body);
      return transaction(db, async (client) => {
        const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "policy.write", true);
        requireCondition(context.enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
        const state = await loadPolicy(client, context.enrollment.id);
        return storePreview(client, context, actor, state, { ...build(state, input as never, request), previewKind: kind });
      });
    });
  }
  function applyRoute(path: string, kind: Kind, operation: string, run: (state: PolicyState, preview: Record<string, unknown> & { previewDigest: string }, context: EnrollmentContext, actor: Actor, eventId: string, now: string, idempotencyKey: string) => ReturnType<typeof revokeGrant>, message: string) {
    app.post(path, async (request) => {
      const actor = await auth.authenticate(request), input = parse(command.extend({ previewId: uuid, previewDigest: digestText, reason }), request.body);
      const { expectedRevision, idempotencyKey, ...semantic } = input;
      return enrollmentCommand(db, actor, params(request).enrollmentId!, "policy.write", operation, { expectedRevision, idempotencyKey }, semantic, async (client, context) => {
        const { preview, state } = await storedPreview(client, context, actor, input.previewId, input.previewDigest, kind);
        const now = new Date().toISOString();
        const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: "staff",
          type: `policy.${kind}_authorized`, payload: { previewDigest: input.previewDigest, reason: input.reason, ...summary(kind, preview) },
          idempotencyKey: `${context.enrollment.id}:${idempotencyKey}`, supervise: true });
        const transition = run(state, preview, context, actor, event.id, now, idempotencyKey);
        await savePolicy(client, context.enrollment.id, transition);
        return { policy: await policyView(client, await enrollmentFor(client, actor, context.enrollment.id, "policy.read")),
          receipt: { id: event.id, authority: "server", outcome: kind }, message };
      });
    });
  }
  function summary(kind: Kind, preview: Record<string, unknown>) {
    if (kind === "revocation") return { grantId: preview.grantId, shortensDeadline: preview.shortensDeadline };
    if (kind === "refund") return { refundId: preview.refundId, grantId: preview.grantId, poolId: preview.poolId, amount: preview.amount };
    return { exceptionId: preview.exceptionId, scopeId: preview.scopeId, change: preview.change };
  }
  previewRoute(`${enrollment}/grants/:grantId/revoke/preview`, "revocation", z.strictObject({}), (state, _input, request) =>
    previewRevocation(state, { grantId: params(request).grantId!, reasonRef: randomUUID() }));
  applyRoute(`${enrollment}/grants/:grantId/revoke`, "revocation", "admin.policy.revoke", (state, p, context, actor, eventId, now, idempotencyKey) => {
    const grantId = String(p.grantId);
    return revokeGrant(state, { grantId, reasonRef: String(p.reasonRef), previewDigest: p.previewDigest, now, idempotencyKey,
      expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
      authorityReceipt: authority(eventId, context, String(p.scopeId), "revoke_extension", p.previewDigest, now, actor.id) });
  }, "Grant revoked. Its usage and history remain in the ledger; no allowance was refunded.");
  previewRoute(`${enrollment}/grants/:grantId/refund/preview`, "refund", z.strictObject({ poolId: z.string().min(1).max(256), amount: z.number().int().min(1).max(366) }),
    (state, input: { poolId: string; amount: number }, request) =>
      previewRefund(state, { refundId: randomUUID(), grantId: params(request).grantId!, poolId: input.poolId, amount: input.amount, reasonRef: randomUUID() }));
  applyRoute(`${enrollment}/grants/:grantId/refund`, "refund", "admin.policy.refund", (state, p, context, actor, eventId, now, idempotencyKey) => {
    const grant = state.grants.find((g) => g.grantId === p.grantId);
    requireCondition(grant, "UNKNOWN_GRANT", 404);
    return refundAllowance(state, { refundId: String(p.refundId), grantId: grant.grantId, poolId: String(p.poolId), amount: Number(p.amount), reasonRef: String(p.reasonRef),
      previewDigest: p.previewDigest, now, idempotencyKey, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
      authorityReceipt: authority(eventId, context, grant.adjustment.scopeId, "refund_allowance", p.previewDigest, now, actor.id) });
  }, "Allowance refunded to the pool. Deadlines are unchanged.");
  previewRoute(`${enrollment}/exceptions/preview`, "exception", z.strictObject({ scopeId: z.string().min(1).max(200), change: changeSchema }),
    (state, input: { scopeId: string; change: z.infer<typeof changeSchema> }) => {
      requireCondition(input.change.deadline || input.change.work, "INVALID_REQUEST");
      return previewExceptionalGrant(state, { exceptionId: randomUUID(), scopeId: input.scopeId, reasonRef: randomUUID(), change: input.change });
    });
  applyRoute(`${enrollment}/exceptions/apply`, "exception", "admin.policy.exception", (state, p, context, actor, eventId, now, idempotencyKey) =>
    grantExceptional(state, { exceptionId: String(p.exceptionId), scopeId: String(p.scopeId), reasonRef: String(p.reasonRef), change: p.change as never,
      previewDigest: p.previewDigest, now, idempotencyKey, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
      authorityReceipt: authority(eventId, context, String(p.scopeId), "exceptional_grant", p.previewDigest, now, actor.id) }),
  "Exceptional grant applied to this learner only. No allowance pool was debited.");

  // ---------------------------------------------------------------- cohort-wide migration
  const COHORT_LIMIT = 500;
  async function cohort(client: PoolClient, catalog: { workspace_id: string; course_key: string }, lock: boolean) {
    return (await client.query<{ id: string; revision: number; status: string; profile: { displayName?: string } }>(
      `SELECT e.id,e.revision,e.status,e.profile FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id
       WHERE r.workspace_id=$1 AND r.course_key=$2 AND e.status='active' ORDER BY e.id LIMIT ${COHORT_LIMIT + 1} ${lock ? "FOR UPDATE OF e" : ""}`,
      [catalog.workspace_id, catalog.course_key])).rows;
  }
  app.post(`${course}/policy/cohort/preview`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(z.strictObject({ change: cohortChangeSchema }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write", true);
      const { settings } = await coursePolicySettings(client, catalog.workspace_id, catalog.course_key);
      const rows = await cohort(client, catalog, false);
      requireCondition(rows.length <= COHORT_LIMIT, "COHORT_TOO_LARGE", 409);
      const enrollments = [], refused = [];
      for (const row of rows) {
        const state = await loadPolicy(client, row.id);
        try {
          const preview = previewPolicyChange(state, { scopes: changedScopes(state, input.change, settings) });
          enrollments.push({ enrollmentId: row.id, displayName: row.profile?.displayName ?? "Learner", enrollmentRevision: row.revision,
            policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision, previewDigest: preview.previewDigest,
            shortenedGrants: preview.shortenedGrants, supersededOfferIds: preview.supersededOfferIds,
            impacts: preview.impacts.filter((i) => i.before.effectiveDeadline !== i.after.effectiveDeadline || digestJson(i.before.quotas) !== digestJson(i.after.quotas))
              .map((i) => ({ scopeId: i.scopeId, effectiveDeadlineBefore: i.before.effectiveDeadline, effectiveDeadlineAfter: i.after.effectiveDeadline })) });
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (!code) throw error;
          refused.push({ enrollmentId: row.id, code });
        }
      }
      const body = { courseId: catalog.id, change: input.change, enrollments, refused };
      const previewDigest = digestJson(body), id = randomUUID(), expiresAt = new Date(Date.now() + PREVIEW_MINUTES * 60_000).toISOString();
      await client.query(`INSERT INTO policy_cohort_migrations(id,catalog_id,workspace_id,actor_id,change,preview,preview_digest,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'previewed',$8)`,
        [id, catalog.id, catalog.workspace_id, actor.id, JSON.stringify(input.change), JSON.stringify(body), previewDigest, expiresAt]);
      return { ...body, migrationId: id, previewDigest, expiresAt,
        shortenedGrantIds: enrollments.flatMap((e) => e.shortenedGrants.map((g) => g.entryId)).sort() };
    });
  });
  app.post(`${course}/policy/cohort/apply`, async (request) => {
    const actor = await auth.authenticate(request);
    const input = parse(z.strictObject({ migrationId: uuid, previewDigest: digestText, reason,
      acknowledgedShortenedGrantIds: z.array(z.string().min(1).max(256)).max(10_000).default([]) }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write", true);
      const stored = (await client.query("SELECT * FROM policy_cohort_migrations WHERE id=$1 AND catalog_id=$2 AND actor_id=$3 FOR UPDATE", [input.migrationId, catalog.id, actor.id])).rows[0];
      requireCondition(stored, "STALE_PREVIEW", 409);
      if (stored.state === "applied") {
        requireCondition(stored.preview_digest === input.previewDigest, "IDEMPOTENCY_CONFLICT", 409);
        return { migrationId: stored.id, applied: stored.preview.enrollments.length, replayed: true };
      }
      requireCondition(stored.preview_digest === input.previewDigest && new Date(stored.expires_at).getTime() > Date.now(), "STALE_PREVIEW", 409);
      const { settings } = await coursePolicySettings(client, catalog.workspace_id, catalog.course_key);
      const rows = await cohort(client, catalog, true);
      const previewed: { enrollmentId: string; enrollmentRevision: number; policyRevision: number; ledgerRevision: number; previewDigest: string; shortenedGrants: { entryId: string }[] }[] = stored.preview.enrollments;
      // The cohort must be exactly the one reviewed, each enrollment unchanged since the preview.
      requireCondition(digestJson(rows.map((r) => r.id).sort()) === digestJson([...previewed.map((e) => e.enrollmentId), ...stored.preview.refused.map((e: { enrollmentId: string }) => e.enrollmentId)].sort()), "STALE_PREVIEW", 409);
      const acknowledged = new Set(input.acknowledgedShortenedGrantIds);
      const shortened = previewed.flatMap((e) => e.shortenedGrants.map((g) => g.entryId));
      requireCondition(shortened.every((id) => acknowledged.has(id)) && acknowledged.size === shortened.length, "SHORTENED_GRANT_UNACKNOWLEDGED", 409);
      const now = new Date().toISOString();
      for (const entry of previewed) {
        const row = rows.find((r) => r.id === entry.enrollmentId)!;
        const state = await loadPolicy(client, entry.enrollmentId);
        requireCondition(row.revision === entry.enrollmentRevision && state.policyRevision === entry.policyRevision && state.ledgerRevision === entry.ledgerRevision, "STALE_PREVIEW", 409);
        const scopes = changedScopes(state, stored.change, settings);
        const event = await appendEvent(client, { workspaceId: catalog.workspace_id, enrollmentId: entry.enrollmentId, actorId: actor.id, actorKind: "staff",
          type: "policy.migration_authorized", payload: { cohortMigrationId: stored.id, previewDigest: entry.previewDigest, reason: input.reason,
            shortenedGrantIds: entry.shortenedGrants.map((g) => g.entryId) },
          idempotencyKey: `cohort-migration:${stored.id}:${entry.enrollmentId}`, supervise: true });
        const root = state.scopes.find((s) => s.parentScopeId === null)!.scopeId;
        const transition = applyPolicyChange(state, { scopes, now, migrationId: `${stored.id}:${entry.enrollmentId}`, reasonRef: event.id, previewDigest: entry.previewDigest,
          acknowledgedShortenedGrantIds: entry.shortenedGrants.map((g) => g.entryId), expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
          idempotencyKey: `cohort-migration:${stored.id}`,
          authorityReceipt: { receiptId: event.id, actorId: actor.id, enrollmentId: entry.enrollmentId, scopeId: root, permission: "migrate_policy", termsDigest: entry.previewDigest, authorizedAt: now } });
        await savePolicy(client, entry.enrollmentId, transition);
      }
      await client.query("UPDATE policy_cohort_migrations SET state='applied',applied_at=clock_timestamp(),reason=$2 WHERE id=$1", [stored.id, input.reason]);
      return { migrationId: stored.id, applied: previewed.length, refused: stored.preview.refused, replayed: false,
        message: `Reviewed policy change applied to ${previewed.length} enrollment${previewed.length === 1 ? "" : "s"}. Anchors, pools, grants and ledger history were preserved.` };
    });
  });
}
