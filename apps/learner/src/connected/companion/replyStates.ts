import {
  companionCouldNotAnswer,
  companionHasPending,
  companionHeldByLimit,
  type CompanionDraft,
  type CompanionMessage,
} from "../../client/companionClient";
import { englishTranslator, type MessageKey, type Translate } from "../../i18n";

/**
 * What the reply to one question shows while it is prepared, written, checked or ended (final
 * design §3.5). All of it lives in the reply row under the question and in the round button;
 * nothing goes in a header, and nothing under the question except a held, unsent or failed send.
 *
 * Times, from the moment the question was sent (or first seen waiting after a reload):
 * nothing for 400 ms, so a fast first token never flashes a loader; then the preparing dots; at
 * 1 s "Companion is replying" is announced once; at 8 s with no text a second line says it is
 * still working. Once text streams, 15 s without a frame pauses the caret ("Reply paused.") and
 * 45 s offers "Ask again". A written reply being checked for more than 1 s says so.
 */
export const REPLY_MS = {
  preparing: 400,
  announce: 1000,
  slow: 8000,
  paused: 15_000,
  stalled: 45_000,
  checking: 1000,
} as const;

/** When things happened for one question, as this page saw them. */
export interface ReplyClock {
  /** The question was sent, or first seen waiting. */
  since: number;
  /** The reply's text last grew (a draft frame). */
  lastFrame?: number;
  /** The reply started being checked (a finished draft, a counted check's draft, a verifying job). */
  checkingSince?: number;
}

/** The learner's own Stop of this question, kept in memory only (Q10). */
export interface LocalStop {
  state: "stopping" | "stopped" | "failed";
  /** The text that was on screen when Stop was pressed; never sent, stored or exported. */
  partial: string;
}

export type EndReason = "noReply" | "partway" | "removed";
export type StreamLine = "paused" | "stalled" | "offline" | "checking";

export type ReplyView =
  /** Nothing to show: within the first 400 ms, or answered (the reply itself shows). */
  | { kind: "none" }
  /** The dots and "Preparing a reply…" (and a second line once it is slow). */
  | { kind: "preparing"; slow: boolean; stopFailed?: boolean }
  /** Text arriving (or written and being checked): the caret while it is live. */
  | { kind: "streaming"; text: string; caret: "live" | "still" | false; line?: StreamLine; stopFailed?: boolean }
  /** No text is shown while the reply is checked (a counted check's reply, a withheld one). */
  | { kind: "checking"; stopFailed?: boolean }
  /** The learner stopped it: the partial text stays muted while this page lives. */
  | { kind: "stopped"; partial?: string }
  /** It ended without an answer: the reason line and "Ask again". */
  | { kind: "ended"; reason: EndReason }
  /** Waiting to be sent (a spending limit, or a companion not set up): the question's footer. */
  | { kind: "held" }
  /** Refused before it was asked: the question's footer offers Edit. */
  | { kind: "notSent" };

export interface ReplyInput {
  message: CompanionMessage;
  draft?: CompanionDraft;
  /** The stored reply to this question is in the conversation. */
  answered: boolean;
  stop?: LocalStop;
  clock: ReplyClock;
  now: number;
  /** The event stream is up (a draft continues once it is back). */
  connected: boolean;
  /** The server says no companion is set up to answer (§3.13): a waiting question is held. */
  notSetUp?: boolean;
}

const CHECKING = ["verifying", "ready"];

/** A question whose call was never sent and was cancelled: it was never asked (§3.5 "cancelled
 * before the call was sent"); the thread leaves it out and its text went back to the box. */
export function cancelledBeforeSent(message: CompanionMessage, draft?: CompanionDraft): boolean {
  return message.role === "learner" && message.job_state === "cancelled" && !message.job_sent && !draft &&
    message.refusal_reason !== "provider_stream_stopped";
}

