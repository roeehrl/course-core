import { z } from "zod";

export const pendingReviewsSchema = z.object({
  pending: z
    .array(
      z.object({
        attemptId: z.string().uuid(),
        enrollmentId: z.string().uuid(),
        learner: z.string().max(200),
        episodeId: z.string().max(200),
        assessmentId: z.string().max(200),
        prompt: z.string().max(12000),
        rubric: z.array(z.object({ id: z.string(), description: z.string(), required: z.boolean() })).max(12),
        response: z.string().max(8000),
        submittedAt: z.string(),
        independentEligible: z.boolean(),
        ownSubmission: z.boolean(),
      }),
    )
    .max(200),
});
export type PendingReview = z.infer<typeof pendingReviewsSchema>["pending"][number];
export interface ReviewInput {
  decision: "met" | "not_met" | "needs_clarification";
  criteria: { criterionId: string; met: boolean; quote?: string; note?: string }[];
  learnerNote?: string;
}
export interface ReviewsPort {
  pending(catalogId: string, signal?: AbortSignal): Promise<z.infer<typeof pendingReviewsSchema>>;
  review(attemptId: string, input: ReviewInput, idempotencyKey: string): Promise<unknown>;
}
export class ReviewActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReviewActionError";
  }
}
const messages: Record<string, string> = {
  FORBIDDEN: "Only owners, admins, instructors and reviewers can review written answers.",
  SELF_REVIEW_FORBIDDEN: "You cannot review your own answer. Ask another reviewer.",
  RUBRIC_QUOTE_REQUIRED: "Every criterion marked as met needs an exact quotation (10+ characters) from the learner's answer.",
  RUBRIC_CRITERIA_INCOMPLETE: "Record a finding for every criterion.",
  RUBRIC_DECISION_INCONSISTENT: "The decision must match the findings: met only when every required criterion is met.",
  CLARIFICATION_NOTE_REQUIRED: "Write a note telling the learner what to clarify.",
  ALREADY_REVIEWED: "This answer was already reviewed. Refresh the queue.",
  RUBRIC_CHANGED: "The rubric changed after this answer was submitted; it cannot be reviewed under the new rubric.",
};
export const reviewErrorMessage = (error: unknown) =>
  messages[error instanceof ReviewActionError ? error.code : ""] ?? "The review could not be saved. Nothing changed.";
