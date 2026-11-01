import React, { useEffect, useRef, useState } from "react";
import type { CompanionMessage } from "../../client/companionClient";
import { companionCanAskAgain, companionHasPending } from "../../client/companionClient";
import { useT } from "../../i18n";
import { MetaLine } from "../ui/MetaLine.web";
import { companionBridge } from "./bridge";
import { BubbleMenu } from "./BubbleMenu.web";
import { conversationActions } from "./conversationActions";
import { copyText } from "./copyText";
import { DeleteConfirm } from "./DeleteConfirm.web";

export interface BubbleActionsProps {
  /** One of the learner's messages. */
  message: CompanionMessage;
  /** This is the learner's newest message. */
  latest: boolean;
  /** A change to this message is being saved. */
  inProgress: boolean;
  /** Deletes the question and its answer; rejects when it could not (the confirm says so). */
  onDelete?: (messageId: string) => Promise<void>;
  /** Puts the question back in the message box to change and send again (by default through the
   * companion bridge, `compose({ source: "edit" })`). */
  onEditResend?: (message: CompanionMessage) => void;
  /** Stop (or resume) using the message as context. */
  onExclude?: (messageId: string, excluded: boolean) => void;
}

/** How long Copy shows its check mark. */
const COPIED_MS = 2000;

/**
 * Beside a learner's message (final design §3.7, §3.4): More (Copy, "Edit and resend", Delete
 * with its confirm) and, under the message, "Not used in later answers" when later answers leave
 * it out. More shows on hover or focus, and always on the latest message on a touch screen.
 *
 * Placement: rendered after the bubble inside an element as wide as the bubble. When that element
 * has the class `cc-act-bubble-host`, More sits 4 px outside the bubble's inline-start edge;
 * otherwise it starts its own line. In the conversation it goes in LearnerTurn's actions slot
 * (`.cc-chat-bubble-actions`), beside the bubble, where companion-actions.css places the menu and
 * the "Not used" line under the bubble.
 */
export function BubbleActions({ message, latest, inProgress, onDelete, onEditResend }: BubbleActionsProps) {
  const t = useT();
  const more = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (message.role !== "learner") return null;
  const deleted = message.content === "[deleted]" || message.content === "[erased]";
  if (deleted) return null;
  // Never while the question waits for its reply.
  const canDelete = Boolean(onDelete) && !companionHasPending([message]);
  // The question was stopped, failed, removed or never answered: it can be changed and sent again.
  const canEdit = latest && companionCanAskAgain(message);
  return (
    <div className={`cc-act-bubble${latest ? " is-latest" : ""}${confirm ? " is-active" : ""}`}>
      <div className="cc-act-bubble-more-anchor">
        <BubbleMenu
          triggerRef={more}
          onCopy={() => {
            void copyText(message.content).then((done) => {
              if (!done) return;
              clearTimeout(timer.current);
              setCopied(true);
              timer.current = setTimeout(() => setCopied(false), COPIED_MS);
            });
          }}
          onEdit={canEdit ? () => (onEditResend ? onEditResend(message) : companionBridge.compose({ source: "edit", text: message.content })) : undefined}
          onDelete={canDelete ? () => setConfirm(true) : undefined}
        />
      </div>
      <span className="cc-ui-sr-only" role="status">{copied ? t("bubbleActions.copied") : ""}</span>
      {message.excluded && <MetaLine icon="eye-off" className="cc-act-footnote-line">{t("bubbleActions.excluded")}</MetaLine>}
      {canDelete && onDelete && (
        <DeleteConfirm
          open={confirm}
          anchor={more}
          onCancel={() => setConfirm(false)}
          onDelete={async () => {
            if (inProgress) return;
            await onDelete(message.id);
            setConfirm(false);
            conversationActions.changedEverywhere({ deleted: message.id });
          }}
        />
      )}
    </div>
  );
}
