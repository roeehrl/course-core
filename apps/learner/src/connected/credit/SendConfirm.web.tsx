import React, { useRef } from "react";
import type { ServerSnapshot } from "../../client/apiClient";
import { useT } from "../../i18n";
import { InlineConfirm } from "../ui/InlineConfirm.web";
import { useAttachedCheckId } from "./CreditNotice.web";
import { scopedQuestion } from "./creditScope";
import { deferredQuestion } from "./deferredQuestion";
import { useOwnEscape } from "./ownEscape";

export interface SendConfirmProps {
  server?: ServerSnapshot;
  episodeId?: string;
  now: number;
  /** A request is in flight: no choice can be made. */
  pending: boolean;
  /** Sending is not possible now (an empty message, or the companion is unavailable). */
  sendDisabled?: boolean;
  onSendAsPractice: () => void;
  /** Keep the question counted: nothing is sent and the draft stays; focus goes back to the message box. */
  onKeep: () => void;
  /** The message is set aside for after the question (deferredQuestion.ts): the composer clears its draft. */
  onSaveForLater?: () => void;
  /** The message, saved by "Save for after the question". */
  draft?: string;
}

/**
 * Asked in place of the meta line when a message would turn an open counted question into
 * practice (final design §3.11, "at the moment"), also when the server answers
 * ASSESSMENT_HELP_CONSENT_REQUIRED: one sentence, "Send as practice" and "Keep it counted" as two
 * equal outline buttons, and "Save for after the question". Nothing is sent before the choice;
 * focus starts on "Keep it counted", and Esc keeps it counted. Asked again for every newly opened
 * counted question, never remembered.
 */
export function SendConfirm({ server, episodeId, now, pending, sendDisabled, onSendAsPractice, onKeep, onSaveForLater, draft }: SendConfirmProps) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const attached = useAttachedCheckId();
  const question = scopedQuestion(server, episodeId, now, attached);
  // The server asked for a choice on a question the preview does not know yet: name the lesson's.
  const ordinal = question?.ordinal ?? 1;
  /** Back to the message box the confirm answers, once the row has gone. */
  const refocus = () => {
    const field = root.current?.closest("#connected-companion")?.querySelector<HTMLTextAreaElement>("textarea");
    requestAnimationFrame(() => field?.isConnected && field.focus({ preventScroll: true }));
  };
  const keep = () => {
    onKeep();
    refocus();
  };
  // Esc is "Keep it counted", and only that (never also closing the companion around it).
  useOwnEscape(true, () => root.current, keep);
  return (
    <div ref={root} className="cc-credit-confirm-row" aria-busy={pending || undefined}>
      <InlineConfirm
        className="cc-credit-confirm"
        sentence={t("sendConfirm.sentence", { ordinal })}
        confirmLabel={t("sendConfirm.switch")}
        onConfirm={() => {
          if (!pending && !sendDisabled) onSendAsPractice();
        }}
        cancelLabel={t("sendConfirm.keep")}
        onCancel={keep}
        {...(onSaveForLater
          ? {
              tertiary: {
                label: t("sendConfirm.later"),
                onPress: () => {
                  if (pending || !server || !episodeId || !draft?.trim()) return;
                  deferredQuestion.save(server.enrollmentId, episodeId, draft, question?.challengeIds ?? [], now);
                  onSaveForLater();
                  refocus();
                },
              },
            }
          : {})}
      />
    </div>
  );
}
