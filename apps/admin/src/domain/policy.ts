import { z } from "zod";
// Presentation projection of policy v0.1.0. No client model grants learning credit.
const id = z.string().min(1).max(256);
const count = z.number().int().nonnegative();
const instant = z.string().datetime({ offset: true });
export const deadlineSchema = z.object({
  scopeId: id,
  kind: z.enum(["absolute", "window", "ultimate"]),
  at: instant,
});
export const quotaSchema = z.object({
  scopeId: id,
  metric: z.enum([
    "additionalMinutes",
    "additionalEpisodes",
    "remediationCyclesPerConcept",
  ]),
  conceptId: id.nullable(),
  limit: count,
  consumed: count,
  reserved: count,
  remaining: count,
});
export const poolBalanceSchema = z.object({
  poolId: id,
  remaining: count,
  grantsRemaining: count,
});
export const workSchema = z.object({
  additionalMinutes: count,
  additionalEpisodes: count,
  remediation: z.array(z.object({ conceptId: id, cycles: count })),
});
const disambiguation = z.enum(["reject", "earlier", "later", "compatible"]);
export const scopeSchema = z.object({
  scopeId: id,
  /** Null for the organization and enrollment levels: the app names them by level. */
  label: z.string().nullable(),
  parentScopeId: id.nullable(),
  policyId: id,
  kind: z.enum([
    "organization",
    "course",
    "enrollment",
    "chapter",
    "episode",
    "activity",
  ]),
  mode: z.enum(["bounded", "open_ended"]),
  targetDate: instant.optional(),
  hardDeadline: z
    .object({ at: instant, timeZone: id, disambiguation })
    .optional(),
  window: z
    .object({
      anchorId: id,
      anchor: z.enum(["enrollment_started", "scope_assigned", "scope_started"]),
      anchorInstant: instant,
      calendarDays: count,
      timeZone: id,
      disambiguation,
      pauseRule: z.enum(["never", "approved_only"]),
      resolvedDeadline: instant,
    })
    .optional(),
  ultimateDeadline: instant.optional(),
  work: z.object({
    additionalMinutes: count.optional(),
    additionalEpisodes: count.optional(),
    remediationCyclesPerConcept: count.optional(),
  }),
  extensions: z
    .object({
      enabled: z.boolean(),
      learnerAcceptanceRequired: z.literal(true),
      poolIds: z.array(id),
      requiredAuthorityIds: z.array(id),
      offerCooldownHours: count,
      maxOutstandingOffersPerScope: count,
      maxOffersPerScope: count,
    })
    .optional(),
  existingMaterialAccess: z.enum(["read_only", "closed"]),
  submissionGraceUntil: instant.optional(),
});
export const constraintSchema = z.object({
  enrollmentId: id,
  scopeId: id,
  policyRevision: count,
  ledgerRevision: count,
  ancestorScopeIds: z.array(id),
  effectiveDeadline: instant.nullable(),
  deadlines: z.array(deadlineSchema),
  bindingDeadlines: z.array(deadlineSchema),
  quotas: z.array(quotaSchema),
  existingMaterialAccess: z.enum(["read_only", "closed"]),
  /** Which level binds: the scope of the effective deadline, and per work counter the scope
   * with the least room left. Older servers omit it. */
  binding: z
    .object({
      deadline: z
        .object({
          scopeId: id,
          level: z.string(),
          kind: z.enum(["absolute", "window", "ultimate"]),
          at: instant,
        })
        .nullable(),
      quotas: z.array(
        z.object({
          metric: quotaSchema.shape.metric,
          conceptId: id.nullable(),
          scopeId: id,
          level: z.string(),
          limit: count,
          remaining: count,
        }),
      ),
    })
    .optional(),
});
const disclosureShape = {
  currentEffectiveDeadline: instant.nullable(),
  proposedEffectiveDeadline: instant.nullable(),
  currentWorkQuotas: z.array(quotaSchema),
  proposedWorkQuotas: z.array(quotaSchema),
  poolDebits: z.array(z.object({ poolId: id, amount: count })),
  balanceBefore: z.array(poolBalanceSchema),
  balanceAfter: z.array(poolBalanceSchema),
  bindingAncestorCaps: z.array(deadlineSchema),
  requiredApprovals: z.array(id),
};
const changeSchema = z.object({
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
export const acceptanceSchema = z.object({
  receiptId: id,
  learnerId: id,
  enrollmentId: id,
  offerId: id,
  termsDigest: id,
  explicit: z.literal(true),
  acceptedAt: instant,
});
export const offerSchema = z.object({
  terms: z.object({
    ...disclosureShape,
    offerId: id,
    scopeId: id,
    enrollmentId: id,
    expectedPolicyRevision: count,
    rationaleEvidenceRefs: z.array(id),
    proposedActivities: z.array(id),
    change: changeSchema,
    addedWork: workSchema,
    planImpact: z.string(),
    alternatives: z.array(z.string()),
    createdAt: instant,
    expiresAt: instant,
  }),
  termsDigest: id,
  lastTransitionAt: instant,
  state: z.enum([
    "proposed",
    "accepted_pending_admin",
    "granted",
    "declined",
    "expired",
    "rejected",
    "superseded",
  ]),
  acceptance: acceptanceSchema.optional(),
});
/** Optional ledger fields of the admin policy view (older servers omit them). */
const policyLedgerFields = {
  pendingApprovals: z.array(id).optional(),
  refunds: z
    .array(
      z
        .object({
          refundId: id,
          grantId: id,
          poolId: id,
          amount: count,
          refundedAt: instant,
        })
        .passthrough(),
    )
    .optional(),
  exceptionalGrants: z
    .array(
      z
        .object({
          exceptionId: id,
          grantedAt: instant,
          adjustment: z.object({ scopeId: id }).passthrough(),
          revocation: z.object({ revokedAt: instant }).passthrough().optional(),
        })
        .passthrough(),
    )
    .optional(),
  afterClosure: z.object({ questionBudget: count }).optional(),
  coverage: z
    .object({
      denominator: count,
      coveredCoreObjectives: count,
      personalExtras: z.object({
        committed: z.object({
          count,
          additionalMinutes: count,
          additionalEpisodes: count,
        }),
        reserved: z.object({
          count,
          additionalMinutes: count,
          additionalEpisodes: count,
        }),
      }),
      headroom: z.array(
        z.object({
          reservationId: id,
          purpose: z.string(),
          scopeId: id,
          state: z.string(),
          remaining: z
            .object({ additionalMinutes: count, additionalEpisodes: count })
            .passthrough(),
        }),
      ),
    })
    .optional(),
};
export const learningPolicySchema = z.object({
  enrollmentId: id,
  learnerId: id,
  revision: count,
  policyRevision: count,
  ledgerRevision: count,
  status: z.enum(["active", "paused", "closed"]),
  scopes: z.array(scopeSchema),
  pools: z.array(
    z.object({
      poolId: id,
      scopeIds: z.array(id),
      unit: z.enum([
        "calendar_day",
        "scope_calendar_day",
        "planned_minute",
        "episode",
      ]),
      total: count,
      maxGrants: count,
      maxPerGrant: count,
    }),
  ),
  constraints: z.array(constraintSchema),
  balances: z.array(poolBalanceSchema),
  offers: z.array(offerSchema),
  grants: z.array(
    z.object({
      grantId: id,
      offerId: id,
      acceptedTermsDigest: id,
      learnerAcceptanceReceipt: acceptanceSchema,
      atomicLedgerTransactionId: id,
      newPolicyRevision: count,
      grantedAt: instant,
      poolDebits: z.array(z.object({ poolId: id, amount: count })),
      revocation: z
        .object({ revokedAt: instant, reasonRef: id })
        .passthrough()
        .optional(),
    }),
  ),
  accommodations: z
    .array(
      z
        .object({
          accommodationId: id,
          kind: z.enum(["accommodation", "approved_pause", "outage"]),
          scopeId: id,
          newPolicyRevision: count,
        })
        .passthrough(),
    )
    .optional(),
  ...policyLedgerFields,
  // These are scoped choices joined by the host from course/activity and event APIs.
  rationaleEvents: z.array(z.object({ id, label: z.string() })),
  activities: z.array(z.object({ id, scopeId: id, label: z.string() })),
});
/** Days move a deadline; planned minutes and episodes raise a work cap. At least one is set. */
export const extensionRequestSchema = z
  .object({
    scopeId: id,
    days: z.number().int().min(1).max(366).optional(),
    minutes: z.number().int().min(1).max(100_000).optional(),
    episodes: z.number().int().min(1).max(1_000).optional(),
    poolIds: z.array(id).min(1).max(10).optional(),
  })
  .refine((r) => r.days || r.minutes || r.episodes);
export const previewSchema = z.object({
  ...disclosureShape,
  enrollmentId: id,
  scopeId: id,
  days: count.nullable().optional(),
  minutes: count.nullable().optional(),
  episodes: count.nullable().optional(),
  revision: count,
  policyRevision: count,
  ledgerRevision: count,
  adjustment: z.object({
    scopeId: id,
    absoluteDeadline: instant.optional(),
    windowDeadline: instant.optional(),
    additionalMinutes: count,
    additionalEpisodes: count,
  }),
});
export const proposalInputSchema = z.object({
  scopeId: id,
  days: z.number().int().min(1).max(366).optional(),
  minutes: z.number().int().min(1).max(100_000).optional(),
  episodes: z.number().int().min(1).max(1_000).optional(),
  rationaleEventIds: z.array(id).min(1).max(20),
  episodeIds: z.array(id).min(1).max(20),
  planImpact: z.string().trim().min(1).max(2000),
  alternatives: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
});
export const proposalResultSchema = z.object({
  policy: learningPolicySchema,
  receipt: z.object({
    id,
    authority: z.enum(["demo", "server"]),
    outcome: z.literal("proposed"),
  }),
  message: z.string(),
});
export type LearningPolicy = z.infer<typeof learningPolicySchema>;
export type ScopePolicy = z.infer<typeof scopeSchema>;
export type Quota = z.infer<typeof quotaSchema>;
export type ExtensionRequest = z.infer<typeof extensionRequestSchema>;
export type ExtensionPreview = z.infer<typeof previewSchema>;
export type ExtensionProposal = z.infer<typeof proposalInputSchema>;
export type ExtensionProposalResult = z.infer<typeof proposalResultSchema>;
export interface EnrollmentMutationContext {
  expectedRevision: number;
  idempotencyKey: string;
}

export const policyMigrationPreviewSchema = z.object({
  enrollmentId: id,
  revision: count,
  policyRevision: count,
  ledgerRevision: count,
  previewId: id,
  previewDigest: id,
  expiresAt: instant,
  scopes: z.array(z.unknown()),
  impacts: z.array(
    z.object({
      scopeId: id,
      before: constraintSchema,
      after: constraintSchema,
    }),
  ),
  affectedReservationIds: z.array(id),
  supersededOfferIds: z.array(id),
});
export const policyMigrationResultSchema = z.object({
  policy: learningPolicySchema,
  receipt: z.object({
    id,
    authority: z.enum(["demo", "server"]),
    outcome: z.literal("migrated"),
  }),
  message: z.string(),
});
export type PolicyMigrationPreview = z.infer<
  typeof policyMigrationPreviewSchema
>;
export type PolicyMigrationResult = z.infer<typeof policyMigrationResultSchema>;

export type AdjustmentKind = "accommodation" | "approved_pause" | "outage";
export interface AccommodationRequest {
  scopeId: string;
  kind: AdjustmentKind;
  change: {
    deadline?: { kind: "absolute" | "window"; calendarDays: number };
    work?: { additionalMinutes?: number; additionalEpisodes?: number };
  };
}
export const accommodationPreviewSchema = z.object({
  previewId: id,
  previewDigest: id,
  revision: count,
  expiresAt: instant,
  scopeId: id,
  kind: z.enum(["accommodation", "approved_pause", "outage"]),
  adjustment: z.object({
    scopeId: id,
    absoluteDeadline: instant.optional(),
    windowDeadline: instant.optional(),
    additionalMinutes: count,
    additionalEpisodes: count,
  }),
});
export const accommodationResultSchema = z.object({
  policy: learningPolicySchema,
  receipt: z.object({
    id,
    authority: z.enum(["demo", "server"]),
    outcome: z.literal("accommodated"),
  }),
  message: z.string(),
});
export type AccommodationPreview = z.infer<typeof accommodationPreviewSchema>;
export type AccommodationResult = z.infer<typeof accommodationResultSchema>;
