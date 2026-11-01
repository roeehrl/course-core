import React, { useEffect, useRef, useState } from "react";
import { MarkdownContent } from "../../components/MarkdownContent";
import { useT, type MessageKey } from "../../i18n";
import { CompanionTurnFrame } from "../ui/CompanionTurnFrame.web";
import { PillButton } from "../ui/PillButton.web";
import { PreparingDots } from "../ui/PreparingDots.web";
import { StatusLine } from "../ui/StatusLine.web";
import type { ReplyView } from "./replyStates";

/** Streamed text is drawn at most this often, however fast frames come (§3.5). */
export const TEXT_BATCH_MS = 50;

/** `text`, updated no faster than every `ms` (the last value always lands). */
export function useBatchedText(text: string, ms = TEXT_BATCH_MS): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (text === shown) return;
    const wait = last.current + ms - Date.now();
    clearTimeout(timer.current);
    if (wait <= 0 || text.length < shown.length) {
      last.current = Date.now();
      setShown(text);
    } else
      timer.current = setTimeout(() => {
        last.current = Date.now();
        setShown(text);
      }, wait);
  }, [text, shown, ms]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return shown;
}

export interface ReplyRowProps {
  view: ReplyView;
  /** The reply row of the latest question offers "Ask again" (§3.5). */
  latest: boolean;
  onAskAgain?: () => void;
  /** Seconds until a rate-limited question can be asked again (HTTP 429 with Retry-After). */
  rateLimited?: number;
  /** Shows the companion's label line (the first block after a learner turn). */
  label?: boolean;
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.max(0, Math.ceil(seconds)) % 60).padStart(2, "0")}`;

/**
 * The reply being prepared for a question, or how it ended (final design §3.5): the dots and
 * "Preparing a reply…", the text growing in place with a caret, the paused, checking and offline
 * lines, the learner's own Stop (the partial text muted, never saved), and the ends that offer
 * "Ask again". Errors are `--ink` with an icon, never red; a learner's own Stop is never an error.
 */
export function ReplyRow({ view, latest, onAskAgain, rateLimited, label = true }: ReplyRowProps) {
  const t = useT();
  const streamed = useBatchedText(view.kind === "streaming" ? view.text : view.kind === "stopped" ? (view.partial ?? "") : "");
  const askAgain = latest && onAskAgain
    ? <PillButton size={32} startIcon="rotate-ccw" label={t("replyRow.askAgain")} onPress={onAskAgain} className="cc-chat-ask-again" />
    : null;
  if (rateLimited !== undefined)
    return (
      <CompanionTurnFrame author="companion" label={label} className="cc-chat-row">
        <StatusLine icon="clock" text={rateLimited > 0 ? t("replyRow.rateLimited", { time: clock(rateLimited) }) : t("replyRow.rateReady")} />
      </CompanionTurnFrame>
    );
  if (view.kind === "none" || view.kind === "held" || view.kind === "notSent") return null;
  const stopFailed = "stopFailed" in view && view.stopFailed ? <StatusLine tone="error" text={t("replyRow.stopFailed")} /> : null;
  let body: React.ReactNode;
  switch (view.kind) {
    case "preparing":
      body = (
        <>
          <p className="cc-chat-preparing">
            <PreparingDots />
            <span>{t("replyRow.preparing")}</span>
          </p>
          {view.slow && <p className="cc-chat-slow">{t("replyRow.slow")}</p>}
        </>
      );
      break;
    case "streaming":
      body = (
        <>
          <div className="cc-chat-prose" aria-busy={view.caret === "live" || view.line === "checking" || undefined}>
            <MarkdownContent markdown={streamed} streaming variant="reply" {...(view.caret ? { caret: view.caret } : {})} />
          </div>
          {view.line === "paused" && <p className="cc-chat-slow">{t("replyRow.paused")}</p>}
          {view.line === "stalled" && (
            <>
              <StatusLine tone="error" text={t("replyRow.stalled")} />
              {askAgain}
            </>
          )}
          {view.line === "offline" && <StatusLine icon="wifi-off" text={t("replyRow.offline")} />}
          {view.line === "checking" && <StatusLine icon="shield-check" text={t("replyRow.checking")} />}
        </>
      );
      break;
    case "checking":
      body = <StatusLine icon="shield-check" text={t("replyRow.checking")} />;
      break;
    case "stopped":
      body = (
        <>
          {view.partial && (
            <div className="cc-chat-prose is-muted">
              <MarkdownContent markdown={streamed} variant="reply" />
            </div>
          )}
          <StatusLine text={t(view.partial ? "replyRow.stoppedPartial" : "replyRow.stopped")} />
          {askAgain}
        </>
      );
      break;
    case "ended":
      body = (
        <>
          <StatusLine tone="error" text={t(`replyRow.ended.${view.reason}` as MessageKey)} />
          {askAgain}
        </>
      );
      break;
  }
  return (
    <CompanionTurnFrame author="companion" label={label} className="cc-chat-row" data-reply-state={view.kind}>
      <div className="cc-chat-row-body" key={view.kind === "streaming" || view.kind === "stopped" ? "text" : view.kind}>
        {body}
      </div>
      {stopFailed}
    </CompanionTurnFrame>
  );
}
