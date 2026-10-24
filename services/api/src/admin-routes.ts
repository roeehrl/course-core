import { HOST_ENDED_REASONS } from "./output-refusal.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { compileCourse } from "@course-core/sdk/compiler";
import { replayRetention } from "./retention.js";
import { refreshDecisionsForEnrollment } from "./gate-decisions.js";
import type { CourseManifest } from "@course-core/sdk";
import {
  applyAccommodation,
  applyPolicyChange,
  previewAccommodation,
  poolBalances,
  previewExtension,
  previewPolicyChange,
  proposeExtension,
  resolveConstraints,
  validateScopePolicy,
  type PolicyState,
  type ScopePolicy,
  type Transition,
} from "@course-core/policy";
import { snapshotSchema } from "@course-core/supervisor";
import { adminHypothesisView, runHypothesisChanges } from "./teaching-hypotheses.js";
import { enrollmentProfileFor, STAFF_READ_ROLES } from "./learner-privacy.js";
import { authService, type Actor } from "./auth.js";
import { adminPermissionMatrix, catalogOfEnrollment, enrollmentRole, permitCourse, sessionCourses, roleCan, type AdminPermission } from "./course-access.js";
import { courseOverview } from "./course-overview.js";
import { auditClosedRecordAmended } from "./closed-record.js";
import { workspaceAudit } from "./workspace-audit.js";
import { courseRun, payloadRequestSchema, recordReplay, replayRun, revealRunPayload, runPolicies, runRetryLinks, runSync, runWorkflow, sandboxed } from "./run-inspector.js";
import { transaction, type Database } from "./database.js";
import { ApiError, requireCondition } from "./errors.js";
import { assertPublishVersion } from "./course-versions.js";
import { requireSameRequest } from "./erased-digests.js";
import { appendEvent } from "./events.js";
import {
  digestJson,
  policyEpisodeId,
  type Enrollment,
  type EnrollmentContext,
  type Release,
} from "./repository.js";
import {
  episodes,
  gradeDeterministic,
  learningSnapshot,
  type EvidenceRow,
  type ProgressRow,
} from "./learning.js";
import {
  activateWindows,
  assertPublishable,
  enrollmentPolicy,
  extensionAmountsSchema,
  extensionRequest,
  loadPolicy,
} from "./policy-adapter.js";
import { recognitionOnlyLegacyGates, assertCourseRunnable, prepareCourseRunnable, type RuntimeExtension } from "./publication.js";
import { policyLedgerView } from "./policy-admin-routes.js";
import { defectiveItems, defectPreview, releaseDiff, rollbackImpact } from "./release-safety.js";
import { checkManifest, previewAsLearners, publishImpact, requireConfirmedImpact } from "./release-editing.js";
import { authorPlacementBounds, authorPlacementLimit, effectivePlacement, enrollmentPlacementView, placementBlueprint, placementBoundsError, placementCounters, placementLimitError, placementSettingsRow, settingsView, type PlacementSettingsRow } from "./placement-settings.js";
import { requeueQuarantinedEvent, setSupervisionControl, supervisionOverview } from "./supervision-control.js";
import { AGENT_ROLES, type ProviderRuntime } from "./provider-runtime.js";
import { withArtifactContent } from './artifact-store.js';
import { staffMessage, type ReleaseCheckCode, type StaffMessage } from "./staff-messages.js";
import { effectiveDigestSql } from "./carried-digest.js";

type Sql = Database | PoolClient;
type Auth = ReturnType<typeof authService>;
export { adminPermissionMatrix, type AdminPermission } from "./course-access.js";
/** Trusted composition only. No credential value or client-provided capability is accepted. */
export interface AdminRuntimeOptions {
  installedExtensions?:
    readonly RuntimeExtension[] | (() => readonly RuntimeExtension[]);
  providerStatus?: (workspaceId:string,client:Sql) => {
    models: ReturnType<ProviderRuntime["describe"]>;
    roles: ReturnType<ProviderRuntime["status"]>;
  }|Promise<{models:ReturnType<ProviderRuntime["describe"]>;roles:ReturnType<ProviderRuntime["status"]>}>;
  /** ALLOW_INSECURE_ORIGINS is on: plain-http origins outside Tailscale are trusted. */
  insecureOriginsAllowed?: boolean;
}
export interface Catalog {
  id: string;
  workspace_id: string;
  course_key: string;
  title: string;
  description: string;
  revision: number;
  active_release_id: string | null;
}
export interface ReleaseRow extends Release {
  version: string;
  course_key: string;
  created_by: string;
  created_at: Date;
  review_state: string;
  notes: string;
  reviewed_digest: string | null;
}
const uuid = z.uuid();
const key = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const profileSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  goal: z.string().max(2000),
  pace: z.enum(["gentle", "steady", "focused"]),
});
const commandSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: key,
});
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, "INVALID_REQUEST");
  return parsed.data;
}
const params = (request: FastifyRequest) =>
  request.params as Record<string, string>;
const iso = (value: Date | string) => new Date(value).toISOString();

