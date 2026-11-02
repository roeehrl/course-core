import React, { useEffect, useId, useRef } from "react";
import { useI18n } from "../../i18n";
import { createCompositionTracker, isMac, isSubmitChord, type CompositionTracker } from "./keys";
import type { LongAnswerComposerProps } from "./LongAnswerComposer";

export type { LongAnswerComposerProps } from "./LongAnswerComposer";

/**
 * A field for a long answer (final design §4.13): the visible label above, radius 16, at least
 * 112 px, Enter makes a new line and Cmd/Ctrl+Enter submits (never while an input method is
 * composing), and one meta row: the key hint at its start, then the optional quiet choice ("I don't
 * know yet") and the submit as an accent pill at its end (the Ideas-quick-check and
 * Reviewer-feedback artboards).
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
}: LongAnswerComposerProps) {
  const i18n = useI18n();
  const own = useId();
  const field = id ?? own;
  const hint = `${field}-hint`;
  const area = useRef<HTMLTextAreaElement>(null);
  const tracker = useRef<CompositionTracker | null>(null);
  useEffect(() => {
    tracker.current = createCompositionTracker(area.current);
    return () => tracker.current?.dispose();
  }, []);
  const off = disabled || busy || !value.trim();
  const submit = () => {
    if (!off) onSubmit();
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
        aria-describedby={[hint, describedBy].filter(Boolean).join(" ")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (!isSubmitChord(event) || tracker.current?.isComposing(event)) return;
          event.preventDefault();
          submit();
        }}
      />
      <div className="cc-ui-long-meta">
        <span id={hint} className="cc-ui-long-hint">
          {i18n.rich(isMac() ? "longAnswerComposer.hint.mac" : "longAnswerComposer.hint.other", undefined, key)}
        </span>
        <span className="cc-ui-long-actions">
          {secondary && (
            <button type="button" className="cc-ui-text-button" disabled={secondary.disabled} onClick={secondary.onPress}>
              {secondary.label}
            </button>
          )}
          <button type="button" className="cc-ui-pill cc-ui-pill-accent cc-ui-pill-36" disabled={off} aria-busy={busy || undefined} onClick={submit}>
            {submitLabel}
          </button>
        </span>
      </div>
    </div>
  );
}
