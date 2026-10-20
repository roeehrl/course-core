import { z } from "zod";

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
const messages: Record<string, string> = {
  FORBIDDEN:
    "Your role cannot make this decision. Reviewers may uphold; owners, admins and instructors may also grant exceptions.",
  INVALID_INPUT: `Write a note of at least ${GATE_REVIEW_NOTE_MIN} characters for the learner.`,
  SELF_REVIEW_FORBIDDEN:
    "This is your own request. Another staff member must decide it.",
  INDEPENDENT_REVIEWER_REQUIRED:
    "This gate needs a reviewer who did not judge this learner's evidence.",
  GATE_REVIEW_ALREADY_DECIDED:
    "This request was already decided. Refresh the queue.",
  GATE_REVIEW_NOT_FOUND: "This request no longer exists. Refresh the queue.",
  GATE_CHANGED:
    "The course changed this gate. The request cannot be decided under the new version.",
  GATE_ALREADY_READY:
    "The learner now meets the gate; no exception is needed. Uphold the request instead.",
  GATE_CAP_REACHED:
    "The course limit or deadline has been reached. An exception cannot lift it.",
  ENROLLMENT_ERASED: "The learner's data was erased.",
};
export const gateReviewErrorMessage = (error: unknown) =>
  messages[error instanceof GateReviewError ? error.code : ""] ??
  "The decision could not be saved. Nothing changed.";
