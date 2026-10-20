import { z } from "zod";

/** Scoped regrade of one attempt (U07): a new decision linked to the decision it supersedes. */
const text = (max = 400) => z.string().max(max);
const decisionRef = z.object({
  kind: z.enum(["attempt", "review", "appeal", "regrade"]),
  id: z.string().uuid(),
});
export const regradeViewSchema = z.object({
  attemptId: z.string().uuid(),
  assessmentId: text(200),
  kind: z.enum(["automated", "rubric"]),
  current: decisionRef
    .extend({
      passed: z.boolean(),
      decision: z.enum(["met", "not_met"]).nullable(),
    })
    .nullable(),
  history: z
    .array(
      z.object({
        regradeId: z.string().uuid(),
        kind: z.enum(["automated", "rubric"]),
        outcome: z.enum(["changed", "upheld"]),
        passed: z.boolean(),
        previousPassed: z.boolean(),
        supersedes: decisionRef,
        evaluatorRef: text(200),
        reason: text(2000),
        actor: text(200),
        at: z.string(),
      }),
    )
    .max(200),
  rubric: z
    .object({
      prompt: text(8000),
      criteria: z
        .array(
          z.object({
            id: text(128),
            description: text(2000),
            required: z.boolean(),
          }),
        )
        .max(12),
      answers: z.array(text(64000)).max(21),
    })
    .optional(),
});
export type RegradeView = z.infer<typeof regradeViewSchema>;
export const regradeResultSchema = z.object({
  regradeId: z.string().uuid(),
  attemptId: z.string().uuid(),
  kind: z.enum(["automated", "rubric"]),
  outcome: z.enum(["changed", "upheld"]),
  passed: z.boolean(),
  previousPassed: z.boolean(),
  supersedes: decisionRef,
  eventId: z.string().uuid(),
  evidence: z.object({
    invalidated: z.number().int(),
    created: z.number().int(),
  }),
  replayed: z.boolean(),
});
export type RegradeResult = z.infer<typeof regradeResultSchema>;
export interface RegradeFinding {
  criterionId: string;
  met: boolean;
  quote?: string;
  note?: string;
}
export interface RegradeInput {
  idempotencyKey: string;
  reason: string;
  decision?: "met" | "not_met";
  criteria?: RegradeFinding[];
}
export interface RegradePort {
  view(
    enrollmentId: string,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<RegradeView>;
  submit(
    enrollmentId: string,
    attemptId: string,
    input: RegradeInput,
  ): Promise<RegradeResult>;
}
export class RegradeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RegradeError";
  }
}
const messages: Record<string, string> = {
  FORBIDDEN:
    "Your role cannot regrade. Regrading needs the evidence.regrade permission (owners, admins and instructors).",
  SELF_REVIEW_FORBIDDEN: "You cannot regrade your own answer.",
  SECOND_REVIEWER_REQUIRED:
    "You made the decision this would replace. A different person must regrade it.",
  APPEAL_OPEN:
    "The learner asked for a second opinion. Decide it in the appeal queue first.",
  NOT_YET_REVIEWED:
    "This written answer has no review yet. Review it in the review queue.",
  NOTHING_TO_REGRADE: "There is no graded result to regrade on this attempt.",
  EVIDENCE_INVALIDATED:
    "Staff already withdrew this attempt's evidence. A regrade does not restore it.",
  REGRADE_UNSUPPORTED: "Placement and retention answers are not regraded here.",
  RUBRIC_CHANGED: "The rubric changed since this answer was given.",
  RUBRIC_FINDINGS_REQUIRED: "Give one finding for every criterion.",
  RUBRIC_CRITERIA_INCOMPLETE: "Give one finding for every criterion.",
  RUBRIC_QUOTE_REQUIRED:
    "Each criterion you mark as shown needs an exact quotation from the answer.",
  RUBRIC_DECISION_INCONSISTENT:
    "The decision does not match the required criteria.",
  EVALUATOR_NOT_CONFIGURED: "This host cannot run the item's evaluator now.",
  COURSE_VERSION_UNAVAILABLE:
    "The course version this answer was given on is no longer stored.",
  ENROLLMENT_CLOSED:
    "This enrollment is closed. Its record is not changed after closure.",
  ENROLLMENT_ERASED: "This learner's data was erased.",
  INVALID_INPUT: "Give a reason of at least 10 characters.",
  IDEMPOTENCY_CONFLICT:
    "A different request was already sent with this key. Reload and try again.",
};
export const regradeErrorMessage = (error: unknown) =>
  messages[error instanceof RegradeError ? error.code : ""] ??
  "The regrade could not be completed. Nothing was changed.";
