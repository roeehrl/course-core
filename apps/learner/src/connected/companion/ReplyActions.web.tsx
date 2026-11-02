import React, { useEffect, useId, useRef, useState } from "react";
import type { ServerSnapshot } from "../../client/apiClient";
import type { CompanionContext, CompanionMessage } from "../../client/companionClient";
import { companionWithheldNote } from "../../client/companionClient";
import { useI18n, type Translate } from "../../i18n";
import { IconButton } from "../ui/IconButton.web";
import { MetaLine } from "../ui/MetaLine.web";
import { PillButton } from "../ui/PillButton.web";
import { useAnnounce } from "../ui/Announcer.web";
import { StatusLine } from "../ui/StatusLine.web";
import { BasedOnBlock, BasedOnChip, WithheldChip, WithheldLine, basedOnContent, partNumber, questionOf } from "./BasedOn.web";
import type { LessonTarget } from "./bridge";
import { conversationActions, useConversationActions } from "./conversationActions";
import { copyText } from "./copyText";
import { ReplyMenu } from "./ReplyMenu.web";
import { showInLesson } from "./showInLesson";
import { VoteButtons, VoteNote, useVoteState } from "./VoteControls.web";

/** What the conversation knows that a reply's actions may need. */
export interface ReplyActionsConversation {
  enrollmentId: string;
  episodeTitles: Readonly<Record<string, string>>;
  /** The enrollment as last read: which lesson part a block is, whether a check is still open. */
  server?: ServerSnapshot;
}
export interface ReplyActionsProps {
  /** The settled companion reply. */
  message: CompanionMessage;
  messages: readonly CompanionMessage[];
  conversation: ReplyActionsConversation;
  /** This is the newest reply in the conversation. */
  latest: boolean;
  context: CompanionContext;
  /** The id of a message whose context change is being saved ("" for none). */
  busy: string;
  /** Stop (or resume) using a message (this reply or one it used) in later answers; a promise that
   * rejects says the change was not saved, which the reply then says in place. */
  onExclude?: (messageId: string, excluded: boolean) => void | Promise<unknown>;
}

/** How long Copy shows its check mark. */
const COPIED_MS = 2000;

/** "14:05", "Yesterday 09:12" or "Mon 3 Nov 09:12": when the reply was written, for the tooltip. */
function writtenAt(created: string, i18n: { date: (value: Date, options: Intl.DateTimeFormatOptions) => string; time: (value: Date, options: "short") => string }, t: Translate, now = new Date()) {
  const at = new Date(created);
  if (Number.isNaN(at.getTime())) return undefined;
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const time = i18n.time(at, "short");
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return t("replyActions.time.yesterday", { time });
  return t("replyActions.time.other", { date: i18n.date(at, { weekday: "short", day: "numeric", month: "short" }), time });
}

/**
 * The action row under a settled companion reply (final design §3.7): Copy, Helpful, Not helpful
 * and More in a fixed group; "Try question 1" or "Back to Part 2" on the latest reply about a
 * check or a part; and "Based on", or under a hint that stood in for an answer its footnote chip.
 * The latest reply always shows its row; older ones on hover or focus (always on touch screens).
 * Under the row: the optional "What was wrong?" field, the open "Based on" block, a change that
 * was not saved, and "Not used in later answers" for a reply later answers leave out.
 */
