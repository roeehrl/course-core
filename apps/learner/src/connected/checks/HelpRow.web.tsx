import React, { forwardRef } from "react";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";
import { useCompanionAvailable } from "../companion/bridge";

export interface HelpRowProps {
  id: string;
  /** The question's number in the lesson ("Help with question 1"). */
  ordinal: number;
  /** An open question that counts: help makes it practice, said once before the buttons. */
  counted: boolean;
  /** After a wrong answer: the next question, first and filled. */
  onTryAgain?: () => void;
  /** The hint ladder's button, when the question has hints (Q11: none without hint content). */
  hint?: React.ReactNode;
  /** Opens the companion about this question; offered only while the companion is. */
  onAsk: () => void;
  /** "Show explanation" / "Hide explanation", when the question has one to show. */
  explanation?: { expanded: boolean; controls: string; disabled?: boolean; onToggle: () => void };
  /** Fade in (M17): the learner opened it. Opened with an answer's feedback, it shows at once. */
  reveal?: boolean;
}

/**
 * The help a check offers (§4.1): opened by "Get help", or by itself after a wrong answer or "I
 * don't know yet". A group named "Help with question 1": on a counted question one line first,
 * then a wrapping row of buttons: "Try again" (after a wrong answer), the hint, "Ask the
 * companion" (only when the study offers the companion, §4.16) and "Show explanation".
 */
export const HelpRow = forwardRef<HTMLDivElement, HelpRowProps>(function HelpRow({ id, ordinal, counted, onTryAgain, hint, onAsk, explanation, reveal }, ref) {
  const t = useT();
  const companion = useCompanionAvailable();
  return (
    <div ref={ref} id={id} className={`cc-check-help${reveal ? " is-revealed" : ""}`} role="group" aria-label={t("helpRow.label", { ordinal })}>
      {counted && (
        <p className="cc-check-help-line">
          <Icon name="practice" size={16} />
          <span>{t("helpRow.countedLine")}</span>
        </p>
      )}
      <div className="cc-check-help-actions">
        {onTryAgain && (
          <button type="button" className="cc-ui-pill cc-ui-pill-accent cc-ui-pill-36" onClick={onTryAgain}>
            {t("helpRow.tryAgain")}
          </button>
        )}
        {hint}
        {companion && (
          <button type="button" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36 cc-check-ask" onClick={onAsk}>
            <Icon name="sparkle" size={16} />
            <span>{t("helpRow.askCompanion")}</span>
          </button>
        )}
        {explanation && (
          <button
            type="button"
            className={`cc-ui-pill cc-ui-pill-outline cc-ui-pill-36 cc-check-explain${explanation.expanded ? " is-expanded" : ""}`}
            aria-expanded={explanation.expanded}
            aria-controls={explanation.expanded ? explanation.controls : undefined}
            disabled={explanation.disabled}
            onClick={explanation.onToggle}
          >
            {t(explanation.expanded ? "helpRow.hideExplanation" : "helpRow.showExplanation")}
          </button>
        )}
      </div>
    </div>
  );
});
