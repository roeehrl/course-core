import { z } from "zod";
import { ApiError, requireCondition } from "./errors.js";
import {
  googleModelDraft,
  type ModelDraftInput,
} from "./google-model-setup.js";
import { anthropicModelDraft } from "./anthropic-model-setup.js";

export const modelMetadataSchema = z.strictObject({
  remoteModel: z.string().min(1).max(2048),
  displayName: z.string().max(128),
  description: z.string().max(2000),
  inputTokenLimit: z.number().int().positive().nullable(),
  outputTokenLimit: z.number().int().positive().nullable(),
  methods: z.array(z.string().min(1).max(128)).max(32),
});
export const modelCatalogSchema = z.strictObject({
  models: z.array(modelMetadataSchema).max(400),
  truncated: z.boolean(),
  pages: z.number().int().min(1).max(4),
  generationPerformed: z.literal(false),
  capabilitiesVerified: z.literal(false),
});
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
/** The metadata method a model must report to be offered for a role. `null` means the provider
 * cannot serve that role through the guide (Anthropic has no media generation). */
export interface RoleMethods {
  companion: string;
  supervisor: string;
  research: string;
  reviewer: string;
  media: { image: string; video: string } | null;
}
/**
 * Why a metadata request (an inspection of a saved key, or a test of a typed key) did not
 * return a catalogue. Each code names one cause the operator can act on; none carries
 * provider text, which may echo request details.
 */
export const METADATA_FAILURE_CODES = [
  /** No key is stored for the connection (or it is empty). */
  "PROVIDER_METADATA_CREDENTIAL_MISSING",
  /** The key contains spaces, line breaks or characters an API key never has. */
  "PROVIDER_METADATA_CREDENTIAL_MALFORMED",
  /** The provider says the key is not valid (wrong, deleted or expired). */
  "PROVIDER_METADATA_KEY_INVALID",
  /** The key is valid but the API is not enabled for its project. */
  "PROVIDER_METADATA_API_NOT_ENABLED",
  /** The key's API or application restrictions block this API. */
  "PROVIDER_METADATA_KEY_RESTRICTED",
  /** Any other refusal of permission. */
  "PROVIDER_METADATA_PERMISSION_DENIED",
  /** Quota or rate limit reached. */
  "PROVIDER_METADATA_RATE_LIMITED",
  /** Another client error (for example an unsupported region or billing state). */
  "PROVIDER_METADATA_REJECTED",
  /** The provider reported a server error. */
  "PROVIDER_METADATA_UPSTREAM_ERROR",
  /** The provider could not be reached. */
  "PROVIDER_METADATA_NETWORK",
  /** No answer within the time limit. */
  "PROVIDER_METADATA_TIMEOUT",
  /** The answer was not a metadata catalogue this host accepts. */
  "PROVIDER_METADATA_INVALID",
  "PROVIDER_METADATA_TOO_LARGE",
] as const;
export type MetadataFailureCode = (typeof METADATA_FAILURE_CODES)[number];
const failureCodes: ReadonlySet<string> = new Set(METADATA_FAILURE_CODES);
/** The failure code of an error thrown by a metadata adapter; anything unexpected is UNAVAILABLE. */
export function metadataFailureCode(
  error: unknown,
): MetadataFailureCode | "PROVIDER_METADATA_UNAVAILABLE" {
  return error instanceof ApiError && failureCodes.has(error.code)
    ? (error.code as MetadataFailureCode)
    : "PROVIDER_METADATA_UNAVAILABLE";
}
/** Classifies a refused metadata request from its status and the provider's structured error
 * (Google `google.rpc.Status` with `ErrorInfo.reason`, Anthropic `error.type`). */
