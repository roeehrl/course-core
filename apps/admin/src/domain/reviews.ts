import { z } from "zod";
import type { MessageKey, Translate } from "../i18n";

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
        rubric: z
          .array(
            z.object({
              id: z.string(),
              description: z.string(),
              required: z.boolean(),
            }),
          )
          .max(12),
        response: z.string().max(8000),
        submittedAt: z.string(),
        independentEligible: z.boolean(),
        ownSubmission: z.boolean(),
        /** Earlier turns when this answer replies to a clarification request. */
        thread: z
          .array(
            z.object({
              attemptId: z.string().uuid(),
              response: z.string().max(8000),
              submittedAt: z.string(),
              reviewerNote: z.string().max(2000).nullable(),
              probeOnly: z.boolean(),
            }),
          )
          .max(20)
          .optional(),
        /** Optional AI draft for the reviewer; absent on servers without the feature. */
        assist: z
          .object({
            learnerConsented: z.boolean(),
            state: z.enum([
              "not_consented",
              "available",
              "requested",
              "suggested",
              "failed",
              "rejected",
            ]),
            /** Why Core's checks refused the model's draft; set only when state is "rejected". */
            rejectionReason: z.string().max(64).nullable().optional(),
            /** "supervisor": proposed when the learner submitted a gate conversation; "staff": a reviewer asked. */
            origin: z.enum(["staff", "supervisor"]).nullable().optional(),
            /** What a gate's deterministic evaluator concluded; a declined check leaves the answer to a person. */
            automaticCheck: z
              .object({
                state: z.string().max(64),
                evaluatorId: z.string().max(200).optional(),
              })
              .nullable()
              .optional(),
            draft: z
              .object({
                suggestionId: z.string().uuid(),
                summary: z.string().max(1000),
                criteria: z
                  .array(
                    z.object({
                      criterionId: z.string(),
                      met: z.boolean(),
                      quote: z.string().max(800),
                      note: z.string().max(500),
                    }),
                  )
                  .max(12),
                notAGrade: z.literal(true),
              })
              .nullable(),
          })
          .optional(),
      }),
    )
    .max(200),
});
export type PendingReview = z.infer<
  typeof pendingReviewsSchema
>["pending"][number];
const finding = z.object({
  criterionId: z.string(),
  met: z.boolean(),
  quote: z.string().optional(),
  note: z.string().optional(),
});
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
        rubric: z
          .array(
            z.object({
              id: z.string(),
              description: z.string(),
              required: z.boolean(),
            }),
          )
          .max(12),
        response: z.string().max(8000),
        thread: z
          .array(
            z
              .object({
                attemptId: z.string().uuid(),
                response: z.string().max(8000),
              })
              .passthrough(),
          )
          .max(20),
        original: z.object({
          decision: z.enum(["met", "not_met"]),
          findings: z.array(finding).max(12),
        }),
        canDecide: z.boolean(),
      }),
    )
    .max(200),
});
export type Appeal = z.infer<typeof appealsSchema>["appeals"][number];
export interface AppealDecision {
  decision: "met" | "not_met";
  criteria: {
    criterionId: string;
    met: boolean;
    quote?: string;
    note?: string;
  }[];
  note: string;
}
export interface ReviewInput {
  decision: "met" | "not_met" | "needs_clarification";
  criteria: {
    criterionId: string;
    met: boolean;
    quote?: string;
    note?: string;
  }[];
  learnerNote?: string;
  /** The AI draft open while reviewing, recorded for agreement metrics only. */
  suggestionId?: string;
  /** Clarification only: the note is a neutral question with no hint. */
  probeOnly?: boolean;
}
export interface ReviewsPort {
  pending(
    catalogId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof pendingReviewsSchema>>;
  review(
    attemptId: string,
    input: ReviewInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  /** Queue an AI draft for the reviewer; needs the learner's opt-in and a configured reviewer model. */
  requestDraft?(attemptId: string, idempotencyKey: string): Promise<unknown>;
  /** Learner requests for a second opinion, decided by a different reviewer. */
  appeals?(
    catalogId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof appealsSchema>>;
  decideAppeal?(
    appealId: string,
    input: AppealDecision,
    idempotencyKey: string,
  ): Promise<unknown>;
}
export class ReviewActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReviewActionError";
  }
}
const codes = new Set([
  "FORBIDDEN",
  "SELF_REVIEW_FORBIDDEN",
  "RUBRIC_QUOTE_REQUIRED",
  "RUBRIC_CRITERIA_INCOMPLETE",
  "RUBRIC_DECISION_INCONSISTENT",
  "CLARIFICATION_NOTE_REQUIRED",
  "ALREADY_REVIEWED",
  "RUBRIC_CHANGED",
  "RUBRIC_ASSIST_CONSENT_REQUIRED",
  "RUBRIC_ASSIST_UNAVAILABLE",
  "SECOND_REVIEWER_REQUIRED",
  "APPEAL_ALREADY_DECIDED",
  "PROBE_ONLY_FOR_CLARIFICATION",
  "RUBRIC_SUGGESTION_MISMATCH",
]);
/** The message for a refusal in the caller's locale; an unknown code gets the generic message. */
export const reviewErrorMessage = (error: unknown, t: Translate) =>
  error instanceof ReviewActionError && codes.has(error.code)
    ? t(`reviews.error.${error.code}` as MessageKey)
    : t("reviews.error.fallback");
