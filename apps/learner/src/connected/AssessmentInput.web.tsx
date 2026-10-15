import React from "react";
import { View } from "react-native";
import type { Question } from "../client/apiClient";
import { ChoiceList, Field } from "../components/ui";
import { CodeEditor } from "../components/CodeEditor";

const WRITTEN = new Set(["rubric", "counterexample", "experiment_design", "teach_back"]);
export const isWritten = (question: Question) => WRITTEN.has(question.type);
export const isCode = (question: Question) => question.type === "code" || question.type === "code_repair";
const writtenLabel: Record<string, string> = {
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

/** The value sent to the server for a draft, or a learner-facing reason it cannot be sent yet. */
export function answerPayload(question: Question, answer: string): { value: unknown } | { error: string } {
  if (question.type === "numeric" || question.type === "prediction") {
    const value = Number(answer.trim());
    return answer.trim() && Number.isFinite(value) ? { value } : { error: "Enter a finite number." };
  }
  if (question.type === "trace") {
    const values = traceAnswers(answer);
    const missing = question.steps.filter((step) => !values[step.id]?.trim());
    return missing.length ? { error: `Fill in every step (${missing.length} left).` } : { value: Object.fromEntries(question.steps.map((s) => [s.id, values[s.id]!])) };
  }
  return answer.trim() ? { value: answer } : { error: "Write an answer first." };
}

/** Learner input for each item type: choice, number, prediction, trace, code, code repair and the
 * written, reviewer-judged tasks (teach-back, counterexample, experiment design, rubric). */
export function AssessmentInput({ question, answer, pending, onChange }: { question: Question; answer: string; pending: boolean; onChange: (answer: string) => void }) {
  if (question.type === "choice")
    return <ChoiceList label="Your answer" options={question.options.map((o) => ({ id: o.id, label: o.text }))} value={answer} onChange={onChange} disabled={pending} />;
  if (question.type === "numeric" || question.type === "prediction")
    return (
      <View style={{ gap: 8 }}>
        {question.type === "prediction" && (
          <p className="connected-input-hint">Commit to a number before you see the result. A wrong prediction is useful too.</p>
        )}
        <Field
          label={`${question.type === "prediction" ? "Your prediction" : "Your numeric answer"}${question.unit ? ` (${question.unit})` : ""}`}
          value={answer}
          onChangeText={onChange}
          editable={!pending}
          autoCapitalize="none"
          inputMode="decimal"
        />
      </View>
    );
  if (question.type === "trace") {
    const values = traceAnswers(answer);
    return (
      <ol className="connected-trace" aria-label="Trace steps">
        {question.steps.map((step) => (
          <li key={step.id}>
            <Field
              label={step.prompt}
              value={values[step.id] ?? ""}
              onChangeText={(text) => onChange(JSON.stringify({ ...values, [step.id]: text }))}
              editable={!pending}
              autoCapitalize="none"
              maxLength={2000}
            />
          </li>
        ))}
      </ol>
    );
  }
  if (question.type === "code" || question.type === "code_repair")
    return <CodeEditor language={question.language} value={answer} onChange={onChange} disabled={pending} />;
  if (!("criteria" in question)) return null;
  return (
    <View style={{ gap: 12 }}>
      <div className="connected-rubric">
        <p className="connected-eyebrow">A REVIEWER WILL LOOK FOR</p>
        <ul>
          {question.criteria.map((c) => (
            <li key={c.id}>
              {c.description}
              {!c.required && <span className="connected-muted"> (optional)</span>}
            </li>
          ))}
        </ul>
        <p className="connected-input-hint">Use your own words. A reviewer quotes what you wrote; a pasted reply from the companion is not accepted.</p>
      </div>
      <Field label={writtenLabel[question.type] ?? "Your answer"} value={answer} onChangeText={onChange} multiline numberOfLines={6} maxLength={8000} editable={!pending} />
    </View>
  );
}

/** Optional self-rated confidence on the item's declared scale. It never changes the result. */
export function ConfidenceInput({ question, value, pending, onChange }: { question: Question; value: number | null; pending: boolean; onChange: (value: number | null) => void }) {
  if (!question.confidence) return null;
  const max = question.confidence.scale.maximum;
  const name = `confidence-${question.id}`;
  return (
    <fieldset className="connected-confidence">
      <legend>How sure are you? (optional)</legend>
      <p className="connected-input-hint" id={`${name}-hint`}>1 means guessing and {max} means certain. Your confidence never changes your result.</p>
      <div className="connected-confidence-scale" role="radiogroup" aria-label="Confidence" aria-describedby={`${name}-hint`}>
        {Array.from({ length: max }, (_, i) => i + 1).map((level) => (
          <label key={level} className={value === level ? "selected" : undefined}>
            <input type="radio" name={name} value={level} checked={value === level} disabled={pending} onChange={() => onChange(level)} />
            <span>{level}</span>
          </label>
        ))}
      </div>
      {value !== null && (
        <button type="button" className="connected-link-button" disabled={pending} onClick={() => onChange(null)}>
          Clear confidence
        </button>
      )}
    </fieldset>
  );
}