export function ReplyActions({ message, messages, conversation, latest, context, busy, onExclude }: ReplyActionsProps) {
  const i18n = useI18n(), t = i18n.t;
  const actions = useConversationActions(conversation.enrollmentId);
  const votes = useVoteState(message, actions.vote && ((input) => actions.vote!(message.id, input)));
  const [copied, setCopied] = useState(false);
  const [basedOpen, setBasedOpen] = useState(false);
  const [footnoteOpen, setFootnoteOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notHelpful = useRef<HTMLDivElement>(null);
  const timeId = useId(), basedId = useId(), footnoteId = useId();
  // "Copied" and "Thanks, noted." are said by the conversation's one status region (§6), not a
  // live region of each reply.
  const announce = useAnnounce();
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  useEffect(() => {
    if (votes.thanked) announce(t("replyActions.thanks"));
  }, [votes.thanked]);
  if (message.role !== "assistant" || message.content === "[deleted]" || message.content === "[erased]") return null;
  const withheld = companionWithheldNote(message);
  const based = basedOnContent(message, messages, conversation.server);
  const written = writtenAt(message.created_at, i18n, t);
  const server = conversation.server;
  // "Try question 1" / "Back to Part 2": the latest reply to a question about a check or a part.
  const question = questionOf(message, messages);
  const episodeId = question?.context.episodeId ?? message.context.episodeId ?? undefined;
  const check = question?.context.attachedCheck;
  const anchorBlock = question?.context.selectedAnchor?.blockId;
  const part = anchorBlock ? partNumber(server, episodeId, anchorBlock) : undefined;
  const back: { label: string; target: LessonTarget } | undefined = !latest ? undefined
    : check && (!server || server.activeChallenges.some((row) => row.challengeId === check.challengeId))
      ? { label: t("replyActions.tryQuestion", { number: check.ordinal }), target: { episodeId, challengeId: check.challengeId, focus: "answer" } }
      : anchorBlock && part
        ? { label: t("replyActions.backToPart", { number: part }), target: { episodeId, blockId: anchorBlock, focus: "block" } }
        : undefined;
  const exclude = onExclude && ((messageId: string, value: boolean) => {
    setFailed(false);
    Promise.resolve(onExclude(messageId, value)).then(
      () => conversationActions.get(conversation.enrollmentId).changed({ excluded: messageId, value }),
      () => setFailed(true),
    );
  });
  const active = basedOpen || footnoteOpen || votes.noteOpen;
  return (
    <div className={`cc-act-reply${latest ? " is-latest" : ""}${active ? " is-active" : ""}`}>
      <div className="cc-act-row" role="group" aria-label={t("replyActions.group")}>
        <div className="cc-act-icons">
          <span className="cc-act-tip">
            <IconButton
              icon={copied ? "check" : "copy"}
              iconSize={16}
              className="cc-act-icon"
              label={t("replyActions.copy")}
              aria-describedby={written ? timeId : undefined}
              onClick={() => {
                void copyText(message.content).then((done) => {
                  if (!done) return;
                  clearTimeout(copiedTimer.current);
                  setCopied(true);
                  announce(t("replyActions.copied"), { again: true });
                  copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
                });
              }}
            />
            {written && <time id={timeId} className="cc-act-time" dateTime={message.created_at}>{written}</time>}
          </span>
          {actions.vote && <div ref={notHelpful} className="cc-act-votes"><VoteButtons state={votes} /></div>}
          <ReplyMenu
            excluded={message.excluded === true}
            saving={busy === message.id}
            reported={votes.reported}
            onExclude={exclude && ((value) => exclude(message.id, value))}
            onReport={actions.vote ? votes.report : undefined}
            onBasedOn={withheld && based ? () => setBasedOpen((open) => !open) : undefined}
          />
        </div>
        {back && (
          <PillButton size={32} startIcon="corner-down-left" label={back.label} className="cc-act-back" onPress={() => showInLesson(back.target, context.episodeId)} />
        )}
        {!votes.thanked && (withheld
          ? <WithheldChip open={footnoteOpen} controls={footnoteId} onToggle={() => setFootnoteOpen((open) => !open)} />
          : based && <BasedOnChip content={based} messages={messages} open={basedOpen} controls={basedId} onToggle={() => setBasedOpen((open) => !open)} />)}
        {votes.thanked && <span className="cc-act-thanks">{t("replyActions.thanks")}</span>}
      </div>
      {withheld && <WithheldLine id={footnoteId} open={footnoteOpen} />}
      <VoteNote state={votes} onClosed={() => notHelpful.current?.querySelectorAll("button")[1]?.focus()} />
      {basedOpen && based && (
        <BasedOnBlock
          id={basedId}
          content={based}
          busy={busy}
          onExclude={exclude}
          onShowPart={based.part ? () => showInLesson({ episodeId: based.used.episodeId, blockId: based.question?.context.selectedAnchor?.blockId ?? based.used.blockId ?? undefined, focus: "block" }, context.episodeId) : undefined}
        />
      )}
      {(failed || votes.failed) && <StatusLine tone="error" text={t("replyActions.error.correct")} className="cc-act-error" />}
      {message.excluded && <MetaLine icon="eye-off" className="cc-act-footnote-line">{t("replyActions.excluded")}</MetaLine>}
    </div>
  );
}
