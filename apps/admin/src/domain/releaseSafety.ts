import { z } from "zod";
import type { MutationContext, MutationResult } from "./contracts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.object({ id: z.string().uuid(), version: z.string().max(100), digest: z.string().max(128) });
const ids = z.array(z.string().max(200)).max(2000);
export const rollbackImpactSchema = z.object({
  impact: z.object({
    from: ref,
    to: ref,
    learnersPinnedToActive: z.number().int().nonnegative(),
    learnersPinnedToTarget: z.number().int().nonnegative(),
    contentChanges: z.number().int().nonnegative(),
    changedOrRemovedItems: ids,
    evidenceOnChangedItems: z.number().int().nonnegative(),
    learnersWithEvidenceOnChangedItems: z.number().int().nonnegative(),
    targetDefectiveItems: ids,
    existingLearnersMove: z.literal(false),
  }),
  impactDigest: digest,
});
export type RollbackImpact = z.infer<typeof rollbackImpactSchema>;
export const releaseDiffSchema = z.object({
  from: ref,
  to: ref,
  identical: z.boolean(),
  changes: z.number().int().nonnegative(),
  kinds: z.record(z.string(), z.object({ added: ids, removed: ids, changed: ids, unchanged: z.number().int().nonnegative() })),
});
export type ReleaseDiff = z.infer<typeof releaseDiffSchema>;
export const defectiveItemsSchema = z.object({
  releaseId: z.string().uuid(),
  items: z.array(z.object({ assessmentId: z.string().max(200), reason: z.string().max(2000), markedAt: z.string() })).max(2000),
});
export const defectPreviewSchema = z.object({
  preview: z.object({
    releaseId: z.string().uuid(),
    assessmentId: z.string().max(200),
    alreadyDefective: z.boolean(),
    evidenceToInvalidate: z.number().int().nonnegative(),
    affectedEnrollments: z.number().int().nonnegative(),
    openChallengesToClose: z.number().int().nonnegative(),
    replacement: z.object({ available: z.boolean(), itemIds: ids }),
  }).passthrough(),
  previewDigest: digest,
});
export type DefectPreview = z.infer<typeof defectPreviewSchema>;

export interface ReleaseSafetyPort {
  rollbackImpact(courseId: string, releaseId: string, signal?: AbortSignal): Promise<RollbackImpact>;
  diff(courseId: string, releaseId: string, against: string, signal?: AbortSignal): Promise<ReleaseDiff>;
  defectiveItems(courseId: string, releaseId: string, signal?: AbortSignal): Promise<z.infer<typeof defectiveItemsSchema>>;
  previewDefect(courseId: string, releaseId: string, assessmentId: string): Promise<DefectPreview>;
  markDefective(
    courseId: string,
    releaseId: string,
    input: { assessmentId: string; reason: string; previewDigest: string; acknowledgeNoReplacement: boolean },
    context: MutationContext,
  ): Promise<MutationResult>;
}