/** Parent must call in the existing release-import transaction after INSERT course_releases. */
export async function ensureCatalog(
  client: Sql,
  releaseId: string,
): Promise<string> {
  const release = (
    await client.query<ReleaseRow>(
      "SELECT * FROM course_releases WHERE id=$1",
      [releaseId],
    )
  ).rows[0];
  requireCondition(release, "RELEASE_NOT_FOUND", 404);
  const created = await client.query(
    `INSERT INTO admin_course_catalog(id,workspace_id,course_key,title,description) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(workspace_id,course_key) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      release.workspace_id,
      release.course_key,
      release.server_bundle.title,
      release.server_bundle.summary,
    ],
  );
  const catalog = (
    await client.query<Catalog>(
      "SELECT * FROM admin_course_catalog WHERE workspace_id=$1 AND course_key=$2 FOR UPDATE",
      [release.workspace_id, release.course_key],
    )
  ).rows[0]!;
  const linked = await client.query(
    "INSERT INTO admin_release_reviews(release_id,catalog_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING release_id",
    [releaseId, catalog.id],
  );
  if (!created.rowCount && linked.rowCount)
    await client.query(
      "UPDATE admin_course_catalog SET revision=revision+1 WHERE id=$1",
      [catalog.id],
    );
  if (release.status === "published" && !catalog.active_release_id)
    await client.query("UPDATE admin_course_catalog SET active_release_id=$2,revision=revision+CASE WHEN $3 THEN 0 ELSE 1 END WHERE id=$1 AND active_release_id IS NULL", [catalog.id, release.id, Boolean(created.rowCount)]);
  return catalog.id;
}

/** Call inside publication/selection transactions with the catalog locked first.
 * This changes discovery for new learners, never immutable releases or pins. */
export async function selectCatalogueReleaseWithin(client: Sql, catalogId: string, releaseId: string) {
  const selected = await client.query(`UPDATE admin_course_catalog c SET active_release_id=r.id
    FROM course_releases r WHERE c.id=$1 AND r.id=$2 AND r.workspace_id=c.workspace_id
    AND r.course_key=c.course_key AND r.status='published' RETURNING c.id`, [catalogId, releaseId]);
  requireCondition(selected.rowCount === 1, "PUBLISHED_RELEASE_REQUIRED", 409);
}
/** Every administration check goes through the shared course-scoped rule (course-access.ts). */
const permit = (client: Sql, actor: Actor, workspaceId: string, permission: AdminPermission, catalogId: string | null = null) =>
  permitCourse(client, actor, workspaceId, catalogId, permission);
export async function catalogFor(
  client: Sql,
  actor: Actor,
  id: string,
  permission: AdminPermission = "course.read",
  lock = false,
) {
  parse(uuid, id);
  const catalog = (
    await client.query<Catalog>(
      `SELECT * FROM admin_course_catalog WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  requireCondition(catalog, "COURSE_NOT_FOUND", 404);
  const role = await permit(client, actor, catalog.workspace_id, permission, catalog.id);
  return { catalog, role };
}
export async function releasesFor(client: Sql, catalog: Catalog) {
  return (
    await client.query<ReleaseRow>(
      `SELECT r.*,v.state AS review_state,v.notes,v.reviewed_digest FROM course_releases r
    JOIN admin_release_reviews v ON v.release_id=r.id WHERE v.catalog_id=$1 AND r.workspace_id=$2 AND r.course_key=$3 ORDER BY r.created_at DESC,r.id`,
      [catalog.id, catalog.workspace_id, catalog.course_key],
    )
  ).rows;
}
/** The author's question limit across the course's live (published or archived) releases. */
async function authorLimitFor(client: Sql, catalog: Catalog) {
  const live = (await releasesFor(client, catalog)).filter((r) => r.status === "published" || r.status === "archived");
  return authorPlacementLimit(live.map((r) => r.server_bundle));
}
async function authorBoundsFor(client: Sql, catalog: Catalog) {
  const live = (await releasesFor(client, catalog)).filter((r) => r.status === "published" || r.status === "archived");
  return authorPlacementBounds(live.map((r) => r.server_bundle));
}
export async function enrollmentFor(
  client: Sql,
  actor: Actor,
  id: string,
  permission: AdminPermission,
  lock = false,
): Promise<EnrollmentContext & { role: string }> {
  parse(uuid, id);
  const enrollment = (
    await client.query<Enrollment>(
      `SELECT * FROM enrollments WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  requireCondition(enrollment, "ENROLLMENT_NOT_FOUND", 404);
  const role = await permit(client, actor, enrollment.workspace_id, permission, await catalogOfEnrollment(client, enrollment));
  const release = (
    await client.query<Release>(
      "SELECT * FROM course_releases WHERE id=$1 AND workspace_id=$2",
      [enrollment.course_release_id, enrollment.workspace_id],
    )
  ).rows[0];
  requireCondition(release, "RELEASE_NOT_FOUND", 404);
  const progress = (
    await client.query<ProgressRow>(
      "SELECT * FROM episode_progress WHERE enrollment_id=$1",
      [id],
    )
  ).rows;
  const evidence = (
    await client.query<EvidenceRow>(
      `SELECT e.id,e.objective_id,e.independent,e.result,a.family_id,a.assessment_id,${effectiveDigestSql()} AS course_digest,a.mode
    FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`,
      [id],
    )
  ).rows;
  return { enrollment, release, progress, evidence, role };
}
function installed(options: AdminRuntimeOptions): RuntimeExtension[] {
  return [
    ...(typeof options.installedExtensions === "function"
      ? options.installedExtensions()
      : (options.installedExtensions ?? [])),
  ];
}
/**
 * The checks shown on a release, as codes the admin app words (releaseChecks namespace):
 * SDK_DIGEST_MATCHES / SDK_DIGEST_MISMATCH, RUNTIME_SUPPORTED / RUNTIME_UNSUPPORTED (params.reason
 * is the refusal code), SANDBOXED_WEB_ACTIVITIES and LEGACY_RECOGNITION_ONLY_GATES (warnings).
 */
export function validation(release: ReleaseRow, options: AdminRuntimeOptions): ReleaseCheck[] {
  let valid = true,
    reason: string | null = null;
  try {
    const compiled = compileCourse(release.server_bundle);
    valid = compiled.digest === release.digest;
  } catch {
    valid = false;
  }
  try {
    assertCourseRunnable(release.server_bundle, installed(options));
  } catch (error) {
    reason = error instanceof ApiError ? error.code : "PUBLISH_CAPABILITY_MISSING";
  }
  return [
    { code: valid ? "SDK_DIGEST_MATCHES" : "SDK_DIGEST_MISMATCH", passed: valid },
    reason === null ? { code: "RUNTIME_SUPPORTED", passed: true } : { code: "RUNTIME_UNSUPPORTED", passed: false, params: { reason } },
    // Not a failure: a standing limit staff must know about before they publish such activities (README "Activity runtime").
    ...(installed(options).some((extension) => extension.activityRuntime?.kind === "sandboxed_web")
      ? [{ code: "SANDBOXED_WEB_ACTIVITIES" as const, passed: true, warning: true }]
      : []),
    // Not a failure: SDK 0.4 bundles stay publishable, but staff should know a checkpoint can be passed on recognition alone.
    ...((gates) => gates.length
      ? [{ code: "LEGACY_RECOGNITION_ONLY_GATES" as const, passed: true, warning: true, params: { gates: gates.join(", ") } }]
      : [])(recognitionOnlyLegacyGates(release.server_bundle)),
  ];
}
export interface ReleaseCheck {
  code: ReleaseCheckCode;
  passed: boolean;
  warning?: boolean;
  params?: Record<string, string>;
}
/** Model slots for the read-only AI services list. Names and descriptions are IDs; the admin app
 * words them (`aiServices.role.<role>.*`, `providersView.provider`). Status is not verification. */
async function runtimeProviders(options: AdminRuntimeOptions,workspaceId:string,client:Sql) {
  const status = await options.providerStatus?.(workspaceId,client);
  if (!status?.models.length)
    return AGENT_ROLES.map((role) => ({
      id: role,
      name: role,
      description: "",
      capabilities: [role],
      configuration: "absent",
      verification: "not_run",
      connectionLabel: "",
      environment: "",
      runtimeStatus: status?.roles[role]?.status ?? "configuration_missing",
    }));
  return status.models.map((model) => ({
    id: model.id,
    name: model.id,
    description: model.providerId,
    capabilities: model.capabilities.map(String),
    configuration: model.configuration,
    verification: "not_run",
    connectionLabel: model.providerId,
    environment: "",
    enabled: model.enabled,
  }));
}
async function enrollmentView(client: Sql, actor: Actor, enrollmentId: string) {
  const context = await enrollmentFor(
    client,
    actor,
    enrollmentId,
    "enrollment.read",
  );
  const course = context.release.server_bundle;
  if (context.enrollment.status === "erased")
    return {
      id: enrollmentId,
      learnerRef: context.enrollment.user_id,
      revision: context.enrollment.revision,
      // No name: the admin words an erased enrollment in the reader's language (status "erased").
      profile: { displayName: "", goal: "", pace: "steady" as const },
      releaseVersion: course.version,
      status: "erased",
      completed: 0,
      required: episodes(course).length,
      lessons: [],
      evidence: [],
    };
  const progress = learningSnapshot(
    course,
    context.release.digest,
    context.progress,
    context.evidence,
  );
  const rows = (
    await client.query(
      `SELECT e.*,a.course_digest,a.assessment_id,a.mode,a.assistance,a.result AS grade_result,
    review.id AS review_id,review.decision,review.note FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
    LEFT JOIN LATERAL (SELECT * FROM admin_evidence_reviews r WHERE r.evidence_id=e.id ORDER BY r.created_at DESC LIMIT 1) review ON true
    WHERE e.enrollment_id=$1 ORDER BY e.created_at,e.id`,
      [enrollmentId],
    )
  ).rows;
  const run = (
    await client.query(
      "SELECT state,stop_reason,proposal,start_episode_id FROM placement_runs WHERE enrollment_id=$1 ORDER BY run_number DESC LIMIT 1",
      [enrollmentId],
    )
  ).rows[0];
  const placement = run
    ? {
        state: run.state as string,
        stopReason: (run.stop_reason as string | null) ?? null,
        exemptEpisodeIds: (run.proposal?.exemptEpisodeIds as string[] | undefined) ?? [],
        startEpisodeId: (run.start_episode_id as string | null) ?? null,
        items: (run.proposal?.itemsUsed as number | undefined) ?? null,
      }
    : null;
  // Name, learning goal and pace, as the shared privacy rule shows them to this role.
  const profile = parse(profileSchema, {
    displayName: "Learner",
    goal: "",
    pace: "steady",
    ...enrollmentProfileFor("staff", context.role, context.enrollment.profile),
  });
  return {
    id: enrollmentId,
    learnerRef: context.enrollment.user_id,
    revision: context.enrollment.revision,
    profile,
    releaseVersion: course.version,
    status: context.enrollment.status,
    completed: progress.lessons.filter((l) =>
      ["completed", "placed"].includes(l.status),
    ).length,
    required: episodes(course).length,
    lessons: progress.lessons.map((l) => ({ id: l.id, status: l.status })),
    placement,
    evidence: rows.map((row) => ({
      id: row.id,
      objective:
        course.objectives.find((o) => o.id === row.objective_id)?.description ??
        row.objective_id,
      summary: row.note
        ? `Review: ${row.note}`
        : `${row.result.regraded ? "Regraded: " : ""}Recorded ${row.evaluator_ref} result: ${row.result.passed ? "passed" : "incorrect"}; ${row.independent ? "independent" : "assisted or practice"}.`,
      status: row.invalidated_at
        ? "rejected"
        : row.course_digest !== context.release.digest
          ? "stale"
          : !row.result.passed || !row.independent
            ? "rejected"
            : row.decision === "accept"
              ? "accepted"
              : "pending_review",
      reviewable:
        !row.invalidated_at && row.course_digest === context.release.digest,
      attemptId: row.attempt_id,
      // A scoped regrade (U07) acts on the attempt behind this evidence while it is in force.
      regradable: !row.invalidated_at && ["practice", "independent"].includes(row.mode) && !["closed", "completed"].includes(context.enrollment.status),
      passed: Boolean(row.result.passed),
      independent: Boolean(row.independent),
      version: row.course_digest,
      rubricVersion: row.evaluator_ref,
      receiptId: row.review_id ?? null,
    })),
  };
}

/** The course's newest 100 runs, or with `runId` that one run of the course at any age. */
async function runSummaries(client: Sql, catalog: Catalog, runId?: string) {
  return (
    await client.query(
      `SELECT j.id,j.role,j.state,j.expected_revision,j.created_at,
    (SELECT count(*)::integer FROM supervisor_tool_calls t WHERE t.job_id=j.id AND t.enrollment_id=j.enrollment_id AND t.workspace_id=j.workspace_id) AS tool_calls,
    (SELECT CASE WHEN count(*)=0 THEN 0 WHEN bool_and(CASE WHEN jsonb_typeof(d.provider_usage->'attempts')='array' THEN jsonb_array_length(d.provider_usage->'attempts')>0 ELSE false END) THEN sum(CASE WHEN jsonb_typeof(d.provider_usage->'attempts')='array' THEN jsonb_array_length(d.provider_usage->'attempts') ELSE 0 END)::integer ELSE NULL END FROM provider_dispatches d WHERE d.job_id=j.id AND d.enrollment_id=j.enrollment_id AND d.workspace_id=j.workspace_id AND d.state<>'not_started') AS provider_attempts,
    (SELECT count(*)::integer FROM supervisor_artifacts a WHERE a.job_id=j.id AND a.enrollment_id=j.enrollment_id AND a.workspace_id=j.workspace_id) AS artifact_count
    FROM supervisor_jobs j JOIN enrollments e ON e.id=j.enrollment_id AND e.workspace_id=j.workspace_id
    JOIN course_releases r ON r.id=e.course_release_id WHERE j.workspace_id=$1 AND r.course_key=$2${runId === undefined ? "" : " AND j.id=$3"} ORDER BY j.created_at DESC LIMIT 100`,
      runId === undefined
        ? [catalog.workspace_id, catalog.course_key]
        : [catalog.workspace_id, catalog.course_key, runId],
    )
  ).rows.map((row) => ({
    id: row.id,
    role: row.role,
    status: row.state,
    startedAt: iso(row.created_at),
    contextVersion: `enrollment-${row.expected_revision}`,
    toolCalls: row.tool_calls,
    providerAttempts:row.provider_attempts,
    artifactCount: row.artifact_count,
  }));
}
/**
 * Why a tool receipt reads as it does, as a code and params for the admin app (runText
 * namespace, `decision.<code>`). Nothing here is model text.
 */
function toolExplanation(t: { tool: string; reason: string | null; draft_verification: string | null; selected: string | null; applied_plan_revision: number | null;
  model_proposal_id: string | null; model_decision: string | null; model_suggestion_digest: string | null }, status: string, ended: boolean): { code: string; params?: Record<string, string | number> } {
  if (["propose_hypothesis", "update_hypothesis", "schedule_probe"].includes(t.tool))
    return t.reason ? { code: "hypothesis_refused", params: { reason: String(t.reason).slice(0, 80) } } : { code: "hypothesis_recorded" };
  if (t.tool === "check_teaching") return { code: ended ? "check_teaching_ended" : "check_teaching_pending", params: { verification: t.draft_verification ?? "unavailable" } };
  if (t.selected === "true" && t.applied_plan_revision === null && status === "applied") return { code: "candidate_not_selected" };
  if (t.selected === "true" && t.applied_plan_revision === null && ended) return { code: "candidate_ended" };
  if (t.model_proposal_id !== null) return { code: "preference_proposal", params: { decision: t.model_decision ?? "pending" } };
  if (t.model_suggestion_digest !== null) return { code: ended ? "preference_ended" : "preference_pending" };
  if (t.applied_plan_revision !== null) return { code: "support_delivered", params: { planRevision: Number(t.applied_plan_revision) } };
  return { code: ended ? "receipt_ended" : "receipt_pending" };
}
async function workspaceView(
  client: Sql,
  actor: Actor,
  catalogId: string,
  options: AdminRuntimeOptions,
) {
  const { catalog, role } = await catalogFor(client, actor, catalogId);
  const permissions = adminPermissionMatrix[role] ?? [];
  const releases = await releasesFor(client, catalog);
  const visible = ["owner", "admin", "author", "reviewer"].includes(role)
    ? releases
    : releases.filter((r) => r.status === "published");
  // Release checks below run every visual check; prepare them in parallel, off the event loop.
  await Promise.all(visible.map((release) => prepareCourseRunnable(release.server_bundle, installed(options))));
  const enrollments = permissions.includes("enrollment.read")
    ? (
        await client.query<{ id: string }>(
          `SELECT e.id FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.workspace_id=$1 AND r.course_key=$2 ORDER BY e.started_at DESC LIMIT 500`,
          [catalog.workspace_id, catalog.course_key],
        )
      ).rows
    : [];
  const providers = await runtimeProviders(options,catalog.workspace_id,client);
  const requests = (
    await client.query(
      "SELECT provider_id,connection_label,environment FROM admin_provider_requests WHERE catalog_id=$1 AND state='pending_review'",
      [catalogId],
    )
  ).rows;
  for (const provider of providers) {
    const request = requests.find((row) => row.provider_id === provider.id);
    if (request) {
      // A metadata change request awaits server operator review.
      Object.assign(provider, { requestPending: true });
      if (provider.configuration === "absent")
        provider.configuration = "pending_review";
    }
  }
  const budget = permissions.includes("run.inspect")
    ? ((
        await client.query(
          "SELECT limit_micro_usd::text,limit_tokens::text,used_micro_usd::text,used_tokens::text FROM supervisor_workspace_budgets WHERE workspace_id=$1",
          [catalog.workspace_id],
        )
      ).rows[0] ?? null)
    : null;
  const enrollmentViews = [];
  for (const row of enrollments)
    enrollmentViews.push(await enrollmentView(client, actor, row.id));
  return {
    course: {
      id: catalogId,
      title: catalog.title,
      description: catalog.description,
      // A code, worded by the admin app in the reader's language (adminApp.workspace).
      categoryCode: "course_workspace" as const,
      objectives: (visible[0]?.server_bundle.objectives ?? []).map(
        (o) => o.description,
      ),
      workspaceId: catalog.workspace_id,
    },
    role,
    revision: String(catalog.revision),
    permissions,
    releases: visible.map((release) => ({
      id: release.id,
      version: release.version,
      availableForNewLearners: release.status === "published" && release.id === catalog.active_release_id,
      state: release.status === "draft" ? release.review_state : release.status,
      notes: release.notes,
      createdAt: iso(release.created_at),
      checks: validation(release, options),
    })),
    enrollments: enrollmentViews,
    providers,
    runs: permissions.includes("run.inspect")
      ? await runSummaries(client, catalog)
      : [],
    toolBudget: budget,
  };
}

function headerContext(request: FastifyRequest) {
  const revision = request.headers["if-match"],
    idempotencyKey = request.headers["idempotency-key"];
  requireCondition(
    typeof revision === "string" && /^[1-9][0-9]*$/.test(revision),
    "INVALID_REVISION",
  );
  return parse(commandSchema, {
    expectedRevision: Number(revision),
    idempotencyKey,
  });
}
async function courseCommand(
  db: Database,
  actor: Actor,
  catalogId: string,
  permission: AdminPermission,
  operation: string,
  input: { expectedRevision: number; idempotencyKey: string },
  semantic: unknown,
  options: AdminRuntimeOptions,
  execute: (
    client: PoolClient,
    catalog: Catalog,
  ) => Promise<{
    outcome: "saved" | "pending_review" | "published";
    message: StaffMessage;
    /** The learner this command concerns when the request does not name it (a new enrollment). */
    enrollmentId?: string;
  }>,
) {
  return transaction(db, async (client) => {
    const { catalog } = await catalogFor(
      client,
      actor,
      catalogId,
      permission,
      true,
    );
    const requestDigest = digestJson({
      actorId: actor.id,
      operation,
      semantic,
    });
    const previous = (
      await client.query(
        "SELECT request_digest,response FROM admin_command_receipts WHERE catalog_id=$1 AND idempotency_key=$2",
        [catalogId, input.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      requireSameRequest(previous.request_digest, requestDigest, "IDEMPOTENCY_CONFLICT");
      return courseCommandResponse(await workspaceView(client, actor, catalogId, options), previous.response);
    }
    requireCondition(
      catalog.revision === input.expectedRevision,
      "STALE_REVISION",
      409,
    );
    const result = await execute(client, catalog);
    await client.query(
      "UPDATE admin_course_catalog SET revision=revision+1 WHERE id=$1",
      [catalogId],
    );
    const event = await appendEvent(client, {
      workspaceId: catalog.workspace_id,
      actorId: actor.id,
      actorKind: "staff",
      type: operation,
      payload: { catalogId },
      idempotencyKey: `admin:${catalogId}:${input.idempotencyKey}`,
    });
    // The receipt keeps only what the command decided. The workspace view lists every
    // enrollment's profile and review notes, so it is rebuilt for each reply, never stored.
    const receipt: CourseCommandReceipt = {
      receipt: { id: event.id, authority: "server", outcome: result.outcome },
      message: result.message,
    };
    // A command about one learner records which, so erasing them tombstones its digest (065).
    const enrollmentId = result.enrollmentId ?? (typeof semantic === "object" && semantic !== null && "enrollmentId" in semantic
      && typeof semantic.enrollmentId === "string" ? semantic.enrollmentId : null);
    const saved = await client.query(
      "INSERT INTO admin_command_receipts(catalog_id,idempotency_key,request_digest,actor_id,response,enrollment_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING response",
      [
        catalogId,
        input.idempotencyKey,
        requestDigest,
        actor.id,
        JSON.stringify(receipt),
        enrollmentId,
      ],
    );
    return courseCommandResponse(await workspaceView(client, actor, catalogId, options), saved.rows[0]!.response);
  });
}
interface CourseCommandReceipt {
  receipt: { id: string; authority: "server"; outcome: "saved" | "pending_review" | "published" };
  /** A code since the admin app translates outcomes; receipts stored before that hold English. */
  message: StaffMessage | string;
}
/** A course command's reply: the stored receipt with the workspace as it is now. The first reply
 * and every replay are built the same way, so a replay answers exactly as the command did when
 * nothing has changed since, and with the current workspace when something has. */
function courseCommandResponse(workspace: Awaited<ReturnType<typeof workspaceView>>, stored: CourseCommandReceipt) {
  return { workspace, receipt: stored.receipt, message: stored.message };
}
export async function enrollmentCommand<T>(
  db: Database,
  actor: Actor,
  enrollmentId: string,
  permission: AdminPermission,
  operation: string,
  input: { expectedRevision: number; idempotencyKey: string },
  semantic: unknown,
  execute: (client: PoolClient, context: EnrollmentContext) => Promise<T>,
) {
  return transaction(db, async (client) => {
    const context = await enrollmentFor(
      client,
      actor,
      enrollmentId,
      permission,
      true,
    );
    requireCondition(context.enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
    const digest = digestJson({ actorId: actor.id, operation, semantic });
    const old = (
      await client.query(
        "SELECT request_digest,response FROM command_receipts WHERE enrollment_id=$1 AND idempotency_key=$2",
        [enrollmentId, input.idempotencyKey],
      )
    ).rows[0];
    if (old) {
      requireSameRequest(old.request_digest, digest, "IDEMPOTENCY_CONFLICT");
      return old.response as T;
    }
    requireCondition(
      context.enrollment.revision === input.expectedRevision,
      "STALE_REVISION",
      409,
    );
    const response = await execute(client, context);
    const saved = await client.query(
      "INSERT INTO command_receipts(enrollment_id,idempotency_key,request_digest,response) VALUES($1,$2,$3,$4) RETURNING response",
      [enrollmentId, input.idempotencyKey, digest, JSON.stringify(response)],
    );
    return saved.rows[0]!.response as T;
  });
}
export async function savePolicy(
  client: PoolClient,
  id: string,
  transition: Transition,
) {
  const saved = await client.query(
    "UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4,updated_at=now() WHERE enrollment_id=$1 AND policy_revision=$5 AND ledger_revision=$6",
    [
      id,
      JSON.stringify(transition.state),
      transition.state.policyRevision,
      transition.state.ledgerRevision,
      transition.preconditions.policyRevision,
      transition.preconditions.ledgerRevision,
    ],
  );
  requireCondition(saved.rowCount === 1, "STALE_POLICY_REVISION", 409);
  await client.query(
    "UPDATE enrollments SET revision=revision+1,policy_revision=$2 WHERE id=$1",
    [id, transition.state.policyRevision],
  );
}
export async function policyView(client: Sql, context: EnrollmentContext) {
  const policy = await loadPolicy(client as PoolClient, context.enrollment.id),
    course = context.release.server_bundle;
  // The organization and enrollment levels have no course title: the admin app names them by level.
  const label = (scope: ScopePolicy) =>
    scope.kind === "organization" || scope.kind === "enrollment"
      ? null
      : scope.kind === "course"
      ? course.title
      : scope.kind === "chapter"
        ? (course.chapters.find((c) => `chapter:${c.id}` === scope.scopeId)
            ?.title ?? scope.scopeId)
        : (episodes(course).find((e) => `episode:${e.id}` === scope.scopeId)
            ?.title ?? scope.scopeId);
  const rationale = (
    await client.query<{ id: string; event_type: string }>(
      "SELECT id,event_type FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 ORDER BY sequence DESC LIMIT 100",
      [policy.enrollmentId, context.enrollment.workspace_id],
    )
  ).rows;
  return {
    enrollmentId: policy.enrollmentId,
    learnerId: policy.learnerId,
    revision: context.enrollment.revision,
    policyRevision: policy.policyRevision,
    ledgerRevision: policy.ledgerRevision,
    status: policy.status,
    scopes: policy.scopes.map((scope) => ({ ...scope, label: label(scope) })),
    pools: policy.pools,
    constraints: policy.scopes.map((scope) =>
      resolveConstraints(policy, scope.scopeId),
    ),
    balances: poolBalances(policy),
    offers: policy.offers,
    grants: policy.grants,
    ...policyLedgerView(policy, context),
    accommodations: policy.accommodations.map((a) => ({ accommodationId: a.accommodationId, kind: a.kind, scopeId: a.adjustment.scopeId, adjustment: a.adjustment, newPolicyRevision: a.newPolicyRevision })),
    rationaleEvents: rationale.map((e) => ({ id: e.id, label: e.event_type })),
    // An inserted personal episode is governed by its anchor episode's scope.
    activities: episodes(course).map((e) => ({
      id: e.id,
      scopeId: `episode:${policyEpisodeId(context.release, e.id)}`,
      label: e.title,
    })),
  };
}
/** Static conditions under which staff may acknowledge (accept) existing evidence as valid:
 * an independent, unassisted, passing deterministic answer on the enrollment's current course
 * version. Acknowledging never changes a grade; the route also regrades the stored answer. */
export function acknowledgeable(
  evidence: {
    result: { passed?: unknown }; attempt_result: { passed?: unknown }; independent: boolean; independent_eligible: boolean | null;
    assistance: string; challenge_assistance: string | null; mode: string; course_digest: string; assessment_id: string;
  },
  release: Release,
) {
  const assessment = release.server_bundle.assessments.find((a) => a.id === evidence.assessment_id);
  return Boolean(
    assessment && ["choice", "numeric"].includes(assessment.type) &&
      evidence.result.passed === true && evidence.attempt_result.passed === true &&
      evidence.independent === true && evidence.independent_eligible === true &&
      evidence.assistance === "none" && evidence.challenge_assistance === "none" &&
      evidence.mode !== "practice" && evidence.course_digest === release.digest,
  );
}
export const EVIDENCE_REVIEW_COLUMNS = `e.*,a.assessment_id,a.response,a.result AS attempt_result,a.assistance,a.mode,a.course_digest,c.independent_eligible,c.assistance AS challenge_assistance`;
export const EVIDENCE_REVIEW_JOINS = `JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id LEFT JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=e.enrollment_id`;

/**
 * One staff review of a piece of evidence, in the caller's transaction (which has checked
 * `evidence.review` on the catalog). `accept` acknowledges a valid result without changing it;
 * `reject` invalidates it and recomputes progress. Either one records an admin_evidence_reviews
 * row, which also closes a learner's open dispute of that evidence (learner-model.ts).
 */
export async function reviewEvidenceWithin(
  client: PoolClient,
  actor: Actor,
  catalog: Catalog,
  input: { enrollmentId: string; evidenceId: string; decision: "accept" | "reject"; note: string; enrollmentRevision?: number; disputeId?: string },
) {
  const context = await enrollmentFor(client, actor, input.enrollmentId, "evidence.review", true);
  requireCondition(
    context.enrollment.workspace_id === catalog.workspace_id &&
      context.release.server_bundle.id === catalog.course_key,
    "EVIDENCE_NOT_FOUND",
    404,
  );
  if (input.enrollmentRevision !== undefined)
    requireCondition(context.enrollment.revision === input.enrollmentRevision, "STALE_REVISION", 409);
  const evidence = (
    await client.query(
      `SELECT ${EVIDENCE_REVIEW_COLUMNS} FROM evidence e ${EVIDENCE_REVIEW_JOINS} WHERE e.id=$1 AND e.enrollment_id=$2 FOR UPDATE OF e`,
      [input.evidenceId, context.enrollment.id],
    )
  ).rows[0];
  requireCondition(evidence && !evidence.invalidated_at, "EVIDENCE_NOT_FOUND", 404);
  if (input.decision === "accept") {
    const assessment = context.release.server_bundle.assessments.find((a) => a.id === evidence.assessment_id);
    // Keeping a result that did not pass grants nothing, whatever kind of answer it was (code,
    // choice, a delayed check). Upholding a pass must be re-checkable by Core without grading again.
    requireCondition(
      evidence.result.passed === false ||
        (acknowledgeable(evidence, context.release) && assessment && gradeDeterministic(assessment, evidence.response).passed),
      "REVIEW_CANNOT_GRANT_MASTERY",
      409,
    );
    // Acknowledge a valid pre-existing result. NEVER update result/independent or create evidence.
  } else
    await client.query("UPDATE evidence SET invalidated_at=now(),invalidation_reason=$2 WHERE id=$1", [evidence.id, input.note]);
  // A closed course is not reopened; the learner is shown the withdrawn evidence (closed-record.ts).
  if (input.decision === "reject")
    await auditClosedRecordAmended(client, { workspaceId: catalog.workspace_id, enrollmentId: context.enrollment.id, source: "evidence_rejected",
      assessmentId: evidence.assessment_id, evidence: 1, idempotencyKey: `closed-record:evidence:${evidence.id}` });
  // The status is never rewritten here. `completed` (finished with mastery) and `closed`
  // (a cap or deadline ended the course) are outcomes recorded at closure; a later
  // rejection amends the record (notice + audit above) without turning a completion into
  // a cap closure, which would also change completed-course Q&A and retention access.
  await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [context.enrollment.id]);
  // Invalidated evidence supersedes any decision that relied on it.
  if (input.decision === "reject") await refreshDecisionsForEnrollment(client, context.enrollment.id, evidence.assessment_id);
  // A withdrawn delayed-check result no longer moves the review schedule.
  if (input.decision === "reject" && evidence.mode === "retention") await replayRetention(client, context.enrollment.id, [evidence.objective_id]);
  const event = await appendEvent(client, {
    workspaceId: catalog.workspace_id,
    enrollmentId: context.enrollment.id,
    actorId: actor.id,
    actorKind: "staff",
    type: input.decision === "reject" ? "evidence.invalidated" : "evidence.review_acknowledged",
    payload: { evidenceId: evidence.id, decision: input.decision, changesGrade: false, ...(input.disputeId ? { disputeId: input.disputeId } : {}) },
    idempotencyKey: `admin-evidence:${randomUUID()}`,
    supervise: true,
  });
  await client.query(
    "INSERT INTO admin_evidence_reviews(id,evidence_id,enrollment_id,actor_id,decision,note,event_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [randomUUID(), evidence.id, context.enrollment.id, actor.id, input.decision, input.note, event.id],
  );
  return {
    outcome: "saved" as const,
    eventId: event.id,
    message:
      staffMessage(input.decision === "accept" ? "EVIDENCE_REVIEW_ACCEPTED" : "EVIDENCE_INVALIDATED"),
  };
}
/**
 * One review/publication transition of a release, inside the caller's transaction with the
 * catalog locked and the actor's permission for `input.action` already checked. Shared by the
 * transitions route and the course-package installer.
 */
export async function transitionReleaseWithin(
  client: PoolClient,
  actor: Actor,
  catalog: Catalog,
  releaseId: string,
  input: { action: "submit-review" | "approve" | "publish" | "activate" | "archive"; impactDigest?: string | undefined; confirmOlderVersion?: true | undefined;
    /** Staff publishing from the admin page confirm the forward impact (release-editing.ts). */
    confirmForward?: boolean },
  options: AdminRuntimeOptions,
): Promise<{ outcome: "saved" | "pending_review" | "published"; message: StaffMessage }> {
  const row = (await releasesFor(client, catalog)).find(
    (r) => r.id === releaseId,
  );
  requireCondition(row, "RELEASE_NOT_FOUND", 404);
  const release = (
    await client.query<ReleaseRow>(
      "SELECT * FROM course_releases WHERE id=$1 FOR UPDATE",
      [row.id],
    )
  ).rows[0]!;
  if (input.action === "archive") {
    requireCondition(release.status === "published", "PUBLISHED_RELEASE_REQUIRED", 409);
    // The release new learners start on cannot be archived; select another one first.
    requireCondition(release.id !== catalog.active_release_id, "ACTIVE_RELEASE_ARCHIVE_FORBIDDEN", 409);
    await client.query("UPDATE course_releases SET status='archived' WHERE id=$1", [release.id]);
    const pinned = (await client.query<{ n: number }>("SELECT count(*)::int AS n FROM enrollments WHERE course_release_id=$1 AND status IN ('active','paused')", [release.id])).rows[0]!.n;
    await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: "staff", type: "release.archived",
      payload: { catalogId: catalog.id, releaseId: release.id, version: release.version, pinnedLearners: pinned }, idempotencyKey: `release:${release.id}:archive` });
    return { outcome: "saved", message: staffMessage("RELEASE_ARCHIVED", { learners: pinned }) };
  }
  if (input.action === "activate") {
    requireCondition(release.status === "published", "PUBLISHED_RELEASE_REQUIRED", 409);
    const active = (await releasesFor(client, catalog)).find((r) => r.id === catalog.active_release_id);
    // Selecting an older release than the live one is a rollback: staff confirm its exact impact.
    if (active && active.id !== release.id && active.created_at > release.created_at) {
      const { impact, impactDigest } = await rollbackImpact(client, active, release);
      if (!input.impactDigest) throw new ApiError(428, "IMPACT_CONFIRMATION_REQUIRED", "IMPACT_CONFIRMATION_REQUIRED", { impact, impactDigest });
      if (input.impactDigest !== impactDigest) throw new ApiError(409, "IMPACT_CHANGED", "IMPACT_CHANGED", { impact, impactDigest });
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: "staff", type: "release.rolled_back",
        payload: { catalogId: catalog.id, fromReleaseId: active.id, toReleaseId: release.id, impactDigest }, idempotencyKey: `release:${catalog.id}:rollback:${randomUUID()}` });
    }
    const compiled = compileCourse(release.server_bundle);
    requireCondition(compiled.digest === release.digest, "RELEASE_DIGEST_MISMATCH", 409);
    await prepareCourseRunnable(release.server_bundle, installed(options));
    assertCourseRunnable(release.server_bundle, installed(options));
    await assertPublishable(client, release.id, release.server_bundle);
    await selectCatalogueReleaseWithin(client, catalog.id, release.id);
    return { outcome: "saved", message: staffMessage("RELEASE_ACTIVATED") };
  }
  requireCondition(
    release.status === "draft",
    "PUBLISHED_RELEASE_IMMUTABLE",
    409,
  );
  requireCondition(
    row.review_state ===
      {
        "submit-review": "draft",
        approve: "pending_review",
        publish: "approved",
      }[input.action],
    "RELEASE_REVIEW_REQUIRED",
    428,
  );
  const compiled = compileCourse(release.server_bundle);
  requireCondition(
    compiled.digest === release.digest,
    "RELEASE_DIGEST_MISMATCH",
    409,
  );
  // The parent's live runtime gate is called on every transition, including inside publication.
  await prepareCourseRunnable(release.server_bundle, installed(options));
  assertCourseRunnable(release.server_bundle, installed(options));
  if (input.action === "publish") {
    requireCondition(
      row.reviewed_digest === release.digest,
      "RELEASE_REVIEW_REQUIRED",
      428,
    );
    // Versions move forward; publishing an older one needs explicit confirmation (course-versions.ts).
    const backFrom = await assertPublishVersion(client, release, input.confirmOlderVersion === true);
    await assertPublishable(client, release.id, release.server_bundle);
    if (input.confirmForward) {
      const active = catalog.active_release_id ? (await releasesFor(client, catalog)).find((r) => r.id === catalog.active_release_id) ?? null : null;
      requireConfirmedImpact(await publishImpact(client, catalog, active, release), input.impactDigest);
    }
    await client.query(
      "UPDATE course_releases SET status='published' WHERE id=$1",
      [release.id],
    );
    if (backFrom)
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: "staff", type: "release.older_version_published",
        payload: { catalogId: catalog.id, releaseId: release.id, version: release.version, newestPublished: backFrom }, idempotencyKey: `release:${release.id}:older-version` });
    await selectCatalogueReleaseWithin(client, catalog.id, release.id);
    return {
      outcome: "published",
      message:
        staffMessage("RELEASE_PUBLISHED"),
    };
  }
  await client.query(
    "UPDATE admin_release_reviews SET state=$2,reviewed_digest=$3,reviewed_by=$4,updated_at=now() WHERE release_id=$1",
    [
      release.id,
      input.action === "approve" ? "approved" : "pending_review",
      input.action === "approve" ? release.digest : null,
      input.action === "approve" ? actor.id : null,
    ],
  );
  return {
    outcome: input.action === "approve" ? "saved" : "pending_review",
    message:
      staffMessage(input.action === "approve" ? "RELEASE_APPROVED" : "RELEASE_SUBMITTED"),
  };
}
export function registerAdminRoutes(
  app: FastifyInstance,
  db: Database,
  auth: Auth,
  options: AdminRuntimeOptions = {},
) {
  const path = "/api/admin";
  app.get(`${path}/session`, async (request) => {
    const actor = await auth.authenticate(request);
    // Workspace staff see every course; course-scoped members only courses of active grants.
    const rows = await sessionCourses(db, actor.id);
    // Workspaces this person runs: AI services are set up per workspace, before any course exists.
    const workspaces = (
      await db.query<{ id: string; title: string; role: string }>(
        "SELECT w.id,w.title,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1 AND m.role IN ('owner','admin') ORDER BY w.title,w.id LIMIT 50",
        [actor.id],
      )
    ).rows;
    return {
      actor: { id: actor.id, name: actor.displayName, role: "member" },
      workspaces,
      courses: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        workspaceId: r.workspace_id,
        workspaceTitle: r.workspace_title,
        role: r.role,
        ...(r.grant_expires_at ? { accessExpiresAt: iso(r.grant_expires_at) } : {}),
      })),
      deployment: { insecureOriginsAllowed: options.insecureOriginsAllowed === true },
    };
  });
  /** What needs attention on one course. Sections the role cannot read are null. */
  app.get(`${path}/courses/:courseId/overview`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!);
      const permissions = adminPermissionMatrix[role] ?? [];
      return courseOverview(client, catalog, {
        enrollments: permissions.includes("enrollment.read"),
        policy: permissions.includes("policy.read"),
        runs: permissions.includes("run.inspect"),
      }, (release) => validation(release as ReleaseRow, options));
    });
  });
  /** Workspace audit log, newest first. Payloads only for allowlisted staff/system events. */
  app.get(`${path}/workspaces/:workspaceId/audit`, async (request) => {
    const actor = await auth.authenticate(request),
      workspaceId = parse(uuid, params(request).workspaceId),
      query = parse(
        z.strictObject({
          before: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          actorKind: z.enum(["learner", "staff", "agent", "system"]).optional(),
          type: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/).optional(),
        }),
        request.query ?? {},
      );
    return transaction(db, async (client) => {
      // Workspace-wide: a course-scoped grant never opens the workspace log.
      await permit(client, actor, workspaceId, "audit.read");
      return workspaceAudit(client, workspaceId, query);
    });
  });
  /** Placement administration for one course: author policy, staff settings, the effective
   * result, what the blueprint and protected units mean per episode, and quality counters. */
  app.get(`${path}/courses/:courseId/placement`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!);
      const active = catalog.active_release_id ? (await client.query<ReleaseRow>("SELECT * FROM course_releases WHERE id=$1", [catalog.active_release_id])).rows[0] : undefined;
      const row = await placementSettingsRow(client, catalog.workspace_id, catalog.course_key);
      const author = active?.server_bundle.placement;
      return {
        authorLimit: await authorLimitFor(client, catalog),
        authorBounds: await authorBoundsFor(client, catalog),
        author: author ? { enabled: author.enabled, maxItems: author.maxItems, learnerMayDecline: author.learnerMayDecline, assessmentIds: author.assessmentIds,
          objectiveIds: author.objectiveIds, protectedEpisodeIds: author.protectedEpisodeIds, retestPolicy: author.retestPolicy ?? null,
          assistancePolicy: author.assistancePolicy ?? null, evidenceThresholds: author.evidenceThresholds ?? null,
          // The blueprint in words, for choosing what to leave out: staff (course.read) already see the course's questions.
          items: author.assessmentIds.map((id) => active!.server_bundle.assessments.find((a) => a.id === id)).filter((a) => a !== undefined)
            .map((a) => ({ assessmentId: a.id, familyId: a.familyId, objectiveIds: a.objectiveIds, prompt: a.prompt.replace(/\s+/g, " ").slice(0, 200) })),
          objectives: author.objectiveIds.map((id) => ({ objectiveId: id, description: active!.server_bundle.objectives.find((o) => o.id === id)?.description ?? id })) } : null,
        settings: settingsView(row),
        effective: active ? effectivePlacement(active.server_bundle, row) : null,
        blueprint: active ? placementBlueprint(active.server_bundle, row) : null,
        counters: (adminPermissionMatrix[role] ?? []).includes("enrollment.read") ? await placementCounters(client, catalog.workspace_id, catalog.course_key) : null,
      };
    });
  });
  const placementSettingsSchema = z.strictObject({
    expectedRevision: z.number().int().min(0),
    enabled: z.boolean(),
    retestCooldownHours: z.number().int().min(0).max(8760),
    maxRuns: z.number().int().min(1).max(10),
    maxItems: z.number().int().min(1).max(100).nullable(),
    minFamiliesPerEpisode: z.number().int().min(1).max(10).nullable(),
    // Staff narrowing of the author's blueprint and protected units (migration 098). Omitted = unchanged.
    excludedAssessmentIds: z.array(z.string().min(1).max(200)).max(500).optional(),
    excludedObjectiveIds: z.array(z.string().min(1).max(200)).max(500).optional(),
    protectedEpisodeIds: z.array(z.string().min(1).max(200)).max(500).optional(),
  });
  type PlacementSettingsInput = z.infer<typeof placementSettingsSchema>;
  /** The settings row these inputs would save, over the current one, checked against the author. */
  async function proposedPlacement(client: Sql, catalog: Catalog, input: PlacementSettingsInput, current: PlacementSettingsRow | null) {
    const refused = placementLimitError(input.maxItems, await authorLimitFor(client, catalog))
      ?? placementBoundsError(input, await authorBoundsFor(client, catalog));
    if (refused) throw new ApiError(409, refused);
    const active = catalog.active_release_id ? (await client.query<ReleaseRow>("SELECT * FROM course_releases WHERE id=$1", [catalog.active_release_id])).rows[0] : undefined;
    const author = active?.server_bundle.placement;
    const unique = (ids: string[] | undefined, fallback: string[]) => [...new Set(ids ?? fallback)];
    const row = { ...(current ?? { workspace_id: catalog.workspace_id, course_key: catalog.course_key, revision: 0, updated_by: null, updated_at: new Date() }),
      enabled: input.enabled, retest_cooldown_hours: input.retestCooldownHours, max_runs: input.maxRuns, max_items: input.maxItems, min_families_per_episode: input.minFamiliesPerEpisode,
      excluded_assessment_ids: unique(input.excludedAssessmentIds, current?.excluded_assessment_ids ?? []),
      excluded_objective_ids: unique(input.excludedObjectiveIds, current?.excluded_objective_ids ?? []),
      protected_episode_ids: unique(input.protectedEpisodeIds, current?.protected_episode_ids ?? []) } as PlacementSettingsRow;
    // Narrowing only: every excluded item or objective must be one the author offered, and an
    // extra protected episode one that exists and the author did not already protect.
    if (author) {
      const episodeIds = new Set(active!.server_bundle.chapters.flatMap((c) => c.episodes.map((e) => e.id)));
      if (input.excludedAssessmentIds && input.excludedAssessmentIds.some((id) => !author.assessmentIds.includes(id))) throw new ApiError(409, "PLACEMENT_ITEM_NOT_IN_BLUEPRINT");
      if (input.excludedObjectiveIds && input.excludedObjectiveIds.some((id) => !author.objectiveIds.includes(id))) throw new ApiError(409, "PLACEMENT_OBJECTIVE_NOT_PLACEABLE");
      if (input.protectedEpisodeIds && input.protectedEpisodeIds.some((id) => !episodeIds.has(id) || author.protectedEpisodeIds.includes(id))) throw new ApiError(409, "PLACEMENT_EPISODE_UNKNOWN");
    } else if ((input.excludedAssessmentIds?.length ?? 0) + (input.excludedObjectiveIds?.length ?? 0) + (input.protectedEpisodeIds?.length ?? 0) > 0)
      throw new ApiError(409, "PLACEMENT_NOT_OFFERED");
    return { row, active };
  }
  /** What the proposed settings would do, without saving them: test before save. */
  app.post(`${path}/courses/:courseId/placement/settings/preview`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(placementSettingsSchema, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write");
      const current = await placementSettingsRow(client, catalog.workspace_id, catalog.course_key);
      const { row, active } = await proposedPlacement(client, catalog, input, current);
      return { effective: active ? effectivePlacement(active.server_bundle, row) : null, blueprint: active ? placementBlueprint(active.server_bundle, row) : null,
        current: active ? placementBlueprint(active.server_bundle, current) : null };
    });
  });
  app.post(`${path}/courses/:courseId/placement/settings`, async (request) => {
    const actor = await auth.authenticate(request), input = parse(placementSettingsSchema, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "policy.write", true);
      const current = await placementSettingsRow(client, catalog.workspace_id, catalog.course_key);
      requireCondition((current?.revision ?? 0) === input.expectedRevision, "STALE_REVISION", 409);
      // Staff settings only tighten the author's: never more questions or runs, a shorter cooldown or
      // fewer item families than any live release that offers placement allows, and the blueprint and
      // protected units only narrowed.
      const { row } = await proposedPlacement(client, catalog, input, current);
      const saved = (await client.query<PlacementSettingsRow>(
        `INSERT INTO placement_settings(workspace_id,course_key,enabled,retest_cooldown_hours,max_runs,max_items,min_families_per_episode,excluded_assessment_ids,excluded_objective_ids,
           protected_episode_ids,revision,updated_by,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,clock_timestamp())
         ON CONFLICT (workspace_id,course_key) DO UPDATE SET enabled=EXCLUDED.enabled,retest_cooldown_hours=EXCLUDED.retest_cooldown_hours,max_runs=EXCLUDED.max_runs,
           max_items=EXCLUDED.max_items,min_families_per_episode=EXCLUDED.min_families_per_episode,excluded_assessment_ids=EXCLUDED.excluded_assessment_ids,
           excluded_objective_ids=EXCLUDED.excluded_objective_ids,protected_episode_ids=EXCLUDED.protected_episode_ids,
           revision=placement_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()
         RETURNING *`,
        [catalog.workspace_id, catalog.course_key, input.enabled, input.retestCooldownHours, input.maxRuns, input.maxItems, input.minFamiliesPerEpisode,
          JSON.stringify(row.excluded_assessment_ids), JSON.stringify(row.excluded_objective_ids), JSON.stringify(row.protected_episode_ids), actor.id])).rows[0]!;
      await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: "staff", type: "placement.settings_changed",
        payload: { catalogId: catalog.id, ...settingsView(saved) }, idempotencyKey: `placement-settings:${catalog.id}:${saved.revision}` });
      return { settings: settingsView(saved) };
    });
  });
  app.get(`${path}/courses/:courseId`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, (client) =>
      workspaceView(client, actor, params(request).courseId!, options),
    );
  });
  app.patch(`${path}/courses/:courseId`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(
        z.strictObject({
          title: z.string().trim().min(1).max(200),
          description: z.string().max(2000),
        }),
        request.body,
      );
    return courseCommand(
      db,
      actor,
      params(request).courseId!,
      "course.write",
      "admin.course.updated",
      headerContext(request),
      input,
      options,
      async (client, catalog) => {
        await client.query(
          "UPDATE admin_course_catalog SET title=$2,description=$3 WHERE id=$1",
          [catalog.id, input.title, input.description],
        );
        return {
          outcome: "saved",
          message:
            staffMessage("COURSE_SAVED"),
        };
      },
    );
  });
  app.post(`${path}/courses/:courseId/releases`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(
        z.strictObject({
          version: z.string().regex(/^\d+\.\d+\.\d+$/),
          notes: z.string().trim().min(1).max(1200),
          manifest: z.unknown().optional(),
        }),
        request.body,
      );
    return courseCommand(
      db,
      actor,
      params(request).courseId!,
      "course.write",
      "admin.release.created",
      headerContext(request),
      input,
      options,
      async (client, catalog) => {
        const latest = (await releasesFor(client, catalog))[0];
        requireCondition(latest || input.manifest, "COURSE_BUNDLE_REQUIRED");
        const manifest = input.manifest ?? {
          ...latest!.server_bundle,
          version: input.version,
        };
        const compiled = compileCourse(manifest);
        requireCondition(
          compiled.server.id === catalog.course_key &&
            compiled.server.version === input.version,
          "COURSE_IDENTITY_MISMATCH",
        );
        const id = randomUUID();
        await client.query(
          `INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8)`,
          [
            id,
            catalog.workspace_id,
            catalog.course_key,
            input.version,
            compiled.digest,
            JSON.stringify(compiled.server),
            JSON.stringify(compiled.learner),
            actor.id,
          ],
        );
        await ensureCatalog(client, id);
        await client.query(
          "UPDATE admin_release_reviews SET notes=$2 WHERE release_id=$1",
          [id, input.notes],
        );
        return {
          outcome: "saved",
          message:
            staffMessage("DRAFT_CREATED"),
        };
      },
    );
  });
  app.get(
    `${path}/courses/:courseId/releases/:releaseId/manifest`,
    async (request) => {
      const actor = await auth.authenticate(request),
        { catalog } = await catalogFor(
          db,
          actor,
          params(request).courseId!,
          "course.write",
        );
      const release = (await releasesFor(db, catalog)).find(
        (r) => r.id === params(request).releaseId,
      );
      requireCondition(release, "RELEASE_NOT_FOUND", 404);
      return {
        manifest: release.server_bundle,
        notes: release.notes,
        editable: release.status === "draft",
      };
    },
  );
  app.patch(
    `${path}/courses/:courseId/releases/:releaseId`,
    { bodyLimit: 16 * 1024 * 1024 },
    async (request) => {
      const actor = await auth.authenticate(request),
        input = parse(
          z.strictObject({
            manifest: z.unknown(),
            notes: z.string().max(1200),
          }),
          request.body,
        );
      return courseCommand(
        db,
        actor,
        params(request).courseId!,
        "course.write",
        "admin.release.updated",
        headerContext(request),
        { releaseId: params(request).releaseId, ...input },
        options,
        async (client, catalog) => {
          const release = (await releasesFor(client, catalog)).find(
            (r) => r.id === params(request).releaseId,
          );
          requireCondition(release, "RELEASE_NOT_FOUND", 404);
          const locked = (
            await client.query(
              "SELECT status FROM course_releases WHERE id=$1 FOR UPDATE",
              [release.id],
            )
          ).rows[0];
          requireCondition(
            locked?.status === "draft",
            "PUBLISHED_RELEASE_IMMUTABLE",
            409,
          );
          const compiled = compileCourse(input.manifest);
          requireCondition(
            compiled.server.id === catalog.course_key &&
              compiled.server.version === release.version,
            "COURSE_IDENTITY_MISMATCH",
          );
          await client.query(
            "UPDATE course_releases SET server_bundle=$2,learner_bundle=$3,digest=$4 WHERE id=$1",
            [
              release.id,
              JSON.stringify(compiled.server),
              JSON.stringify(compiled.learner),
              compiled.digest,
            ],
          );
          await client.query(
            "UPDATE admin_release_reviews SET state='draft',notes=$2,reviewed_digest=NULL,reviewed_by=NULL,updated_at=now() WHERE release_id=$1",
            [release.id, input.notes],
          );
          return {
            outcome: "saved",
            message:
              staffMessage("DRAFT_SAVED"),
          };
        },
      );
    },
  );
  app.post(
    `${path}/courses/:courseId/releases/:releaseId/transitions`,
    async (request) => {
      const actor = await auth.authenticate(request),
        input = parse(
          z.strictObject({
            action: z.enum(["submit-review", "approve", "publish", "activate", "archive"]),
            /** Required to select an older release (rollback): the digest of its current impact. */
            impactDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
            /** Required to publish a version lower than one already published (course-versions.ts). */
            confirmOlderVersion: z.literal(true).optional(),
          }),
          request.body,
        );
      const permission =
        input.action === "approve"
          ? "release.review"
          : input.action === "publish" || input.action === "activate" || input.action === "archive"
            ? "release.publish"
            : "course.write";
      return courseCommand(
        db,
        actor,
        params(request).courseId!,
        permission,
        "admin.release.transition",
        headerContext(request),
        { releaseId: params(request).releaseId, ...input },
        options,
        async (client, catalog) =>
          transitionReleaseWithin(client, actor, catalog, params(request).releaseId!, { ...input, confirmForward: true }, options),
      );
    },
  );
  const releaseOf = async (client: Sql, catalog: Catalog, releaseId: string | undefined) => {
    const release = (await releasesFor(client, catalog)).find((r) => r.id === releaseId);
    requireCondition(release, "RELEASE_NOT_FOUND", 404);
    return release;
  };
  /** The impact of selecting this (older) release for new learners, with the digest to confirm. */
  app.get(`${path}/courses/:courseId/releases/:releaseId/rollback-impact`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "release.publish");
      const target = await releaseOf(client, catalog, params(request).releaseId);
      requireCondition(target.status === "published", "PUBLISHED_RELEASE_REQUIRED", 409);
      const active = await releaseOf(client, catalog, catalog.active_release_id ?? undefined);
      return rollbackImpact(client, active, target);
    });
  });
  /** Checks a manifest exactly as saving the draft would, without saving it ("test before save"),
   * and says whether this runtime could run it and what it changes against the live release. */
  app.post(`${path}/courses/:courseId/releases/:releaseId/check`, { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(z.strictObject({ manifest: z.unknown() }), request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "course.write");
      const release = await releaseOf(client, catalog, params(request).releaseId);
      const check = checkManifest(input.manifest, { courseKey: catalog.course_key, version: release.version });
      if (!check.valid) return { ...check, runtime: null, changes: null };
      const course = compileCourse(input.manifest).server;
      let runtime: { ready: boolean; code: string | null } = { ready: true, code: null };
      try {
        await prepareCourseRunnable(course, installed(options));
        assertCourseRunnable(course, installed(options));
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        runtime = { ready: false, code: error.code };
      }
      const active = catalog.active_release_id ? await releaseOf(client, catalog, catalog.active_release_id) : null;
      const changes = active ? releaseDiff(active, { ...release, digest: check.digest!, server_bundle: course }) : null;
      return { ...check, runtime, changes: changes && { against: changes.from, identical: changes.identical, changes: changes.changes, kinds: changes.kinds } };
    });
  });
  /** The release (or an unsaved manifest for it) as representative synthetic learners would see
   * it: each one's roadmap from the learner engine and their next lesson's content. */
  app.post(`${path}/courses/:courseId/releases/:releaseId/preview`, { bodyLimit: 16 * 1024 * 1024 }, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(z.strictObject({ manifest: z.unknown().optional() }), request.body ?? {});
    return transaction(db, async (client) => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!, "course.read");
      const release = await releaseOf(client, catalog, params(request).releaseId);
      // Drafts and unsaved edits are visible only to the roles that may see drafts.
      if (release.status === "draft" || input.manifest !== undefined)
        requireCondition(["owner", "admin", "author", "reviewer"].includes(role), "FORBIDDEN", 403);
      if (input.manifest === undefined) return { source: "saved" as const, ...previewAsLearners(release.server_bundle, release.digest) };
      const compiled = compileCourse(input.manifest);
      requireCondition(compiled.server.id === catalog.course_key && compiled.server.version === release.version, "COURSE_IDENTITY_MISMATCH");
      return { source: "unsaved" as const, ...previewAsLearners(compiled.server, compiled.digest) };
    });
  });
  /** Who publishing this approved draft affects, with the digest staff confirm when publishing. */
  app.get(`${path}/courses/:courseId/releases/:releaseId/publish-impact`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "release.publish");
      const draft = await releaseOf(client, catalog, params(request).releaseId);
      requireCondition(draft.status === "draft", "PUBLISHED_RELEASE_IMMUTABLE", 409);
      const active = catalog.active_release_id ? await releaseOf(client, catalog, catalog.active_release_id) : null;
      return publishImpact(client, catalog, active, draft);
    });
  });
  /** What differs between two releases of this course, by entity digest. */
  app.get(`${path}/courses/:courseId/releases/:releaseId/diff`, async (request) => {
    const actor = await auth.authenticate(request),
      { against } = parse(z.strictObject({ against: uuid }), request.query ?? {});
    return transaction(db, async (client) => {
      const { catalog, role } = await catalogFor(client, actor, params(request).courseId!, "course.read");
      const target = await releaseOf(client, catalog, params(request).releaseId), base = await releaseOf(client, catalog, against);
      // Roles that only see published releases cannot diff drafts.
      if (!["owner", "admin", "author", "reviewer"].includes(role)) requireCondition(target.status !== "draft" && base.status !== "draft", "RELEASE_NOT_FOUND", 404);
      return releaseDiff(base, target);
    });
  });
  const defectSchema = z.strictObject({ assessmentId: z.string().min(1).max(200) });
  app.get(`${path}/courses/:courseId/releases/:releaseId/defective-items`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "course.read");
      const release = await releaseOf(client, catalog, params(request).releaseId);
      return { releaseId: release.id, items: (await defectiveItems(client, release.id)).map((d) => ({ assessmentId: d.assessment_id, reason: d.reason, markedAt: iso(d.created_at) })) };
    });
  });
  app.post(`${path}/courses/:courseId/releases/:releaseId/defective-items/preview`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(defectSchema, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "release.publish");
      const release = await releaseOf(client, catalog, params(request).releaseId);
      requireCondition(release.status !== "draft", "PUBLISHED_RELEASE_REQUIRED", 409);
      const result = await defectPreview(client, release, input.assessmentId);
      requireCondition(result.preview.known, "ASSESSMENT_NOT_FOUND", 404);
      return result;
    });
  });
  /**
   * Mark an item defective on one published (or archived) release. Every valid evidence record
   * earned on it is invalidated with the reason, open challenges for it close, gate decisions that
   * relied on it are recomputed, and it is never issued again on that release. Without a
   * replacement item staff must acknowledge that learners lose that route to the gate.
   */
  app.post(`${path}/courses/:courseId/releases/:releaseId/defective-items`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(
        z.strictObject({
          assessmentId: z.string().min(1).max(200),
          reason: z.string().trim().min(10).max(2000),
          previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
          acknowledgeNoReplacement: z.boolean().default(false),
        }),
        request.body,
      );
    let summary = { evidence: 0, enrollments: 0 };
    const response = await courseCommand(db, actor, params(request).courseId!, "release.publish", "admin.release.item_defective", headerContext(request),
      { releaseId: params(request).releaseId, ...input }, options, async (client, catalog) => {
        const release = await releaseOf(client, catalog, params(request).releaseId);
        requireCondition(release.status !== "draft", "PUBLISHED_RELEASE_REQUIRED", 409);
        const { preview, previewDigest } = await defectPreview(client, release, input.assessmentId);
        requireCondition(preview.known, "ASSESSMENT_NOT_FOUND", 404);
        requireCondition(!preview.alreadyDefective, "ITEM_ALREADY_DEFECTIVE", 409);
        if (previewDigest !== input.previewDigest) throw new ApiError(409, "IMPACT_CHANGED", "IMPACT_CHANGED", { preview, previewDigest });
        if (!preview.replacement.available && !input.acknowledgeNoReplacement) throw new ApiError(409, "NO_REPLACEMENT_ITEM", "NO_REPLACEMENT_ITEM", { preview, previewDigest });
        await client.query(`INSERT INTO release_defective_items(id,workspace_id,release_id,assessment_id,reason,marked_by,preview_digest,replacement_item_ids,
            acknowledged_no_replacement,invalidated_evidence,affected_enrollments) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [randomUUID(), catalog.workspace_id, release.id, input.assessmentId, input.reason, actor.id, previewDigest, JSON.stringify(preview.replacement.itemIds),
            !preview.replacement.available, preview.evidenceToInvalidate, preview.affectedEnrollments]);
        const invalidated = (await client.query<{ enrollment_id: string; n: number }>(
          `WITH changed AS (UPDATE evidence ev SET invalidated_at=clock_timestamp(),invalidation_reason=$3
             FROM attempts a, enrollments e WHERE a.id=ev.attempt_id AND a.enrollment_id=ev.enrollment_id AND e.id=ev.enrollment_id
               AND e.course_release_id=$1 AND a.assessment_id=$2 AND ev.invalidated_at IS NULL AND e.status<>'erased' RETURNING ev.enrollment_id)
           SELECT enrollment_id,count(*)::int AS n FROM changed GROUP BY enrollment_id ORDER BY enrollment_id`,
          [release.id, input.assessmentId, `Item marked defective: ${input.reason}`])).rows;
        await client.query(`UPDATE assessment_challenges c SET expires_at=clock_timestamp() FROM enrollments e
          WHERE e.id=c.enrollment_id AND e.course_release_id=$1 AND c.assessment_id=$2 AND c.attempt_id IS NULL AND c.expires_at>clock_timestamp()`, [release.id, input.assessmentId]);
        for (const row of invalidated) {
          // Invalidated evidence supersedes any gate decision that relied on it.
          await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [row.enrollment_id]);
          await refreshDecisionsForEnrollment(client, row.enrollment_id, input.assessmentId);
          // A defective delayed check no longer moves the learner's review schedule.
          const item = release.server_bundle.assessments.find((x) => x.id === input.assessmentId);
          if (item && release.server_bundle.retention?.assessmentIds.includes(item.id)) await replayRetention(client, row.enrollment_id, item.objectiveIds);
          await appendEvent(client, { workspaceId: catalog.workspace_id, enrollmentId: row.enrollment_id, actorId: actor.id, actorKind: "staff", type: "evidence.invalidated",
            payload: { assessmentId: input.assessmentId, reason: "item_defective", evidence: row.n, releaseId: release.id }, idempotencyKey: `defect:${release.id}:${input.assessmentId}:${row.enrollment_id}`, supervise: true });
          // A completed or closed course is not reopened; the amendment is audited and shown to the learner.
          await auditClosedRecordAmended(client, { workspaceId: catalog.workspace_id, enrollmentId: row.enrollment_id, source: "item_defective",
            assessmentId: input.assessmentId, evidence: row.n, idempotencyKey: `closed-record:defect:${release.id}:${input.assessmentId}:${row.enrollment_id}` });
        }
        summary = { evidence: invalidated.reduce((n, r) => n + r.n, 0), enrollments: invalidated.length };
        return { outcome: "saved", message: staffMessage("ITEM_DEFECTIVE", { assessmentId: input.assessmentId, evidence: summary.evidence, learners: summary.enrollments }) };
      });
    return response;
  });
  app.post(`${path}/courses/:courseId/enrollments`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(
        z.strictObject({
          learnerRef: uuid,
          profile: profileSchema,
          releaseId: uuid.optional(),
        }),
        request.body,
      );
    return courseCommand(
      db,
      actor,
      params(request).courseId!,
      "enrollment.write",
      "admin.enrollment.created",
      headerContext(request),
      input,
      options,
      async (client, catalog) => {
        const target = (
          await client.query(
            "SELECT u.id FROM app_users u JOIN memberships m ON m.user_id=u.id WHERE u.id=$1 AND m.workspace_id=$2",
            [input.learnerRef, catalog.workspace_id],
          )
        ).rows[0];
        requireCondition(target, "LEARNER_NOT_IN_WORKSPACE", 404);
        const release = (await releasesFor(client, catalog)).find(
          (r) =>
            r.status === "published" &&
            (!input.releaseId || r.id === input.releaseId),
        );
        requireCondition(release, "PUBLISHED_RELEASE_REQUIRED", 409);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `enroll:${release.id}:${input.learnerRef}`,
        ]);
        const old = (
          await client.query(
            "SELECT id FROM enrollments WHERE course_release_id=$1 AND user_id=$2",
            [release.id, input.learnerRef],
          )
        ).rows[0];
        requireCondition(!old, "ALREADY_ENROLLED", 409);
        const id = randomUUID(),
          now = new Date().toISOString(),
          { policy } = await enrollmentPolicy(client, release.id, release.server_bundle, id, input.learnerRef, now);
        await client.query(
          "INSERT INTO enrollments(id,workspace_id,course_release_id,user_id,profile,policy,started_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            catalog.workspace_id,
            release.id,
            input.learnerRef,
            JSON.stringify(input.profile),
            JSON.stringify(release.server_bundle.policy),
            now,
          ],
        );
        await client.query(
          "INSERT INTO policy_states(enrollment_id,policy_revision,ledger_revision,snapshot) VALUES($1,$2,$3,$4)",
          [
            id,
            policy.policyRevision,
            policy.ledgerRevision,
            JSON.stringify(policy),
          ],
        );
        const first = episodes(release.server_bundle)[0];
        if (first)
          await activateWindows(
            client,
            release.server_bundle,
            id,
            first.id,
            now,
            "scope_assigned",
          );
        await appendEvent(client, {
          workspaceId: catalog.workspace_id,
          enrollmentId: id,
          actorId: actor.id,
          actorKind: "staff",
          type: "enrollment.started",
          payload: { releaseId: release.id, createdFor: input.learnerRef },
          idempotencyKey: `admin-enroll:${id}`,
          supervise: true,
        });
        return {
          outcome: "saved",
          message:
            staffMessage("ENROLLMENT_CREATED"),
          enrollmentId: id,
        };
      },
    );
  });
  app.patch(
    `${path}/courses/:courseId/enrollments/:enrollmentId/profile`,
    async (request) => {
      const actor = await auth.authenticate(request),
        input = parse(
          z.strictObject({
            profile: profileSchema,
            enrollmentRevision: z.number().int().positive(),
          }),
          request.body,
        );
      return courseCommand(
        db,
        actor,
        params(request).courseId!,
        "enrollment.write",
        "admin.profile.updated",
        headerContext(request),
        { enrollmentId: params(request).enrollmentId, ...input },
        options,
        async (client, catalog) => {
          const context = await enrollmentFor(
            client,
            actor,
            params(request).enrollmentId!,
            "enrollment.write",
            true,
          );
          requireCondition(
            context.enrollment.workspace_id === catalog.workspace_id &&
              context.release.server_bundle.id === catalog.course_key,
            "ENROLLMENT_NOT_FOUND",
            404,
          );
          requireCondition(
            context.enrollment.revision === input.enrollmentRevision,
            "STALE_REVISION",
            409,
          );
          await client.query(
            "UPDATE enrollments SET profile=$2,profile_revision=profile_revision+1,revision=revision+1 WHERE id=$1",
            [context.enrollment.id, JSON.stringify(input.profile)],
          );
          await appendEvent(client, {
            workspaceId: catalog.workspace_id,
            enrollmentId: context.enrollment.id,
            actorId: actor.id,
            actorKind: "staff",
            type: "profile.updated",
            payload: {
              profileRevision: context.enrollment.profile_revision + 1,
            },
            idempotencyKey: `admin-profile:${randomUUID()}`,
            supervise: true,
          });
          return {
            outcome: "saved",
            message: staffMessage("PROFILE_SAVED"),
          };
        },
      );
    },
  );
  app.post(
    `${path}/courses/:courseId/enrollments/:enrollmentId/evidence/:evidenceId/review`,
    async (request) => {
      const actor = await auth.authenticate(request),
        input = parse(
          z.strictObject({
            decision: z.enum(["accept", "reject"]),
            note: z.string().trim().min(1).max(600),
            enrollmentRevision: z.number().int().positive(),
          }),
          request.body,
        );
      return courseCommand(
        db,
        actor,
        params(request).courseId!,
        "evidence.review",
        "admin.evidence.reviewed",
        headerContext(request),
        {
          enrollmentId: params(request).enrollmentId,
          evidenceId: params(request).evidenceId,
          ...input,
        },
        options,
        async (client, catalog) =>
          reviewEvidenceWithin(client, actor, catalog, {
            enrollmentId: params(request).enrollmentId!,
            evidenceId: parse(uuid, params(request).evidenceId),
            decision: input.decision,
            note: input.note,
            enrollmentRevision: input.enrollmentRevision,
          }),
      );
    },
  );
  app.post(
    `${path}/courses/:courseId/providers/:providerId/configuration-requests`,
    async (request) => {
      const actor = await auth.authenticate(request),
        input = parse(
          z.strictObject({
            connectionLabel: z.string().regex(/^[a-zA-Z0-9 _-]{1,60}$/),
            environment: z.string().regex(/^[a-zA-Z0-9_-]{1,30}$/),
          }),
          request.body,
        );
      return courseCommand(
        db,
        actor,
        params(request).courseId!,
        "provider.configure",
        "admin.provider.requested",
        headerContext(request),
        { providerId: params(request).providerId, ...input },
        options,
        async (client, catalog) => {
          requireCondition(
            (await runtimeProviders(options,catalog.workspace_id,client)).some(
              (p) => p.id === params(request).providerId,
            ),
            "PROVIDER_NOT_FOUND",
            404,
          );
          await client.query(
            "INSERT INTO admin_provider_requests(id,catalog_id,provider_id,connection_label,environment,requested_by) VALUES($1,$2,$3,$4,$5,$6)",
            [
              randomUUID(),
              catalog.id,
              params(request).providerId,
              input.connectionLabel,
              input.environment,
              actor.id,
            ],
          );
          return {
            outcome: "pending_review",
            message:
              staffMessage("PROVIDER_REQUESTED"),
          };
        },
      );
    },
  );
  registerAdminPolicyRoutes(app, db, auth, path);
  app.get(`${path}/courses/:courseId/runs/:runId`, async (request) => {
    const actor = await auth.authenticate(request),
      { catalog } = await catalogFor(
        db,
        actor,
        params(request).courseId!,
        "run.inspect",
      );
    return runView(db, catalog, parse(uuid, params(request).runId));
  });
  /** Reveals one run's payload (owner/admin, run.payload) for a stated reason. The audit receipt
   * is written in the same transaction before anything is returned. */
  app.post(`${path}/courses/:courseId/runs/:runId/payload`, async (request, reply) => {
    const actor = await auth.authenticate(request), input = parse(payloadRequestSchema, request.body);
    const result = await transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "run.payload");
      const job = await courseRun(client, catalog, parse(uuid, params(request).runId));
      return revealRunPayload(client, actor, catalog, job, input.reason);
    });
    reply.header("Cache-Control", "no-store");
    return result;
  });
  /** Sandboxed replay of one run: frozen inputs, recorded model decisions, stubbed tools, a new
   * run id, inside a read-only transaction. Only the receipt is written, afterwards. */
  app.post(`${path}/courses/:courseId/runs/:runId/replay`, async (request) => {
    const actor = await auth.authenticate(request), runId = parse(uuid, params(request).runId);
    const { catalog, job, result } = await sandboxed(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "run.inspect");
      const job = await courseRun(client, catalog, runId);
      return { catalog, job, result: await replayRun(client, job) };
    });
    await transaction(db, (client) => recordReplay(client, actor, catalog, job, result));
    return result;
  });
  /** Replays up to 20 of the course's latest finished supervisor runs that kept a plan, each in
   * the same read-only sandbox as a single replay, with its own new replay id and audit receipt.
   * Used after an upgrade or rule change to see which recorded runs today's rules still reproduce. */
  app.post(`${path}/courses/:courseId/runs/replay`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(z.strictObject({ limit: z.number().int().min(1).max(20).default(10), enrollmentId: uuid.optional() }), request.body ?? {});
    const { catalog, results } = await sandboxed(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, "run.inspect");
      const ids = (await client.query<{ id: string }>(
        `SELECT j.id FROM supervisor_jobs j JOIN enrollments e ON e.id=j.enrollment_id AND e.workspace_id=j.workspace_id JOIN course_releases r ON r.id=e.course_release_id
          WHERE j.workspace_id=$1 AND r.course_key=$2 AND j.role='supervisor' AND j.state IN ('applied','failed','cancelled') AND e.status<>'erased'
            AND ($3::uuid IS NULL OR j.enrollment_id=$3)
            AND EXISTS (SELECT 1 FROM supervisor_artifacts a WHERE a.job_id=j.id AND a.content->>'kind'='supervised_plan')
          ORDER BY j.updated_at DESC,j.id LIMIT $4`, [catalog.workspace_id, catalog.course_key, input.enrollmentId ?? null, input.limit])).rows;
      const results = [];
      for (const { id } of ids) {
        const job = await courseRun(client, catalog, id);
        results.push({ job, result: await replayRun(client, job) });
      }
      return { catalog, results };
    });
    await transaction(db, async (client) => { for (const { job, result } of results) await recordReplay(client, actor, catalog, job, result); });
    const runs = results.map(({ job, result }) => ({ runId: job.id, replayRunId: result.replayRunId, outcome: result.outcome, reason: result.reason }));
    return { runs, summary: { matches: runs.filter((r) => r.outcome === "matches").length, diverged: runs.filter((r) => r.outcome === "diverged").length,
      notReplayable: runs.filter((r) => r.outcome === "not_replayable").length }, providerCalls: 0, progressWrites: "denied" as const };
  });
  /** Runs of one enrollment (optionally of one episode), for the inspector opened from the
   * read-only learner view. Summaries only; the run view and payload keep their own rules. */
  app.get(`${path}/enrollments/:enrollmentId/runs`, async (request) => {
    const actor = await auth.authenticate(request),
      query = parse(z.strictObject({ episodeId: z.string().min(1).max(200).optional() }), request.query ?? {});
    return transaction(db, async (client) => {
      const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "run.inspect");
      const catalogId = await catalogOfEnrollment(client, context.enrollment);
      const rows = (await client.query(
        `SELECT j.id,j.role,j.state,j.created_at,i.context->>'episodeId' AS episode_id,i.context->>'blockId' AS block_id FROM supervisor_jobs j
          LEFT JOIN supervisor_inputs i ON i.job_id=j.id AND i.enrollment_id=j.enrollment_id AND i.workspace_id=j.workspace_id AND i.checkpoint_id='generate'
          WHERE j.enrollment_id=$1 AND j.workspace_id=$2 AND ($3::text IS NULL OR i.context->>'episodeId'=$3) ORDER BY j.created_at DESC LIMIT 50`,
        [context.enrollment.id, context.enrollment.workspace_id, query.episodeId ?? null])).rows;
      return {
        courseId: catalogId,
        runs: rows.map((row) => ({ id: row.id, role: row.role, status: row.state, startedAt: iso(row.created_at), episodeId: row.episode_id, blockId: row.block_id })),
      };
    });
  });
}

