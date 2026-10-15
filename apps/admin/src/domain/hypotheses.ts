import { z } from "zod";

/** Staff read view of one learner's teaching hypotheses. Hypotheses guide
 * teaching only; they are never grades or evidence and staff cannot edit them. */
const text = z.string().max(2000);
export const hypothesisViewSchema = z.object({
  enrollmentId: z.string(),
  items: z
    .array(
      z.object({
        hypothesisId: z.string(),
        revision: z.number().int(),
        templateId: z.string().nullable(),
        kind: z.enum(["misconception", "missing_prerequisite", "slip", "ambiguous_item", "useful_analogy"]),
        /** Null when the learner wrote it: their own words stay private to them. */
        statement: text.nullable(),
        /** Staff never receive the learner's corrected wording, only that it exists. */
        learnerCorrection: z.null(),
        correctedByLearner: z.boolean(),
        statementWithheld: z.boolean(),
        status: z.enum(["proposed", "probing", "confirmed", "rejected", "resolved", "expired"]),
        uncertainty: z.enum(["low", "medium", "high"]),
        source: z.enum(["supervisor", "companion", "assessment", "learner"]),
        pinned: z.boolean(),
        rejectedBy: z.enum(["learner", "evidence", "supervisor"]).nullable(),
        objectiveIds: z.array(z.string()),
        observations: z.number().int().nonnegative(),
        updatedAt: z.string(),
        grantsMastery: z.literal(false),
      }),
    )
    .max(30),
  probes: z
    .array(
      z.object({
        probeRunId: z.string(),
        probeId: z.string(),
        requestedBy: z.enum(["supervisor", "learner", "trigger"]),
        state: z.enum(["scheduled", "answered", "abstained", "expired", "cancelled"]),
        scheduledAt: z.string(),
        countsAsEvidence: z.literal(false),
      }),
    )
    .max(20),
  signals: z
    .array(
      z.object({
        signalKind: z.string(),
        ruleIds: z.array(z.string()),
        recommendations: z.array(z.object({ action: z.string(), objectiveIds: z.array(z.string()) })),
        restraints: z.array(z.string()),
        createdAt: z.string(),
      }),
    )
    .max(10),
});
export type HypothesisView = z.infer<typeof hypothesisViewSchema>;
export interface HypothesisReadPort {
  load(enrollmentId: string, signal?: AbortSignal): Promise<HypothesisView>;
}
export class HypothesisReadError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HypothesisReadError";
  }
}
