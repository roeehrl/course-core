import { z } from "zod";

/** One learner's open dispute of a piece of their evidence. The learner's explanation is never
 * part of it: staff see that a result is disputed, not why (learner-privacy.ts, evidence-dispute-reason). */
export const evidenceDisputeQueueSchema = z.object({
  disputes: z
    .array(
      z.strictObject({
        disputeId: z.string().uuid(),
        state: z.literal("open"),
        enrollmentId: z.string().uuid(),
        learner: z.string().max(200),
        objectiveId: z.string().max(200),
        evidence: z.strictObject({
          evidenceId: z.string().uuid(),
          attemptId: z.string().uuid(),
          assessmentId: z.string().max(200),
          passed: z.boolean(),
          independent: z.boolean(),
          mode: z.string().max(50),
          releaseVersion: z.string().max(100),
        }),
        raisedAt: z.string(),
        ageDays: z.number().int().min(0),
        /** False for the learner's own dispute: nobody resolves their own. */
        canResolve: z.boolean(),
        /** True only when Core can acknowledge the result as valid without grading it again. */
        canUphold: z.boolean(),
      }),
    )
    .max(200),
  truncated: z.boolean(),
});
export type EvidenceDispute = z.infer<
  typeof evidenceDisputeQueueSchema
>["disputes"][number];

export const evidenceDisputeReceiptSchema = z.object({
  disputeId: z.string().uuid(),
  state: z.literal("resolved"),
  decision: z.enum(["accept", "reject"]),
  invalidated: z.boolean(),
  replayed: z.boolean(),
});
export type EvidenceDisputeReceipt = z.infer<
  typeof evidenceDisputeReceiptSchema
>;

export interface EvidenceDisputeResolution {
  /** accept: uphold the result as valid (it does not change). reject: invalidate the evidence. */
  decision: "accept" | "reject";
  /** Recorded with the review. Invalidating also records it as the reason. */
  note: string;
}
/** Staff queue of learners' open evidence disputes for one course. The server checks
 * evidence.review on the course for every read and decision; the flags only shape the controls. */
export interface EvidenceDisputesPort {
  queue(
    catalogId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof evidenceDisputeQueueSchema>>;
  resolve(
    catalogId: string,
    disputeId: string,
    input: EvidenceDisputeResolution,
    idempotencyKey: string,
  ): Promise<EvidenceDisputeReceipt>;
}
export const EVIDENCE_DISPUTE_NOTE_MAX = 600;

export class EvidenceDisputeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EvidenceDisputeError";
  }
}
const messages: Record<string, string> = {
  FORBIDDEN: "Your role cannot review evidence for this course.",
  INVALID_INPUT: "Write a note for the review.",
  SELF_REVIEW_FORBIDDEN:
    "This is your own dispute. Another staff member must resolve it.",
  EVIDENCE_DISPUTE_CLOSED:
    "This dispute was already resolved or withdrawn. Refresh the queue.",
  EVIDENCE_DISPUTE_NOT_FOUND:
    "This dispute no longer exists. Refresh the queue.",
  EVIDENCE_NOT_FOUND: "This evidence is no longer valid. Refresh the queue.",
  REVIEW_CANNOT_GRANT_MASTERY:
    "This result cannot be upheld as valid. Invalidate it, or leave the dispute open.",
  IDEMPOTENCY_CONFLICT:
    "A different decision was already sent. Refresh the queue.",
  ENROLLMENT_ERASED: "The learner's data was erased.",
};
export const evidenceDisputeErrorMessage = (error: unknown) =>
  messages[error instanceof EvidenceDisputeError ? error.code : ""] ??
  "The decision could not be saved. Nothing changed.";
