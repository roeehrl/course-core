import { z } from "zod";
import { learningPolicySchema, poolBalanceSchema } from "./policy";

// Projections of the server's policy settings, ledger previews and cohort migration.
// Previews are review aids; the server re-validates every command against current state.
const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });
const disambiguation = z.enum(["reject", "earlier", "later", "compatible"]);
const work = z.object({ additionalMinutes: count, additionalEpisodes: count });

/** An allowance an administrator adds on top of what the course release declares. */
export const extensionPoolConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  unit: z.enum(["calendar_day", "planned_minute", "episode"]),
  appliesTo: z.enum(["course", "every_chapter", "every_episode"]),
  sharing: z.enum(["shared", "per_scope"]),
  total: z.number().int().min(1),
  maxPerGrant: z.number().int().min(1),
  maxGrants: z.number().int().min(1),
});
export type ExtensionPoolConfig = z.infer<typeof extensionPoolConfigSchema>;
export const assessmentPolicySchema = z.object({
  /** Graded attempts a learner gets at one check; null is no limit. */
  maxGradedAttemptsPerCheck: z.number().int().min(1).max(100).nullable(),
  /** Minutes to wait after a graded attempt that did not pass. */
  retryCooldownMinutes: z.number().int().min(0).max(10_080),
});
export type AssessmentPolicy = z.infer<typeof assessmentPolicySchema>;
export const policySettingsSchema = z.object({
  timeZone: z.string().min(1).max(64),
  disambiguation,
  hardDeadlineDisambiguation: disambiguation,
  extensions: z.object({
    approval: z.enum(["learner", "learner_and_admin"]),
    offerCooldownHours: count,
    maxOutstandingOffersPerScope: count,
    maxOffersPerScope: count.nullable(),
    /** No extension, accommodation or exception can move the course past this. */
    ultimateDeadline: instant.nullable().default(null),
  }),
  extensionPools: z.array(extensionPoolConfigSchema).default([]),
  headroom: z.object({ core: work, finalAssessment: work }),
  closedQuestionBudget: count,
  pacing: z.object({
    minutesPerRequiredEpisode: count.nullable(),
    finalAssessmentMinutes: count.nullable(),
    studyMinutesPerDay: count.nullable(),
  }),
  /** Graded attempts per check and the wait after an unsuccessful one. Older servers omit it;
   * the default is today's behaviour (no limit, no wait). */
  assessment: assessmentPolicySchema.default({
    maxGradedAttemptsPerCheck: null,
    retryCooldownMinutes: 0,
  }),
});
export type PolicySettings = z.infer<typeof policySettingsSchema>;

export const feasibilityIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  scopeId: id,
  message: z.string(),
  workIds: z.array(z.string()).optional(),
  deadline: instant.optional(),
  neededMinutes: count.optional(),
  availableMinutes: count.optional(),
});
export const feasibilitySchema = z.object({
  feasible: z.boolean(),
  issues: z.array(feasibilityIssueSchema),
  alternatives: z.array(z.string()),
  masteryCriteria: z.literal("unchanged"),
});
export const calendarRowSchema = z.object({
  scopeId: id,
  rule: z.enum(["window", "absolute"]),
  timeZone: z.string(),
  disambiguation,
  calendarDays: count,
  rejectsSomeStarts: z.boolean(),
  rejectedExtensionDays: z.array(count),
  transitions: z.array(
    z.object({
      transitionAt: instant,
      kind: z.enum(["gap", "overlap"]),
      offsetBefore: z.string(),
      offsetAfter: z.string(),
      localDate: z.string(),
      localStart: z.string(),
      localEnd: z.string(),
      affectedAnchorDate: z.string().nullable(),
      example: z
        .object({ anchorAt: instant, resolved: instant.nullable() })
        .nullable(),
      resolution: z.enum(["rejected", "earlier", "later"]),
    }),
  ),
});
export const policySettingsViewSchema = z.object({
  courseId: id,
  source: z.enum(["default", "configured"]),
  revision: count,
  changedAt: instant.nullable(),
  settings: policySettingsSchema,
  defaults: policySettingsSchema,
  releaseId: id.nullable(),
  appliesTo: z.literal("new_enrollments"),
  preview: z
    .object({
      settings: policySettingsSchema,
      feasibility: feasibilitySchema,
      calendar: z.array(calendarRowSchema),
      /** What each allowance pool can do for a learner enrolling now. Older servers omit it. */
      pools: z
        .array(
          z.object({
            poolId: id,
            unit: z.string(),
            total: count,
            maxPerGrant: count,
            maxGrants: count,
            scopeIds: z.array(id),
            unusableScopeIds: z.array(id),
            source: z.enum(["admin", "course"]),
          }),
        )
        .optional(),
    })
    .nullable(),
  message: z.string().optional(),
});
export type PolicySettingsView = z.infer<typeof policySettingsViewSchema>;

