import type { Question } from "../client/apiClient";
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
): string | undefined {
  if (language !== "python")
    return "This exercise uses an unsupported language. The current grader accepts Python only; ask your course team to update the exercise.";
  if (!source.trim()) return "Enter your Python solution before submitting.";
  if (utf8Bytes(source) > MAX_CODE_BYTES)
    return "Your solution exceeds 64,000 UTF-8 bytes. Shorten it before submitting; your draft has been kept.";
  return;
}
export const CODE_PROTOCOL =
  "Implement solve(input) as described in the exercise prompt. The runner passes a decoded JSON value; return a JSON-compatible Python value. The runner handles serialization. Do not print results or read stdin. Use the Python standard library only, with no network access or third-party packages.";
