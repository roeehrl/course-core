import { z } from "zod";
import { requireCondition } from "./errors.js";
import {
  googleModelDraft,
  type ModelDraftInput,
} from "./google-model-setup.js";

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
export interface MetadataAdapter {
  label: string;
  buildDraft?: (input: ModelDraftInput) => unknown;
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
/** Read metadata only. The origin/path and headers are trusted code, never an
 * operator-supplied fetch URL. No generation or provider-side key echo logging. */
export function googleMetadataAdapter(
  request: typeof fetch = fetch,
): MetadataAdapter {
  return {
    label: "Google",
    buildDraft: googleModelDraft,
    async inspect({ getCredential, signal }) {
      const key = getCredential();
      requireCondition(
        /^[\x21-\x7e]{1,4096}$/.test(key),
        "PROVIDER_METADATA_CREDENTIAL_MISSING",
        409,
      );
      const limit = 1048576,
        seen = new Set<string>(),
        tokens = new Set<string>(),
        models: ModelCatalog["models"] = [];
      let bytes = 0,
        pageToken: string | undefined,
        pages = 0;
      do {
        const url = new URL(
          "https://generativelanguage.googleapis.com/v1beta/models",
        );
        url.searchParams.set("pageSize", "100");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const pending = request(url, {
          method: "GET",
          redirect: "error",
          signal,
          headers: { "x-goog-api-key": key, Accept: "application/json" },
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
          Number(declared) > limit - bytes
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
            bytes += result.value.byteLength;
            size += result.value.byteLength;
            requireCondition(
              bytes <= limit,
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
        let raw: unknown;
        try {
          raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
        } catch {
          requireCondition(false, "PROVIDER_METADATA_INVALID", 503);
        }
        const parsed = googlePage.safeParse(raw);
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
      const output = modelCatalogSchema.parse({
        models,
        truncated: !!pageToken,
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
    },
  };
}
