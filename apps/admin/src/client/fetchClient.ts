import {
  learningPolicySchema,
  previewSchema,
  proposalResultSchema,
  policyMigrationPreviewSchema,
  policyMigrationResultSchema,
} from "../domain/policy";
import { z } from "zod";
import {
  mutationSchema,
  runSchema,
  sessionSchema,
  workspaceSchema,
  type AdminClient,
  type MutationContext,
} from "../domain/contracts";
import { AdminError, type AdminErrorCode } from "../domain/errors";

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
  const mutate = (
    path: string,
    input: unknown,
    context: MutationContext,
    method = "POST",
  ) => request(path, mutationSchema, method, input, context);
  return {
    mode: "connected",
    getSession: (signal) =>
      request("/session", sessionSchema, "GET", undefined, undefined, signal),
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
  };
}
