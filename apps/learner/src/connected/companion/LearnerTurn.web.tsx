import React from "react";
import type { CompanionMessage } from "../../client/companionClient";
import { Icon } from "../../components/icons/Icon.web";
import type { IconName } from "../../components/icons/icons";
import { useT, type Translate } from "../../i18n";
import { CompanionTurnFrame } from "../ui/CompanionTurnFrame.web";
import type { LessonTarget } from "./bridge";
import { CHIP_EXCERPT } from "./AttachmentChips.web";

/** What sits under a question that was not (yet) asked: §3.5's bubble footers. */
export type BubbleFooter =
  | { kind: "held"; onCancel?: () => void }
  | { kind: "notSent"; onEdit?: () => void }
  | { kind: "sendFailed"; onRetry?: () => void }
  | { kind: "unconfirmed"; onRefresh?: () => void };

export interface TurnAnchor {
  icon: IconName;
  label: string;
  target?: LessonTarget;
}

const clip = (text: string) => (text.length > CHIP_EXCERPT ? `${text.slice(0, CHIP_EXCERPT).trimEnd()}…` : text);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * The anchor chip above a question (§3.3): only for what the learner attached explicitly (a check,
 * a selection, a video moment), never for the lesson they were in. Activating it shows that place
 * in the lesson (M14).
 */
export function turnAnchor(message: CompanionMessage, t: Translate): TurnAnchor | undefined {
  const { attachedCheck, selectedAnchor, mediaRef, episodeId } = message.context;
  if (attachedCheck)
    return {
      icon: "corner-down-left",
      label: t("learnerTurn.anchor.check", { number: attachedCheck.ordinal }),
      target: { ...(episodeId ? { episodeId } : {}), challengeId: attachedCheck.challengeId, focus: "answer" },
    };
  if (selectedAnchor) {
    const target: LessonTarget | undefined = selectedAnchor.blockId
      ? { ...(episodeId ? { episodeId } : {}), blockId: selectedAnchor.blockId, focus: "block" }
      : undefined;
    const base = target ? { target } : {};
    if (selectedAnchor.kind === "code_line" && selectedAnchor.lineStart !== undefined)
      return {
        icon: "code",
        label: selectedAnchor.lineEnd === undefined || selectedAnchor.lineEnd === selectedAnchor.lineStart
          ? t("learnerTurn.anchor.codeLine", { line: selectedAnchor.lineStart })
          : t("learnerTurn.anchor.codeLines", { start: selectedAnchor.lineStart, end: selectedAnchor.lineEnd }),
        ...base,
      };
    if (selectedAnchor.kind === "visual_node") return { icon: "image", label: t("learnerTurn.anchor.illustration"), ...base };
    if (selectedAnchor.excerpt) return { icon: "quote", label: t("learnerTurn.anchor.text", { excerpt: clip(selectedAnchor.excerpt) }), ...base };
    return target ? { icon: "quote", label: t("learnerTurn.anchor.part"), target } : undefined;
  }
  if (mediaRef)
    return {
      icon: "play",
      label: typeof mediaRef.playbackSeconds === "number"
        ? t("learnerTurn.anchor.videoAt", { time: clock(mediaRef.playbackSeconds) })
        : t("learnerTurn.anchor.video"),
    };
  return undefined;
}

/** A question's text, a block per paragraph, each taking its own direction (RTL-2). */
function BubbleText({ text }: { text: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((part) => part.trim());
  return (
    <>
      {(paragraphs.length ? paragraphs : [text]).map((part, index) => (
        <p key={index} dir="auto" className="cc-chat-bubble-text">
          {part}
        </p>
      ))}
    </>
  );
}

export interface LearnerTurnProps {
  id: string;
  /** The question's server id (a sent question), for "reveal" and the actions. */
  messageId?: string;
  text: string;
  anchor?: TurnAnchor;
  onAnchor?: (target: LessonTarget) => void;
  footer?: BubbleFooter;
  /** The learner bubble's actions (actions' slot), beside the bubble. */
  actions?: React.ReactNode;
  /** Set on the bubble so the thread can anchor it on send. */
  bubbleRef?: React.Ref<HTMLDivElement>;
}

/**
 * One of the learner's turns (§3.3): an `<article>` named "You said", the anchor chip, a tinted
 * bubble at the inline end (radius 18, 6 at the bottom inline end; no "You" label) and, when the
 * question was not asked, one footer line with its one action.
 */
export function LearnerTurn({ id, messageId, text, anchor, onAnchor, footer, actions, bubbleRef }: LearnerTurnProps) {
  const t = useT();
  return (
    <CompanionTurnFrame author="learner" id={id} className="cc-chat-turn is-learner" data-message-id={messageId}>
      {anchor &&
        (anchor.target && onAnchor ? (
          <button type="button" className="cc-chat-anchor" id={`${id}-anchor`} onClick={() => onAnchor(anchor.target!)}>
            <Icon name={anchor.icon} size={16} />
            <span>{anchor.label}</span>
          </button>
        ) : (
          <span className="cc-chat-anchor" id={`${id}-anchor`}>
            <Icon name={anchor.icon} size={16} />
            <span>{anchor.label}</span>
          </span>
        ))}
      <div className="cc-chat-bubble-row">
        {actions && <div className="cc-chat-bubble-actions">{actions}</div>}
        <div className="cc-chat-bubble" ref={bubbleRef}>
          <BubbleText text={text} />
        </div>
      </div>
      {footer && <Footer footer={footer} t={t} />}
    </CompanionTurnFrame>
  );
}

function Footer({ footer, t }: { footer: BubbleFooter; t: Translate }) {
  const [icon, text, action, onPress] =
    footer.kind === "held"
      ? (["clock", t("learnerTurn.held"), t("learnerTurn.cancel"), footer.onCancel] as const)
      : footer.kind === "notSent"
        ? (["alert-circle", t("learnerTurn.notSent"), t("learnerTurn.edit"), footer.onEdit] as const)
        : footer.kind === "sendFailed"
          ? (["alert-circle", t("learnerTurn.sendFailed"), t("learnerTurn.tryAgain"), footer.onRetry] as const)
          : (["alert-circle", t("learnerTurn.unconfirmed"), t("learnerTurn.refresh"), footer.onRefresh] as const);
  return (
    <p className={`cc-chat-footer is-${footer.kind}`}>
      <Icon name={icon} size={16} />
      <span>{text}</span>
      {onPress && (
        <button type="button" className="cc-ui-text-button" onClick={onPress}>
          {footer.kind === "notSent" && <Icon name="pencil" size={16} />}
          {action}
        </button>
      )}
    </p>
  );
}
