import React, { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { Icon } from "../../components/icons/Icon.web";
import { createCompositionTracker, isMac, isSubmitChord, type CompositionTracker } from "./keys";
import { useCoarsePointer } from "./media";
import type { LongAnswerComposerProps } from "./LongAnswerComposer";

export type { LongAnswerComposerProps } from "./LongAnswerComposer";

/**
 * A field for a long answer (final design §4.13): the visible label above, radius 16, at least
 * 112 px, Enter makes a new line and Cmd/Ctrl+Enter submits (never while an input method is
 * composing), and one meta row: the key hint at its start (fine pointers only, as in the
 * companion's composer, §3.6: a touch keyboard has no ⌘ or Ctrl, and the submit says how), then the
 * optional quiet choice ("I don't know yet") and the submit as an accent pill at its end (the
 * Ideas-quick-check and Reviewer-feedback artboards). Like the check's "Check" (§4.1), an empty
 * field does not grey the submit out: it keeps its accent and its place in the Tab order
 * (`aria-disabled`), and a press says under the field what is missing and puts the learner in it.
 * Only a submit in progress (or a field that takes nothing) disables it.
 */
export function LongAnswerComposer({
  label,
  value,
  onChange,
  onSubmit,
  submitLabel,
  placeholder,
  disabled,
  busy,
  id,
  className,
  describedBy,
  secondary,
  action = "submit",
}: LongAnswerComposerProps) {
  const i18n = useI18n();
  const own = useId();
  const field = id ?? own;
  const hint = `${field}-hint`;
  const missing = `${field}-missing`;
  const area = useRef<HTMLTextAreaElement>(null);
  const keyHint = !useCoarsePointer();
  const tracker = useRef<CompositionTracker | null>(null);
  useEffect(() => {
    tracker.current = createCompositionTracker(area.current);
    return () => tracker.current?.dispose();
  }, []);
  const off = Boolean(disabled || busy);
  const empty = !value.trim();
  const [emptyPress, setEmptyPress] = useState(false);
  useEffect(() => {
    if (!empty) setEmptyPress(false);
  }, [empty]);
  const submit = () => {
    if (off) return;
    if (empty) {
      setEmptyPress(true);
      area.current?.focus({ preventScroll: true });
      return;
    }
    onSubmit();
  };
  const key = { key: (children: React.ReactNode, k: string | number) => <bdi key={k}>{children}</bdi> };
  return (
    <div className={["cc-ui-long", className].filter(Boolean).join(" ")}>
      <label className="cc-ui-long-label" htmlFor={field}>
        {label}
      </label>
      <textarea
        ref={area}
        id={field}
        className="cc-ui-long-field"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={[emptyPress ? missing : "", keyHint ? hint : "", describedBy].filter(Boolean).join(" ") || undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!isSubmitChord(event) || tracker.current?.isComposing(event)) return;
          event.preventDefault();
          submit();
        }}
      />
      {emptyPress && (
        <p id={missing} className="cc-ui-long-missing" role="alert">
          <Icon name="alert-circle" size={16} />
          <span>{i18n.t("longAnswerComposer.empty")}</span>
        </p>
      )}
      <div className="cc-ui-long-meta">
        {keyHint && (
          <span id={hint} className="cc-ui-long-hint">
            {i18n.rich(
              action === "save"
                ? isMac() ? "longAnswerComposer.saveHint.mac" : "longAnswerComposer.saveHint.other"
                : isMac() ? "longAnswerComposer.hint.mac" : "longAnswerComposer.hint.other",
              undefined,
              key,
            )}
          </span>
        )}
        <span className="cc-ui-long-actions">
          {secondary && (
            <button type="button" className="cc-ui-text-button" disabled={secondary.disabled} onClick={secondary.onPress}>
              {secondary.label}
            </button>
          )}
          <button
            type="button"
            className="cc-ui-pill cc-ui-pill-accent cc-ui-pill-36"
            disabled={off}
            aria-disabled={!off && empty ? true : undefined}
            aria-describedby={emptyPress ? missing : undefined}
            aria-busy={busy || undefined}
            onClick={submit}
          >
            {submitLabel}
          </button>
        </span>
      </div>
    </div>
  );
}
