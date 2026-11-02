import { useEffect, useSyncExternalStore } from "react";
import type { CompanionMessage } from "../../client/companionClient";
import { companionBridge, type CompanionActivity } from "./bridge";
import { useCompanionOpenValue } from "./openState";

/**
 * The companion's unread replies (final design §3.1, §4.1 item 9): replies that settled while the
 * companion was closed, or before this device last showed them. Published to the bridge for the
 * trigger's dot and name (`unread`), where the companion opens (`firstUnreadId`, the oldest unread
 * reply) and the check's "Your companion replied about this question." (`replyAbout`, keyed by the
 * check the question was attached to). They are seen once the companion shows the thread: open, in
 * a visible tab, not folded to the phone's collapsed bar.
 *
 * Per device: the time of the newest reply this device has shown is kept per enrollment in
 * `localStorage` (`course:companion-seen:<enrollment>`, "" before any reply), in memory when storage
 * is unavailable. A device with no record counts the conversation it first loads as seen, so a new
 * device does not call old replies new (the bell says what arrived while the learner was away).
 */
export const SEEN_PREFIX = "course:companion-seen:";
const memory = new Map<string, string>();

/** The newest reply time this device showed for an enrollment; null when it never recorded one. */
export function readSeen(enrollmentId: string): string | null {
  try {
    const value = window.localStorage.getItem(SEEN_PREFIX + enrollmentId);
    if (value !== null) return value;
  } catch {
    /* Storage blocked: the page's own record below. */
  }
  return memory.get(enrollmentId) ?? null;
}
export function writeSeen(enrollmentId: string, value: string) {
  memory.set(enrollmentId, value);
  try {
    window.localStorage.setItem(SEEN_PREFIX + enrollmentId, value);
  } catch {
    /* The record then lasts for this page only. */
  }
}

const time = (value: string) => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : at;
};

/** The question a reply answers: the learner's message of the same job, else the one before it. */
function questionOf(messages: readonly CompanionMessage[], index: number): CompanionMessage | undefined {
  const reply = messages[index]!;
  if (reply.job_id) {
    const asked = messages.find((row) => row.role === "learner" && row.job_id === reply.job_id);
    if (asked) return asked;
  }
  for (let i = index - 1; i >= 0; i--) if (messages[i]!.role === "learner") return messages[i];
  return undefined;
}

export type UnreadActivity = Pick<CompanionActivity, "unread" | "firstUnreadId" | "replyAbout">;
export const NOTHING_UNREAD: UnreadActivity = Object.freeze({ unread: 0, firstUnreadId: undefined, replyAbout: Object.freeze({}) });

/** The replies newer than `seen` (a reply time; "" counts every reply). */
export function unreadReplies(messages: readonly CompanionMessage[], seen: string): UnreadActivity {
  const after = seen ? time(seen) : -Infinity;
  const replyAbout: Record<string, string> = {};
  let unread = 0,
    firstUnreadId: string | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || time(message.created_at) <= after) return;
    unread += 1;
    firstUnreadId ??= message.id;
    const check = questionOf(messages, index)?.context.attachedCheck?.challengeId;
    // The newest reply about a check wins.
    if (check) replyAbout[check] = message.id;
  });
  return unread ? { unread, firstUnreadId, replyAbout } : NOTHING_UNREAD;
}

/** The newest reply's time, or "" when there is none. */
export function newestReply(messages: readonly CompanionMessage[]): string {
  let newest = "";
  for (const message of messages) if (message.role === "assistant" && time(message.created_at) > (newest ? time(newest) : -Infinity)) newest = message.created_at;
  return newest;
}

const visibility = {
  subscribe(listener: () => void) {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  get: () => typeof document === "undefined" || document.visibilityState !== "hidden",
};

/**
 * Keeps the bridge's unread fields for one enrollment's conversation: cleared while the thread
 * shows (and the newest reply recorded as seen), counted while it does not.
 */
export function useCompanionActivity(messages: readonly CompanionMessage[], open: boolean, enrollmentId: string) {
  const visible = useSyncExternalStore(visibility.subscribe, visibility.get, () => true);
  const detent = useCompanionOpenValue("detent"),
    docked = useCompanionOpenValue("docked");
  // The phone's collapsed bar shows one line, not the thread.
  const showing = open && visible && (docked || detent !== "collapsed");
  const newest = newestReply(messages);
  useEffect(() => {
    let seen = readSeen(enrollmentId);
    // Nothing loaded yet (or nothing asked yet): it waits for the first conversation this device shows.
    if (seen === null && messages.length) writeSeen(enrollmentId, (seen = newest));
    if (showing && seen !== null && newest && time(newest) > (seen ? time(seen) : -Infinity)) writeSeen(enrollmentId, newest);
    companionBridge.updateActivity(showing || seen === null ? NOTHING_UNREAD : unreadReplies(messages, seen));
  }, [messages, newest, showing, enrollmentId]);
  // Another enrollment, or the companion is gone: nothing unread is shown for it.
  useEffect(() => () => companionBridge.updateActivity(NOTHING_UNREAD), [enrollmentId]);
}
