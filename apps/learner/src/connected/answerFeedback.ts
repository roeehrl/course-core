import { CourseApiError } from "../client/apiClient";
import { englishTranslator, type Translate } from "../i18n";
/** Format only a structurally valid server receipt; never infer a grade from source/output. */
export function answerFeedback(receipt: unknown, code = false, t: Translate = englishTranslator().t): string {
  const result =
    receipt && typeof receipt === "object"
      ? (receipt as { result?: unknown }).result
      : undefined;
  if (!result || typeof result !== "object")
    throw new CourseApiError("INVALID_RESPONSE", 502);
  const value = result as {
    passed?: unknown;
    explanation?: unknown;
    independent?: unknown;
    execution?: unknown;
  };
  if (
    typeof value.passed !== "boolean" ||
    typeof value.explanation !== "string" ||
    typeof value.independent !== "boolean"
  )
    throw new CourseApiError("INVALID_RESPONSE", 502);
  if (value.execution !== undefined) {
    if (
      !value.execution ||
      typeof value.execution !== "object" ||
      typeof (value.execution as { status?: unknown }).status !== "string"
    )
      throw new CourseApiError("INVALID_RESPONSE", 502);
    code = true;
    if (
      value.passed &&
      (value.execution as { status: string }).status !== "graded"
    )
      throw new CourseApiError("INVALID_RESPONSE", 502);
  }
  const explanation = value.explanation;
  if ((value as { abstained?: unknown }).abstained === true)
    return t("answerFeedback.abstained", { explanation });
  if ((value as { pendingReview?: unknown }).pendingReview === true)
    return value.independent
      ? t("answerFeedback.pendingReview", { explanation })
      : t("answerFeedback.pendingReviewPractice", { explanation });
  const verdict = code ? (value.passed ? "codePassed" : "codeFailed") : value.passed ? "correct" : "revisit";
  return value.independent
    ? t(`answerFeedback.verdict.${verdict}`, { explanation })
    : t(`answerFeedback.verdictPractice.${verdict}`, { explanation });
}
