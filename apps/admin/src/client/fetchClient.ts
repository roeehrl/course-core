import {
  AiServicesError,
  JOBS,
  activationSchema,
  aiPricingSchema,
  budgetReceiptSchema as aiBudgetReceiptSchema,
  budgetsSchema,
  connectionReceiptSchema,
  connectionsSchema,
  connectionTestSchema,
  currentDraftSchema,
  draftSchema,
  qualityCheckSchema,
  qualityStatusSchema,
  modelListSchema,
  serviceKeyReceiptSchema,
  type Job,
} from "../domain/aiServices";
import {
  learningPolicySchema,
  previewSchema,
  proposalResultSchema,
  policyMigrationPreviewSchema,
  policyMigrationResultSchema,
  accommodationPreviewSchema,
  accommodationResultSchema,
} from "../domain/policy";
import { z } from "zod";
import {
  cohortPreviewSchema,
  cohortResultSchema,
  ledgerPreviewSchema,
  ledgerResultSchema,
  policySettingsViewSchema,
  type LedgerAction,
} from "../domain/policyLedger";
import {
  allowancesSchema,
  batchesSchema,
  batchPreviewSchema,
  batchResultSchema,
  ceilingsViewSchema,
} from "../domain/policyLevels";
import { createEventEnvelope } from "./eventEnvelope";
import { withTraceContext } from "./traceContext";
import {
  CoursePackageError,
  installationSchema,
  installResultSchema,
  packagePreviewSchema,
} from "../domain/coursePackages";
import { checkResultSchema, updatesViewSchema } from "../domain/courseUpdates";
import {
  providerSetupSchema,
  keyTestSchema,
  providerBudgetsSchema,
  setupReceiptSchema,
  budgetReceiptSchema,
  inspectionSchema,
  modelPreviewSchema,
} from "../domain/providerSetup";
import {
  evalStatusSchema,
  overrideReceiptSchema,
  evalRequiredSchema,
} from "../domain/providerEvals";
import {
  costSettingsReceiptSchema,
  priceReceiptSchema,
  pricingViewSchema,
  ProviderCostError,
  spendViewSchema,
} from "../domain/providerCosts";
import {
  mutationSchema,
  runSchema,
  sessionSchema,
  workspaceSchema,
  type AdminClient,
  type MutationContext,
} from "../domain/contracts";
import { AdminError, type AdminErrorCode } from "../domain/errors";
import {
  defectiveItemsSchema,
  defectPreviewSchema,
  releaseDiffSchema,
  rollbackImpactSchema,
} from "../domain/releaseSafety";
import {
  researchLibrarySchema,
  researchQueueSchema,
  researchReceiptSchema,
  youtubeSearchReceiptSchema,
  youtubeStatusSchema,
  ResearchActionError,
} from "../domain/research";
import {
  MediaActionError,
  mediaCheckSchema,
  mediaEstimateSchema,
  mediaJobSchema,
  mediaLibrarySchema,
  mediaReceiptSchema,
  storyboardListSchema,
  storyboardSchema,
} from "../domain/media";
import { erasureSchema, LearnerDataError } from "../domain/learnerData";
import {
  allocationCheckSchema,
  StudyError,
  studiesSchema,
  studyResultSchema,
} from "../domain/studies";
import { learnerViewSchema, LearnerViewError } from "../domain/learnerView";
import {
  HypothesisReadError,
  hypothesisViewSchema,
} from "../domain/hypotheses";
import {
  appealsSchema,
  pendingReviewsSchema,
  ReviewActionError,
} from "../domain/reviews";
import {
  GateReviewError,
  gateReviewQueueSchema,
  gateReviewReceiptSchema,
} from "../domain/gateReviews";
import { auditSchema, OverviewError, overviewSchema } from "../domain/overview";
import {
  AdminSectionError,
  sectionListSchema,
  sectionReadSchema,
  sectionWriteSchema,
} from "../domain/adminSections";
import {
  cancelResultSchema,
  enrollmentRunsSchema,
  payloadRevealSchema,
  replayBatchSchema,
  replaySchema,
  retryResultSchema,
  RunInspectorError,
} from "../domain/runInspector";
import {
  learnerPreviewSchema,
  manifestCheckSchema,
  publishImpactSchema,
  ReleaseEditingError,
} from "../domain/releaseEditing";
import {
  billingReceiptSchema,
  billingSchema,
  integrationsSchema,
  PlatformError,
  policyHistorySchema,
  readinessSchema,
} from "../domain/platform";
import {
  RegradeError,
  regradeResultSchema,
  regradeViewSchema,
} from "../domain/corrections";
import {
  AssessmentAdminError,
  assessmentListSchema,
  fixtureListSchema,
  fixtureResultSchema,
  fixtureRunSchema,
  fixtureRunsSchema,
  keyImpactSchema,
} from "../domain/assessmentAdmin";
import {
  coursePlacementSchema,
  enrollmentPlacementSchema,
  PlacementAdminError,
  placementPreviewSchema,
  placementSettingsSchema,
} from "../domain/placementAdmin";
import {
  SupervisionError,
  requeueResultSchema,
  supervisionOverviewSchema,
  supervisionResultSchema,
  supervisionSettingsSchema,
  settingsPreviewSchema,
  authorityQueueSchema,
  authorityRequestSchema,
  learnerBudgetSchema,
} from "../domain/supervision";
import {
  ConceptMappingError,
  conceptMappingSchema,
  mappingCandidatesSchema,
  mappingPairSchema,
} from "../domain/conceptMappings";
import {
  EvidenceDisputeError,
  evidenceDisputeQueueSchema,
  evidenceDisputeReceiptSchema,
} from "../domain/evidenceDisputes";
import {
  courseGrantSchema,
  courseGrantsSchema,
  peopleSchema,
  signInSchema,
  PeopleActionError,
} from "../domain/people";

