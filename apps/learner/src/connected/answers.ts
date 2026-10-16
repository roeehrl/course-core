import type { Question } from "../client/apiClient";

/** Answer drafts and the payloads sent for them, shared by the web and native answer inputs. */

const WRITTEN = new Set(["rubric", "counterexample", "experiment_design", "teach_back"]);
export const isWritten = (question: Question) => WRITTEN.has(question.type);
export const isCode = (question: Question) => question.type === "code" || question.type === "code_repair";
export const writtenLabel: Record<string, string> = {
  rubric: "Your explanation",
  teach_back: "Your explanation, as you would teach it",
  counterexample: "Your counterexample and why it works",
  experiment_design: "Your experiment design",
};

/** Trace drafts are stored as a JSON object of step answers. */
export function traceAnswers(answer: string): Record<string, string> {
  try {
    const value = JSON.parse(answer) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    /* an empty or partial draft */
  }
  return {};
}

const NUMBER_WITH_UNIT = /^\s*([+\-\u2212]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?)\s*([^\d.,+\-\u2212\s].*?)?\s*$/s;
/** A number, optionally followed by the item's declared unit ("12.5 cm"). A stated unit is sent
 * as `{ value, unit }` so the server checks it; another unit is pointed out here, never graded. */
export function numericPayload(answer: string, unit: string | undefined): { value: number | { value: number; unit: string } } | { error: string; wrongUnit?: true } {
  const match = NUMBER_WITH_UNIT.exec(answer);
  const value = match ? Number(match[1]!.replace("\u2212", "-")) : NaN;
  if (!match || !Number.isFinite(value)) return { error: "Enter a finite number." };
  const stated = (match[2] ?? "").replace(/\s+/g, " ");
  if (!stated) return { value };
  if (stated !== unit?.trim().replace(/\s+/g, " "))
    return { error: unit ? `Give your answer in ${unit}, not ${stated}.` : "Enter just the number; this question has no unit.", wrongUnit: true };
  return { value: { value, unit: stated } };
}

/** The value sent to the server for a draft, or a learner-facing reason it cannot be sent yet. */
export function answerPayload(question: Question, answer: string): { value: unknown } | { error: string } {
  if (question.type === "numeric" || question.type === "prediction") return numericPayload(answer, question.unit);
  if (question.type === "trace") {
    const values = traceAnswers(answer);
    const missing = question.steps.filter((step) => !values[step.id]?.trim());
    return missing.length ? { error: `Fill in every step (${missing.length} left).` } : { value: Object.fromEntries(question.steps.map((s) => [s.id, values[s.id]!])) };
  }
  return answer.trim() ? { value: answer } : { error: "Write an answer first." };
}
