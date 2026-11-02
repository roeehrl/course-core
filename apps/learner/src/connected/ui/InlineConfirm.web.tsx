import React, { useId, useLayoutEffect, useRef } from "react";

/**
 * A choice asked in place (a send that changes credit, a hint, the explanation): `role="group"`
 * named by its sentence, two equal outline buttons and an optional text button that wraps under
 * them. Focus starts on the safe choice, and Esc takes the safe choice. M17.
 */
export function InlineConfirm({
  sentence,
  detail,
  confirmLabel,
  onConfirm,
  cancelLabel,
  onCancel,
  tertiary,
  safe = "cancel",
  className,
}: {
  sentence: React.ReactNode;
  detail?: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  cancelLabel: string;
  onCancel: () => void;
  tertiary?: { label: string; onPress: () => void };
  /** Which button is the safe choice (focused first, taken by Esc). */
  safe?: "cancel" | "confirm";
  className?: string;
}) {
  const id = useId();
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    (safe === "confirm" ? confirm : cancel).current?.focus({ preventScroll: true });
  }, [safe]);
  return (
    <div
      role="group"
      aria-labelledby={`${id}-sentence`}
      className={["cc-ui-confirm", className].filter(Boolean).join(" ")}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        (safe === "confirm" ? onConfirm : onCancel)();
      }}
    >
      <p id={`${id}-sentence`} className="cc-ui-confirm-sentence">
        {sentence}
      </p>
      {detail && <p className="cc-ui-confirm-detail">{detail}</p>}
      <div className="cc-ui-confirm-actions">
        <button ref={confirm} type="button" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button ref={cancel} type="button" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36" onClick={onCancel}>
          {cancelLabel}
        </button>
        {tertiary && (
          <button type="button" className="cc-ui-text-button" onClick={tertiary.onPress}>
            {tertiary.label}
          </button>
        )}
      </div>
    </div>
  );
}
