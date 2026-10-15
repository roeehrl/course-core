import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { compileCourse } from "@course-core/sdk/compiler";
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
import { authService, membership, type Actor } from "./auth.js";
import { transaction, type Database } from "./database.js";
import { ApiError, requireCondition } from "./errors.js";
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
  initialPolicy,
  loadPolicy,
} from "./policy-adapter.js";
import { assertCourseRunnable, prepareCourseRunnable, type RuntimeExtension } from "./publication.js";
import { AGENT_ROLES, type ProviderRuntime } from "./provider-runtime.js";

type Sql = Database | PoolClient;
type Auth = ReturnType<typeof authService>;
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
  /** Read-only, audited "view as learner" (owner/admin only). */
  | "learner.view";
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
      "learner.view",
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
      "learner.view",
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
    ],
    reviewer: [
      "course.read",
      "release.review",
      "enrollment.read",
      "evidence.review",
      "policy.read",
      "run.inspect",
    ],
    observer: ["course.read"],
    learner: [],
  };
/** Trusted composition only. No credential value or client-provided capability is accepted. */
export interface AdminRuntimeOptions {
  installedExtensions?:
    readonly RuntimeExtension[] | (() => readonly RuntimeExtension[]);
  providerStatus?: (workspaceId:string,client:Sql) => {
    models: ReturnType<ProviderRuntime["describe"]>;
    roles: ReturnType<ProviderRuntime["status"]>;
  }|Promise<{models:ReturnType<ProviderRuntime["describe"]>;roles:ReturnType<ProviderRuntime["status"]>}>;
}
interface Catalog {
  id: string;
  workspace_id: string;
  course_key: string;
  title: string;
  description: string;
  revision: number;
  active_release_id: string | null;
}
interface ReleaseRow extends Release {
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
async function permit(
  client: Sql,
  actor: Actor,
  workspaceId: string,
  permission: AdminPermission,
) {
  const role = await membership(client, actor, workspaceId);
  requireCondition(
    adminPermissionMatrix[role]?.includes(permission),
    "FORBIDDEN",
    403,
  );
  return role;
}
async function catalogFor(
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
  const role = await permit(client, actor, catalog.workspace_id, permission);
  return { catalog, role };
}
async function releasesFor(client: Sql, catalog: Catalog) {
  return (
    await client.query<ReleaseRow>(
      `SELECT r.*,v.state AS review_state,v.notes,v.reviewed_digest FROM course_releases r
    JOIN admin_release_reviews v ON v.release_id=r.id WHERE v.catalog_id=$1 AND r.workspace_id=$2 AND r.course_key=$3 ORDER BY r.created_at DESC,r.id`,
      [catalog.id, catalog.workspace_id, catalog.course_key],
    )
  ).rows;
}
async function enrollmentFor(
  client: Sql,
  actor: Actor,
  id: string,
  permission: AdminPermission,
  lock = false,
): Promise<EnrollmentContext> {
  parse(uuid, id);
  const enrollment = (
    await client.query<Enrollment>(
      `SELECT * FROM enrollments WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  requireCondition(enrollment, "ENROLLMENT_NOT_FOUND", 404);
  await permit(client, actor, enrollment.workspace_id, permission);
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
      `SELECT e.id,e.objective_id,e.independent,e.result,a.family_id,a.assessment_id,a.course_digest,a.mode
    FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id WHERE e.enrollment_id=$1 AND e.invalidated_at IS NULL`,
      [id],
    )
  ).rows;
  return { enrollment, release, progress, evidence };
}
function installed(options: AdminRuntimeOptions): RuntimeExtension[] {
  return [
    ...(typeof options.installedExtensions === "function"
      ? options.installedExtensions()
      : (options.installedExtensions ?? [])),
  ];
}
function validation(release: ReleaseRow, options: AdminRuntimeOptions) {
  let valid = true,
    runnable = true,
    code = "Installed runtime supports required paths.";
  try {
    const compiled = compileCourse(release.server_bundle);
    valid = compiled.digest === release.digest;
  } catch {
    valid = false;
  }
  try {
    assertCourseRunnable(release.server_bundle, installed(options));
  } catch (error) {
    runnable = false;
    code =
      error instanceof ApiError ? error.code : "PUBLISH_CAPABILITY_MISSING";
  }
  return [
    {
      label: "SDK validation and digest",
      passed: valid,
      detail: valid
        ? "Released SDK validation matches the stored bundle digest."
        : "Bundle validation or digest mismatch.",
    },
    { label: "Installed runtime capabilities", passed: runnable, detail: code },
  ];
}
async function runtimeProviders(options: AdminRuntimeOptions,workspaceId:string,client:Sql) {
  const status = await options.providerStatus?.(workspaceId,client);
  if (!status?.models.length)
    return AGENT_ROLES.map((role) => ({
      id: role,
      name: `${role} provider`,
      description: "Trusted runtime capability slot.",
      capabilities: [role],
      configuration: "absent",
      verification: "not_run",
      connectionLabel: "",
      environment: "",
      detail: `Runtime status: ${status?.roles[role]?.status ?? "configuration_missing"}. No live verification is claimed.`,
    }));
  return status.models.map((model) => ({
    id: model.id,
    name: model.id,
    description: `Provider: ${model.providerId}`,
    capabilities: model.capabilities.map(String),
    configuration: model.configuration,
    verification: "not_run",
    connectionLabel: model.providerId,
    environment: "",
    detail: `Registry ${model.enabled ? "enabled" : "disabled"}; credential configuration ${model.configuration}. Configuration is not verification.`,
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
      profile: { displayName: "Erased learning data", goal: "", pace: "steady" as const },
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
      "SELECT state,stop_reason,proposal,start_episode_id FROM placement_runs WHERE enrollment_id=$1",
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
  const profile = parse(profileSchema, {
    displayName: "Learner",
    goal: "",
    pace: "steady",
    ...context.enrollment.profile,
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
        : `Recorded ${row.evaluator_ref} result: ${row.result.passed ? "passed" : "incorrect"}; ${row.independent ? "independent" : "assisted or practice"}.`,
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
      passed: Boolean(row.result.passed),
      independent: Boolean(row.independent),
      version: row.course_digest,
      rubricVersion: row.evaluator_ref,
      receiptId: row.review_id ?? null,
    })),
  };
}

async function runSummaries(client: Sql, catalog: Catalog) {
  return (
    await client.query(
      `SELECT j.id,j.role,j.state,j.expected_revision,j.created_at,
    (SELECT count(*)::integer FROM supervisor_tool_calls t WHERE t.job_id=j.id AND t.enrollment_id=j.enrollment_id AND t.workspace_id=j.workspace_id) AS tool_calls,
    (SELECT CASE WHEN count(*)=0 THEN 0 WHEN bool_and(CASE WHEN jsonb_typeof(d.provider_usage->'attempts')='array' THEN jsonb_array_length(d.provider_usage->'attempts')>0 ELSE false END) THEN sum(CASE WHEN jsonb_typeof(d.provider_usage->'attempts')='array' THEN jsonb_array_length(d.provider_usage->'attempts') ELSE 0 END)::integer ELSE NULL END FROM provider_dispatches d WHERE d.job_id=j.id AND d.enrollment_id=j.enrollment_id AND d.workspace_id=j.workspace_id AND d.state<>'not_started') AS provider_attempts,
    (SELECT count(*)::integer FROM supervisor_artifacts a WHERE a.job_id=j.id AND a.enrollment_id=j.enrollment_id AND a.workspace_id=j.workspace_id) AS artifact_count
    FROM supervisor_jobs j JOIN enrollments e ON e.id=j.enrollment_id AND e.workspace_id=j.workspace_id
    JOIN course_releases r ON r.id=e.course_release_id WHERE j.workspace_id=$1 AND r.course_key=$2 ORDER BY j.created_at DESC LIMIT 100`,
      [catalog.workspace_id, catalog.course_key],
    )
  ).rows.map((row) => ({
    id: row.id,
    label: `${row.role} run`,
    status: row.state,
    startedAt: iso(row.created_at),
    contextVersion: `enrollment-${row.expected_revision}`,
    toolCalls: row.tool_calls,
    providerAttempts:row.provider_attempts,
    artifactCount: row.artifact_count,
  }));
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
      provider.detail +=
        " Metadata change request awaits server operator review.";
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
      category: "Course workspace",
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
    message: string;
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
      requireCondition(
        previous.request_digest === requestDigest,
        "IDEMPOTENCY_CONFLICT",
        409,
      );
      return previous.response;
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
    const response = {
      workspace: await workspaceView(client, actor, catalogId, options),
      receipt: { id: event.id, authority: "server", outcome: result.outcome },
      message: result.message,
    };
    const saved = await client.query(
      "INSERT INTO admin_command_receipts(catalog_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,$5) RETURNING response",
      [
        catalogId,
        input.idempotencyKey,
        requestDigest,
        actor.id,
        JSON.stringify(response),
      ],
    );
    return saved.rows[0]!.response;
  });
}
async function enrollmentCommand<T>(
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
      requireCondition(
        old.request_digest === digest,
        "IDEMPOTENCY_CONFLICT",
        409,
      );
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
async function savePolicy(
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
async function policyView(client: Sql, context: EnrollmentContext) {
  const policy = await loadPolicy(client as PoolClient, context.enrollment.id),
    course = context.release.server_bundle;
  const label = (scope: ScopePolicy) =>
    scope.kind === "course"
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
function extensionArgs(state: PolicyState, scopeId: string, days: number) {
  const scope = state.scopes.find((s) => s.scopeId === scopeId);
  requireCondition(scope, "UNKNOWN_SCOPE", 404);
  const pool = state.pools.find(
    (p) =>
      scope.extensions?.poolIds.includes(p.poolId) &&
      ["calendar_day", "scope_calendar_day"].includes(p.unit),
  );
  requireCondition(pool, "EXTENSIONS_DISABLED", 409);
  requireCondition(
    scope.window || scope.hardDeadline,
    "NO_DEADLINE_TO_EXTEND",
    409,
  );
  return {
    scopeId,
    change: {
      deadline: {
        kind: scope.window ? ("window" as const) : ("absolute" as const),
        calendarDays: days,
      },
    },
    addedWork: { additionalMinutes: 0, additionalEpisodes: 0, remediation: [] },
    poolDebits: [{ poolId: pool.poolId, amount: days }],
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
    const rows = (
      await db.query(
        `SELECT c.id,c.title,c.description,c.workspace_id,w.title AS workspace_title,m.role FROM admin_course_catalog c JOIN memberships m ON m.workspace_id=c.workspace_id AND m.user_id=$1 JOIN workspaces w ON w.id=c.workspace_id WHERE m.role<>'learner' ORDER BY w.title,c.title`,
        [actor.id],
      )
    ).rows;
    return {
      actor: { id: actor.id, name: actor.displayName, role: "member" },
      courses: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        workspaceId: r.workspace_id,
        workspaceTitle: r.workspace_title,
        role: r.role,
      })),
    };
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
            "Course catalog details saved. Published release content is unchanged.",
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
            "A validated draft bundle was created. Runtime readiness and review still govern publication.",
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
              "Draft bundle validated and saved. Previous approval was cleared.",
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
            action: z.enum(["submit-review", "approve", "publish", "activate"]),
          }),
          request.body,
        );
      const permission =
        input.action === "approve"
          ? "release.review"
          : input.action === "publish" || input.action === "activate"
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
        async (client, catalog) => {
          const row = (await releasesFor(client, catalog)).find(
            (r) => r.id === params(request).releaseId,
          );
          requireCondition(row, "RELEASE_NOT_FOUND", 404);
          const release = (
            await client.query<ReleaseRow>(
              "SELECT * FROM course_releases WHERE id=$1 FOR UPDATE",
              [row.id],
            )
          ).rows[0]!;
          if (input.action === "activate") {
            requireCondition(release.status === "published", "PUBLISHED_RELEASE_REQUIRED", 409);
            const compiled = compileCourse(release.server_bundle);
            requireCondition(compiled.digest === release.digest, "RELEASE_DIGEST_MISMATCH", 409);
            await prepareCourseRunnable(release.server_bundle, installed(options));
            assertCourseRunnable(release.server_bundle, installed(options));
            await selectCatalogueReleaseWithin(client, catalog.id, release.id);
            return { outcome: "saved", message: "Release selected for new learners. Existing enrollments remain pinned." };
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
            await client.query(
              "UPDATE course_releases SET status='published' WHERE id=$1",
              [release.id],
            );
            await selectCatalogueReleaseWithin(client, catalog.id, release.id);
            return {
              outcome: "published",
              message:
                "Reviewed release published. Existing enrollments remain pinned.",
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
              input.action === "approve"
                ? "Approval recorded for this exact bundle digest."
                : "Release submitted for review.",
          };
        },
      );
    },
  );
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
          policy = initialPolicy(
            release.server_bundle,
            id,
            input.learnerRef,
            now,
          );
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
            "Enrollment created for the selected workspace member. No consent or mastery was granted.",
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
            message: "Profile saved. Evidence and mastery are unchanged.",
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
        async (client, catalog) => {
          const context = await enrollmentFor(
            client,
            actor,
            params(request).enrollmentId!,
            "evidence.review",
            true,
          );
          requireCondition(
            context.enrollment.workspace_id === catalog.workspace_id &&
              context.release.server_bundle.id === catalog.course_key,
            "EVIDENCE_NOT_FOUND",
            404,
          );
          requireCondition(
            context.enrollment.revision === input.enrollmentRevision,
            "STALE_REVISION",
            409,
          );
          const evidence = (
            await client.query(
              `SELECT e.*,a.assessment_id,a.response,a.result AS attempt_result,a.assistance,a.mode,a.course_digest,c.independent_eligible,c.assistance AS challenge_assistance
        FROM evidence e JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id LEFT JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=e.enrollment_id
        WHERE e.id=$1 AND e.enrollment_id=$2 FOR UPDATE OF e`,
              [parse(uuid, params(request).evidenceId), context.enrollment.id],
            )
          ).rows[0];
          requireCondition(
            evidence && !evidence.invalidated_at,
            "EVIDENCE_NOT_FOUND",
            404,
          );
          if (input.decision === "accept") {
            const assessment = context.release.server_bundle.assessments.find(
              (a) => a.id === evidence.assessment_id,
            );
            requireCondition(
              assessment && ["choice", "numeric"].includes(assessment.type),
              "REVIEW_CANNOT_GRANT_MASTERY",
              409,
            );
            const grade = gradeDeterministic(assessment, evidence.response);
            requireCondition(
              grade.passed &&
                evidence.result.passed === true &&
                evidence.attempt_result.passed === true &&
                evidence.independent === true &&
                evidence.independent_eligible === true &&
                evidence.assistance === "none" &&
                evidence.challenge_assistance === "none" &&
                evidence.mode !== "practice" &&
                evidence.course_digest === context.release.digest,
              "REVIEW_CANNOT_GRANT_MASTERY",
              409,
            );
            // Acknowledge a valid pre-existing result. NEVER update result/independent or create evidence.
          } else
            await client.query(
              "UPDATE evidence SET invalidated_at=now(),invalidation_reason=$2 WHERE id=$1",
              [evidence.id, input.note],
            );
          await client.query(
            "UPDATE enrollments SET revision=revision+1,status=CASE WHEN $2='reject' AND status='completed' THEN 'closed' ELSE status END WHERE id=$1",
            [context.enrollment.id, input.decision],
          );
          // Invalidated evidence supersedes any decision that relied on it.
          if (input.decision === "reject") await refreshDecisionsForEnrollment(client, context.enrollment.id, evidence.assessment_id);
          const event = await appendEvent(client, {
            workspaceId: catalog.workspace_id,
            enrollmentId: context.enrollment.id,
            actorId: actor.id,
            actorKind: "staff",
            type:
              input.decision === "reject"
                ? "evidence.invalidated"
                : "evidence.review_acknowledged",
            payload: {
              evidenceId: evidence.id,
              decision: input.decision,
              changesGrade: false,
            },
            idempotencyKey: `admin-evidence:${randomUUID()}`,
            supervise: true,
          });
          await client.query(
            "INSERT INTO admin_evidence_reviews(id,evidence_id,enrollment_id,actor_id,decision,note,event_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              randomUUID(),
              evidence.id,
              context.enrollment.id,
              actor.id,
              input.decision,
              input.note,
              event.id,
            ],
          );
          return {
            outcome: "saved",
            message:
              input.decision === "accept"
                ? "Valid evidence review acknowledged; its grade and independence did not change."
                : "Evidence invalidated. Progress and descendant availability are recomputed from remaining evidence.",
          };
        },
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
              "Metadata request recorded for server operator review. Runtime configuration and verification were not changed.",
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
}

function registerAdminPolicyRoutes(
  app: FastifyInstance,
  db: Database,
  auth: Auth,
  path: string,
) {
  const enrollmentPath = `${path}/enrollments/:enrollmentId`;
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
  const daysSchema = z.strictObject({
    scopeId: z.string().min(1).max(200),
    days: z.number().int().min(1).max(366),
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
        days: input.days,
        revision: context.enrollment.revision,
        policyRevision: state.policyRevision,
        ledgerRevision: state.ledgerRevision,
        ...previewExtension(
          state,
          extensionArgs(state, input.scopeId, input.days),
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
          ...extensionArgs(state, input.scopeId, input.days),
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
            "Offer proposed for exact learner acceptance. No grant, allowance debit, work-cap change or deadline change occurred.",
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
            "Reviewed policy migration applied. Existing anchors, pools, grants and ledger history were preserved.",
        };
      },
    );
  });
  // Accommodations and approved pauses: individual adjustments with their own
  // audited authority, separate from learner-requested extensions and pools.
  const adjustmentSchema = z.strictObject({
    scopeId: z.string().min(1).max(200),
    kind: z.enum(["accommodation", "approved_pause"]),
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
          message: p.kind === "approved_pause" ? "Approved pause applied to this learner's window." : "Accommodation applied to this learner only. Pools and other learners are unchanged.",
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
  const summary = (await runSummaries(client, catalog)).find(
    (row) => row.id === runId,
  );
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
      `SELECT a.id,a.digest,a.created_at,a.content->>'kind' AS artifact_kind,CASE WHEN v.revoked_at IS NULL THEN v.verdict ELSE NULL END AS verdict
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
  // No raw context, event payload, prompt, model reasoning, provider response or artifact content is selected.
  return {
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
    summary: `Persisted ${summary.status} job. ${snapshot?.reason ? `Runtime reason: ${snapshot.reason}.` : ""} Debug output is a metadata-only projection; no private reasoning or credentials are included.`,
    events: events.map((row) => ({
      id: row.id,
      time: iso(row.created_at),
      label: row.event_type,
      status: "Recorded",
      detail:
        "Scoped learning event; payload withheld in the debug projection.",
    })),
    context: [
      {id:catalog.workspace_id,label:"Provider configuration binding",version:job.provider_revision===null?"Host fallback":`workspace-provider-${job.provider_revision}`,source:"Persisted job version binding",visibility:"Reference only"},
      {id:job.id,label:"Tool receipt coverage",version:tools.length>64?"Latest 64; additional receipts retained":`${tools.length} recorded tools`,source:"Scoped durable tool receipts",visibility:"Safe metadata only"},
      {
        id: job.enrollment_id,
        label: "Enrollment reference",
        version: `revision-${job.expected_revision}`,
        source: "Persisted supervisor job",
        visibility: "Reference only",
      },
      ...inputs.map((row) => ({
        id: row.id,
        label: `Checkpoint ${row.checkpoint_id}`,
        version: snapshot
          ? `profile-${snapshot.specification.fence.profileRevision} / policy-${snapshot.specification.fence.policyRevision} / ledger-${snapshot.specification.fence.ledgerRevision}`
          : "Unavailable fence",
        source: "Scoped supervisor input",
        visibility: "Raw context withheld",
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
      explanation: `Persisted operation state: ${operation.status}. No private reasoning is exposed.`,
      inputSummary: `Checkpoint reference only; reserved budget ${operation.reservation.microUsd} micro-USD / ${operation.reservation.tokens} tokens.`,
      budgetUnits:
        operation.outcome?.status === "succeeded"
          ? operation.outcome.usage.tokens
          : 0,
    })),...tools.slice(0,64).map(t=>({id:t.id,tool:t.tool,outcome:t.available==='false'?'denied':t.selected==='true'&&t.applied_plan_revision===null?(summary.status==='applied'?'denied':'pending_review'):'allowed',reasonCode:['learner_opt_in_required','independent_assessment_active','reviewed_support_not_available','tool_projection_limit'].includes(t.reason)?t.reason:'recorded',explanation:t.tool==='check_teaching'?`Reference feedback: ${t.draft_verification??'unavailable'}. Final verification/application is still required.`:t.selected==='true'&&t.applied_plan_revision===null&&summary.status==='applied'?'Another teaching option was selected; this candidate was not delivered.':t.model_proposal_id!==null?`Learning preference proposal recorded; learner review: ${t.model_decision??'pending'}. No mastery granted.`:t.model_suggestion_digest!==null?'Learning preference suggestion awaits separate verification and delivery. No mastery granted.':t.applied_plan_revision!==null?`Selected support delivered in plan revision ${t.applied_plan_revision}. No mastery granted.`:'Persisted scoped tool receipt. A selection is pending until separate verification and delivery.',inputSummary:`Step ${t.step}; request and result text withheld.`,budgetUnits:0}))],
    artifacts: artifacts.map((row) => ({
      id: row.id,
      name: row.artifact_kind==='research_candidate'?`Unreviewed research candidate ${row.id}`:`Artifact ${row.id}`,
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
        },
        null,
        2,
      ),
      provenance:
        "Persisted scoped artifact metadata. Raw output is deliberately not retrieved.",
    })),
  };
}
