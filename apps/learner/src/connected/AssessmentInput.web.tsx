import React from "react";
import { View } from "react-native";
import type { Question } from "../client/apiClient";
import { ChoiceList, Field } from "../components/ui";
import { CodeEditor } from "../components/CodeEditor";
import { numericPayload, traceAnswers, writtenLabel } from "./answers";
import { useT } from "../i18n";
import { courseContentAttributes } from "../domain/contentLanguage";

export { answerPayload, isCode, isWritten, numericPayload, traceAnswers } from "./answers";

/** Learner input for each item type: choice, number, prediction, trace, code, code repair and the
 * written, reviewer-judged tasks (teach-back, counterexample, experiment design, rubric). */
export function AssessmentInput({ question, answer, pending, onChange, practiceRuns = false }: {
  question: Question; answer: string; pending: boolean; onChange: (answer: string) => void;
  /** Offer browser practice runs on code items. Off unless the caller allows it (see browserRunsAllowed). */
  practiceRuns?: boolean;
}) {
  const t = useT();
  if (question.type === "choice")
    return <ChoiceList label={t("assessmentInput.yourAnswer")} options={question.options.map((o) => ({ id: o.id, label: o.text }))} value={answer} onChange={onChange} disabled={pending} />;
  if (question.type === "numeric" || question.type === "prediction") {
    // A stated unit that differs from the item's is pointed out before sending; it is never graded wrong.
    const parsed = numericPayload(answer, question.unit, t);
    const unitProblem = "wrongUnit" in parsed ? parsed.error : "";
    return (
      <View style={{ gap: 8 }}>
        {question.type === "prediction" && (
          <p className="connected-input-hint">{t("assessmentInput.predictionHint")}</p>
        )}
        <Field
          label={
            question.unit
              ? t(question.type === "prediction" ? "assessmentInput.predictionWithUnit" : "assessmentInput.numericWithUnit", { unit: question.unit })
              : t(question.type === "prediction" ? "assessmentInput.prediction" : "assessmentInput.numeric")
          }
          value={answer}
          onChangeText={onChange}
          editable={!pending}
          dir="ltr"
          autoCapitalize="none"
          inputMode="decimal"
        />
        {question.unit && <p className="connected-input-hint">{t("assessmentInput.unitHint", { unit: question.unit })}</p>}
        <p className="connected-input-hint connected-unit-problem" role="status" aria-live="polite">{unitProblem}</p>
      </View>
    );
  }
  if (question.type === "trace") {
    const values = traceAnswers(answer);
    return (
      <ol className="connected-trace" aria-label={t("assessmentInput.traceSteps")}>
        {question.steps.map((step) => (
          <li key={step.id}>
            <Field
              label={step.prompt}
              value={values[step.id] ?? ""}
              onChangeText={(text) => onChange(JSON.stringify({ ...values, [step.id]: text }))}
              editable={!pending}
              dir="ltr"
              autoCapitalize="none"
              maxLength={2000}
            />
          </li>
        ))}
      </ol>
    );
  }
  if (question.type === "code" || question.type === "code_repair")
    return <CodeEditor language={question.language} value={answer} onChange={onChange} disabled={pending} practice={practiceRuns} />;
  if (!("criteria" in question)) return null;
  return (
    <View style={{ gap: 12 }}>
      <div className="connected-rubric">
        <p className="connected-eyebrow">{t("assessmentInput.rubric.eyebrow")}</p>
        <ul>
          {question.criteria.map((c) => (
            <li key={c.id}>
              <span {...courseContentAttributes()}>{c.description}</span>
              {!c.required && <span className="connected-muted"> {t("assessmentInput.rubric.optional")}</span>}
            </li>
          ))}
        </ul>
        <p className="connected-input-hint">{t("assessmentInput.rubric.ownWords")}</p>
      </div>
      <Field label={writtenLabel(question.type, t)} value={answer} onChangeText={onChange} multiline numberOfLines={6} maxLength={8000} editable={!pending} />
    </View>
  );
}

/** Optional self-rated confidence on the item's declared scale. It never changes the result. */
export function ConfidenceInput({ question, value, pending, onChange }: { question: Question; value: number | null; pending: boolean; onChange: (value: number | null) => void }) {
  const t = useT();
  if (!question.confidence) return null;
  const max = question.confidence.scale.maximum;
  const name = `confidence-${question.id}`;
  return (
    <fieldset className="connected-confidence">
      <legend>{t("assessmentInput.confidence.legend")}</legend>
      <p className="connected-input-hint" id={`${name}-hint`}>{t("assessmentInput.confidence.hint", { max })}</p>
      <div className="connected-confidence-scale" role="radiogroup" aria-label={t("assessmentInput.confidence.label")} aria-describedby={`${name}-hint`}>
        {Array.from({ length: max }, (_, i) => i + 1).map((level) => (
          <label key={level} className={value === level ? "selected" : undefined}>
            <input type="radio" name={name} value={level} checked={value === level} disabled={pending} onChange={() => onChange(level)} />
            <span>{level}</span>
          </label>
        ))}
      </div>
      {value !== null && (
        <button type="button" className="connected-link-button" disabled={pending} onClick={() => onChange(null)}>
          {t("assessmentInput.confidence.clear")}
        </button>
      )}
    </fieldset>
  );
}
