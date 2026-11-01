import React, { useEffect, useId, useRef } from "react";
import type { Question } from "../client/apiClient";
import { ChoiceList, Field } from "../components/ui";
import { CodeEditor } from "../components/CodeEditor";
import { numericPayload, traceAnswers, writtenLabel } from "./answers";
import { useT } from "../i18n";
import { courseContentAttributes } from "../domain/contentLanguage";
import { createCompositionTracker, type CompositionTracker } from "./ui/keys";

export { answerPayload, isCode, isWritten, numericPayload, traceAnswers } from "./answers";

/**
 * A one-line answer field (numbers and predictions): 48 px, radius 12 (checks.css). Enter checks
 * the answer, but never while an input method is still composing (IME, Safari's late Enter).
 */
function AnswerField({ label, value, onChange, readOnly, onSubmit, describedBy }: {
  label: string; value: string; onChange: (value: string) => void; readOnly: boolean; onSubmit?: () => void; describedBy?: string;
}) {
  const t = useT();
  const field = useRef<HTMLInputElement>(null);
  const ime = useRef<CompositionTracker | null>(null);
  useEffect(() => {
    const tracker = createCompositionTracker(field.current);
    ime.current = tracker;
    return () => tracker.dispose();
  }, []);
  return (
    <input
      ref={field}
      className="cc-check-field"
      type="text"
      aria-label={label}
      placeholder={t("assessmentInput.yourAnswer")}
      value={value}
      readOnly={readOnly}
      dir="ltr"
      inputMode="decimal"
      autoCapitalize="none"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || ime.current?.isComposing(event)) return;
        event.preventDefault();
        if (!readOnly) onSubmit?.();
      }}
    />
  );
}

/** A written answer for a reviewer: a labelled box, at least 112 px (checks.css). */
function WrittenField({ label, value, onChange, readOnly, describedBy }: {
  label: string; value: string; onChange: (value: string) => void; readOnly: boolean; describedBy?: string;
}) {
  const id = useId();
  return (
    <div className="cc-check-written">
      <label htmlFor={id} className="cc-check-label">{label}</label>
      <textarea
        id={id}
        className="cc-check-field cc-check-textarea"
        value={value}
        readOnly={readOnly}
        rows={6}
        maxLength={8000}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** Learner input for each item type: choice, number, prediction, trace, code, code repair and the
 * written, reviewer-judged tasks (teach-back, counterexample, experiment design, rubric). The
 * check's actions (`actions`: "Check" and what goes with it) sit beside a one-line field and
 * under every other input, in the sticky answer bar. */
export function AssessmentInput({ question, answer, pending, onChange, practiceRuns = false, actions, onSubmit, describedBy }: {
  question: Question; answer: string; pending: boolean; onChange: (answer: string) => void;
  /** Offer browser practice runs on code items. Off unless the caller allows it (see browserRunsAllowed). */
  practiceRuns?: boolean;
  /** The answer bar's controls ("Check"). */
  actions?: React.ReactNode;
  /** Enter in a one-line field checks the answer. */
  onSubmit?: () => void;
  /** What describes the field (a refusal said under it). */
  describedBy?: string;
}) {
  const t = useT();
  const bar = actions ? <div className="connected-answer-actions">{actions}</div> : null;
  if (question.type === "choice")
    return (
      <>
        <ChoiceList label={t("assessmentInput.yourAnswer")} options={question.options.map((o) => ({ id: o.id, label: o.text }))} value={answer} onChange={onChange} disabled={pending} />
        {bar}
      </>
    );
  if (question.type === "numeric" || question.type === "prediction") {
    // A stated unit that differs from the item's is pointed out before sending; it is never graded wrong.
    const parsed = numericPayload(answer, question.unit, t);
    const unitProblem = "wrongUnit" in parsed ? parsed.error : "";
    const label = question.unit
      ? t(question.type === "prediction" ? "assessmentInput.predictionWithUnit" : "assessmentInput.numericWithUnit", { unit: question.unit })
      : t(question.type === "prediction" ? "assessmentInput.prediction" : "assessmentInput.numeric");
    return (
      <>
        {question.type === "prediction" && (
          <p className="connected-input-hint">{t("assessmentInput.predictionHint")}</p>
        )}
        <div className="connected-answer-actions cc-check-answer-row">
          <AnswerField label={label} value={answer} onChange={onChange} readOnly={pending} {...(onSubmit ? { onSubmit } : {})} {...(describedBy ? { describedBy } : {})} />
          {actions}
        </div>
        {question.unit && <p className="connected-input-hint">{t("assessmentInput.unitHint", { unit: question.unit })}</p>}
        <p className="connected-input-hint connected-unit-problem" role="status" aria-live="polite">{unitProblem}</p>
      </>
    );
  }
  if (question.type === "trace") {
    const values = traceAnswers(answer);
    return (
      <>
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
                {...(onSubmit ? { onSubmitEditing: onSubmit } : {})}
              />
            </li>
          ))}
        </ol>
        {bar}
      </>
    );
  }
  if (question.type === "code" || question.type === "code_repair")
    return (
      <>
        <CodeEditor language={question.language} value={answer} onChange={onChange} disabled={pending} practice={practiceRuns} />
        {bar}
      </>
    );
  if (!("criteria" in question)) return bar;
  return (
    <>
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
      <WrittenField label={writtenLabel(question.type, t)} value={answer} onChange={onChange} readOnly={pending} {...(describedBy ? { describedBy } : {})} />
      {bar}
    </>
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
