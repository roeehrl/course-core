import { z } from "zod";
import type { MessageKey, Translate } from "../i18n";

/** A gate decision as Core computed it. The queue shows it read-only: a review never edits it. */
const decisionSchema = z
  .object({
    decisionId: z.string().uuid(),
    gateId: z.string().max(200),
    gateVersion: z.string().max(100),
    status: z.enum([
      "ready",
      "needs_evidence",
      "needs_help",
      "under_review",
      "closed_with_gaps",
    ]),
    criterionResults: z
      .array(
        z
          .object({
            criterionId: z.string().max(200),
            met: z.union([z.boolean(), z.literal("pending")]),
            reason: z.string().max(2000).optional(),
          })
          .passthrough(),
      )
      .max(50),
    missingObjectiveIds: z.array(z.string().max(200)).max(100),
    learnerVisibleReason: z.string().max(4000),
    decidedAt: z.string(),
  })
  .passthrough();

export const gateReviewQueueSchema = z.object({
  reviews: z
    .array(
      z.object({
        requestId: z.string().uuid(),
        enrollmentId: z.string().uuid(),
        gateId: z.string().max(200),
        decisionId: z.string().uuid(),
        learner: z.string().max(200),
        reason: z.string().max(2000),
        state: z.literal("open"),
        requestedAt: z.string(),
        decision: decisionSchema,
        /** False when the reviewer is the learner (nobody decides their own request). */
        canUphold: z.boolean(),
        /** True only for staff who may change enrollments, never for the learner themself. */
        canGrantException: z.boolean(),
      }),
    )
    .max(200),
});
export type GateReview = z.infer<
  typeof gateReviewQueueSchema
>["reviews"][number];

export const gateReviewReceiptSchema = z.object({
  requestId: z.string().uuid(),
  state: z.enum(["upheld", "exception_granted"]),
  replayed: z.boolean(),
});
export type GateReviewReceipt = z.infer<typeof gateReviewReceiptSchema>;

export interface GateReviewResolution {
  outcome: "upheld" | "exception";
  /** Read by the learner. At least 10 characters. */
  note: string;
}
/** Staff queue of learner requests to look at a gate decision again. Server authorization decides
 * who may uphold and who may grant an exception; the flags only shape the controls. */
export interface GateReviewsPort {
  queue(
    catalogId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof gateReviewQueueSchema>>;
  resolve(
    requestId: string,
    input: GateReviewResolution,
    idempotencyKey: string,
  ): Promise<GateReviewReceipt>;
}
export const GATE_REVIEW_NOTE_MIN = 10;

export class GateReviewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GateReviewError";
  }
}
const codes = new Set([
  "FORBIDDEN",
  "INVALID_INPUT",
  "SELF_REVIEW_FORBIDDEN",
  "INDEPENDENT_REVIEWER_REQUIRED",
  "GATE_REVIEW_ALREADY_DECIDED",
  "GATE_REVIEW_NOT_FOUND",
  "GATE_CHANGED",
  "GATE_ALREADY_READY",
  "GATE_CAP_REACHED",
  "ENROLLMENT_ERASED",
]);
/** The message for a refusal in the caller's locale; an unknown code gets the generic message. */
export const gateReviewErrorMessage = (error: unknown, t: Translate) =>
  error instanceof GateReviewError && codes.has(error.code)
    ? t(`gateReviews.error.${error.code}` as MessageKey, {
        min: GATE_REVIEW_NOTE_MIN,
      })
    : t("gateReviews.error.fallback");
