import { CourseApiError } from "../client/apiClient";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";
/** Core's own answer feedback codes (services/api/src/answer-messages.ts); the server never sends its sentence. */
export const ANSWER_MESSAGE_CODES = ["abstained", "pending_review", "code_all_matched", "code_some_matched", "code_limit"] as const;
const CODE_LIMITS = ["time", "output", "execution"];
/** Core's coded message in the reader's language, or undefined when it is malformed. */
function coreMessage(message: unknown, t: Translate): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { code, params = {} } = message as { code?: unknown; params?: unknown };
  if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,59}$/.test(code) || !params || typeof params !== "object") return undefined;
  // A code from a newer server is named inside a translated sentence, never guessed at in English.
  if (!(ANSWER_MESSAGE_CODES as readonly string[]).includes(code)) return t("answerFeedback.message.unknown", { code });
  const values = params as Record<string, unknown>;
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  if (code === "code_all_matched" && !count(values.total)) return undefined;
  if (code === "code_some_matched" && !(count(values.passed) && count(values.total))) return undefined;
  if (code === "code_limit" && !CODE_LIMITS.includes(String(values.limit))) return undefined;
  return t(`answerFeedback.message.${code as string}` as MessageKey, values as Record<string, string | number>);
}
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
    message?: unknown;
    independent?: unknown;
    execution?: unknown;
  };
  // Core's own feedback arrives as a code; an author's or extension's explanation as its text.
  const coded = value.message === undefined ? undefined : coreMessage(value.message, t);
  if (
    typeof value.passed !== "boolean" ||
    (value.message !== undefined && coded === undefined) ||
    (coded === undefined && typeof value.explanation !== "string") ||
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
  const explanation = coded ?? (value.explanation as string);
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

/** The notice tone for a receipt `answerFeedback` words: an answer that did not pass (wrong, or
 * stopped by a time or output limit) is a warning, never the calm confirmation a passed answer, an
 * "I don't know yet" or an answer sent for review gets. */
export function answerFeedbackTone(receipt: unknown): "info" | "warning" {
  const result = receipt && typeof receipt === "object" ? (receipt as { result?: unknown }).result : undefined;
  if (!result || typeof result !== "object") return "info";
  const value = result as { passed?: unknown; abstained?: unknown; pendingReview?: unknown };
  return value.passed === false && value.abstained !== true && value.pendingReview !== true ? "warning" : "info";
}
