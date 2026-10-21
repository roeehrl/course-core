import type { Question } from "../client/apiClient";
import { englishTranslator, type Translate } from "../i18n";
/** Matches the server broker's validateSubmission bound; this does not execute code. */
export const MAX_CODE_BYTES = 64_000;
export type CodeQuestion = Extract<Question, { type: "code" }>;
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}
export function codeSubmissionError(
  language: string,
  source: string,
  t: Translate = englishTranslator().t,
): string | undefined {
  if (language !== "python")
    return t("code.error.unsupportedLanguage");
  if (!source.trim()) return t("code.error.empty");
  if (utf8Bytes(source) > MAX_CODE_BYTES)
    return t("code.error.tooLarge");
  return;
}
/** How the runner calls a solution, in the translator's locale. */
export const codeProtocol = (t: Translate = englishTranslator().t) => t("code.protocol");

/**
 * Challenge modes whose code items may offer a browser practice run (an allow-list; an unknown
 * mode gets none). Lesson checks, practice or independent, keep it: running your own code is
 * what a learner does in any editor, and only the server evaluator grades. Checks that measure
 * what the learner already knows or still remembers without help do not:
 * - placement: places the learner past material they already know;
 * - retention: the held-out delayed check of what was retained.
 */
export const BROWSER_RUN_MODES: ReadonlySet<string> = new Set(["practice", "independent"]);
export const browserRunsAllowed = (mode: string) => BROWSER_RUN_MODES.has(mode);
