import { z } from "zod";
import {
  INTERACTION_ASPECT_RATIOS,
  INTERACTION_IMAGE_SIZES,
} from "@course-core/providers/google";
import { requireCondition } from "./errors.js";
import type { ModelCatalog } from "./provider-metadata.js";
import { providerConfigurationSchema } from "./provider-composition.js";

/** Output settings of an image model (the Interactions API values; the first is the default). */
const imageSettings = {
  imageAspectRatio: z.enum(INTERACTION_ASPECT_RATIOS).optional(),
  imageSize: z.enum(INTERACTION_IMAGE_SIZES).optional(),
};
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
      ...imageSettings,
      /**
       * With a video model, an image model of the same connection for pictures, so a workspace
       * can make both. Ignored (refused) for an image model, which makes pictures itself.
       */
      imageModel: z
        .strictObject({ remoteModel: z.string().max(2048), ...imageSettings })
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
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9",
  DEFAULT_IMAGE_SIZE = "1K",
  /** Largest image accepted inline; the response bound leaves room for its base64 form. */
  MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/**
 * An image model on the Interactions API (`image_interaction`): the transport Google documents
 * for its current image models, with the image returned inline and nothing stored. The model
 * declares exactly the aspect ratio and size the binding asks for.
 */
function imageModelEntry(
  catalog: ModelCatalog,
  adapterId: string,
  modelId: string,
  choice: {
    remoteModel: string;
    imageAspectRatio?: string | undefined;
    imageSize?: string | undefined;
  },
) {
  const m = catalog.models.find((m) => m.remoteModel === choice.remoteModel);
  requireCondition(m, "PROVIDER_GUIDE_MODEL_UNAVAILABLE", 409);
  requireCondition(
    m.methods.includes("generateContent"),
    "PROVIDER_GUIDE_METHOD_UNSUPPORTED",
    409,
  );
  const maxInputCharacters = Math.min(
      12000,
      Math.floor(Math.max(0, (m.inputTokenLimit ?? 0) - 4096) / 4),
    ),
    maxOutputTokens = Math.min(1000, m.outputTokenLimit ?? 0);
  requireCondition(
    maxInputCharacters >= 2000 && maxOutputTokens >= 1,
    "PROVIDER_GUIDE_LIMITS_UNKNOWN",
    409,
  );
  const aspectRatio = choice.imageAspectRatio ?? DEFAULT_IMAGE_ASPECT_RATIO,
    imageSize = choice.imageSize ?? DEFAULT_IMAGE_SIZE;
  return {
    model: {
      id: modelId,
      providerId: adapterId,
      remoteModel: choice.remoteModel,
      enabled: true,
      capabilities: ["image"],
      tools: [],
      providerConfig: {
        transport: "image_interaction",
        apiVersion: "v1beta",
        maxResponseBytes: 16777216,
        image: {
          aspectRatios: [aspectRatio],
          imageSizes: [imageSize],
          mimeTypes: ["image/jpeg"],
          maxImageBytes: MAX_IMAGE_BYTES,
        },
      },
      limits: { maxInputCharacters, maxOutputTokens },
    },
    binding: {
      modelId,
      maxInputCharacters,
      maxOutputTokens,
      image: { aspectRatio, imageSize },
    },
  };
}
const upsert = (
  models: Record<string, unknown>[],
  model: Record<string, unknown>,
) => {
  const index = models.findIndex((m) => m.id === model.id);
  if (index < 0) models.push(model);
  else models[index] = model;
};

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
          : null;
    if (media?.kind === "image") {
      requireCondition(!media.imageModel, "PROVIDER_DRAFT_INVALID", 400);
      const image = imageModelEntry(catalog, adapterId, adapterId + ":media", media);
      upsert(models, image.model);
      roles.media = { ...image.binding, mediaKind: "image" };
      continue;
    }
    const remoteModel =
        typeof selection === "string" ? selection : selection.remoteModel,
      m = catalog.models.find((m) => m.remoteModel === remoteModel);
    requireCondition(m, "PROVIDER_GUIDE_MODEL_UNAVAILABLE", 409);
    const video = media?.kind === "video";
    requireCondition(
      !video || (!media.imageAspectRatio && !media.imageSize),
      "PROVIDER_DRAFT_INVALID",
      400,
    );
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
      maxResponseBytes: 1048576,
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
      // With a video model, an optional image model for pictures (same connection).
      pictures =
        video && media?.imageModel
          ? imageModelEntry(
              catalog,
              adapterId,
              adapterId + ":media-image",
              media.imageModel,
            )
          : null;
    upsert(models, model);
    if (pictures) upsert(models, pictures.model);
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
            ...(pictures ? { imageModel: pictures.binding } : {}),
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
