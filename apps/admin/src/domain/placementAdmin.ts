import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

const count = z.number().int().nonnegative();
export const placementSettingsSchema = z.object({
  enabled: z.boolean(),
  retestCooldownHours: count,
  maxRuns: z.number().int().min(1),
  maxItems: z.number().int().min(1).nullable(),
  minFamiliesPerEpisode: z.number().int().min(1).nullable(),
  /** Staff narrowing of the author's blueprint and protected units. Absent from older servers. */
  excludedAssessmentIds: z.array(z.string().max(200)).max(500).default([]),
  excludedObjectiveIds: z.array(z.string().max(200)).max(500).default([]),
  protectedEpisodeIds: z.array(z.string().max(200)).max(500).default([]),
  revision: count,
  updatedAt: z.string().nullable(),
});
export type PlacementSettings = z.infer<typeof placementSettingsSchema>;
/** Each required episode as placement treats it under some settings. */
export const placementBlueprintSchema = z
  .array(
    z.object({
      episodeId: z.string().max(200),
      title: z.string().max(400),
      status: z.enum([
        "placeable",
        "not_placeable",
        "no_questions",
        "protected_by_author",
        "protected_by_staff",
      ]),
      questions: count,
      families: count,
      objectives: z
        .array(
          z.object({
            objectiveId: z.string().max(200),
            description: z.string().max(2000),
            placeable: z.boolean(),
          }),
        )
        .max(100),
    }),
  )
  .max(1000);
export type PlacementBlueprint = z.infer<typeof placementBlueprintSchema>;
export const placementPreviewSchema = z.object({
  blueprint: placementBlueprintSchema.nullable(),
  current: placementBlueprintSchema.nullable(),
});
export const coursePlacementSchema = z.object({
  /** The most questions a staff limit may allow: the lowest author limit among the live releases
   * that offer placement; null when none offers it. Absent from older servers. */
  authorLimit: count.nullable().optional(),
  /** The author's retest and evidence bounds across live releases (SDK 0.5); absent from older servers. */
  authorBounds: z
    .object({
      maxRuns: count.nullable(),
      minCooldownHours: count.nullable(),
      minFamiliesPerEpisode: count.nullable(),
    })
    .optional(),
  author: z
    .object({
      enabled: z.boolean(),
      maxItems: count,
      learnerMayDecline: z.boolean(),
      protectedEpisodeIds: z.array(z.string().max(200)).max(500).default([]),
      assistancePolicy: z.string().max(40).nullable().optional(),
      items: z
        .array(
          z.object({
            assessmentId: z.string().max(200),
            familyId: z.string().max(200),
            objectiveIds: z.array(z.string().max(200)).max(50),
            prompt: z.string().max(400),
          }),
        )
        .max(500)
        .default([]),
      objectives: z
        .array(
          z.object({
            objectiveId: z.string().max(200),
            description: z.string().max(2000),
          }),
        )
        .max(500)
        .default([]),
    })
    .passthrough()
    .nullable(),
  blueprint: placementBlueprintSchema.nullable().optional(),
  settings: placementSettingsSchema,
  effective: z
    .object({
      enabled: z.boolean(),
      authorEnabled: z.boolean(),
      staffEnabled: z.boolean(),
      maxItems: count,
      authorMaxItems: count,
    })
    .passthrough()
    .nullable(),
  counters: z
    .object({
      runs: z.record(z.string(), count),
      exemptions: count,
      falseSkips: z.object({
        total: count,
        revokedByStaff: count,
        laterFailed: count,
      }),
      unnecessaryRepetitions: count,
    })
    .nullable(),
});
export type CoursePlacement = z.infer<typeof coursePlacementSchema>;
/** The staff question-limit bound. Older servers do not send it: fall back to the live release's
 * own limit when it offers placement (the server still enforces the real bound). */
export const placementAuthorLimit = (c: CoursePlacement): number | null =>
  c.authorLimit !== undefined
    ? c.authorLimit
    : c.author?.enabled
      ? c.author.maxItems
      : null;
export const enrollmentPlacementSchema = z.object({
  enrollmentId: z.string().uuid(),
  release: z.object({
    version: z.string().max(100),
    digest: z.string().max(128),
  }),
  runs: z
    .array(
      z
        .object({
          runNumber: z.number().int(),
          state: z.string().max(40),
          stopReason: z.string().max(60).nullable(),
          itemsUsed: count.nullable(),
          startedAt: z.string().nullable(),
          finishedAt: z.string().nullable(),
          acceptedAt: z.string().nullable(),
        })
        .passthrough(),
    )
    .max(20),
  exemptions: z
    .array(
      z.object({
        episodeId: z.string().max(200),
        title: z.string().max(400),
        placedAt: z.string().nullable(),
        runNumber: z.number().int().nullable(),
        evidence: z
          .array(
            z.object({
              evidenceId: z.string().uuid(),
              objectiveId: z.string().max(200),
              assessmentId: z.string().max(200),
              familyId: z.string().max(200),
              independent: z.boolean(),
              passed: z.boolean().nullable(),
              invalidated: z.boolean(),
              sameCourseVersion: z.boolean(),
              placement: z.boolean(),
            }),
          )
          .max(100),
      }),
    )
    .max(500),
  overrides: z
    .array(
      z
        .object({
          episodeId: z.string().max(200),
          title: z.string().max(400),
          reason: z.string().max(2000),
          revokedBy: z.string().max(200),
          at: z.string(),
        })
        .passthrough(),
    )
    .max(500),
});
export type EnrollmentPlacement = z.infer<typeof enrollmentPlacementSchema>;
export type PlacementSettingsInput = Omit<
  PlacementSettings,
  | "revision"
  | "updatedAt"
  | "excludedAssessmentIds"
  | "excludedObjectiveIds"
  | "protectedEpisodeIds"
> & {
  expectedRevision: number;
  excludedAssessmentIds?: string[];
  excludedObjectiveIds?: string[];
  protectedEpisodeIds?: string[];
};

export interface PlacementAdminPort {
  course(catalogId: string, signal?: AbortSignal): Promise<CoursePlacement>;
  save(
    catalogId: string,
    input: PlacementSettingsInput,
  ): Promise<{ settings: PlacementSettings }>;
  /** What the settings would do, without saving them. Optional for older ports. */
  preview?(
    catalogId: string,
    input: PlacementSettingsInput,
  ): Promise<z.infer<typeof placementPreviewSchema>>;
  enrollment(
    enrollmentId: string,
    signal?: AbortSignal,
  ): Promise<EnrollmentPlacement>;
  revoke(
    enrollmentId: string,
    episodeId: string,
    input: { reason: string; expectedRevision: number },
    idempotencyKey: string,
  ): Promise<unknown>;
}
export class PlacementAdminError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PlacementAdminError";
  }
}
export const placementErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) => {
  const code = error instanceof PlacementAdminError ? error.code : "";
  const key = `placementAdmin.error.${code}` as MessageKey;
  return code && englishTranslator().has(key)
    ? t(key)
    : t("placementAdmin.error.unavailable");
};
