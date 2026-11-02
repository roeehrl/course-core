import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A long identifier (a learner reference, a digest) behind a small "Copy" button instead of on
 * the page: the value is the button's tooltip and goes to the clipboard on a click. The caller
 * passes the translated labels.
 */
export function CopyText({
  value,
  label,
  copiedLabel,
  accessibleLabel,
}: {
  value: string;
  /** The button's text, such as "Copy reference". */
  label: string;
  /** Shown for a moment after copying. */
  copiedLabel: string;
  /** A fuller name for screen readers, when the visible label needs context. */
  accessibleLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="copy-text"
      title={value}
      aria-label={accessibleLabel}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      <span aria-live="polite">{copied ? copiedLabel : label}</span>
    </button>
  );
}
