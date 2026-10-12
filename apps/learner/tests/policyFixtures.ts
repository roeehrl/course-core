import type { LearningPolicy } from "@course-core/sdk";
import type {
  EnrollmentPolicy,
  ExtensionOffer,
} from "../src/client/policyClient";
export const authorPolicy: LearningPolicy = {
  mode: "bounded",
  window: {
    calendarDays: 90,
    timeZone: "Asia/Jerusalem",
    anchor: "enrollment_started",
    pauseRule: "approved_only",
  },
  hardDeadline: "2030-07-01T00:00:00Z",
  work: {
    additionalMinutes: 30,
    additionalEpisodes: 2,
    remediationCyclesPerConcept: 1,
  },
  extensions: {
    enabled: true,
    calendarDays: 7,
    maxGrants: 2,
    maxDaysPerGrant: 4,
    learnerAcceptanceRequired: true,
  },
  existingMaterialAccess: "read_only",
};
export function policyFixture(id = "enrollment-1"): EnrollmentPolicy {
  const balance = {
    poolId: "course:calendar",
    remaining: 7,
    grantsRemaining: 2,
  };
  const base = {
    enrollmentId: id,
    deadlines: [
      {
        scopeId: "course",
        kind: "window" as const,
        at: "2030-03-01T10:00:00Z",
      },
    ],
    quotas: [],
    existingMaterialAccess: "read_only" as const,
  };
  const offer: ExtensionOffer = {
    termsDigest: "a".repeat(64),
    state: "proposed",
    terms: {
      offerId: "11111111-1111-4111-8111-111111111111",
      scopeId: "course",
      enrollmentId: id,
      expectedPolicyRevision: 1,
      currentEffectiveDeadline: "2030-03-01T10:00:00Z",
      proposedEffectiveDeadline: "2030-03-04T10:00:00Z",
      balanceBefore: [balance],
      balanceAfter: [{ ...balance, remaining: 4, grantsRemaining: 1 }],
      currentWorkQuotas: [],
      proposedWorkQuotas: [],
      addedWork: {
        additionalMinutes: 15,
        additionalEpisodes: 1,
        remediation: [],
      },
      planImpact: "Three extra days to finish your current learning plan.",
      alternatives: ["Keep your current deadline."],
      proposedActivities: ["intro"],
      bindingAncestorCaps: [],
      createdAt: "2026-01-01T00:00:00Z",
      expiresAt: "2030-02-01T00:00:00Z",
      requiredApprovals: [],
    },
  };
  return {
    revision: 1,
    policyRevision: 1,
    ledgerRevision: 1,
    constraints: [
      { ...base, scopeId: "course", effectiveDeadline: "2030-03-01T10:00:00Z" },
      {
        ...base,
        scopeId: "chapter:begin",
        effectiveDeadline: "2030-02-01T10:00:00Z",
      },
    ],
    balances: [balance],
    offers: [offer],
    grants: [],
  };
}
