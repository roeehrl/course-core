import { z } from "zod";

const count = z.number().int().nonnegative();
export const placementSettingsSchema = z.object({
  enabled: z.boolean(),
  retestCooldownHours: count,
  maxRuns: z.number().int().min(1),
  maxItems: z.number().int().min(1).nullable(),
  minFamiliesPerEpisode: z.number().int().min(1).nullable(),
  revision: count,
  updatedAt: z.string().nullable(),
});
export type PlacementSettings = z.infer<typeof placementSettingsSchema>;
export const coursePlacementSchema = z.object({
  author: z.object({ enabled: z.boolean(), maxItems: count, learnerMayDecline: z.boolean() }).passthrough().nullable(),
  settings: placementSettingsSchema,
  effective: z.object({ enabled: z.boolean(), authorEnabled: z.boolean(), staffEnabled: z.boolean(), maxItems: count, authorMaxItems: count }).passthrough().nullable(),
  counters: z
    .object({
      runs: z.record(z.string(), count),
      exemptions: count,
      falseSkips: z.object({ total: count, revokedByStaff: count, laterFailed: count }),
      unnecessaryRepetitions: count,
    })
    .nullable(),
});
export type CoursePlacement = z.infer<typeof coursePlacementSchema>;
export const enrollmentPlacementSchema = z.object({
  enrollmentId: z.string().uuid(),
  release: z.object({ version: z.string().max(100), digest: z.string().max(128) }),
  runs: z.array(z.object({ runNumber: z.number().int(), state: z.string().max(40), stopReason: z.string().max(60).nullable(), itemsUsed: count.nullable(),
    startedAt: z.string().nullable(), finishedAt: z.string().nullable(), acceptedAt: z.string().nullable() }).passthrough()).max(20),
  exemptions: z.array(z.object({
    episodeId: z.string().max(200), title: z.string().max(400), placedAt: z.string().nullable(), runNumber: z.number().int().nullable(),
    evidence: z.array(z.object({ evidenceId: z.string().uuid(), objectiveId: z.string().max(200), assessmentId: z.string().max(200), familyId: z.string().max(200),
      independent: z.boolean(), passed: z.boolean().nullable(), invalidated: z.boolean(), sameCourseVersion: z.boolean(), placement: z.boolean() })).max(100),
  })).max(500),
  overrides: z.array(z.object({ episodeId: z.string().max(200), title: z.string().max(400), reason: z.string().max(2000), revokedBy: z.string().max(200), at: z.string() }).passthrough()).max(500),
});
export type EnrollmentPlacement = z.infer<typeof enrollmentPlacementSchema>;
export type PlacementSettingsInput = Omit<PlacementSettings, "revision" | "updatedAt"> & { expectedRevision: number };

export interface PlacementAdminPort {
  course(catalogId: string, signal?: AbortSignal): Promise<CoursePlacement>;
  save(catalogId: string, input: PlacementSettingsInput): Promise<{ settings: PlacementSettings }>;
  enrollment(enrollmentId: string, signal?: AbortSignal): Promise<EnrollmentPlacement>;
  revoke(enrollmentId: string, episodeId: string, input: { reason: string; expectedRevision: number }, idempotencyKey: string): Promise<unknown>;
}
export class PlacementAdminError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PlacementAdminError";
  }
}
const messages: Record<string, string> = {
  FORBIDDEN: "Your role cannot change placement. Owners and admins set it; instructors may revoke an exemption.",
  STALE_REVISION: "These settings or this enrollment changed since you opened them. Refresh and try again.",
  PLACEMENT_LIMIT_LOOSENS_AUTHOR: "The question limit can only be lowered below what the course author allows.",
  PLACEMENT_EXEMPTION_NOT_FOUND: "That exemption no longer exists. Refresh.",
  INVALID_REQUEST: "Check the values: the reason needs at least 10 characters.",
};
export const placementErrorMessage = (error: unknown) =>
  messages[error instanceof PlacementAdminError ? error.code : ""] ?? "Placement administration is unavailable. Nothing changed.";
