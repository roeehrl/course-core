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
        /** Earlier turns when this answer replies to a clarification request. */
        thread: z
          .array(z.object({ attemptId: z.string().uuid(), response: z.string().max(8000), submittedAt: z.string(), reviewerNote: z.string().max(2000).nullable(), probeOnly: z.boolean() }))
          .max(20)
          .optional(),
        /** Optional AI draft for the reviewer; absent on servers without the feature. */
        assist: z
          .object({
            learnerConsented: z.boolean(),
            state: z.enum(["not_consented", "available", "requested", "suggested", "failed"]),
            /** "supervisor": proposed when the learner submitted a gate conversation; "staff": a reviewer asked. */
            origin: z.enum(["staff", "supervisor"]).nullable().optional(),
            /** What a gate's deterministic evaluator concluded; a declined check leaves the answer to a person. */
            automaticCheck: z.object({ state: z.string().max(64), evaluatorId: z.string().max(200).optional() }).nullable().optional(),
            draft: z
              .object({
                suggestionId: z.string().uuid(),
                summary: z.string().max(1000),
                criteria: z.array(z.object({ criterionId: z.string(), met: z.boolean(), quote: z.string().max(800), note: z.string().max(500) })).max(12),
                notAGrade: z.literal(true),
              })
              .nullable(),
          })
          .optional(),
      }),
    )
    .max(200),
});
export type PendingReview = z.infer<typeof pendingReviewsSchema>["pending"][number];
const finding = z.object({ criterionId: z.string(), met: z.boolean(), quote: z.string().optional(), note: z.string().optional() });
export const appealsSchema = z.object({
  appeals: z
    .array(
      z.object({
        appealId: z.string().uuid(),
        attemptId: z.string().uuid(),
        enrollmentId: z.string().uuid(),
        learner: z.string().max(200),
        reason: z.string().max(2000),
        createdAt: z.string(),
        prompt: z.string().max(12000),
        rubric: z.array(z.object({ id: z.string(), description: z.string(), required: z.boolean() })).max(12),
        response: z.string().max(8000),
        thread: z.array(z.object({ attemptId: z.string().uuid(), response: z.string().max(8000) }).passthrough()).max(20),
        original: z.object({ decision: z.enum(["met", "not_met"]), findings: z.array(finding).max(12) }),
        canDecide: z.boolean(),
      }),
    )
    .max(200),
});
export type Appeal = z.infer<typeof appealsSchema>["appeals"][number];
export interface AppealDecision {
  decision: "met" | "not_met";
  criteria: { criterionId: string; met: boolean; quote?: string; note?: string }[];
  note: string;
}
export interface ReviewInput {
  decision: "met" | "not_met" | "needs_clarification";
  criteria: { criterionId: string; met: boolean; quote?: string; note?: string }[];
  learnerNote?: string;
  /** The AI draft open while reviewing, recorded for agreement metrics only. */
  suggestionId?: string;
  /** Clarification only: the note is a neutral question with no hint. */
  probeOnly?: boolean;
}
export interface ReviewsPort {
  pending(catalogId: string, signal?: AbortSignal): Promise<z.infer<typeof pendingReviewsSchema>>;
  review(attemptId: string, input: ReviewInput, idempotencyKey: string): Promise<unknown>;
  /** Queue an AI draft for the reviewer; needs the learner's opt-in and a configured reviewer model. */
  requestDraft?(attemptId: string, idempotencyKey: string): Promise<unknown>;
  /** Learner requests for a second opinion, decided by a different reviewer. */
  appeals?(catalogId: string, signal?: AbortSignal): Promise<z.infer<typeof appealsSchema>>;
  decideAppeal?(appealId: string, input: AppealDecision, idempotencyKey: string): Promise<unknown>;
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
  RUBRIC_ASSIST_CONSENT_REQUIRED: "The learner has not allowed AI drafts for their written answers.",
  RUBRIC_ASSIST_UNAVAILABLE: "No reviewer-drafts model is configured for this workspace.",
  SECOND_REVIEWER_REQUIRED: "A different reviewer must give the second opinion.",
  APPEAL_ALREADY_DECIDED: "This appeal was already decided. Refresh the queue.",
  PROBE_ONLY_FOR_CLARIFICATION: "Only a clarification request can be marked as a neutral question.",
  RUBRIC_SUGGESTION_MISMATCH: "That draft belongs to a different answer. Refresh the queue.",
};
export const reviewErrorMessage = (error: unknown) =>
  messages[error instanceof ReviewActionError ? error.code : ""] ?? "The review could not be saved. Nothing changed.";
