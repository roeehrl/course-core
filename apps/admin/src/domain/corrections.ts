import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

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
const ERROR_CODES = new Set([
  "FORBIDDEN",
  "SELF_REVIEW_FORBIDDEN",
  "SECOND_REVIEWER_REQUIRED",
  "APPEAL_OPEN",
  "NOT_YET_REVIEWED",
  "NOTHING_TO_REGRADE",
  "EVIDENCE_INVALIDATED",
  "REGRADE_UNSUPPORTED",
  "RUBRIC_CHANGED",
  "RUBRIC_FINDINGS_REQUIRED",
  "RUBRIC_CRITERIA_INCOMPLETE",
  "RUBRIC_QUOTE_REQUIRED",
  "RUBRIC_DECISION_INCONSISTENT",
  "EVALUATOR_NOT_CONFIGURED",
  "COURSE_VERSION_UNAVAILABLE",
  "ENROLLMENT_CLOSED",
  "ENROLLMENT_ERASED",
  "INVALID_INPUT",
  "IDEMPOTENCY_CONFLICT",
]);
export function regradeErrorMessage(
  error: unknown,
  t: Translate = englishTranslator().t,
) {
  const code = error instanceof RegradeError ? error.code : "";
  return ERROR_CODES.has(code)
    ? t(`corrections.error.${code}` as MessageKey)
    : t("corrections.error.unavailable");
}
