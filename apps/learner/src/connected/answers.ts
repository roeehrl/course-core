import type { Question } from "../client/apiClient";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/** Answer drafts and the payloads sent for them, shared by the web and native answer inputs. */

const WRITTEN = new Set(["rubric", "counterexample", "experiment_design", "teach_back"]);
export const isWritten = (question: Question) => WRITTEN.has(question.type);
export const isCode = (question: Question) => question.type === "code" || question.type === "code_repair";
/** The answer field's label for a question type; written types have their own wording. */
export function writtenLabel(type: string, t: Translate = englishTranslator().t): string {
  return WRITTEN.has(type) ? t(`answers.written.${type}` as MessageKey) : t("answers.yourAnswer");
}

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
export function numericPayload(answer: string, unit: string | undefined, t: Translate = englishTranslator().t): { value: number | { value: number; unit: string } } | { error: string; wrongUnit?: true } {
  const match = NUMBER_WITH_UNIT.exec(answer);
  const value = match ? Number(match[1]!.replace("\u2212", "-")) : NaN;
  if (!match || !Number.isFinite(value)) return { error: t("answers.error.notNumber") };
  const stated = (match[2] ?? "").replace(/\s+/g, " ");
  if (!stated) return { value };
  if (stated !== unit?.trim().replace(/\s+/g, " "))
    return { error: unit ? t("answers.error.wrongUnit", { unit, stated }) : t("answers.error.noUnit"), wrongUnit: true };
  return { value: { value, unit: stated } };
}

/** The value sent to the server for a draft, or a learner-facing reason it cannot be sent yet. */
export function answerPayload(question: Question, answer: string, t: Translate = englishTranslator().t): { value: unknown } | { error: string } {
  if (question.type === "numeric" || question.type === "prediction") return numericPayload(answer, question.unit, t);
  if (question.type === "trace") {
    const values = traceAnswers(answer);
    const missing = question.steps.filter((step) => !values[step.id]?.trim());
    return missing.length ? { error: t("answers.error.stepsLeft", { count: missing.length }) } : { value: Object.fromEntries(question.steps.map((s) => [s.id, values[s.id]!])) };
  }
  return answer.trim() ? { value: answer } : { error: t("answers.error.empty") };
}
