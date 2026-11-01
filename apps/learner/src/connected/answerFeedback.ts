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
/** What a check's feedback says first (the verdict line). */
export type AnswerVerdict = "correct" | "revisit" | "codePassed" | "codeFailed" | "submitted" | "abstained";
/** A server receipt read for the check's feedback: the verdict, then what explains it. */
export interface AnswerResult {
  verdict: AnswerVerdict;
  passed: boolean;
  /** The answer counted toward the lesson (false: it was practice). */
  independent: boolean;
  /** The author's explanation (Markdown), or Core's coded message worded in the reader's language. */
  explanation: string;
  /** The explanation is Core's coded message, not the author's text. */
  coded: boolean;
}

/** Read only a structurally valid server receipt; never infer a grade from source/output. */
export function answerResult(receipt: unknown, code = false, t: Translate = englishTranslator().t): AnswerResult {
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
    abstained?: unknown;
    pendingReview?: unknown;
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
  const verdict: AnswerVerdict =
    value.abstained === true ? "abstained"
    : value.pendingReview === true ? "submitted"
    : code ? (value.passed ? "codePassed" : "codeFailed")
    : value.passed ? "correct" : "revisit";
  return { verdict, passed: value.passed, independent: value.independent, explanation: coded ?? (value.explanation as string), coded: coded !== undefined };
}

/** A receipt in one sentence run (the host's notice for a recovered submission): the verdict, the
 * explanation and, on practice, that it counted as practice. The check itself shows `answerResult`. */
export function answerFeedback(receipt: unknown, code = false, t: Translate = englishTranslator().t): string {
  const result = answerResult(receipt, code, t);
  const practice = !result.independent && result.verdict !== "abstained";
  return [t(`answerFeedback.verdict.${result.verdict}`), result.explanation, practice ? t("answerFeedback.practice") : ""]
    .filter(Boolean)
    .join(" ");
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
