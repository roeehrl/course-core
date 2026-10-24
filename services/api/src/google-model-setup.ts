import { z } from "zod";
import { requireCondition } from "./errors.js";
import type { ModelCatalog } from "./provider-metadata.js";
import { providerConfigurationSchema } from "./provider-composition.js";

export const modelAssignmentsSchema = z.strictObject({
  companion: z.string().max(2048).nullable().optional(),
  supervisor: z.string().max(2048).nullable().optional(),
  research: z.string().max(2048).nullable().optional(),
  reviewer: z.string().max(2048).nullable().optional(),
  media: z
    .strictObject({
      remoteModel: z.string().max(2048),
      kind: z.enum(["image", "video"]),
      durationSeconds: z.number().int().min(1).max(20).optional(),
      aspectRatio: z
        .string()
        .regex(/^\d{1,2}:\d{1,2}$/)
        .optional(),
      resolution: z.string().min(1).max(128).optional(),
      downloadHosts: z
        .array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/))
        .max(8)
        .optional(),
    })
    .nullable()
    .optional(),
});
export type ModelAssignments = z.infer<typeof modelAssignmentsSchema>;

/**
 * Thinking and output limits per role for Gemini thinking models (2.5, 3.x, 4). Thought tokens
 * count toward `maxOutputTokens`, and a limit reached while thinking leaves a cut-off or empty
 * answer that is still billed (https://ai.google.dev/gemini-api/docs/generate-content/thinking).
 * Google's advice is to lower the thinking level rather than shrink the output limit, so each role
 * gets a level for its work and an output limit with room for both thinking and the answer:
 * the companion answers one learner question (low), the other roles plan, judge or research
 * (medium). Gemini 2.5 takes a token budget instead of a level.
 */
export const GEMINI_ROLE_OUTPUT_TOKENS = { companion: 4096, supervisor: 8192, reviewer: 8192, research: 8192 } as const;
const ROLE_THINKING_LEVEL = { companion: "low", supervisor: "medium", reviewer: "medium", research: "medium" } as const;
const ROLE_THINKING_BUDGET = { companion: 512, supervisor: -1, reviewer: -1, research: -1 } as const;
/** Levels a model is documented to refuse (the docs' support table); such a level is not sent. */
const UNSUPPORTED_LEVELS: readonly [RegExp, readonly string[]][] = [
  [/^gemini-3-pro/, ["minimal", "medium"]],
  [/^gemini-3\.8-flash|^gemini-4-/, ["minimal"]],
  [/^gemini-3\.1-pro/, ["minimal"]],
];
/** A Gemini model that thinks by default: the 2.5 series and every later generation. */
export function geminiThinkingFamily(remoteModel: string): "level" | "budget" | null {
  if (/^gemini-2\.5-/.test(remoteModel)) return "budget";
  if (/^gemini-([3-9]|[1-9][0-9])(\.|-)/.test(remoteModel) && !/-image|-tts|embedding|-live/.test(remoteModel)) return "level";
  return null;
}
/** The thinking setting a text role gets on a Gemini thinking model, or undefined (model default). */
export function geminiRoleThinking(role: keyof typeof ROLE_THINKING_LEVEL, remoteModel: string) {
  const family = geminiThinkingFamily(remoteModel);
  if (family === "budget") {
    const budget = ROLE_THINKING_BUDGET[role];
    // 2.5 Pro cannot go below 128 or turn thinking off; dynamic (-1) is valid everywhere.
    return { budget: /^gemini-2\.5-pro/.test(remoteModel) && budget >= 0 ? Math.max(128, budget) : budget };
  }
  if (family !== "level") return undefined;
  const level = ROLE_THINKING_LEVEL[role];
  if (UNSUPPORTED_LEVELS.some(([pattern, levels]) => pattern.test(remoteModel) && levels.includes(level))) return undefined;
  return { level };
}
export interface ModelDraftInput {
  configuration: unknown;
  adapterId: string;
  catalog: ModelCatalog;
  assignments: ModelAssignments;
}
/** Provider-specific protocol draft only. Metadata doesn't establish research,
 * structured-output, image or video quality; live verification is separate. */