/** The reply view for one learner question. */
export function replyView({ message, draft, answered, stop, clock, now, connected, notSetUp = false }: ReplyInput): ReplyView {
  if (message.role !== "learner" || message.content === "[deleted]" || answered) return { kind: "none" };
  if (stop?.state === "stopped") return { kind: "stopped", ...(stop.partial ? { partial: stop.partial } : {}) };
  const stopFailed = stop?.state === "failed" ? { stopFailed: true } : {};
  // Final outcomes the server saved come first: they are newer than any draft.
  if (message.job_stalled === true) return { kind: "ended", reason: "noReply" };
  if (message.refusal_reason === "provider_stream_stalled") return { kind: "ended", reason: "partway" };
  if (message.refusal_reason === "provider_stream_stopped") return { kind: "stopped", ...(stop?.partial ? { partial: stop.partial } : {}) };
  if (companionCouldNotAnswer(message)) return { kind: "ended", reason: "removed" };
  if (message.job_state === "refused") return { kind: "notSent" };
  if (message.job_state === "cancelled") return message.job_sent || draft ? { kind: "stopped", ...(stop?.partial ? { partial: stop.partial } : {}) } : { kind: "none" };
  if (["failed", "dead", "dead_letter"].includes(message.job_state ?? "")) return { kind: "ended", reason: "noReply" };
  if (!companionHasPending([message])) return { kind: "none" };
  // Held, like a paused or offline question (§3.5): waiting to send, not being answered. With no
  // companion set up nothing will answer it, so it never shows as prepared.
  if (message.job_reason === "configuration_missing" || message.job_state === "configuration_pending" || companionHeldByLimit(message) ||
    (notSetUp && !draft && !CHECKING.includes(message.job_state ?? "")))
    return { kind: "held" };
  const elapsed = now - clock.since;
  const checkingFor = clock.checkingSince === undefined ? 0 : now - clock.checkingSince;
  if (draft) {
    if (draft.state === "cancelled") return { kind: "stopped", ...(stop?.partial ? { partial: stop.partial } : {}) };
    if (draft.state === "withdrawn") {
      // Withheld for a counted check: Core's own hint follows; nothing of the reply stays.
      if (draft.reason === "check_answer_withheld" || draft.reason === "check_unverified") return { kind: "checking", ...stopFailed };
      return { kind: "ended", reason: draft.reason === "provider_failed" ? "partway" : "removed" };
    }
    if (draft.text) {
      if (draft.state === "complete")
        return { kind: "streaming", text: draft.text, caret: false, ...(checkingFor >= REPLY_MS.checking ? { line: "checking" as const } : {}), ...stopFailed };
      const quiet = now - (clock.lastFrame ?? clock.since);
      const line: StreamLine | undefined = !connected ? "offline" : quiet >= REPLY_MS.stalled ? "stalled" : quiet >= REPLY_MS.paused ? "paused" : undefined;
      return { kind: "streaming", text: draft.text, caret: line ? "still" : "live", ...(line ? { line } : {}), ...stopFailed };
    }
    // A counted check's reply is checked whole before any of it shows (§3.5).
    if (draft.checking || draft.state === "complete")
      return checkingFor >= REPLY_MS.checking ? { kind: "checking", ...stopFailed } : elapsed < REPLY_MS.preparing ? { kind: "none" } : { kind: "preparing", slow: false, ...stopFailed };
  }
  if (CHECKING.includes(message.job_state ?? "") && checkingFor >= REPLY_MS.checking) return { kind: "checking", ...stopFailed };
  if (elapsed < REPLY_MS.preparing && !stop) return { kind: "none" };
  return { kind: "preparing", slow: elapsed >= REPLY_MS.slow, ...stopFailed };
}

/** Milliseconds until the view of this question can change by time alone, or none. */
export function nextReplyChange({ clock, now, draft }: Pick<ReplyInput, "clock" | "now" | "draft">): number | undefined {
  const marks = [clock.since + REPLY_MS.preparing, clock.since + REPLY_MS.announce, clock.since + REPLY_MS.slow];
  if (draft?.text && draft.state === "streaming") {
    const last = clock.lastFrame ?? clock.since;
    marks.push(last + REPLY_MS.paused, last + REPLY_MS.stalled);
  }
  if (clock.checkingSince !== undefined) marks.push(clock.checkingSince + REPLY_MS.checking);
  const next = marks.filter((at) => at > now).sort((a, b) => a - b)[0];
  return next === undefined ? undefined : next - now;
}

/** The question's reply is on its way: Stop applies, and Enter does not send another. */
export function replyInProgress(message: CompanionMessage, view: ReplyView, stop?: LocalStop): boolean {
  if (stop?.state === "stopped") return false;
  return companionHasPending([message]) && (view.kind === "none" || view.kind === "preparing" || view.kind === "streaming" || view.kind === "checking");
}

/** Replies longer than this are announced by a pointer to heading navigation, not read out. */
export const ANNOUNCE_MAX = 600;

/** The sentence the status region says when a reply is stored (§3.5 "done", §6). */
export function repliedAnnouncement(plain: string, t: Translate = englishTranslator().t): string {
  return plain.length > ANNOUNCE_MAX ? t("replyStates.announce.repliedLong") : t("replyStates.announce.replied", { text: plain });
}

/** The once-per-change sentences of §3.5's "Announced" column. */
export type AnnouncementKind =
  | "replying"
  | "slow"
  | "stalled"
  | "offline"
  | "stopped"
  | "stopFailed"
  | "ended"
  | "cancelled"
  | "held"
  | "backOnline"
  | "notSent"
  | "sendFailed"
  | "unconfirmed"
  | "canAskAgain";

export function replyAnnouncement(kind: AnnouncementKind, t: Translate = englishTranslator().t): string {
  return t(`replyStates.announce.${kind}` as MessageKey);
}