export function refusalCode(status: number, body: unknown): MetadataFailureCode {
  const error =
      body && typeof body === "object" && "error" in body
        ? (body.error as Record<string, unknown> | null)
        : null,
    text = (value: unknown) => (typeof value === "string" ? value : ""),
    googleStatus = text(error?.status),
    errorType = text(error?.type),
    reasons = Array.isArray(error?.details)
      ? error.details.map((d: unknown) =>
          d && typeof d === "object" && "reason" in d ? text(d.reason) : "",
        )
      : [];
  if (
    reasons.includes("API_KEY_INVALID") ||
    reasons.includes("API_KEY_EXPIRED") ||
    status === 401 ||
    googleStatus === "UNAUTHENTICATED" ||
    errorType === "authentication_error"
  )
    return "PROVIDER_METADATA_KEY_INVALID";
  if (reasons.includes("SERVICE_DISABLED"))
    return "PROVIDER_METADATA_API_NOT_ENABLED";
  if (reasons.some((reason) => /^API_KEY_[A-Z_]*BLOCKED$/.test(reason)))
    return "PROVIDER_METADATA_KEY_RESTRICTED";
  if (
    status === 429 ||
    googleStatus === "RESOURCE_EXHAUSTED" ||
    errorType === "rate_limit_error"
  )
    return "PROVIDER_METADATA_RATE_LIMITED";
  if (
    status === 403 ||
    googleStatus === "PERMISSION_DENIED" ||
    errorType === "permission_error"
  )
    return "PROVIDER_METADATA_PERMISSION_DENIED";
  if (status >= 500) return "PROVIDER_METADATA_UPSTREAM_ERROR";
  return "PROVIDER_METADATA_REJECTED";
}
export interface MetadataAdapter {
  label: string;
  buildDraft?: (input: ModelDraftInput) => unknown;
  roleMethods?: RoleMethods;
  inspect(input: {
    getCredential: () => string;
    configuration: unknown;
    signal: AbortSignal;
  }): Promise<ModelCatalog>;
}
export async function boundedMetadataInspection(
  adapter: MetadataAdapter,
  input: Parameters<MetadataAdapter["inspect"]>[0],
) {
  return modelCatalogSchema.parse(
    await abortable(adapter.inspect(input), input.signal),
  );
}
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  requireCondition(!signal.aborted, "PROVIDER_METADATA_TIMEOUT", 503);
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(new ApiError(503, "PROVIDER_METADATA_TIMEOUT"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
const googlePage = z.object({
  models: z
    .array(
      z.object({
        name: z.string().regex(/^models\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
        displayName: z.string().max(128).optional(),
        description: z.string().max(2000).optional(),
        inputTokenLimit: z.number().int().positive().optional(),
        outputTokenLimit: z.number().int().positive().optional(),
        supportedGenerationMethods: z
          .array(z.string().min(1).max(128))
          .max(32)
          .optional(),
      }),
    )
    .max(100),
  nextPageToken: z.string().min(1).max(4096).optional(),
});
/** Reads a response body within a byte budget shared by every page of one request. */
async function readBounded(
  response: Response,
  signal: AbortSignal,
  budget: { used: number; limit: number },
) {
  requireCondition(response.body, "PROVIDER_METADATA_INVALID", 503);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      budget.used += result.value.byteLength;
      size += result.value.byteLength;
      requireCondition(
        budget.used <= budget.limit,
        "PROVIDER_METADATA_TOO_LARGE",
        503,
      );
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
/** Shared bounded reader for one metadata page: GET only, redirects refused, a JSON content
 * type, and a byte budget shared by every page of one inspection. */
async function boundedPage(
  request: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  budget: { used: number; limit: number },
): Promise<unknown> {
  const pending = request(url, {
    method: "GET",
    redirect: "error",
    signal,
    headers: { ...headers, Accept: "application/json" },
  });
  void pending
    .then((r) => {
      if (signal.aborted) void r.body?.cancel().catch(() => {});
    })
    .catch(() => {});
  let response: Response;
  try {
    response = await abortable(pending, signal);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // fetch rejects with its own abort error when the deadline fires first.
    throw new ApiError(
      503,
      signal.aborted ? "PROVIDER_METADATA_TIMEOUT" : "PROVIDER_METADATA_NETWORK",
    );
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => {});
    requireCondition(false, "PROVIDER_METADATA_INVALID", 503);
  }
  if (!response.ok) {
    // Only the structured error's status and reason are read, from a small bounded body.
    let detail: unknown = null;
    try {
      detail = JSON.parse(
        new TextDecoder().decode(
          await readBounded(response, signal, { used: 0, limit: 16384 }),
        ),
      );
    } catch (e) {
      if (signal.aborted) throw new ApiError(503, "PROVIDER_METADATA_TIMEOUT");
    }
    throw new ApiError(503, refusalCode(response.status, detail));
  }
  if (
    response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    requireCondition(false, "PROVIDER_METADATA_INVALID", 503);
  }
  const declared = response.headers.get("content-length");
  if (
    declared &&
    /^\d+$/.test(declared) &&
    Number(declared) > budget.limit - budget.used
  ) {
    void response.body.cancel().catch(() => {});
    requireCondition(false, "PROVIDER_METADATA_TOO_LARGE", 503);
  }
  const body = await readBounded(response, signal, budget);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    requireCondition(false, "PROVIDER_METADATA_INVALID", 503);
  }
}
function printableKey(key: string) {
  requireCondition(key, "PROVIDER_METADATA_CREDENTIAL_MISSING", 409);
  requireCondition(
    /^[\x21-\x7e]{1,4096}$/.test(key),
    "PROVIDER_METADATA_CREDENTIAL_MALFORMED",
    409,
  );
}
function catalogue(
  models: ModelCatalog["models"],
  pages: number,
  truncated: boolean,
  key: string,
) {
  const output = modelCatalogSchema.parse({
    models,
    truncated,
    pages,
    generationPerformed: false,
    capabilitiesVerified: false,
  });
  requireCondition(
    !JSON.stringify(output).includes(key),
    "PROVIDER_METADATA_INVALID",
    503,
  );
  return output;
}
/** Read metadata only. The origin/path and headers are trusted code, never an
 * operator-supplied fetch URL. No generation or provider-side key echo logging. */
export function googleMetadataAdapter(
  request: typeof fetch = fetch,
): MetadataAdapter {
  return {
    label: "Google",
    buildDraft: googleModelDraft,
    roleMethods: {
      companion: "generateContent",
      supervisor: "generateContent",
      research: "generateContent",
      reviewer: "generateContent",
      media: { image: "generateContent", video: "predictLongRunning" },
    },
    async inspect({ getCredential, signal }) {
      const key = getCredential();
      printableKey(key);
      const budget = { used: 0, limit: 1048576 },
        seen = new Set<string>(),
        tokens = new Set<string>(),
        models: ModelCatalog["models"] = [];
      let pageToken: string | undefined,
        pages = 0;
      do {
        const url = new URL(
          "https://generativelanguage.googleapis.com/v1beta/models",
        );
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const parsed = googlePage.safeParse(
          await boundedPage(
            request,
            url,
            { "x-goog-api-key": key },
            signal,
            budget,
          ),
        );
        requireCondition(parsed.success, "PROVIDER_METADATA_INVALID", 503);
        pages++;
        for (const m of parsed.data.models) {
          const remoteModel = m.name.slice(7);
          requireCondition(
            !seen.has(remoteModel),
            "PROVIDER_METADATA_INVALID",
            503,
          );
          seen.add(remoteModel);
          models.push({
            remoteModel,
            displayName: m.displayName ?? remoteModel,
            description: m.description ?? "",
            inputTokenLimit: m.inputTokenLimit ?? null,
            outputTokenLimit: m.outputTokenLimit ?? null,
            methods: m.supportedGenerationMethods ?? [],
          });
        }
        pageToken = parsed.data.nextPageToken;
        if (pageToken) {
          requireCondition(
            !tokens.has(pageToken),
            "PROVIDER_METADATA_INVALID",
            503,
          );
          tokens.add(pageToken);
        }
      } while (pageToken && pages < 4);
      return catalogue(models, pages, !!pageToken, key);
    },
  };
}

const supported = z.object({ supported: z.boolean() }).nullable().optional();
/** One GET /v1/models page from the Models API. Unknown capability keys are ignored. */
const anthropicPage = z.object({
  data: z
    .array(
      z.object({
        type: z.literal("model").optional(),
        id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
        display_name: z.string().max(128),
        // Unknown lifecycle values are listed without a deprecation note rather than failing the page.
        lifecycle: z.string().max(32).optional(),
        retires_at: z.string().max(64).nullable().optional(),
        max_input_tokens: z.number().int().positive().nullable().optional(),
        max_tokens: z.number().int().positive().nullable().optional(),
        capabilities: z
          .object({
            structured_outputs: supported,
            effort: z
              .object({ supported: z.boolean(), low: supported })
              .nullable()
              .optional(),
            thinking: z
              .object({
                supported: z.boolean(),
                types: z.object({ disabled: supported }).optional(),
              })
              .nullable()
              .optional(),
            server_tools: z
              .object({ supported: z.boolean(), web_search: supported })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      }),
    )
    .max(100),
  has_more: z.boolean(),
  first_id: z.string().max(256).nullable().optional(),
  last_id: z.string().max(256).nullable().optional(),
});
/** Metadata method names the Anthropic guided builder relies on. They restate Models API
 * capability flags; they are declarations, not live verification. */
export const anthropicMethods = {
  messages: "messages",
  structuredOutputs: "structured_outputs",
  webSearch: "web_search",
  effortLow: "effort_low",
  thinkingDisabled: "thinking_disabled",
} as const;
/** Models API metadata only: GET https://api.anthropic.com/v1/models with the key in
 * `x-api-key`. No generation, no redirects, no operator-supplied URL. Retired models are
 * skipped; the API omits them unless asked. */
export function anthropicMetadataAdapter(
  request: typeof fetch = fetch,
): MetadataAdapter {
  return {
    label: "Anthropic",
    buildDraft: anthropicModelDraft,
    roleMethods: {
      companion: anthropicMethods.messages,
      supervisor: anthropicMethods.structuredOutputs,
      research: anthropicMethods.webSearch,
      reviewer: anthropicMethods.structuredOutputs,
      media: null,
    },
    async inspect({ getCredential, signal }) {
      const key = getCredential();
      printableKey(key);
      const budget = { used: 0, limit: 1048576 },
        seen = new Set<string>(),
        cursors = new Set<string>(),
        models: ModelCatalog["models"] = [];
      let after: string | undefined,
        more = false,
        pages = 0;
      do {
        const url = new URL("https://api.anthropic.com/v1/models");
        url.searchParams.set("limit", "100");
        if (after) url.searchParams.set("after_id", after);
        const parsed = anthropicPage.safeParse(
          await boundedPage(
            request,
            url,
            { "x-api-key": key, "anthropic-version": "2023-06-01" },
            signal,
            budget,
          ),
        );
        requireCondition(parsed.success, "PROVIDER_METADATA_INVALID", 503);
        pages++;
        for (const m of parsed.data.data) {
          requireCondition(!seen.has(m.id), "PROVIDER_METADATA_INVALID", 503);
          seen.add(m.id);
          if (m.lifecycle === "retired") continue;
          const c = m.capabilities,
            methods: string[] = [anthropicMethods.messages];
          if (c?.structured_outputs?.supported)
            methods.push(anthropicMethods.structuredOutputs);
          // Web search is offered when reported, or when the listing has no server tool tree at all
          // (the operator then declares it; live search is unverified). An explicit false hides it.
          if (
            c?.server_tools?.web_search?.supported ||
            (c && c.server_tools === undefined)
          )
            methods.push(anthropicMethods.webSearch);
          if (c?.effort?.supported && c.effort.low?.supported)
            methods.push(anthropicMethods.effortLow);
          if (c?.thinking?.supported && c.thinking.types?.disabled?.supported)
            methods.push(anthropicMethods.thinkingDisabled);
          models.push({
            remoteModel: m.id,
            displayName: m.display_name || m.id,
            description:
              m.lifecycle === "deprecated"
                ? "Deprecated" +
                  (m.retires_at
                    ? "; scheduled to retire " + m.retires_at.slice(0, 10)
                    : "") +
                  "."
                : "",
            inputTokenLimit: m.max_input_tokens ?? null,
            outputTokenLimit: m.max_tokens ?? null,
            methods,
          });
        }
        more = parsed.data.has_more;
        after = parsed.data.last_id ?? undefined;
        if (more) {
          requireCondition(
            !!after && !cursors.has(after),
            "PROVIDER_METADATA_INVALID",
            503,
          );
          cursors.add(after!);
        }
      } while (more && pages < 4);
      return catalogue(models, pages, more, key);
    },
  };
}
