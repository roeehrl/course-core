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
import {providerSetupSchema,providerBudgetsSchema,setupReceiptSchema,budgetReceiptSchema,inspectionSchema,modelPreviewSchema} from "../domain/providerSetup";
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
  researchLibrarySchema,
  researchQueueSchema,
  researchReceiptSchema,
  ResearchActionError,
} from "../domain/research";
import { erasureSchema, LearnerDataError } from "../domain/learnerData";
import { learnerViewSchema, LearnerViewError } from "../domain/learnerView";
import { appealsSchema, pendingReviewsSchema, ReviewActionError } from "../domain/reviews";
import {
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
export function createFetchAdminClient(
  options: FetchClientOptions,
): AdminClient {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, "");
  const course = (courseId: string) =>
    `/courses/${encodeURIComponent(courseId)}`;
  let providerAccountId:string|undefined;
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
        ULTIMATE_CEILING: "policy_reset_forbidden",
        REVIEW_CANNOT_GRANT_MASTERY: "review_invalid",
        RELEASE_REVIEW_REQUIRED: "pending_review",
        PUBLISHED_RELEASE_IMMUTABLE: "immutable_release",
        PUBLISH_CAPABILITY_MISSING: "runtime_unsupported",
        PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE: "runtime_unsupported",
        PUBLISH_ACTIVITY_RUNTIME_UNAVAILABLE: "runtime_unsupported",
        PUBLISH_VISUAL_VALIDATOR_MISSING: "runtime_unsupported",
        PUBLISH_VISUAL_INVALID: "runtime_unsupported",
        INVALID_COURSE: "validation",
        ALREADY_ENROLLED: "validation",
        IDEMPOTENCY_CONFLICT: "validation",
        PROVIDER_CONFIGURATION_INVALID: "validation",
        PROVIDER_SECRET_FIELD_FORBIDDEN: "validation",
        PROVIDER_BUDGET_INVALID: "validation",
        PROVIDER_BUDGET_BELOW_USAGE: "validation",
        PAID_WORK_CONSENT_REQUIRED: "validation",
        PROVIDER_TOKEN_RESERVATION_TOO_SMALL: "validation",
        STALE_PROVIDER_REVISION: "stale_revision",
        STALE_PROVIDER_BUDGET_REVISION: "stale_revision",
      };
      // Read only an allowlisted error code. Never display/log a raw service body.
      let policyCode: AdminErrorCode | undefined;
      try {
        const body: unknown = await response.json();
        if (
          body &&
          typeof body === "object" &&
          "error" in body &&
          typeof body.error === "string"
        )
          policyCode = policyCodes[body.error];
      } catch {
        /* Non-JSON service error. */
      }
      throw new AdminError(
        policyCode ?? codes[response.status] ?? "unavailable",
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
    fail: (code: string) => Error,
  ): Promise<T> {
    const headers = new Headers(options.requestHeaders?.());
    headers.set("Accept", "application/json");
    if (payload !== undefined) headers.set("Content-Type", "application/json");
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
      throw fail(/^[A-Z_]{1,64}$/.test(code) ? code : "UNAVAILABLE");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw fail("INVALID_RESPONSE");
    return parsed.data;
  }
  const research = <T,>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    signal?: AbortSignal,
  ) =>
    direct(path, schema, method, payload, signal, (c) => new ResearchActionError(c));
  const people = <T,>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    payload?: unknown,
    signal?: AbortSignal,
  ) =>
    direct(path, schema, method, payload, signal, (c) => new PeopleActionError(c));
  const workspacePeople = (id: string) =>
    `/workspaces/${encodeURIComponent(id)}/people`;
  const mutate = (
    path: string,
    input: unknown,
    context: MutationContext,
    method = "POST",
  ) => request(path, mutationSchema, method, input, context);
  return {
    mode: "connected",
    adaptationRuntime:()=>request('/runtime/adaptation-adapters',z.object({adapters:z.array(z.object({id:z.string(),kind:z.string(),implementationDigest:z.string().regex(/^[a-f0-9]{64}$/),authorization:z.string()}))})),
    adaptationRegistry:(id)=>request(`/releases/${encodeURIComponent(id)}/adaptation-registry`,z.object({registryRevision:z.number().int().nonnegative(),configured:z.boolean(),configurationDigest:z.string().nullable()})),
    approveAdaptationRegistry:(id,expectedRegistryRevision,configuration)=>request(`/releases/${encodeURIComponent(id)}/adaptation-registry`,z.object({registryRevision:z.number().int().positive()}),'POST',{expectedRegistryRevision,configuration}),
    getSession: async (signal) => { const session=await request("/session", sessionSchema, "GET", undefined, undefined, signal);providerAccountId=session.actor.id;return session;},
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
    transitionRelease: (id, releaseId, action, ctx) =>
      mutate(
        `${course(id)}/releases/${encodeURIComponent(releaseId)}/transitions`,
        { action },
        ctx,
      ),
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
        { scopeId: input.scopeId, days: input.days },
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
      get accountId(){return providerAccountId;},
      inspectModels:(id,input)=>request(`/workspaces/${encodeURIComponent(id)}/provider-setup/inspect-models`,inspectionSchema,'POST',input),
      previewModels:(id,input)=>request(`/workspaces/${encodeURIComponent(id)}/provider-setup/preview-models`,modelPreviewSchema,'POST',input),
      read:(id,signal)=>request(`/workspaces/${encodeURIComponent(id)}/provider-setup`,providerSetupSchema,'GET',undefined,undefined,signal),
      budgets:(id,signal)=>request(`/workspaces/${encodeURIComponent(id)}/provider-setup/budgets`,providerBudgetsSchema,'GET',undefined,undefined,signal),
      save:(id,input)=>request(`/workspaces/${encodeURIComponent(id)}/provider-setup`,setupReceiptSchema,'POST',input),
      saveBudget:(id,input)=>request(`/workspaces/${encodeURIComponent(id)}/provider-setup/budgets`,budgetReceiptSchema,'POST',input),
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
    reviews: {
      pending: (catalogId, signal) =>
        direct(`${course(catalogId)}/rubric-reviews`, pendingReviewsSchema, "GET", undefined, signal, (c) => new ReviewActionError(c)),
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
        direct(`${course(catalogId)}/rubric-appeals`, appealsSchema, "GET", undefined, signal, (c) => new ReviewActionError(c)),
      decideAppeal: (appealId, input, idempotencyKey) =>
        direct(`/rubric-appeals/${encodeURIComponent(appealId)}`, z.record(z.string(), z.unknown()), "POST", { ...input, idempotencyKey }, undefined, (c) => new ReviewActionError(c)),
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
    learnerData: {
      exportEnrollment: (id) =>
        direct(
          `/enrollments/${encodeURIComponent(id)}/export`,
          z.object({ format: z.literal("course-core.enrollment-export") }).passthrough(),
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
    previewAccommodation: (id, input, signal) =>
      request(`/enrollments/${encodeURIComponent(id)}/accommodations/preview`, accommodationPreviewSchema, "POST", input, undefined, signal),
    applyAccommodation: (id, input, ctx) =>
      request(`/enrollments/${encodeURIComponent(id)}/accommodations/apply`, accommodationResultSchema, "POST", {
        ...input,
        expectedRevision: ctx.expectedRevision,
        idempotencyKey: ctx.idempotencyKey,
      }),
  };
}
