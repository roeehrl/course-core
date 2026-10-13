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
      maxOutputTokens = video ? 0 : Math.min(1000, m.outputTokenLimit ?? 0);
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
