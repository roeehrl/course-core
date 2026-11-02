import React, { memo } from "react";
import type { CompanionMessage } from "../../client/companionClient";
import { MarkdownContent } from "../../components/MarkdownContent";
import { useT } from "../../i18n";
import { CompanionTurnFrame } from "../ui/CompanionTurnFrame.web";
import { Tag } from "../ui/Tag.web";
import { LengthLimit } from "./ThreadLines.web";

/** Core writes its coaching in the question's script (companion-check-integrity.ts): Hebrew from
 * eight Hebrew letters on. */
const HEBREW_LETTERS = /[א-ת]/g;
export const hintLanguage = (text: string) => ((text.match(HEBREW_LETTERS)?.length ?? 0) >= 8 ? "he" : "en");

export interface CompanionTurnProps {
  message: CompanionMessage;
  /** The label line ("Companion"), on the first block after a learner turn. */
  label: boolean;
  /** The reply ends by asking the learner something: its closing question is set at 600. */
  asks: boolean;
  /** It is the learner's turn to answer it (the latest reply, nothing sent since): "Your turn". */
  yourTurn: boolean;
  /** A hint in place of a counted check's answer: drawn as a normal reply in its own language. */
  hint: boolean;
  /** It arrived while the conversation was open: it fades in once (M1). */
  fresh?: boolean;
  /** The latest reply: "Continue" after a reply that reached its length limit. */
  onContinue?: () => void;
  /** The action row (actions' slot) and the chips under it. */
  actions?: React.ReactNode;
  chips?: React.ReactNode;
}

/**
 * A settled companion reply (§3.3): no box and no fill, prose at the chat type (reading type in
 * the focus view), the label line on the first block after a learner turn, the closing question
 * at weight 600 with "Your turn" while the learner has not answered, then the action row and the
 * chips. One that arrives fades in once (M1). Memoized: a reply re-renders only when it changes.
 */
export const CompanionTurn = memo(function CompanionTurn({ message, label, asks, yourTurn, hint, fresh, onContinue, actions, chips }: CompanionTurnProps) {
  const t = useT();
  return (
    <CompanionTurnFrame author="companion" label={label} className={`cc-chat-turn is-companion${fresh ? " is-fresh" : ""}`} data-message-id={message.id}>
      <div className="cc-chat-prose" {...(hint ? { lang: hintLanguage(message.content) } : {})}>
        <MarkdownContent
          markdown={message.content}
          variant="reply"
          {...(asks ? { closingQuestion: { tag: yourTurn ? <Tag label={t("companionTurn.yourTurn")} variant="accent" className="cc-chat-your-turn" /> : undefined } } : {})}
        />
      </div>
      {message.context.cutShort === true && <LengthLimit {...(onContinue ? { onContinue } : {})} />}
      {actions}
      {chips}
    </CompanionTurnFrame>
  );
});
