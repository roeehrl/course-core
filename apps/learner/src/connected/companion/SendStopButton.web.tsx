import React, { forwardRef } from "react";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";

/**
 * The round button's states (final design §3.6): an empty box, text ready to send, a reply in
 * progress (Stop), stopping, offline with text (sends on reconnect), over the length limit, and a
 * place where nothing can be sent (outside a lesson, a lesson not taking questions).
 */
export type SendStopState = "empty" | "ready" | "running" | "stopping" | "offline" | "over" | "blocked";

// i18n-ignore: key names for assistive technology (aria-keyshortcuts), not text
const KEYS_SEND = "Enter Control+Enter Meta+Enter";
// i18n-ignore: key names for assistive technology (aria-keyshortcuts), not text
const KEYS_STOP = "Escape";

export interface SendStopButtonProps {
  state: SendStopState;
  onSend(): void;
  onStop(): void;
  /** What says why sending is not possible (the over-limit count, the notice), by id. */
  describedBy?: string;
}

/**
 * Send and Stop are one element in every state, so focus never drops when a reply starts or ends
 * (§6). 36 px (44 under a coarse pointer), at the bottom inline end of the pill; its icon crossfades
 * (M4) and never mirrors.
 */
export const SendStopButton = forwardRef<HTMLButtonElement, SendStopButtonProps>(function SendStopButton(
  { state, onSend, onStop, describedBy },
  ref,
) {
  const t = useT();
  const stop = state === "running" || state === "stopping";
  const disabled = state === "empty" || state === "over" || state === "blocked";
  const name = stop ? t("sendStopButton.stop") : t("connectedCompanion.send.send");
  const tip = stop
    ? t("sendStopButton.stopTip")
    : state === "offline"
      ? t("sendStopButton.offlineTip")
      : state === "ready"
        ? t("sendStopButton.sendTip")
        : name;
  return (
    <button
      ref={ref}
      type="button"
      className="cc-chat-send"
      data-state={state}
      aria-label={name}
      title={tip}
      aria-disabled={disabled || undefined}
      aria-busy={state === "stopping" || undefined}
      aria-describedby={disabled ? describedBy : undefined}
      aria-keyshortcuts={stop ? KEYS_STOP : KEYS_SEND}
      onClick={() => {
        if (state === "stopping" || disabled) return;
        if (stop) onStop();
        else onSend();
      }}
    >
      {state === "stopping" ? (
        <span key="spin" className="cc-chat-spinner" aria-hidden="true" />
      ) : stop ? (
        <span key="stop" className="cc-chat-stop-square" aria-hidden="true" />
      ) : (
        <Icon key="send" name="arrow-up" size={18} />
      )}
      {state === "offline" && (
        <span className="cc-chat-send-badge" aria-hidden="true">
          <Icon name="clock" size={16} />
        </span>
      )}
    </button>
  );
});
