import React, { useEffect, useRef, useState } from "react";
import { useT, type Translate } from "../i18n";

export interface ToastMessage {
  /** A new id shows the message again even when its text is the same. */
  id: number;
  /** Rendered at display time, so the message follows a language switch while it shows. */
  render: (t: Translate) => string;
}
/** How long a confirmation stays when the pointer and focus are elsewhere. */
const TOAST_MS = 8000;

/**
 * A short confirmation floating at the bottom of the window, announced as a status. It never
 * moves the page (an account setting saved in a dialog, for example). It fades after a few
 * seconds unless the pointer or focus is on it, and can be closed at once.
 */
export function Toast({
  toast,
  onDismiss,
}: {
  toast: ToastMessage | null;
  onDismiss: () => void;
}) {
  const t = useT();
  const [held, setHeld] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!toast || held) return;
    const timer = setTimeout(() => dismiss.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, held]);
  useEffect(() => setHeld(false), [toast?.id]);
  return (
    <div className="connected-toast-region">
      <div role="status">
        {toast && (
          <div
            className="connected-toast"
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={() => setHeld(false)}
          >
            <span className="connected-toast-mark" aria-hidden="true">
              ✓
            </span>
            <p>{toast.render(t)}</p>
            <button
              type="button"
              className="connected-toast-dismiss"
              aria-label={t("toast.dismiss")}
              onClick={onDismiss}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