export type LedgerAction =
  | { kind: "revocation"; grantId: string }
  | { kind: "refund"; grantId: string; poolId: string; amount: number }
  | {
      kind: "exception";
      scopeId: string;
      days: number;
      deadlineKind: "absolute" | "window";
    };
const previewBase = {
  previewId: id,
  previewDigest: id,
  revision: count,
  expiresAt: instant,
};
export const ledgerPreviewSchema = z.union([
  z.object({
    ...previewBase,
    previewKind: z.literal("revocation"),
    grantId: id,
    kind: z.enum(["extension", "exceptional"]),
    scopeId: id,
    shortensDeadline: z.boolean(),
    impacts: z.array(
      z.object({
        scopeId: id,
        effectiveDeadlineBefore: instant.nullable(),
        effectiveDeadlineAfter: instant.nullable(),
        shortened: z.boolean(),
      }),
    ),
  }),
  z.object({
    ...previewBase,
    previewKind: z.literal("refund"),
    grantId: id,
    poolId: id,
    amount: count,
    balanceBefore: poolBalanceSchema,
    balanceAfter: poolBalanceSchema,
  }),
  z.object({
    ...previewBase,
    previewKind: z.literal("exception"),
    exceptionId: id,
    scopeId: id,
    effectiveDeadlineBefore: instant.nullable(),
    effectiveDeadlineAfter: instant.nullable(),
    poolDebits: z.array(z.unknown()).length(0),
  }),
]);
export type LedgerPreview = z.infer<typeof ledgerPreviewSchema>;
export const ledgerResultSchema = z.object({
  policy: learningPolicySchema,
  receipt: z.object({
    id,
    authority: z.enum(["demo", "server"]),
    outcome: z.string(),
  }),
  message: z.string(),
});
export type LedgerResult = z.infer<typeof ledgerResultSchema>;

export interface CohortChange {
  scopeId: string;
  hardDeadline?: string;
  targetDate?: string;
}
export const cohortPreviewSchema = z.object({
  migrationId: id,
  previewDigest: id,
  expiresAt: instant,
  shortenedGrantIds: z.array(id),
  enrollments: z.array(
    z.object({
      enrollmentId: id,
      displayName: z.string(),
      shortenedGrants: z.array(
        z.object({
          entryId: id,
          kind: z.string(),
          scopeId: id,
          effectiveDeadlineBefore: instant,
          effectiveDeadlineAfter: instant,
        }),
      ),
      impacts: z.array(
        z.object({
          scopeId: id,
          effectiveDeadlineBefore: instant.nullable(),
          effectiveDeadlineAfter: instant.nullable(),
        }),
      ),
    }),
  ),
  refused: z.array(z.object({ enrollmentId: id, code: z.string() })),
});
export type CohortPreview = z.infer<typeof cohortPreviewSchema>;
export const cohortResultSchema = z.object({
  migrationId: id,
  applied: count,
  replayed: z.boolean(),
  message: z.string().optional(),
});
export type CohortResult = z.infer<typeof cohortResultSchema>;