export interface FetchClientOptions {
  /** Proposed adapter base, normally a same-origin /api/admin route. No default live endpoint. */
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  /** Parent owns the cookie session/CSRF implementation. Never pass provider secrets. */
  requestHeaders?: () => HeadersInit;
}
/** Route and preview body of a revocation, refund or exceptional grant. */
function ledgerPath(
  id: string,
  action: LedgerAction,
): [string, Record<string, unknown>] {
  const base = `/enrollments/${encodeURIComponent(id)}`;
  if (action.kind === "revocation")
    return [`${base}/grants/${encodeURIComponent(action.grantId)}/revoke`, {}];
  if (action.kind === "refund")
    return [
      `${base}/grants/${encodeURIComponent(action.grantId)}/refund`,
      { poolId: action.poolId, amount: action.amount },
    ];
  return [
    `${base}/exceptions`,
    {
      scopeId: action.scopeId,
      change: {
        deadline: { kind: action.deadlineKind, calendarDays: action.days },
      },
    },
  ];
}
export function createFetchAdminClient(
  options: FetchClientOptions,
): AdminClient {
  const fetcher = withTraceContext(
    options.fetch ?? globalThis.fetch.bind(globalThis),
  );
  // Staff actions record the same client facts on their events as learner actions.
  const envelope = createEventEnvelope();
  const base = options.baseUrl.replace(/\/$/, "");
  const course = (courseId: string) =>
    `/courses/${encodeURIComponent(courseId)}`;
  let providerAccountId: string | undefined;
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    context?: MutationContext,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(options.requestHeaders?.());
    headers.set("Accept", "application/json");
    if (payload !== undefined) headers.set("Content-Type", "application/json");
    for (const [name, value] of Object.entries(envelope(method)))
      headers.set(name, value);
    if (context) {
      headers.set("If-Match", context.expectedRevision);
      headers.set("Idempotency-Key", context.idempotencyKey);
    }
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AdminError("unavailable");
    }
    if (!response.ok) {
      const codes: Record<number, AdminErrorCode> = {
        401: "permission_denied",
        403: "permission_denied",
        404: "not_found",
        409: "stale_revision",
        412: "stale_revision",
        422: "validation",
        400: "validation",
        428: "pending_review",
        424: "config_absent",
      };
      const policyCodes: Record<string, AdminErrorCode> = {
        PARENT_CAP_CONFLICT: "parent_cap",
        NO_EFFECT: "parent_cap",
        PER_GRANT_LIMIT: "per_grant_limit",
        ALLOWANCE_EXHAUSTED: "allowance_exhausted",
        EXTENSIONS_DISABLED: "scope_not_extendable",
        NO_DEADLINE_TO_EXTEND: "scope_not_extendable",
        ENROLLMENT_INACTIVE: "inactive_enrollment",
        OUTSTANDING_OFFER_LIMIT: "offer_limit",
        OFFER_FREQUENCY_LIMIT: "offer_limit",
        OFFER_COOLDOWN: "offer_limit",
        STALE_POLICY_REVISION: "stale_revision",
        STALE_OFFER: "stale_revision",
        TERMS_CHANGED: "stale_revision",
        INVALID_REQUEST: "validation",
        INVALID_INPUT: "validation",
        INVALID_CALENDAR_TIME: "validation",
        UNBOUNDED_POLICY: "validation",
        INVALID_LEDGER: "validation",
        STALE_LEDGER_REVISION: "stale_revision",
        STALE_PREVIEW: "stale_revision",
        STALE_REVISION: "stale_revision",
        RESET_FORBIDDEN: "policy_reset_forbidden",
        LOOSER_THAN_PARENT: "looser_than_parent",
        NO_POOL_FOR_UNIT: "no_pool_for_unit",
        OUTAGE_DEADLINE_ONLY: "outage_deadline_only",
        COHORT_TOO_LARGE: "cohort_too_large",
        NO_ACTIVE_LEARNERS: "no_active_learners",
        PAUSE_NOT_ALLOWED: "pause_not_allowed",
        ULTIMATE_CEILING: "policy_reset_forbidden",
        REVIEW_CANNOT_GRANT_MASTERY: "review_invalid",
        RELEASE_REVIEW_REQUIRED: "pending_review",
        PUBLISHED_RELEASE_IMMUTABLE: "immutable_release",
        PUBLISH_CAPABILITY_MISSING: "runtime_unsupported",
        PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE: "runtime_unsupported",
        PUBLISH_EVALUATOR_CONFIGURATION_INVALID: "runtime_unsupported",
        PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED: "runtime_unsupported",
        PUBLISH_ACTIVITY_RUNTIME_UNAVAILABLE: "runtime_unsupported",
        PUBLISH_ACTIVITY_CONTRACT_REQUIRED: "runtime_unsupported",
        PUBLISH_ACTIVITY_EXECUTION_UNSUPPORTED: "runtime_unsupported",
        PUBLISH_ACTIVITY_TARGET_UNSUPPORTED: "runtime_unsupported",
        PUBLISH_ACTIVITY_CONFIGURATION_INVALID: "runtime_unsupported",
        PUBLISH_ACTIVITY_SCHEMA_UNSUPPORTED: "runtime_unsupported",
        PUBLISH_ACTIVITY_BUDGET_INVALID: "runtime_unsupported",
        PUBLISH_CAPABILITY_FORBIDDEN: "runtime_unsupported",
        PUBLISH_VISUAL_VALIDATOR_MISSING: "runtime_unsupported",
        PUBLISH_VISUAL_INVALID: "runtime_unsupported",
        PUBLISH_VISUAL_INACCESSIBLE: "visual_inaccessible",
        PUBLISH_INFEASIBLE: "policy_infeasible",
        ENROLLMENT_INFEASIBLE: "policy_infeasible",
        RESERVE_EXCEEDS_QUOTA: "policy_infeasible",
        SHORTENED_GRANT_UNACKNOWLEDGED: "shortened_grant",
        ALREADY_REVOKED: "ledger_refused",
        REFUND_EXCEEDS_DEBIT: "ledger_refused",
        POOL_NOT_DEBITED: "ledger_refused",
        UNKNOWN_GRANT: "ledger_refused",
        LEARNER_ACCEPTANCE_REQUIRED: "ledger_refused",
        INVALID_COURSE: "validation",
        ALREADY_ENROLLED: "validation",
        IDEMPOTENCY_CONFLICT: "validation",
        PROVIDER_CONFIGURATION_INVALID: "validation",
        PROVIDER_SECRET_FIELD_FORBIDDEN: "validation",
        PROVIDER_CREDENTIAL_EMPTY: "validation",
        PROVIDER_CREDENTIAL_MALFORMED: "validation",
        PROVIDER_KEY_TEST_INVALID: "validation",
        PROVIDER_BUDGET_INVALID: "validation",
        PROVIDER_BUDGET_BELOW_USAGE: "validation",
        PAID_WORK_CONSENT_REQUIRED: "validation",
        PROVIDER_TOKEN_RESERVATION_TOO_SMALL: "validation",
        PROVIDER_EVAL_REQUIRED: "eval_required",
        PROVIDER_EVAL_OVERRIDE_INVALID: "validation",
        STALE_PROVIDER_REVISION: "stale_revision",
        STALE_PROVIDER_BUDGET_REVISION: "stale_revision",
        IMPACT_CHANGED: "impact_changed",
        IMPACT_CONFIRMATION_REQUIRED: "impact_changed",
        PUBLISH_VERSION_OLDER_THAN_PUBLISHED: "older_version",
        ACTIVE_RELEASE_ARCHIVE_FORBIDDEN: "active_release",
        NO_REPLACEMENT_ITEM: "no_replacement",
        ITEM_ALREADY_DEFECTIVE: "item_defective",
      };
      // Read only an allowlisted error code. Never display/log a raw service body.
      let policyCode: AdminErrorCode | undefined,
        details: unknown,
        reason: string | undefined;
      try {
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
        ) {
          policyCode = policyCodes[body.error];
          if (/^PROVIDER_[A-Z_]{1,80}$/.test(body.error)) reason = body.error;
          // The refused revisions are digests and reason codes only; anything else is dropped.
          if (policyCode === "eval_required" && "details" in body) {
            const parsed = evalRequiredSchema.safeParse(body.details);
            if (parsed.success) details = parsed.data;
          }
        }
      } catch {
        /* Non-JSON service error. */
      }
      throw new AdminError(
        policyCode ?? codes[response.status] ?? "unavailable",
        details,
        reason,
      );
    }
    try {
      return schema.parse(await response.json());
    } catch {
      throw new AdminError("invalid_response");
    }
  }
  /** Research actions surface only server-enumerated error codes (A-Z/_). */
  async function direct<T>(
    path: string,
    schema: z.ZodType<T>,
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    fail: (code: string, details?: unknown) => Error,
  ): Promise<T> {
    const headers = new Headers(options.requestHeaders?.());
    headers.set("Accept", "application/json");
    if (payload !== undefined) headers.set("Content-Type", "application/json");
    for (const [name, value] of Object.entries(envelope(method)))
      headers.set(name, value);
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw fail("UNAVAILABLE");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw fail("UNAVAILABLE");
    }
    if (!response.ok) {
      const code =
        body && typeof body === "object" && "error" in body
          ? String(body.error)
          : "";
      throw fail(
        /^[A-Z_]{1,64}$/.test(code) ? code : "UNAVAILABLE",
        body && typeof body === "object" && "details" in body
          ? body.details
          : undefined,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw fail("INVALID_RESPONSE");
    return parsed.data;
  }
  /** Study administration: a refused definition carries its problem codes (422 details.problems);
   * an export is returned as the file text with its server digest, never parsed or logged. */
  async function studyCall(
    path: string,
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    raw: true,
  ): Promise<Response>;
  async function studyCall(
    path: string,
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown>;
  async function studyCall(
    path: string,
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    raw = false,
  ): Promise<unknown> {
    const headers = new Headers(options.requestHeaders?.());
    headers.set(
      "Accept",
      raw ? "text/csv, application/json" : "application/json",
    );
    if (payload !== undefined) headers.set("Content-Type", "application/json");
    for (const [name, value] of Object.entries(envelope(method)))
      headers.set(name, value);
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new StudyError("UNAVAILABLE");
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        details?: { problems?: unknown };
      } | null;
      const code =
        typeof body?.error === "string" && /^[A-Z_]{1,64}$/.test(body.error)
          ? body.error
          : "UNAVAILABLE";
      const problems = Array.isArray(body?.details?.problems)
        ? body.details.problems.filter(
            (p): p is string =>
              typeof p === "string" && /^[A-Z_]{1,64}$/.test(p),
          )
        : [];
      throw new StudyError(code, problems);
    }
    if (raw) return response;
    try {
      return await response.json();
    } catch {
      throw new StudyError("UNAVAILABLE");
    }
  }
  const parsed = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value);
    if (!result.success) throw new StudyError("INVALID_RESPONSE");
    return result.data;
  };
  const research = <T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    signal?: AbortSignal,
  ) =>
    direct(
      path,
      schema,
      method,
      payload,
      signal,
      (c, details) => new ResearchActionError(c, details),
    );
  const media = <T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    signal?: AbortSignal,
  ) =>
    direct(
      path,
      schema,
      method,
      payload,
      signal,
      (c, details) => new MediaActionError(c, details),
    );
  const costs = <T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    signal?: AbortSignal,
  ) =>
    direct(
      path,
      schema,
      method,
      payload,
      signal,
      (c) => new ProviderCostError(c),
    );
  const workspacePath = (id: string) => `/workspaces/${encodeURIComponent(id)}`;
  /** AI services calls keep the service's exact code and a few allowlisted facts. Never a body. */
  async function ai<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(options.requestHeaders?.());
    headers.set("Accept", "application/json");
    if (payload !== undefined) headers.set("Content-Type", "application/json");
    for (const [name, value] of Object.entries(envelope(method)))
      headers.set(name, value);
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new AiServicesError("UNAVAILABLE", 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = (body && typeof body === "object" ? body : {}) as {
        error?: unknown;
        details?: {
          roles?: unknown;
          count?: unknown;
          neededMicroUsd?: unknown;
          availableMicroUsd?: unknown;
        };
      };
      const code =
        typeof record.error === "string" &&
        /^[A-Z0-9_]{1,80}$/.test(record.error)
          ? record.error
          : "UNAVAILABLE";
      const roles = Array.isArray(record.details?.roles)
        ? record.details.roles.filter(
            (r): r is Job =>
              typeof r === "string" && (JOBS as readonly string[]).includes(r),
          )
        : undefined;
      const count =
        typeof record.details?.count === "number"
          ? record.details.count
          : undefined;
      const amount = (value: unknown) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
          ? value
          : undefined;
      const neededMicroUsd = amount(record.details?.neededMicroUsd),
        availableMicroUsd = amount(record.details?.availableMicroUsd);
      throw new AiServicesError(code, response.status, {
        ...(roles ? { roles } : {}),
        ...(count !== undefined ? { count } : {}),
        ...(neededMicroUsd !== undefined ? { neededMicroUsd } : {}),
        ...(availableMicroUsd !== undefined ? { availableMicroUsd } : {}),
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new AiServicesError("INVALID_RESPONSE", response.status);
    return parsed.data;
  }
  const setupPath = (id: string) => `${workspacePath(id)}/provider-setup`;
  const people = <T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    signal?: AbortSignal,
  ) =>
    direct(
      path,
      schema,
      method,
      payload,
      signal,
      (c) => new PeopleActionError(c),
    );
  const workspacePeople = (id: string) =>
    `/workspaces/${encodeURIComponent(id)}/people`;
  const mutate = (
    path: string,
    input: unknown,
    context: MutationContext,
    method = "POST",
  ) => request(path, mutationSchema, method, input, context);
  /** Course-package calls keep the server's refusal details (asset choices), unlike `direct`. */
  async function packageCall<T>(
    path: string,
    schema: z.ZodType<T>,
    method: string,
    body?: BodyInit,
    contentType?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(options.requestHeaders?.());
    headers.set("Accept", "application/json");
    if (contentType) headers.set("Content-Type", contentType);
    for (const [name, value] of Object.entries(envelope(method)))
      headers.set(name, value);
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        headers,
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        body,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new CoursePackageError("UNAVAILABLE");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CoursePackageError("UNAVAILABLE");
    }
    if (!response.ok) {
      const record =
        payload && typeof payload === "object"
          ? (payload as { error?: unknown; details?: { assets?: unknown } })
          : {};
      const code =
        typeof record.error === "string" &&
        /^[A-Z0-9_]{1,64}$/.test(record.error)
          ? record.error
          : "UNAVAILABLE";
      const assets = Array.isArray(record.details?.assets)
        ? record.details.assets
            .filter((a): a is string => typeof a === "string")
            .slice(0, 50)
        : undefined;
      throw new CoursePackageError(code, assets ? { assets } : undefined);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new CoursePackageError("UNAVAILABLE");
    return parsed.data;
  }
  const packages = "/course-packages";
  return {
    mode: "connected",
    adaptationRuntime: () =>
      request(
        "/runtime/adaptation-adapters",
        z.object({
          adapters: z.array(
            z.object({
              id: z.string(),
              kind: z.string(),
              implementationDigest: z.string().regex(/^[a-f0-9]{64}$/),
              authorization: z.string(),
            }),
          ),
        }),
      ),
    adaptationRegistry: (id) =>
      request(
        `/releases/${encodeURIComponent(id)}/adaptation-registry`,
        z.object({
          registryRevision: z.number().int().nonnegative(),
          configured: z.boolean(),
          configurationDigest: z.string().nullable(),
        }),
      ),
    approveAdaptationRegistry: (id, expectedRegistryRevision, configuration) =>
      request(
        `/releases/${encodeURIComponent(id)}/adaptation-registry`,
        z.object({ registryRevision: z.number().int().positive() }),
        "POST",
        { expectedRegistryRevision, configuration },
      ),
    getSession: async (signal) => {
      const session = await request(
        "/session",
        sessionSchema,
        "GET",
        undefined,
        undefined,
        signal,
      );
      providerAccountId = session.actor.id;
      return session;
    },
    getCourse: (id, signal) =>
      request(course(id), workspaceSchema, "GET", undefined, undefined, signal),
    getRun: (id, runId, signal) =>
      request(
        `${course(id)}/runs/${encodeURIComponent(runId)}`,
        runSchema,
        "GET",
        undefined,
        undefined,
        signal,
      ),
    updateCourse: (id, input, ctx) => mutate(course(id), input, ctx, "PATCH"),
    createRelease: (id, input, ctx) =>
      mutate(`${course(id)}/releases`, input, ctx),
    getReleaseManifest: (id, releaseId, signal) =>
      request(
        `${course(id)}/releases/${encodeURIComponent(releaseId)}/manifest`,
        z.object({
          manifest: z.unknown(),
          notes: z.string(),
          editable: z.boolean(),
        }),
        "GET",
        undefined,
        undefined,
        signal,
      ),
    updateRelease: (id, releaseId, input, ctx) =>
      mutate(
        `${course(id)}/releases/${encodeURIComponent(releaseId)}`,
        input,
        ctx,
        "PATCH",
      ),
    transitionRelease: (id, releaseId, action, ctx, confirmation) =>
      mutate(
        `${course(id)}/releases/${encodeURIComponent(releaseId)}/transitions`,
        {
          action,
          ...(confirmation?.impactDigest
            ? { impactDigest: confirmation.impactDigest }
            : {}),
          ...(confirmation?.confirmOlderVersion
            ? { confirmOlderVersion: true }
            : {}),
        },
        ctx,
      ),
    coursePackages: {
      inspectFile: (workspaceId, file, signal) =>
        packageCall(
          `${packages}/inspect?workspaceId=${encodeURIComponent(workspaceId)}`,
          packagePreviewSchema,
          "POST",
          file,
          "application/gzip",
          signal,
        ),
      inspectUrl: (workspaceId, url, asset, signal) =>
        packageCall(
          `${packages}/inspect?workspaceId=${encodeURIComponent(workspaceId)}`,
          packagePreviewSchema,
          "POST",
          JSON.stringify({ url, ...(asset ? { asset } : {}) }),
          "application/json",
          signal,
        ),
      install: (sha256, input) =>
        packageCall(
          `${packages}/${encodeURIComponent(sha256)}/install`,
          installResultSchema,
          "POST",
          JSON.stringify(input),
          "application/json",
        ),
      installation: (releaseId, signal) =>
        packageCall(
          `${packages}/installs/${encodeURIComponent(releaseId)}`,
          installationSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      approveRegistry: (releaseId, input) =>
        packageCall(
          `${packages}/installs/${encodeURIComponent(releaseId)}/registry`,
          installationSchema,
          "POST",
          JSON.stringify(input),
          "application/json",
        ),
    },
    courseUpdates: {
      get: (courseId, signal) =>
        packageCall(
          `${course(courseId)}/updates`,
          updatesViewSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      saveSource: (courseId, expectedRevision, source) =>
        packageCall(
          `${course(courseId)}/updates/source`,
          updatesViewSchema,
          "PUT",
          JSON.stringify({ expectedRevision, source }),
          "application/json",
        ),
      saveSettings: (courseId, input) =>
        packageCall(
          `${course(courseId)}/updates/settings`,
          updatesViewSchema,
          "PUT",
          JSON.stringify(input),
          "application/json",
        ),
      check: (courseId) =>
        packageCall(
          `${course(courseId)}/updates/check`,
          checkResultSchema,
          "POST",
          "{}",
          "application/json",
        ),
    },
    releaseSafety: {
      rollbackImpact: (id, releaseId, signal) =>
        request(
          `${course(id)}/releases/${encodeURIComponent(releaseId)}/rollback-impact`,
          rollbackImpactSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      diff: (id, releaseId, against, signal) =>
        request(
          `${course(id)}/releases/${encodeURIComponent(releaseId)}/diff?against=${encodeURIComponent(against)}`,
          releaseDiffSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      defectiveItems: (id, releaseId, signal) =>
        request(
          `${course(id)}/releases/${encodeURIComponent(releaseId)}/defective-items`,
          defectiveItemsSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      previewDefect: (id, releaseId, assessmentId) =>
        request(
          `${course(id)}/releases/${encodeURIComponent(releaseId)}/defective-items/preview`,
          defectPreviewSchema,
          "POST",
          { assessmentId },
        ),
      markDefective: (id, releaseId, input, ctx) =>
        mutate(
          `${course(id)}/releases/${encodeURIComponent(releaseId)}/defective-items`,
          input,
          ctx,
        ),
    },
    enroll: (id, input, ctx) => mutate(`${course(id)}/enrollments`, input, ctx),
    updateProfile: (id, enrollmentId, input, ctx) =>
      mutate(
        `${course(id)}/enrollments/${encodeURIComponent(enrollmentId)}/profile`,
        { profile: input, enrollmentRevision: ctx.targetRevision },
        ctx,
        "PATCH",
      ),
    reviewEvidence: (id, enrollmentId, evidenceId, input, ctx) =>
      mutate(
        `${course(id)}/enrollments/${encodeURIComponent(enrollmentId)}/evidence/${encodeURIComponent(evidenceId)}/review`,
        { ...input, enrollmentRevision: ctx.targetRevision },
        ctx,
      ),
    getPolicy: (id, signal) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/policy`,
        learningPolicySchema,
        "GET",
        undefined,
        undefined,
        signal,
      ),
    previewExtension: (id, input, signal) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/extensions/preview`,
        previewSchema,
        "POST",
        input,
        undefined,
        signal,
      ),
    proposeExtension: (id, input, ctx) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/extensions/propose`,
        proposalResultSchema,
        "POST",
        {
          ...input,
          expectedRevision: ctx.expectedRevision,
          idempotencyKey: ctx.idempotencyKey,
        },
      ),
    providerSetup: {
      get accountId() {
        return providerAccountId;
      },
      inspectModels: (id, input) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-setup/inspect-models`,
          inspectionSchema,
          "POST",
          input,
        ),
      testKey: (id, input) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-setup/test-key`,
          keyTestSchema,
          "POST",
          input,
        ),
      previewModels: (id, input) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-setup/preview-models`,
          modelPreviewSchema,
          "POST",
          input,
        ),
      read: (id, signal) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-setup`,
          providerSetupSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      budgets: (id, signal) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-setup/budgets`,
          providerBudgetsSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      save: (id, input) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-setup`,
          setupReceiptSchema,
          "POST",
          input,
        ),
      saveBudget: (id, input) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-setup/budgets`,
          budgetReceiptSchema,
          "POST",
          input,
        ),
    },
    providerEvals: {
      status: (id, signal) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-evals`,
          evalStatusSchema,
          "GET",
          undefined,
          undefined,
          signal,
        ),
      override: (id, input) =>
        request(
          `/workspaces/${encodeURIComponent(id)}/provider-evals/overrides`,
          overrideReceiptSchema,
          "POST",
          input,
        ),
    },
    providerCosts: {
      pricing: (id, signal) =>
        costs(
          `${workspacePath(id)}/provider-pricing`,
          pricingViewSchema,
          "GET",
          undefined,
          signal,
        ),
      savePrice: (id, input) =>
        costs(
          `${workspacePath(id)}/provider-pricing`,
          priceReceiptSchema,
          "POST",
          input,
        ),
      saveSettings: (id, input) =>
        costs(
          `${workspacePath(id)}/provider-pricing/settings`,
          costSettingsReceiptSchema,
          "POST",
          input,
        ),
      spend: (id, period, signal) =>
        costs(
          `${workspacePath(id)}/provider-spend?period=${period}`,
          spendViewSchema,
          "GET",
          undefined,
          signal,
        ),
    },
    aiServices: {
      setup: (id, signal) =>
        ai(setupPath(id), providerSetupSchema, "GET", undefined, signal),
      connections: (id, signal) =>
        ai(
          `${setupPath(id)}/connections`,
          connectionsSchema,
          "GET",
          undefined,
          signal,
        ),
      testKey: (id, input) =>
        ai(`${setupPath(id)}/test-key`, keyTestSchema, "POST", input),
      addConnection: (id, input) =>
        ai(
          `${setupPath(id)}/connections`,
          connectionReceiptSchema,
          "POST",
          input,
        ),
      replaceKey: (id, connection, input) =>
        ai(
          `${setupPath(id)}/connections/${encodeURIComponent(connection)}/key`,
          connectionReceiptSchema,
          "PUT",
          input,
        ),
      testConnection: (id, connection) =>
        ai(
          `${setupPath(id)}/connections/${encodeURIComponent(connection)}/test`,
          connectionTestSchema,
          "POST",
          {},
        ),
      removeConnection: (id, connection, input) =>
        ai(
          `${setupPath(id)}/connections/${encodeURIComponent(connection)}`,
          z.unknown(),
          "DELETE",
          input,
        ),
      models: (id, connection, signal) =>
        ai(
          `${setupPath(id)}/connections/${encodeURIComponent(connection)}/models`,
          modelListSchema,
          "GET",
          undefined,
          signal,
        ),
      currentDraft: async (id, signal) =>
        (
          await ai(
            `${setupPath(id)}/drafts/current`,
            currentDraftSchema,
            "GET",
            undefined,
            signal,
          )
        ).draft,
      draftFromModels: (id, input) =>
        ai(`${setupPath(id)}/drafts`, draftSchema, "POST", input),
      draftFromJson: (id, input) =>
        ai(`${setupPath(id)}/drafts/json`, draftSchema, "POST", input),
      discardDraft: (id) =>
        ai(`${setupPath(id)}/drafts/current`, z.unknown(), "DELETE"),
      activate: (id, draft, input) =>
        ai(
          `${setupPath(id)}/drafts/${encodeURIComponent(draft)}/activate`,
          activationSchema,
          "POST",
          input,
        ),
      approve: (id, input) =>
        ai(
          `${workspacePath(id)}/provider-evals/overrides`,
          overrideReceiptSchema,
          "POST",
          input,
        ),
      pricing: (id, signal) =>
        ai(
          `${workspacePath(id)}/provider-pricing`,
          aiPricingSchema,
          "GET",
          undefined,
          signal,
        ),
      savePrice: (id, input) =>
        ai(
          `${workspacePath(id)}/provider-pricing`,
          priceReceiptSchema,
          "POST",
          input,
        ),
      saveCostSettings: (id, input) =>
        ai(
          `${workspacePath(id)}/provider-pricing/settings`,
          costSettingsReceiptSchema,
          "POST",
          input,
        ),
      budgets: (id, signal) =>
        ai(`${setupPath(id)}/budgets`, budgetsSchema, "GET", undefined, signal),
      saveBudget: (id, input) =>
        ai(`${setupPath(id)}/budgets`, aiBudgetReceiptSchema, "POST", input),
      qualityStatus: (id, signal) =>
        ai(
          `${setupPath(id)}/quality-check`,
          qualityStatusSchema,
          "GET",
          undefined,
          signal,
        ),
      startQualityCheck: (id, input) =>
        ai(`${setupPath(id)}/quality-check`, qualityCheckSchema, "POST", input),
      qualityCheck: (id, checkId, signal) =>
        ai(
          `${setupPath(id)}/quality-check/${encodeURIComponent(checkId)}`,
          qualityCheckSchema,
          "GET",
          undefined,
          signal,
        ),
      evals: (id, signal) =>
        ai(
          `${workspacePath(id)}/provider-evals`,
          evalStatusSchema,
          "GET",
          undefined,
          signal,
        ),
      spend: (id, period, signal) =>
        ai(
          `${workspacePath(id)}/provider-spend?period=${period}`,
          spendViewSchema,
          "GET",
          undefined,
          signal,
        ),
      setServiceKey: (id, service, input) =>
        ai(
          `${setupPath(id)}/service-keys/${encodeURIComponent(service)}`,
          serviceKeyReceiptSchema,
          "PUT",
          input,
        ),
    },
    research: {
      library: (releaseId, signal) =>
        research(
          `/releases/${encodeURIComponent(releaseId)}/research/library`,
          researchLibrarySchema,
          "GET",
          undefined,
          signal,
        ),
      queue: (releaseId, signal) =>
        research(
          `/releases/${encodeURIComponent(releaseId)}/research`,
          researchQueueSchema,
          "GET",
          undefined,
          signal,
        ),
      addSource: (releaseId, input, idempotencyKey) =>
        research(
          `/releases/${encodeURIComponent(releaseId)}/research/sources`,
          researchReceiptSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      inspect: (sourceId) =>
        research(
          `/research/sources/${encodeURIComponent(sourceId)}/inspect`,
          researchReceiptSchema,
          "POST",
          {},
        ),
      youtubeStatus: (workspaceId, signal) =>
        research(
          `${workspacePath(workspaceId)}/youtube`,
          youtubeStatusSchema,
          "GET",
          undefined,
          signal,
        ),
      youtubeCheck: (workspaceId) =>
        research(
          `${workspacePath(workspaceId)}/youtube/check`,
          z.object({ ok: z.literal(true), status: youtubeStatusSchema }),
          "POST",
          {},
        ),
      youtubeSearch: (releaseId, topicId) =>
        research(
          `/releases/${encodeURIComponent(releaseId)}/research/topics/${encodeURIComponent(topicId)}/youtube-search`,
          youtubeSearchReceiptSchema,
          "POST",
          { maxResults: 5 },
        ),
      review: (inspectionId, input, idempotencyKey) =>
        research(
          `/research/inspections/${encodeURIComponent(inspectionId)}/review`,
          researchReceiptSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      attach: (reviewId, input, idempotencyKey) =>
        research(
          `/research/reviews/${encodeURIComponent(reviewId)}/attachments`,
          researchReceiptSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      revoke: (attachmentId, reason, idempotencyKey) =>
        research(
          `/research/attachments/${encodeURIComponent(attachmentId)}/revoke`,
          researchReceiptSchema,
          "POST",
          { reason, idempotencyKey },
        ),
    },
    media: {
      library: (releaseId, signal) =>
        media(
          `/releases/${encodeURIComponent(releaseId)}/media-jobs`,
          mediaLibrarySchema,
          "GET",
          undefined,
          signal,
        ),
      detail: (jobId, signal) =>
        media(
          `/media-jobs/${encodeURIComponent(jobId)}`,
          mediaJobSchema,
          "GET",
          undefined,
          signal,
        ),
      estimate: (enrollmentId, episodeId) =>
        media(
          `/enrollments/${encodeURIComponent(enrollmentId)}/media-jobs/estimate`,
          mediaEstimateSchema,
          "POST",
          { episodeId },
        ),
      request: (enrollmentId, input, idempotencyKey) =>
        media(
          `/enrollments/${encodeURIComponent(enrollmentId)}/media-jobs`,
          mediaJobSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      review: (jobId, input, idempotencyKey) =>
        media(
          `/media-jobs/${encodeURIComponent(jobId)}/review`,
          mediaReceiptSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      attach: (jobId, expiresAt, idempotencyKey) =>
        media(
          `/media-jobs/${encodeURIComponent(jobId)}/attach`,
          mediaReceiptSchema,
          "POST",
          { expiresAt, idempotencyKey },
        ),
      cancel: (jobId, idempotencyKey) =>
        media(
          `/media-jobs/${encodeURIComponent(jobId)}/cancel`,
          mediaReceiptSchema,
          "POST",
          { idempotencyKey },
        ),
      revoke: (attachmentId, reason, idempotencyKey) =>
        media(
          `/media-attachments/${encodeURIComponent(attachmentId)}/revoke`,
          mediaReceiptSchema,
          "POST",
          { reason, idempotencyKey },
        ),
      assetUrl: (jobId) =>
        `${base}/media-jobs/${encodeURIComponent(jobId)}/asset`,
      requestImage: (enrollmentId, input, idempotencyKey) =>
        media(
          `/enrollments/${encodeURIComponent(enrollmentId)}/media-images`,
          mediaJobSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      requestClip: (enrollmentId, input, idempotencyKey) =>
        media(
          `/enrollments/${encodeURIComponent(enrollmentId)}/media-clips`,
          mediaJobSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      compose: (storyboardId, idempotencyKey) =>
        media(
          `/media-storyboards/${encodeURIComponent(storyboardId)}/compose`,
          mediaJobSchema,
          "POST",
          { idempotencyKey },
        ),
      storyboards: async (releaseId, signal) =>
        (
          await media(
            `/releases/${encodeURIComponent(releaseId)}/media-storyboards`,
            storyboardListSchema,
            "GET",
            undefined,
            signal,
          )
        ).storyboards,
      createStoryboard: (enrollmentId, input, idempotencyKey) =>
        media(
          `/enrollments/${encodeURIComponent(enrollmentId)}/media-storyboards`,
          storyboardSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      editStoryboard: (storyboardId, expectedRevision, shots, idempotencyKey) =>
        media(
          `/media-storyboards/${encodeURIComponent(storyboardId)}/edit`,
          storyboardSchema,
          "POST",
          { expectedRevision, shots, idempotencyKey },
        ),
      reviewStoryboard: (
        storyboardId,
        expectedRevision,
        decision,
        idempotencyKey,
      ) =>
        media(
          `/media-storyboards/${encodeURIComponent(storyboardId)}/review`,
          storyboardSchema,
          "POST",
          { expectedRevision, decision, idempotencyKey },
        ),
      check: (jobId, input, idempotencyKey) =>
        media(
          `/media-jobs/${encodeURIComponent(jobId)}/check`,
          mediaCheckSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
    },
    reviews: {
      pending: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/rubric-reviews`,
          pendingReviewsSchema,
          "GET",
          undefined,
          signal,
          (c) => new ReviewActionError(c),
        ),
      review: (attemptId, input, idempotencyKey) =>
        direct(
          `/rubric-reviews/${encodeURIComponent(attemptId)}`,
          z.record(z.string(), z.unknown()),
          "POST",
          { ...input, idempotencyKey },
          undefined,
          (c) => new ReviewActionError(c),
        ),
      appeals: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/rubric-appeals`,
          appealsSchema,
          "GET",
          undefined,
          signal,
          (c) => new ReviewActionError(c),
        ),
      decideAppeal: (appealId, input, idempotencyKey) =>
        direct(
          `/rubric-appeals/${encodeURIComponent(appealId)}`,
          z.record(z.string(), z.unknown()),
          "POST",
          { ...input, idempotencyKey },
          undefined,
          (c) => new ReviewActionError(c),
        ),
      requestDraft: (attemptId, idempotencyKey) =>
        direct(
          `/rubric-reviews/${encodeURIComponent(attemptId)}/assist`,
          z.record(z.string(), z.unknown()),
          "POST",
          { idempotencyKey },
          undefined,
          (c) => new ReviewActionError(c),
        ),
    },
    evidenceDisputes: {
      queue: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/evidence-disputes`,
          evidenceDisputeQueueSchema,
          "GET",
          undefined,
          signal,
          (c) => new EvidenceDisputeError(c),
        ),
      resolve: (catalogId, disputeId, input, idempotencyKey) =>
        direct(
          `${course(catalogId)}/evidence-disputes/${encodeURIComponent(disputeId)}/resolve`,
          evidenceDisputeReceiptSchema,
          "POST",
          { ...input, idempotencyKey },
          undefined,
          (c) => new EvidenceDisputeError(c),
        ),
    },
    gateReviews: {
      queue: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/gate-reviews`,
          gateReviewQueueSchema,
          "GET",
          undefined,
          signal,
          (c) => new GateReviewError(c),
        ),
      resolve: (requestId, input, idempotencyKey) =>
        direct(
          `/gate-reviews/${encodeURIComponent(requestId)}`,
          gateReviewReceiptSchema,
          "POST",
          { ...input, idempotencyKey },
          undefined,
          (c) => new GateReviewError(c),
        ),
    },
    overview: {
      load: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/overview`,
          overviewSchema,
          "GET",
          undefined,
          signal,
          (c) => new OverviewError(c),
        ),
    },
    audit: {
      list: (workspaceId, query, signal) => {
        const search = new URLSearchParams();
        if (query.before) search.set("before", query.before);
        if (query.actorKind) search.set("actorKind", query.actorKind);
        search.set("limit", String(query.limit ?? 50));
        return direct(
          `/workspaces/${encodeURIComponent(workspaceId)}/audit?${search}`,
          auditSchema,
          "GET",
          undefined,
          signal,
          (c) => new OverviewError(c),
        );
      },
    },
    studies: {
      list: async (catalogId, signal) =>
        parsed(
          studiesSchema,
          await studyCall(
            `${course(catalogId)}/studies`,
            "GET",
            undefined,
            signal,
          ),
        ),
      create: async (catalogId, input) =>
        parsed(
          studyResultSchema,
          await studyCall(
            `${course(catalogId)}/studies`,
            "POST",
            input,
            undefined,
          ),
        ),
      update: async (studyId, input) =>
        parsed(
          studyResultSchema,
          await studyCall(
            `/studies/${encodeURIComponent(studyId)}`,
            "PUT",
            input,
            undefined,
          ),
        ),
      transition: async (studyId, action, expectedRevision) =>
        parsed(
          studyResultSchema,
          await studyCall(
            `/studies/${encodeURIComponent(studyId)}/${action}`,
            "POST",
            { expectedRevision },
            undefined,
          ),
        ),
      allocationCheck: async (studyId) =>
        parsed(
          allocationCheckSchema,
          await studyCall(
            `/studies/${encodeURIComponent(studyId)}/allocation-check`,
            "GET",
            undefined,
            undefined,
          ),
        ),
      download: async (studyId, format) => {
        const response = await studyCall(
          `/studies/${encodeURIComponent(studyId)}/export?format=${format}`,
          "GET",
          undefined,
          undefined,
          true,
        );
        const name =
          /filename="([A-Za-z0-9._-]{1,80})"/.exec(
            response.headers.get("Content-Disposition") ?? "",
          )?.[1] ?? `study.${format}`;
        return {
          body: await response.text(),
          filename: name,
          digest: response.headers.get("X-Export-Digest") ?? "",
          contentType: format === "csv" ? "text/csv" : "application/json",
        };
      },
    },
    assessments: {
      list: (catalogId, releaseId, signal) =>
        direct(
          `${course(catalogId)}/releases/${encodeURIComponent(releaseId)}/assessments`,
          assessmentListSchema,
          "GET",
          undefined,
          signal,
          (c) => new AssessmentAdminError(c),
        ),
      previewKey: (catalogId, releaseId, assessmentId, grading) =>
        direct(
          `${course(catalogId)}/releases/${encodeURIComponent(releaseId)}/assessments/${encodeURIComponent(assessmentId)}/key/preview`,
          keyImpactSchema,
          "POST",
          { grading },
          undefined,
          (c) => new AssessmentAdminError(c),
        ),
      saveKey: (catalogId, releaseId, assessmentId, input) =>
        direct(
          `${course(catalogId)}/releases/${encodeURIComponent(releaseId)}/assessments/${encodeURIComponent(assessmentId)}/key`,
          keyImpactSchema.extend({ digest: z.string() }),
          "PUT",
          input,
          undefined,
          (c) => new AssessmentAdminError(c),
        ),
      saveRubric: (catalogId, releaseId, rubricId, input) =>
        direct(
          `${course(catalogId)}/releases/${encodeURIComponent(releaseId)}/rubrics/${encodeURIComponent(rubricId)}`,
          z.object({ digest: z.string() }),
          "PUT",
          input,
          undefined,
          (c) => new AssessmentAdminError(c),
        ),
      fixtures: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/assessment-fixtures`,
          fixtureListSchema,
          "GET",
          undefined,
          signal,
          (c) => new AssessmentAdminError(c),
        ),
      addFixture: (catalogId, input) =>
        direct(
          `${course(catalogId)}/assessment-fixtures`,
          fixtureResultSchema,
          "POST",
          input,
          undefined,
          (c) => new AssessmentAdminError(c),
        ),
      removeFixture: (catalogId, fixtureId) =>
        direct(
          `${course(catalogId)}/assessment-fixtures/${encodeURIComponent(fixtureId)}`,
          z.record(z.string(), z.unknown()),
          "DELETE",
          undefined,
          undefined,
          (c) => new AssessmentAdminError(c),
        ),
      run: (catalogId, releaseId) =>
        direct(
          `${course(catalogId)}/releases/${encodeURIComponent(releaseId)}/fixture-runs`,
          fixtureRunSchema,
          "POST",
          undefined,
          undefined,
          (c) => new AssessmentAdminError(c),
        ),
      runs: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/fixture-runs`,
          fixtureRunsSchema,
          "GET",
          undefined,
          signal,
          (c) => new AssessmentAdminError(c),
        ),
    },
    placement: {
      course: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/placement`,
          coursePlacementSchema,
          "GET",
          undefined,
          signal,
          (c) => new PlacementAdminError(c),
        ),
      save: (catalogId, input) =>
        direct(
          `${course(catalogId)}/placement/settings`,
          z.object({ settings: placementSettingsSchema }),
          "POST",
          input,
          undefined,
          (c) => new PlacementAdminError(c),
        ),
      preview: (catalogId, input) =>
        direct(
          `${course(catalogId)}/placement/settings/preview`,
          placementPreviewSchema,
          "POST",
          input,
          undefined,
          (c) => new PlacementAdminError(c),
        ),
      enrollment: (id, signal) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/placement`,
          enrollmentPlacementSchema,
          "GET",
          undefined,
          signal,
          (c) => new PlacementAdminError(c),
        ),
      revoke: (id, episodeId, input, idempotencyKey) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/placement/exemptions/${encodeURIComponent(episodeId)}/revoke`,
          z.record(z.string(), z.unknown()),
          "POST",
          { ...input, idempotencyKey },
          undefined,
          (c) => new PlacementAdminError(c),
        ),
    },
    adminSections: {
      list: (catalogId, signal) =>
        direct(
          `${course(catalogId)}/admin-sections`,
          sectionListSchema,
          "GET",
          undefined,
          signal,
          (c) => new AdminSectionError(c),
        ),
      read: (catalogId, sectionId, target, signal) =>
        direct(
          `${course(catalogId)}/admin-sections/${encodeURIComponent(sectionId)}?${new URLSearchParams({ scope: target.scope, scopeRef: target.scopeRef })}`,
          sectionReadSchema,
          "GET",
          undefined,
          signal,
          (c) => new AdminSectionError(c),
        ),
      save: (catalogId, sectionId, input) =>
        direct(
          `${course(catalogId)}/admin-sections/${encodeURIComponent(sectionId)}/values`,
          sectionWriteSchema,
          "PUT",
          input,
          undefined,
          (c) => new AdminSectionError(c),
        ),
    },
    runInspector: {
      revealPayload: (courseId, runId, reason) =>
        direct(
          `${course(courseId)}/runs/${encodeURIComponent(runId)}/payload`,
          payloadRevealSchema,
          "POST",
          { reason },
          undefined,
          (c) => new RunInspectorError(c),
        ),
      replay: (courseId, runId) =>
        direct(
          `${course(courseId)}/runs/${encodeURIComponent(runId)}/replay`,
          replaySchema,
          "POST",
          {},
          undefined,
          (c) => new RunInspectorError(c),
        ),
      retry: (courseId, runId, input) =>
        direct(
          `${course(courseId)}/runs/${encodeURIComponent(runId)}/retry`,
          retryResultSchema,
          "POST",
          input,
          undefined,
          (c) => new RunInspectorError(c),
        ),
      cancel: (courseId, runId, input) =>
        direct(
          `${course(courseId)}/runs/${encodeURIComponent(runId)}/cancel`,
          cancelResultSchema,
          "POST",
          input,
          undefined,
          (c) => new RunInspectorError(c),
        ),
      replayRecent: (courseId, limit) =>
        direct(
          `${course(courseId)}/runs/replay`,
          replayBatchSchema,
          "POST",
          { limit },
          undefined,
          (c) => new RunInspectorError(c),
        ),
      enrollmentRuns: (enrollmentId, episodeId, signal) =>
        direct(
          `/enrollments/${encodeURIComponent(enrollmentId)}/runs${episodeId ? `?${new URLSearchParams({ episodeId })}` : ""}`,
          enrollmentRunsSchema,
          "GET",
          undefined,
          signal,
          (c) => new RunInspectorError(c),
        ),
    },
    releaseEditing: {
      check: (courseId, releaseId, manifest, signal) =>
        direct(
          `${course(courseId)}/releases/${encodeURIComponent(releaseId)}/check`,
          manifestCheckSchema,
          "POST",
          { manifest },
          signal,
          (c) => new ReleaseEditingError(c),
        ),
      preview: (courseId, releaseId, manifest, signal) =>
        direct(
          `${course(courseId)}/releases/${encodeURIComponent(releaseId)}/preview`,
          learnerPreviewSchema,
          "POST",
          manifest === undefined ? {} : { manifest },
          signal,
          (c) => new ReleaseEditingError(c),
        ),
      publishImpact: (courseId, releaseId, signal) =>
        direct(
          `${course(courseId)}/releases/${encodeURIComponent(releaseId)}/publish-impact`,
          publishImpactSchema,
          "GET",
          undefined,
          signal,
          (c) => new ReleaseEditingError(c),
        ),
    },
    platform: {
      readiness: (workspaceId, signal) =>
        direct(
          `/workspaces/${encodeURIComponent(workspaceId)}/platform-readiness`,
          readinessSchema,
          "GET",
          undefined,
          signal,
          (c) => new PlatformError(c),
        ),
      integrations: (workspaceId, signal) =>
        direct(
          `/workspaces/${encodeURIComponent(workspaceId)}/integrations`,
          integrationsSchema,
          "GET",
          undefined,
          signal,
          (c) => new PlatformError(c),
        ),
      billing: (workspaceId, signal) =>
        direct(
          `/workspaces/${encodeURIComponent(workspaceId)}/billing-statements`,
          billingSchema,
          "GET",
          undefined,
          signal,
          (c) => new PlatformError(c),
        ),
      recordBilled: (workspaceId, input) =>
        direct(
          `/workspaces/${encodeURIComponent(workspaceId)}/billing-statements`,
          billingReceiptSchema,
          "POST",
          input,
          undefined,
          (c) => new PlatformError(c),
        ),
      exportAudit: async (workspaceId, query) => {
        const search = new URLSearchParams({
          format: query.format,
          from: query.from,
          to: query.to,
          ...(query.actorKind ? { actorKind: query.actorKind } : {}),
        });
        const headers = new Headers(options.requestHeaders?.());
        headers.set(
          "Accept",
          query.format === "csv" ? "text/csv" : "application/json",
        );
        let response: Response;
        try {
          response = await fetcher(
            `${base}/workspaces/${encodeURIComponent(workspaceId)}/audit/export?${search}`,
            {
              method: "GET",
              headers,
              credentials: "include",
              cache: "no-store",
              redirect: "error",
            },
          );
        } catch {
          throw new PlatformError("UNAVAILABLE");
        }
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const code =
            body && typeof body === "object" && "error" in body
              ? String(body.error)
              : "";
          throw new PlatformError(
            /^[A-Z_]{1,64}$/.test(code) ? code : "UNAVAILABLE",
          );
        }
        const rows = Number(response.headers.get("X-Export-Rows"));
        const digest = response.headers.get("X-Export-Digest") ?? "";
        if (!Number.isSafeInteger(rows) || !/^[a-f0-9]{64}$/.test(digest))
          throw new PlatformError("INVALID_RESPONSE");
        return {
          body: await response.blob(),
          // i18n-ignore: download file name, the same in every locale
          fileName: `audit-${query.from}-to-${query.to}.${query.format}`,
          rows,
          truncated: response.headers.get("X-Export-Truncated") === "true",
          digest,
        };
      },
      policyHistory: (courseId, signal) =>
        direct(
          `${course(courseId)}/policy-history`,
          policyHistorySchema,
          "GET",
          undefined,
          signal,
          (c) => new PlatformError(c),
        ),
    },
    regrade: {
      view: (id, attemptId, signal) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/attempts/${encodeURIComponent(attemptId)}/regrade`,
          regradeViewSchema,
          "GET",
          undefined,
          signal,
          (c) => new RegradeError(c),
        ),
      submit: (id, attemptId, input) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/attempts/${encodeURIComponent(attemptId)}/regrade`,
          regradeResultSchema,
          "POST",
          input,
          undefined,
          (c) => new RegradeError(c),
        ),
    },
    conceptMappings: {
      candidates: (signal) =>
        direct(
          "/concept-mappings/candidates",
          mappingCandidatesSchema,
          "GET",
          undefined,
          signal,
          (c) => new ConceptMappingError(c),
        ),
      pair: (first, second, signal) =>
        direct(
          `/concept-mappings?${new URLSearchParams({ first, second })}`,
          mappingPairSchema,
          "GET",
          undefined,
          signal,
          (c) => new ConceptMappingError(c),
        ),
      save: (input) =>
        direct(
          "/concept-mappings",
          conceptMappingSchema,
          "POST",
          input,
          undefined,
          (c) => new ConceptMappingError(c),
        ),
      retire: (id, input) =>
        direct(
          `/concept-mappings/${encodeURIComponent(id)}/retire`,
          conceptMappingSchema,
          "POST",
          input,
          undefined,
          (c) => new ConceptMappingError(c),
        ),
    },
    supervision: {
      overview: (id, signal) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/supervision`,
          supervisionOverviewSchema,
          "GET",
          undefined,
          signal,
          (c) => new SupervisionError(c),
        ),
      control: (id, action, input) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/supervision/${action}`,
          supervisionResultSchema,
          "POST",
          input,
          undefined,
          (c) => new SupervisionError(c),
        ),
      requeue: (id, eventId, input) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/supervision/events/${encodeURIComponent(eventId)}/requeue`,
          requeueResultSchema,
          "POST",
          input,
          undefined,
          (c) => new SupervisionError(c),
        ),
      settings: {
        load: (ws, signal) =>
          direct(
            `/workspaces/${encodeURIComponent(ws)}/supervision/settings`,
            supervisionSettingsSchema,
            "GET",
            undefined,
            signal,
            (c) => new SupervisionError(c),
          ),
        preview: (ws, input) =>
          direct(
            `/workspaces/${encodeURIComponent(ws)}/supervision/settings/preview`,
            settingsPreviewSchema,
            "POST",
            input,
            undefined,
            (c) => new SupervisionError(c),
          ),
        save: (ws, input) =>
          direct(
            `/workspaces/${encodeURIComponent(ws)}/supervision/settings`,
            supervisionSettingsSchema,
            "PUT",
            input,
            undefined,
            (c) => new SupervisionError(c),
          ),
        requests: (ws, signal) =>
          direct(
            `/workspaces/${encodeURIComponent(ws)}/supervision/requests`,
            authorityQueueSchema,
            "GET",
            undefined,
            signal,
            (c) => new SupervisionError(c),
          ),
        decide: (ws, requestId, input) =>
          direct(
            `/workspaces/${encodeURIComponent(ws)}/supervision/requests/${encodeURIComponent(requestId)}/decision`,
            authorityRequestSchema,
            "POST",
            input,
            undefined,
            (c) => new SupervisionError(c),
          ),
        budget: (ws, id, signal) =>
          direct(
            `/workspaces/${encodeURIComponent(ws)}/supervision/enrollments/${encodeURIComponent(id)}/budget`,
            learnerBudgetSchema,
            "GET",
            undefined,
            signal,
            (c) => new SupervisionError(c),
          ),
        saveBudget: (ws, id, input) =>
          direct(
            `/workspaces/${encodeURIComponent(ws)}/supervision/enrollments/${encodeURIComponent(id)}/budget`,
            learnerBudgetSchema,
            "PUT",
            input,
            undefined,
            (c) => new SupervisionError(c),
          ),
      },
    },
    teachingHypotheses: {
      load: (id, signal) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/hypotheses`,
          hypothesisViewSchema,
          "GET",
          undefined,
          signal,
          (c) => new HypothesisReadError(c),
        ),
    },
    learnerData: {
      exportEnrollment: (id) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/export`,
          z
            .object({ format: z.literal("course-core.enrollment-export") })
            .passthrough(),
          "GET",
          undefined,
          undefined,
          (c) => new LearnerDataError(c),
        ),
      erase: (id, confirmation, reason) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/erase`,
          erasureSchema,
          "POST",
          { confirmation, reason },
          undefined,
          (c) => new LearnerDataError(c),
        ),
    },
    learnerView: {
      // Read only: one GET, audited by the server. No command exists on this port.
      open: (id, signal) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/learner-view`,
          learnerViewSchema,
          "GET",
          undefined,
          signal,
          (c) => new LearnerViewError(c),
        ),
    },
    people: {
      list: (id, signal) =>
        people(workspacePeople(id), peopleSchema, "GET", undefined, signal),
      invite: (id, input, idempotencyKey) =>
        people(workspacePeople(id), signInSchema, "POST", {
          ...input,
          idempotencyKey,
        }),
      changeRole: (id, userId, input, idempotencyKey) =>
        people(
          `${workspacePeople(id)}/${encodeURIComponent(userId)}/role`,
          z.record(z.string(), z.unknown()),
          "POST",
          { ...input, idempotencyKey },
        ),
      issueSignIn: (id, userId, idempotencyKey) =>
        people(
          `${workspacePeople(id)}/${encodeURIComponent(userId)}/sign-in`,
          signInSchema,
          "POST",
          { idempotencyKey },
        ),
      setPassword: (id, userId, input, idempotencyKey) =>
        people(
          `${workspacePeople(id)}/${encodeURIComponent(userId)}/password`,
          signInSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      revoke: (id, userId, input, idempotencyKey) =>
        people(
          `${workspacePeople(id)}/${encodeURIComponent(userId)}/revoke`,
          z.record(z.string(), z.unknown()),
          "POST",
          { ...input, idempotencyKey },
        ),
      grants: (id, signal) =>
        people(
          `/workspaces/${encodeURIComponent(id)}/course-grants`,
          courseGrantsSchema,
          "GET",
          undefined,
          signal,
        ),
      grant: (id, input, idempotencyKey) =>
        people(
          `/workspaces/${encodeURIComponent(id)}/course-grants`,
          courseGrantSchema,
          "POST",
          { ...input, idempotencyKey },
        ),
      revokeGrant: (id, grantId, reasonCode, idempotencyKey) =>
        people(
          `/workspaces/${encodeURIComponent(id)}/course-grants/${encodeURIComponent(grantId)}/revoke`,
          courseGrantSchema,
          "POST",
          { reasonCode, idempotencyKey },
        ),
    },
    requestProviderConfig: (id, providerId, input, ctx) =>
      mutate(
        `${course(id)}/providers/${encodeURIComponent(providerId)}/configuration-requests`,
        input,
        ctx,
      ),
    previewPolicyChange: (id, scopes, signal) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/policy/preview`,
        policyMigrationPreviewSchema,
        "POST",
        { scopes },
        undefined,
        signal,
      ),
    migratePolicy: (id, input, ctx) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/policy/migrate`,
        policyMigrationResultSchema,
        "POST",
        {
          ...input,
          expectedRevision: ctx.expectedRevision,
          idempotencyKey: ctx.idempotencyKey,
        },
      ),
    getPolicySettings: (id, signal) =>
      request(
        `${course(id)}/policy-settings`,
        policySettingsViewSchema,
        "GET",
        undefined,
        undefined,
        signal,
      ),
    previewPolicySettings: (id, settings) =>
      request(
        `${course(id)}/policy-settings/preview`,
        policySettingsViewSchema,
        "POST",
        { settings },
      ),
    savePolicySettings: (id, input) =>
      request(
        `${course(id)}/policy-settings`,
        policySettingsViewSchema,
        "PUT",
        input,
      ),
    approveExtension: (id, offerId, ctx) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/extensions/${encodeURIComponent(offerId)}/grant`,
        ledgerResultSchema,
        "POST",
        {
          expectedRevision: ctx.expectedRevision,
          idempotencyKey: ctx.idempotencyKey,
        },
      ),
    rejectExtension: (id, offerId, reason, ctx) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/extensions/${encodeURIComponent(offerId)}/reject`,
        ledgerResultSchema,
        "POST",
        {
          reason,
          expectedRevision: ctx.expectedRevision,
          idempotencyKey: ctx.idempotencyKey,
        },
      ),
    previewLedgerAction: (id, action) => {
      const [path, body] = ledgerPath(id, action);
      return request(`${path}/preview`, ledgerPreviewSchema, "POST", body);
    },
    applyLedgerAction: (id, action, input, ctx) => {
      const [path] = ledgerPath(id, action);
      return request(
        action.kind === "exception" ? `${path}/apply` : path,
        ledgerResultSchema,
        "POST",
        {
          ...input,
          expectedRevision: ctx.expectedRevision,
          idempotencyKey: ctx.idempotencyKey,
        },
      );
    },
    previewCohortMigration: (id, change) =>
      request(
        `${course(id)}/policy/cohort/preview`,
        cohortPreviewSchema,
        "POST",
        { change },
      ),
    applyCohortMigration: (id, input) =>
      request(
        `${course(id)}/policy/cohort/apply`,
        cohortResultSchema,
        "POST",
        input,
      ),
    getPolicyCeilings: (id, signal) =>
      request(
        `/workspaces/${encodeURIComponent(id)}/policy-ceilings`,
        ceilingsViewSchema,
        "GET",
        undefined,
        undefined,
        signal,
      ),
    previewPolicyCeilings: (id, ceilings) =>
      request(
        `/workspaces/${encodeURIComponent(id)}/policy-ceilings/preview`,
        ceilingsViewSchema,
        "POST",
        { ceilings },
      ),
    savePolicyCeilings: (id, input) =>
      request(
        `/workspaces/${encodeURIComponent(id)}/policy-ceilings`,
        ceilingsViewSchema,
        "PUT",
        input,
      ),
    getAllowances: (id, view, signal) =>
      request(
        `${course(id)}/allowances?view=${view}`,
        allowancesSchema,
        "GET",
        undefined,
        undefined,
        signal,
      ),
    previewAccommodationBatch: (id, input) =>
      request(
        `${course(id)}/accommodations/batch/preview`,
        batchPreviewSchema,
        "POST",
        input,
      ),
    applyAccommodationBatch: (id, input) =>
      request(
        `${course(id)}/accommodations/batch/apply`,
        batchResultSchema,
        "POST",
        input,
      ),
    getAccommodationBatches: (id, signal) =>
      request(
        `${course(id)}/accommodations/batches`,
        batchesSchema,
        "GET",
        undefined,
        undefined,
        signal,
      ),
    previewAccommodation: (id, input, signal) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/accommodations/preview`,
        accommodationPreviewSchema,
        "POST",
        input,
        undefined,
        signal,
      ),
    applyAccommodation: (id, input, ctx) =>
      request(
        `/enrollments/${encodeURIComponent(id)}/accommodations/apply`,
        accommodationResultSchema,
        "POST",
        {
          ...input,
          expectedRevision: ctx.expectedRevision,
          idempotencyKey: ctx.idempotencyKey,
        },
      ),
  };
}