export function googleModelDraft({
  configuration,
  adapterId,
  catalog,
  assignments,
}: ModelDraftInput) {
  const parsed = providerConfigurationSchema.parse(configuration),
    registry = z
      .object({
        revision: z.string(),
        models: z.array(z.record(z.string(), z.unknown())),
      })
      .parse(parsed.registry),
    adapter = parsed.adapters.find((a) => a.id === adapterId);
  requireCondition(
    adapter?.kind === "google",
    "PROVIDER_GUIDE_UNSUPPORTED",
    409,
  );
  const roles = structuredClone(parsed.roles),
    models = structuredClone(registry.models);
  for (const role of [
    "companion",
    "supervisor",
    "research",
    "reviewer",
    "media",
  ] as const) {
    const selection = assignments[role];
    if (selection === undefined) continue;
    if (selection === null) {
      delete roles[role];
      continue;
    }
    const media =
        role === "media"
          ? (selection as NonNullable<ModelAssignments["media"]>)
          : null,
      remoteModel =
        typeof selection === "string" ? selection : selection.remoteModel,
      m = catalog.models.find((m) => m.remoteModel === remoteModel);
    requireCondition(m, "PROVIDER_GUIDE_MODEL_UNAVAILABLE", 409);
    const video = media?.kind === "video";
    requireCondition(
      m.methods.includes(video ? "predictLongRunning" : "generateContent"),
      "PROVIDER_GUIDE_METHOD_UNSUPPORTED",
      409,
    );
    const maxInputCharacters = video
        ? 2000
        : Math.min(
            role === "supervisor" ? 30000 : role === "reviewer" ? 20000 : 12000,
            Math.floor(Math.max(0, (m.inputTokenLimit ?? 0) - 4096) / 4),
          ),
      thinking =
        !media && role !== "media" ? geminiRoleThinking(role, remoteModel) : undefined,
      maxOutputTokens = video
        ? 0
        : Math.min(
            thinking || geminiThinkingFamily(remoteModel)
              ? GEMINI_ROLE_OUTPUT_TOKENS[role as keyof typeof GEMINI_ROLE_OUTPUT_TOKENS] ?? 1000
              : 1000,
            m.outputTokenLimit ?? 0,
          );
    requireCondition(
      video || (maxInputCharacters >= 2000 && maxOutputTokens >= 1),
      "PROVIDER_GUIDE_LIMITS_UNKNOWN",
      409,
    );
    requireCondition(
      role !== "supervisor" || maxInputCharacters >= 20000,
      "PROVIDER_GUIDE_CONTEXT_TOO_SMALL",
      409,
    );
    const modelId = adapterId + ":" + role,
      capability =
        role === "companion"
          ? "tutoring"
          : role === "supervisor" || role === "reviewer"
            ? "structured_assessment"
            : role === "research"
              ? "research"
              : media!.kind;
    let providerConfig: unknown = {
      transport: "generate_content",
      apiVersion: "v1beta",
      maxResponseBytes: media?.kind === "image" ? 16777216 : 1048576,
      ...(thinking ? { thinking } : {}),
    };
    if (video) {
      requireCondition(
        media?.durationSeconds &&
          media.aspectRatio &&
          media.resolution &&
          media.downloadHosts?.length,
        "PROVIDER_GUIDE_VIDEO_PARAMETERS_REQUIRED",
        409,
      );
      providerConfig = {
        transport: "video_lro",
        apiVersion: "v1beta",
        maxResponseBytes: 1048576,
        video: {
          durationSeconds: [media.durationSeconds],
          aspectRatios: [media.aspectRatio],
          resolutions: [media.resolution],
          downloadHosts: media.downloadHosts,
        },
      };
    }
    const model = {
        id: modelId,
        providerId: adapterId,
        remoteModel,
        enabled: true,
        capabilities: [capability],
        tools: role === "research" ? ["web_search"] : [],
        providerConfig,
        limits: { maxInputCharacters, ...(!video ? { maxOutputTokens } : {}) },
      },
      index = models.findIndex((m) => m.id === modelId);
    if (index < 0) models.push(model);
    else models[index] = model;
    roles[role] = {
      modelId,
      maxInputCharacters,
      maxOutputTokens,
      ...(role === "supervisor" ? { maxToolRounds: 4 } : {}),
      ...(media
        ? {
            mediaKind: media.kind,
            ...(video
              ? {
                  video: {
                    durationSeconds: media.durationSeconds!,
                    aspectRatio: media.aspectRatio!,
                    resolution: media.resolution!,
                  },
                }
              : {}),
          }
        : {}),
    };
  }
  return {
    registry: { revision: registry.revision, models },
    adapters: parsed.adapters,
    roles,
  };
}
