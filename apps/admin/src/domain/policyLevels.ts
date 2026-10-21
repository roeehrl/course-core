import { z } from "zod";

// Projections of organization ceilings, cross-learner allowances and batch adjustments.
// Previews are review aids; the server re-validates every command against current state.
const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });
const change = z.object({
  deadline: z
    .object({ kind: z.enum(["absolute", "window"]), calendarDays: count })
    .optional(),
  work: z
    .object({
      additionalMinutes: count.optional(),
      additionalEpisodes: count.optional(),
    })
    .optional(),
});
export type AdjustmentChange = z.infer<typeof change>;

/** The organization's outer limits. Every level below may only tighten them. */
export const ceilingsSchema = z.object({
  timeZone: z.string().min(1).max(64),
  hardDeadline: instant.nullable(),
  maxEnrollmentDays: count.nullable(),
  work: z.object({
    additionalMinutes: count.nullable(),
    additionalEpisodes: count.nullable(),
    remediationCyclesPerConcept: count.nullable(),
  }),
  extensionsAllowed: z.boolean(),
  existingMaterialAccess: z.enum(["read_only", "closed"]),
});
export type OrganizationCeilings = z.infer<typeof ceilingsSchema>;
export const ceilingsViewSchema = z.object({
  workspaceId: id,
  source: z.enum(["default", "configured"]),
  revision: count,
  changedAt: instant.nullable(),
  ceilings: ceilingsSchema,
  defaults: ceilingsSchema,
  preview: z.object({ ceilings: ceilingsSchema }).nullable(),
  impact: z.array(
    z.object({
      courseId: id,
      title: z.string(),
      feasible: z.boolean(),
      issues: z.array(
        z.object({
          severity: z.enum(["error", "warning"]),
          code: z.string(),
          scopeId: id,
          deadline: instant.nullable(),
        }),
      ),
    }),
  ),
  moreCourses: z.boolean(),
  appliesTo: z.literal("new_enrollments"),
  outcome: z.literal("saved").optional(),
});
export type CeilingsView = z.infer<typeof ceilingsViewSchema>;

const offerState = z.enum([
  "proposed",
  "accepted_pending_admin",
  "granted",
  "declined",
  "expired",
  "rejected",
  "superseded",
]);
export const allowancesSchema = z.object({
  courseId: id,
  view: z.enum(["pending", "all"]),
  offers: z.array(
    z.object({
      enrollmentId: id,
      displayName: z.string().nullable(),
      enrollmentRevision: count,
      enrollmentStatus: z.string(),
      offerId: id,
      scopeId: id,
      state: offerState,
      change,
      poolDebits: z.array(z.object({ poolId: id, amount: count })),
      requiredApprovals: z.array(id),
      createdAt: instant,
      expiresAt: instant,
      lastTransitionAt: instant,
      acceptedAt: instant.nullable(),
    }),
  ),
  accommodations: z.array(
    z.object({
      enrollmentId: id,
      displayName: z.string().nullable(),
      accommodationId: id,
      kind: z.enum(["accommodation", "approved_pause", "outage"]),
      scopeId: id,
      adjustment: z
        .object({
          absoluteDeadline: instant.optional(),
          windowDeadline: instant.optional(),
          additionalMinutes: count.optional(),
          additionalEpisodes: count.optional(),
        })
        .passthrough(),
      batchId: id.nullable(),
      authorizedAt: instant,
    }),
  ),
  pools: z.array(
    z.object({
      poolId: id,
      unit: z.string(),
      learners: count,
      total: count,
      used: count,
      grants: count,
    }),
  ),
});
export type Allowances = z.infer<typeof allowancesSchema>;
export type AllowanceOffer = Allowances["offers"][number];

export interface BatchRequest {
  scopeId: string;
  kind: "accommodation" | "outage";
  change: AdjustmentChange;
  enrollmentIds?: string[];
}
export const batchPreviewSchema = z.object({
  batchId: id,
  previewDigest: id,
  expiresAt: instant,
  courseId: id,
  kind: z.enum(["accommodation", "outage"]),
  scopeId: id,
  change,
  enrollments: z.array(
    z.object({
      enrollmentId: id,
      displayName: z.string().nullable(),
      effectiveDeadlineBefore: instant.nullable(),
      effectiveDeadlineAfter: instant.nullable(),
      bindingAfter: z
        .object({ scopeId: id, level: z.string() })
        .passthrough()
        .nullable(),
    }),
  ),
  refused: z.array(
    z.object({
      enrollmentId: id,
      displayName: z.string().nullable(),
      code: z.string(),
    }),
  ),
});
export type BatchPreview = z.infer<typeof batchPreviewSchema>;
export const batchResultSchema = z.object({
  batchId: id,
  applied: count,
  replayed: z.boolean(),
  outcome: z.literal("applied"),
});
export type BatchResult = z.infer<typeof batchResultSchema>;
export const batchesSchema = z.object({
  courseId: id,
  batches: z.array(
    z.object({
      batchId: id,
      kind: z.enum(["accommodation", "outage"]),
      scopeId: id,
      change,
      reason: z.string().nullable(),
      applied: count,
      appliedAt: instant,
      appliedBy: z.string(),
    }),
  ),
});
export type Batches = z.infer<typeof batchesSchema>;
