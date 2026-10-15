import { z } from "zod";
import { requireCondition } from "./errors.js";
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
  requireCondition(!signal.aborted, "PROVIDER_METADATA_CANCELLED", 503);
  let stop!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    stop = () => reject(Error("metadata_cancelled"));
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
  const response = await abortable(pending, signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    requireCondition(false, "PROVIDER_METADATA_UNAVAILABLE", 503);
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    requireCondition(false, "PROVIDER_METADATA_INVALID", 503);
  }
}
function printableKey(key: string) {
  requireCondition(
    /^[\x21-\x7e]{1,4096}$/.test(key),
    "PROVIDER_METADATA_CREDENTIAL_MISSING",
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