function registerAdminPolicyRoutes(
  app: FastifyInstance,
  db: Database,
  auth: Auth,
  path: string,
) {
  const enrollmentPath = `${path}/enrollments/:enrollmentId`;
  // Teaching hypotheses about one learner: read-only, staff projection (learner's own words withheld).
  app.get(`${enrollmentPath}/hypotheses`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "enrollment.read");
      // The shared privacy rule: only staff read roles, never e.g. a reviewer.
      const role = await enrollmentRole(client, actor, context.enrollment);
      requireCondition((STAFF_READ_ROLES as readonly string[]).includes(role ?? ""), "FORBIDDEN", 403);
      requireCondition(context.enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      return { enrollmentId: context.enrollment.id, ...(await adminHypothesisView(client, context.enrollment.id, context.release.server_bundle)) };
    });
  });
  /** Placement for one enrollment: runs, each exemption with its evidence and version, overrides. */
  app.get(`${enrollmentPath}/placement`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "enrollment.read");
      requireCondition(context.enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      return { enrollmentId: context.enrollment.id, ...(await enrollmentPlacementView(client, context.enrollment, context.release.server_bundle)) };
    });
  });
  /** Staff override: one placement exemption is revoked and the episode returns to the path.
   * The evidence stays; the learner studies the episode normally. */
  app.post(`${enrollmentPath}/placement/exemptions/:episodeId/revoke`, async (request) => {
    const actor = await auth.authenticate(request),
      episodeId = parse(z.string().min(1).max(200), params(request).episodeId),
      input = parse(commandSchema.extend({ reason: z.string().trim().min(10).max(2000) }), request.body);
    return enrollmentCommand(db, actor, params(request).enrollmentId!, "enrollment.write", "placement.exemption_revoked", input, { episodeId, reason: input.reason },
      async (client, context) => {
        const placed = (await client.query<{ evidence_refs: string[] }>(
          "SELECT evidence_refs FROM episode_progress WHERE enrollment_id=$1 AND episode_id=$2 AND state='placed' FOR UPDATE", [context.enrollment.id, episodeId])).rows[0];
        requireCondition(placed, "PLACEMENT_EXEMPTION_NOT_FOUND", 404);
        const run = (await client.query<{ id: string }>("SELECT id FROM placement_runs WHERE enrollment_id=$1 AND state='accepted' ORDER BY run_number DESC LIMIT 1", [context.enrollment.id])).rows[0];
        await client.query(`INSERT INTO placement_exemption_overrides(id,workspace_id,enrollment_id,episode_id,run_id,evidence_refs,reason,revoked_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), context.enrollment.workspace_id, context.enrollment.id, episodeId, run?.id ?? null, JSON.stringify(placed.evidence_refs), input.reason, actor.id]);
        await client.query("UPDATE episode_progress SET state='started',evidence_refs='[]'::jsonb,completed_at=NULL WHERE enrollment_id=$1 AND episode_id=$2", [context.enrollment.id, episodeId]);
        await client.query("UPDATE enrollments SET revision=revision+1,status=CASE WHEN status='completed' THEN 'active' ELSE status END WHERE id=$1", [context.enrollment.id]);
        await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: "staff",
          type: "placement.exemption_revoked", payload: { episodeId, evidenceRefs: placed.evidence_refs }, idempotencyKey: `placement-override:${context.enrollment.id}:${input.idempotencyKey}`, supervise: true });
        return { episodeId, state: "revoked", revision: context.enrollment.revision + 1 };
      });
  });
  /** One enrollment's AI supervision: the control in force, live jobs (held while paused) and
   * wake-up signals not yet delivered. Readable by roles that inspect runs. */
  app.get(`${enrollmentPath}/supervision`, async (request) => {
    const actor = await auth.authenticate(request);
    const { workspaceId, role } = await transaction(db, async (client) => {
      const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "run.inspect");
      requireCondition(context.enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      // A course-scoped member's role here is their grant's role on this course.
      return { workspaceId: context.enrollment.workspace_id,
        role: await enrollmentRole(client, actor, context.enrollment) };
    });
    return { ...(await supervisionOverview(db, workspaceId, params(request).enrollmentId!)),
      canControl: roleCan(role, "supervision.control"), canRequeue: roleCan(role, "supervision.requeue") };
  });
  /** Re-queues, once, a request the dispatcher quarantined after an outage (owner/admin). */
  const requeueInput = z.strictObject({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
    reason: z.string().trim().min(10).max(500),
  });
  app.post(`${enrollmentPath}/supervision/events/:eventId/requeue`, async (request) => {
    const actor = await auth.authenticate(request),
      eventId = parse(uuid, params(request).eventId),
      input = parse(requeueInput, request.body);
    return transaction(db, async (client) => {
      const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "supervision.requeue", true);
      requireCondition(context.enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      return requeueQuarantinedEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id,
        eventId, actorId: actor.id, reason: input.reason, idempotencyKey: input.idempotencyKey });
    });
  });
  const supervisionInput = z.strictObject({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
    expectedRevision: z.number().int().nonnegative().optional(),
    reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  });
  for (const action of ["pause", "stop", "resume"] as const)
    app.post(`${enrollmentPath}/supervision/${action}`, async (request) => {
      const actor = await auth.authenticate(request),
        input = parse(supervisionInput, request.body);
      return transaction(db, async (client) => {
        // Authorize first, then change the control in the same transaction (it locks the enrollment).
        const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "supervision.control", true);
        requireCondition(context.enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
        return setSupervisionControl(client, {
          workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, action, actorId: actor.id,
          idempotencyKey: input.idempotencyKey,
          ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
          ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        });
      });
    });
  app.get(`${enrollmentPath}/policy`, async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) =>
      policyView(
        client,
        await enrollmentFor(
          client,
          actor,
          params(request).enrollmentId!,
          "policy.read",
        ),
      ),
    );
  });
  // Days move a deadline; planned minutes and episodes raise a work cap; at least one is required.
  const daysSchema = extensionAmountsSchema.extend({
    scopeId: z.string().min(1).max(200),
  });
  app.post(`${enrollmentPath}/extensions/preview`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(daysSchema, request.body);
    return transaction(db, async (client) => {
      const context = await enrollmentFor(
          client,
          actor,
          params(request).enrollmentId!,
          "policy.read",
        ),
        state = await loadPolicy(client, context.enrollment.id);
      return {
        enrollmentId: context.enrollment.id,
        scopeId: input.scopeId,
        days: input.days ?? null,
        minutes: input.minutes ?? null,
        episodes: input.episodes ?? null,
        revision: context.enrollment.revision,
        policyRevision: state.policyRevision,
        ledgerRevision: state.ledgerRevision,
        ...previewExtension(
          state,
          extensionRequest(state, input.scopeId, input),
        ),
      };
    });
  });
  const proposalSchema = daysSchema.extend({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: key,
    rationaleEventIds: z.array(uuid).min(1).max(20),
    episodeIds: z.array(z.string().min(1).max(200)).min(1).max(20),
    planImpact: z.string().trim().min(1).max(2000),
    alternatives: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
  });
  app.post(`${enrollmentPath}/extensions/propose`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(proposalSchema, request.body),
      { expectedRevision, idempotencyKey, ...semantic } = input;
    return enrollmentCommand(
      db,
      actor,
      params(request).enrollmentId!,
      "extension.propose",
      "admin.extension.propose",
      { expectedRevision, idempotencyKey },
      semantic,
      async (client, context) => {
        const events = await client.query(
          "SELECT id FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])",
          [
            context.enrollment.id,
            context.enrollment.workspace_id,
            input.rationaleEventIds,
          ],
        );
        requireCondition(
          events.rowCount === input.rationaleEventIds.length,
          "RATIONALE_OUT_OF_SCOPE",
          403,
        );
        const state = await loadPolicy(client, context.enrollment.id);
        requireCondition(
          input.episodeIds.every(
            (id) =>
              episodes(context.release.server_bundle).some(
                (e) => e.id === id,
              ) &&
              resolveConstraints(
                state,
                `episode:${policyEpisodeId(context.release, id)}`,
              ).ancestorScopeIds.includes(input.scopeId),
          ),
          "ACTIVITY_OUT_OF_SCOPE",
          403,
        );
        const now = new Date().toISOString(),
          offerId = randomUUID();
        const transition = proposeExtension(state, {
          ...extensionRequest(state, input.scopeId, input),
          now,
          offerId,
          expectedPolicyRevision: state.policyRevision,
          expectedLedgerRevision: state.ledgerRevision,
          idempotencyKey,
          rationaleEvidenceRefs: input.rationaleEventIds,
          proposedActivities: input.episodeIds,
          planImpact: input.planImpact,
          alternatives: input.alternatives,
          expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
        });
        await savePolicy(client, context.enrollment.id, transition);
        const event = await appendEvent(client, {
          workspaceId: context.enrollment.workspace_id,
          enrollmentId: context.enrollment.id,
          actorId: actor.id,
          actorKind: "staff",
          type: "extension.proposed",
          payload: {
            offerId,
            termsDigest: transition.state.offers.at(-1)!.termsDigest,
          },
          idempotencyKey: `${context.enrollment.id}:${idempotencyKey}`,
          supervise: true,
        });
        const policy = await policyView(
          client,
          await enrollmentFor(
            client,
            actor,
            context.enrollment.id,
            "policy.read",
          ),
        );
        return {
          policy,
          receipt: { id: event.id, authority: "server", outcome: "proposed" },
          message:
            staffMessage("OFFER_PROPOSED"),
        };
      },
    );
  });
  app.post(`${enrollmentPath}/policy/preview`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(
        z.strictObject({ scopes: z.array(z.unknown()).min(1).max(1000) }),
        request.body,
      );
    return transaction(db, async (client) => {
      const context = await enrollmentFor(
          client,
          actor,
          params(request).enrollmentId!,
          "policy.write",
          true,
        ),
        state = await loadPolicy(client, context.enrollment.id);
      const scopes = input.scopes.map((value) => validateScopePolicy(value));
      // This domain preview enforces retained scope identities, anchors, work counters and ceilings.
      const preview = previewPolicyChange(state, { scopes });
      const previewId = randomUUID(),
        expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await client.query(
        "INSERT INTO admin_policy_previews(id,enrollment_id,actor_id,enrollment_revision,policy_revision,ledger_revision,preview_digest,preview,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          previewId,
          context.enrollment.id,
          actor.id,
          context.enrollment.revision,
          state.policyRevision,
          state.ledgerRevision,
          preview.previewDigest,
          JSON.stringify(preview),
          expiresAt,
        ],
      );
      return {
        ...preview,
        previewId,
        revision: context.enrollment.revision,
        expiresAt,
      };
    });
  });
  app.post(`${enrollmentPath}/policy/migrate`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(
        commandSchema.extend({
          previewId: uuid,
          previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
          reason: z.string().trim().min(1).max(1000),
          // Required when the reviewed preview shortens a grant, exception or accommodation.
          acknowledgedShortenedGrantIds: z.array(z.string().min(1).max(256)).max(500).optional(),
        }),
        request.body,
      );
    const { expectedRevision, idempotencyKey, ...semantic } = input;
    return enrollmentCommand(
      db,
      actor,
      params(request).enrollmentId!,
      "policy.write",
      "admin.policy.migrate",
      { expectedRevision, idempotencyKey },
      semantic,
      async (client, context) => {
        const stored = (
          await client.query(
            "SELECT * FROM admin_policy_previews WHERE id=$1 AND enrollment_id=$2 AND actor_id=$3",
            [input.previewId, context.enrollment.id, actor.id],
          )
        ).rows[0];
        requireCondition(
          stored &&
            Array.isArray(stored.preview?.scopes) &&
            stored.preview_digest === input.previewDigest &&
            new Date(stored.expires_at).getTime() > Date.now(),
          "STALE_PREVIEW",
          409,
        );
        const state = await loadPolicy(client, context.enrollment.id);
        requireCondition(
          stored.enrollment_revision === context.enrollment.revision &&
            stored.policy_revision === state.policyRevision &&
            stored.ledger_revision === state.ledgerRevision,
          "STALE_PREVIEW",
          409,
        );
        const now = new Date().toISOString(),
          migrationId = randomUUID(),
          authorityId = randomUUID();
        const audit = await appendEvent(client, {
          workspaceId: context.enrollment.workspace_id,
          enrollmentId: context.enrollment.id,
          actorId: actor.id,
          actorKind: "staff",
          type: "policy.migration_authorized",
          payload: {
            migrationId,
            previewDigest: input.previewDigest,
            reason: input.reason,
            authorityReceiptId: authorityId,
          },
          idempotencyKey: `${context.enrollment.id}:${idempotencyKey}`,
          supervise: true,
        });
        const transition = applyPolicyChange(state, {
          scopes: stored.preview.scopes,
          now,
          migrationId,
          reasonRef: audit.id,
          previewDigest: input.previewDigest,
          acknowledgedShortenedGrantIds: input.acknowledgedShortenedGrantIds ?? [],
          expectedPolicyRevision: state.policyRevision,
          expectedLedgerRevision: state.ledgerRevision,
          idempotencyKey,
          authorityReceipt: {
            receiptId: authorityId,
            actorId: actor.id,
            enrollmentId: context.enrollment.id,
            scopeId: state.scopes.find((s) => s.parentScopeId === null)!
              .scopeId,
            permission: "migrate_policy",
            termsDigest: input.previewDigest,
            authorizedAt: now,
          },
        });
        await savePolicy(client, context.enrollment.id, transition);
        return {
          policy: await policyView(
            client,
            await enrollmentFor(
              client,
              actor,
              context.enrollment.id,
              "policy.read",
            ),
          ),
          receipt: { id: audit.id, authority: "server", outcome: "migrated" },
          message:
            staffMessage("POLICY_MIGRATED"),
        };
      },
    );
  });
  // Accommodations and approved pauses: individual adjustments with their own
  // audited authority, separate from learner-requested extensions and pools.
  const adjustmentSchema = z.strictObject({
    scopeId: z.string().min(1).max(200),
    kind: z.enum(["accommodation", "approved_pause", "outage"]),
    change: z.strictObject({
      deadline: z.strictObject({ kind: z.enum(["absolute", "window"]), calendarDays: z.number().int().min(1).max(366) }).optional(),
      work: z.strictObject({ additionalMinutes: z.number().int().min(1).max(100000).optional(), additionalEpisodes: z.number().int().min(1).max(1000).optional() }).optional(),
    }),
  });
  app.post(`${enrollmentPath}/accommodations/preview`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(adjustmentSchema, request.body);
    return transaction(db, async (client) => {
      const context = await enrollmentFor(client, actor, params(request).enrollmentId!, "policy.write", true),
        state = await loadPolicy(client, context.enrollment.id);
      const preview = previewAccommodation(state, { ...input, accommodationId: randomUUID(), reasonRef: randomUUID() });
      const previewId = randomUUID(),
        expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      await client.query(
        "INSERT INTO admin_policy_previews(id,enrollment_id,actor_id,enrollment_revision,policy_revision,ledger_revision,preview_digest,preview,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [previewId, context.enrollment.id, actor.id, context.enrollment.revision, state.policyRevision, state.ledgerRevision, preview.previewDigest, JSON.stringify(preview), expiresAt],
      );
      return { ...preview, previewId, revision: context.enrollment.revision, expiresAt };
    });
  });
  app.post(`${enrollmentPath}/accommodations/apply`, async (request) => {
    const actor = await auth.authenticate(request),
      input = parse(
        commandSchema.extend({
          previewId: uuid,
          previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
          // A reference such as an approval ticket, not health or personal details.
          reason: z.string().trim().min(1).max(300),
        }),
        request.body,
      );
    const { expectedRevision, idempotencyKey, ...semantic } = input;
    return enrollmentCommand(db, actor, params(request).enrollmentId!, "policy.write", "admin.policy.accommodate", { expectedRevision, idempotencyKey }, semantic,
      async (client, context) => {
        const stored = (await client.query("SELECT * FROM admin_policy_previews WHERE id=$1 AND enrollment_id=$2 AND actor_id=$3", [input.previewId, context.enrollment.id, actor.id])).rows[0];
        requireCondition(stored && typeof stored.preview?.accommodationId === "string" && stored.preview_digest === input.previewDigest
          && new Date(stored.expires_at).getTime() > Date.now(), "STALE_PREVIEW", 409);
        const state = await loadPolicy(client, context.enrollment.id);
        requireCondition(stored.enrollment_revision === context.enrollment.revision && stored.policy_revision === state.policyRevision
          && stored.ledger_revision === state.ledgerRevision, "STALE_PREVIEW", 409);
        const p = stored.preview, now = new Date().toISOString(), authorityId = randomUUID();
        const audit = await appendEvent(client, {
          workspaceId: context.enrollment.workspace_id, enrollmentId: context.enrollment.id, actorId: actor.id, actorKind: "staff",
          type: "policy.accommodation_authorized",
          payload: { accommodationId: p.accommodationId, kind: p.kind, scopeId: p.scopeId, previewDigest: input.previewDigest, reasonRef: p.reasonRef, reason: input.reason, authorityReceiptId: authorityId },
          idempotencyKey: `${context.enrollment.id}:${idempotencyKey}`, supervise: true,
        });
        const transition = applyAccommodation(state, {
          scopeId: p.scopeId, accommodationId: p.accommodationId, reasonRef: p.reasonRef, kind: p.kind, change: p.change,
          now, previewDigest: input.previewDigest, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision, idempotencyKey,
          authorityReceipt: { receiptId: authorityId, actorId: actor.id, enrollmentId: context.enrollment.id, scopeId: p.scopeId, permission: "accommodate", termsDigest: input.previewDigest, authorizedAt: now },
        });
        await savePolicy(client, context.enrollment.id, transition);
        return {
          policy: await policyView(client, await enrollmentFor(client, actor, context.enrollment.id, "policy.read")),
          receipt: { id: audit.id, authority: "server", outcome: "accommodated" },
          message: staffMessage(p.kind === "approved_pause" ? "PAUSE_APPLIED" : p.kind === "outage" ? "OUTAGE_APPLIED" : "ACCOMMODATION_APPLIED"),
        };
      },
    );
  });
}

/** How each budget dimension was settled: the provider's report or the reserved ceiling. Only known values pass. */
function usageBasisView(value: unknown) {
  const basis = (v: unknown) => (v === "reported" || v === "reserved_ceiling" ? v : null);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { microUsd, tokens } = value as Record<string, unknown>;
  const view = { microUsd: basis(microUsd), tokens: basis(tokens) };
  return view.microUsd || view.tokens ? view : null;
}
/** One provider call as numbers and identifiers: no prompt, context or output. */
function providerCallView(row: { operation_id: string; state: string; failure_code: string | null; provider_usage: unknown; usage_basis: unknown; started_at: Date; finished_at: Date | null }) {
  const usage = (row.provider_usage && typeof row.provider_usage === "object" ? row.provider_usage : {}) as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const label = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(v) ? v : null);
  const attempts = Array.isArray(usage.attempts) ? usage.attempts.slice(0, 10) : [];
  return {
    operationId: row.operation_id,
    state: row.state,
    failureCode: label(row.failure_code),
    providerId: label(usage.providerId),
    modelId: label(usage.modelId),
    operation: label(usage.operation),
    inputCharacters: count(usage.inputCharacters),
    requestedMaxOutputTokens: count(usage.requestedMaxOutputTokens),
    usageBasis: usageBasisView(row.usage_basis),
    attempts: attempts.map((a: Record<string, unknown>) => {
      const t = (a?.tokens ?? {}) as Record<string, unknown>;
      return { attempt: count(a?.attempt), status: count(a?.status), outcome: label(a?.outcome), tokens: { input: count(t.input), output: count(t.output), total: count(t.total) } };
    }),
    startedAt: iso(row.started_at),
    durationMs: row.finished_at ? row.finished_at.getTime() - row.started_at.getTime() : null,
  };
}

async function runView(client: Sql, catalog: Catalog, runId: string) {
  // Look the run up by id: the course's run list is capped, older runs still exist.
  const [summary] = await runSummaries(client, catalog, runId);
  requireCondition(summary, "RUN_NOT_FOUND", 404);
  const job = (
    await client.query(
      "SELECT j.id,j.enrollment_id,j.input_event_id,j.runtime_snapshot,j.expected_revision,j.provider_revision FROM supervisor_jobs j JOIN enrollments e ON e.id=j.enrollment_id AND e.workspace_id=j.workspace_id JOIN course_releases r ON r.id=e.course_release_id WHERE j.id=$1 AND j.workspace_id=$2 AND r.course_key=$3",
      [runId, catalog.workspace_id, catalog.course_key],
    )
  ).rows[0];
  requireCondition(job, "RUN_NOT_FOUND", 404);
  const parsed = snapshotSchema.safeParse(job.runtime_snapshot),
    snapshot = parsed.success ? parsed.data : null;
  const events = (
    await client.query(
      "SELECT id,event_type,created_at FROM learning_events WHERE enrollment_id=$1 AND workspace_id=$2 ORDER BY sequence DESC LIMIT 100",
      [job.enrollment_id, catalog.workspace_id],
    )
  ).rows;
  const inputs = (
    await client.query(
      "SELECT id,checkpoint_id FROM supervisor_inputs WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3",
      [runId, job.enrollment_id, catalog.workspace_id],
    )
  ).rows;
  const artifacts = (
    await client.query(
      `SELECT a.id,a.digest,a.created_at,COALESCE(a.content->>'kind',a.content_kind) AS artifact_kind,CASE WHEN a.content->>'kind'='output_refusal' THEN a.content->>'reason' END AS refusal_reason,CASE WHEN v.revoked_at IS NULL THEN v.verdict ELSE NULL END AS verdict
    FROM supervisor_artifacts a LEFT JOIN supervisor_verifications v ON v.job_id=a.job_id AND v.enrollment_id=a.enrollment_id AND v.workspace_id=a.workspace_id
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.artifacts) item WHERE item->>'artifactId'=a.id::text AND item->>'digest'=a.digest)
    WHERE a.job_id=$1 AND a.enrollment_id=$2 AND a.workspace_id=$3 ORDER BY a.created_at`,
      [runId, job.enrollment_id, catalog.workspace_id],
    )
  ).rows;
  const tools=(await client.query(`SELECT t.id,t.tool,t.step,t.created_at,t.outcome #>> '{result,available}' AS available,t.outcome #>> '{result,reason}' AS reason,t.outcome #>> '{result,selected}' AS selected,t.outcome #>> '{result,verification}' AS draft_verification,CASE WHEN EXISTS(SELECT 1 FROM supervisor_artifacts a WHERE a.job_id=t.job_id AND a.enrollment_id=t.enrollment_id AND a.workspace_id=t.workspace_id AND a.content->>'kind'='supervised_plan' AND ((t.tool='choose_support' AND a.content->'selection'=t.outcome->'selection') OR (t.tool='create_teaching' AND a.content->'generatedTeaching'=t.outcome->'generatedTeaching'))) THEN (SELECT e.plan_revision FROM supervisor_plan_effects e WHERE e.job_id=t.job_id AND e.enrollment_id=t.enrollment_id AND e.workspace_id=t.workspace_id) ELSE NULL END AS applied_plan_revision,
        t.outcome->>'modelSuggestionDigest' AS model_suggestion_digest,
        (SELECT m.proposal_id FROM supervisor_model_effects m WHERE m.job_id=t.job_id AND m.enrollment_id=t.enrollment_id AND m.workspace_id=t.workspace_id AND m.selection_digest=t.outcome->>'modelSuggestionDigest') AS model_proposal_id,
        (SELECT c.action FROM supervisor_model_effects m JOIN learner_model_changes c ON c.proposal_id=m.proposal_id AND c.enrollment_id=m.enrollment_id AND c.workspace_id=m.workspace_id WHERE m.job_id=t.job_id AND m.enrollment_id=t.enrollment_id AND m.workspace_id=t.workspace_id AND m.selection_digest=t.outcome->>'modelSuggestionDigest' AND c.action<>'proposal.created' ORDER BY c.sequence DESC LIMIT 1) AS model_decision
        FROM supervisor_tool_calls t WHERE t.job_id=$1 AND t.enrollment_id=$2 AND t.workspace_id=$3 ORDER BY t.created_at,t.id LIMIT 65`,[job.id,job.enrollment_id,catalog.workspace_id])).rows;
  const dispatches = (
    await client.query(
      "SELECT operation_id,state,failure_code,provider_usage,outcome->'usageBasis' AS usage_basis,started_at,finished_at FROM provider_dispatches WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3 ORDER BY started_at",
      [runId, job.enrollment_id, catalog.workspace_id],
    )
  ).rows;
  const verification = (
    await client.query(
      `SELECT v.verdict,v.application_kind,v.created_at,v.revoked_at,a.label,x.application_kind AS applied_kind,x.created_at AS applied_at
       FROM supervisor_verifications v JOIN supervisor_verifier_authorities a ON a.id=v.verifier_id AND a.workspace_id=v.workspace_id
       LEFT JOIN supervisor_applications x ON x.job_id=v.job_id AND x.enrollment_id=v.enrollment_id AND x.workspace_id=v.workspace_id
       WHERE v.job_id=$1 AND v.enrollment_id=$2 AND v.workspace_id=$3`,
      [runId, job.enrollment_id, catalog.workspace_id],
    )
  ).rows[0];
  // A failed or cancelled run delivers nothing: its receipts read as ended, never as pending.
  const ended = summary.status === "failed" || summary.status === "cancelled";
  const refusal = artifacts.find((row) => row.artifact_kind === "output_refusal")?.refusal_reason as string | undefined;
  const hypothesisChanges = await runHypothesisChanges(client, job.id, job.enrollment_id);
  const row = await courseRun(client, catalog, runId);
  const [workflow, policies, sync] = [await runWorkflow(client, row), await runPolicies(client, row), await runSync(client, row)];
  // A staff retry (U07) runs as a new run; both runs name each other.
  const retry = await runRetryLinks(client, row);
  // No raw context, event payload, prompt, model reasoning, provider response or artifact content is selected.
  return {
    workflow,
    policies,
    sync,
    retry,
    // The payload stays withheld here whatever the request says; only POST .../payload reveals it.
    payload: "withheld" as const,
    hypothesisChanges: hypothesisChanges.map((row) => ({ hypothesisId: row.hypothesisId, action: row.action, revision: row.revision, kind: row.kind,
      status: row.status, pinnedByLearner: row.pinned, templateId: row.templateId, time: iso(row.createdAt) })),
    providerCalls: dispatches.map((row) => providerCallView(row)),
    verification: verification
      ? {
          verifier: String(verification.label).slice(0, 200),
          verdict: verification.revoked_at ? "revoked" : verification.verdict,
          applicationKind: verification.application_kind,
          verifiedAt: iso(verification.created_at),
          applied: verification.applied_kind ? { kind: verification.applied_kind, at: iso(verification.applied_at) } : null,
        }
      : null,
    ...summary,
    // Codes only; the admin app words the summary (runText namespace).
    outcome: {
      ...(snapshot?.reason ? { runtimeReason: snapshot.reason } : {}),
      ...(refusal ? { refusal, refusalBy: HOST_ENDED_REASONS.includes(refusal) ? "host" as const : "core" as const } : {}),
    },
    events: events.map((row) => ({
      id: row.id,
      time: iso(row.created_at),
      label: row.event_type,
      status: "recorded",
    })),
    context: [
      { id: catalog.workspace_id, kind: "provider_binding", facts: { providerRevision: job.provider_revision === null ? "host" : String(job.provider_revision) } },
      { id: job.id, kind: "tool_receipts", facts: { count: Math.min(tools.length, 64), more: tools.length > 64 ? "yes" : "no" } },
      { id: job.enrollment_id, kind: "enrollment", facts: { revision: job.expected_revision } },
      ...inputs.map((row) => ({
        id: row.id,
        kind: "checkpoint_input",
        facts: {
          checkpointId: row.checkpoint_id,
          ...(snapshot
            ? { profileRevision: snapshot.specification.fence.profileRevision, policyRevision: snapshot.specification.fence.policyRevision,
              ledgerRevision: snapshot.specification.fence.ledgerRevision }
            : {}),
        },
      })),
    ],
    decisions: [...(snapshot?.operations ?? []).map((operation) => ({
      id: operation.id,
      tool: operation.checkpointId,
      outcome:
        operation.status === "succeeded"
          ? "allowed"
          : operation.status === "not_started"
            ? "denied"
            : "pending_review",
      reasonCode: snapshot?.reason ?? operation.status,
      explanation: { code: "operation_state", params: { status: operation.status } },
      inputSummary: { code: "checkpoint_reservation", params: { microUsd: operation.reservation.microUsd, tokens: operation.reservation.tokens } },
      budgetUnits:
        operation.outcome?.status === "succeeded"
          ? operation.outcome.usage.tokens
          : 0,
    })),...tools.slice(0,64).map(t=>({id:t.id,tool:t.tool,outcome:t.available==='false'?'denied':t.selected==='true'&&t.applied_plan_revision===null?(summary.status==='applied'||ended?'denied':'pending_review'):'allowed',reasonCode:['learner_opt_in_required','independent_assessment_active','reviewed_support_not_available','tool_projection_limit'].includes(t.reason)?t.reason:'recorded',explanation:toolExplanation(t,summary.status,ended),inputSummary:{code:'tool_step',params:{step:t.step}},budgetUnits:0}))],
    artifacts: artifacts.map((row) => ({
      id: row.id,
      // The admin app names the artifact by this code and its ID (runText namespace).
      nameCode: row.artifact_kind==='research_candidate'?'research_candidate':row.artifact_kind==='output_refusal'?(HOST_ENDED_REASONS.includes(row.refusal_reason)?'ended_without_output':'refused_output'):'artifact',
      mediaType: "application/json",
      status:
        row.artifact_kind==='research_candidate'?"pending_review":row.verdict === "verified"
          ? "approved"
          : row.verdict === "rejected"
            ? "rejected"
            : "pending_review",
      preview: JSON.stringify(
        {
          artifactId: row.id,
          sha256: row.digest,
          createdAt: iso(row.created_at),
          verification: row.artifact_kind==='research_candidate'?"unreviewed_source_content":row.verdict ?? "not_verified",
          ...(row.artifact_kind==='research_candidate'?{collectionCheck:row.verdict??"not_verified",sourceUseApproved:false}:{}),
          // Core refused what the model returned; only the reason is kept, never the output.
          ...(row.artifact_kind==='output_refusal'?{refusedByCoreChecks:!HOST_ENDED_REASONS.includes(row.refusal_reason),refusalReason:row.refusal_reason,outputStored:false}:{}),
        },
        null,
        2,
      ),
    })),
  };
}
