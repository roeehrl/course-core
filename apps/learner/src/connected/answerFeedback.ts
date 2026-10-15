import { CourseApiError } from "../client/apiClient";
/** Format only a structurally valid server receipt; never infer a grade from source/output. */
export function answerFeedback(receipt: unknown, code = false): string {
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
  if ((value as { abstained?: unknown }).abstained === true)
    return `Noted. Nothing was recorded against you, and it does not count as evidence. ${value.explanation}`;
  if ((value as { pendingReview?: unknown }).pendingReview === true)
    return `Submitted for review. ${value.explanation}${value.independent ? "" : " Because help or prior exposure was involved, it will count as practice."}`;
  const verdict = code
    ? value.passed
      ? "Code check passed."
      : "Code check did not pass."
    : value.passed
      ? "Correct."
      : "Let’s revisit this.";
  return `${verdict} ${value.explanation}${value.independent ? "" : " This counts as practice because help or prior exposure was involved."}`;
}
