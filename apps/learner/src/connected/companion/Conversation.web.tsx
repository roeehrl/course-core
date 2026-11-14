import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CourseApiError, type CourseApi, type ServerSnapshot } from "../../client/apiClient";
import {
  companionDraftFor,
  companionHasPending,
  companionHeldByLimit,
  companionReplyStarted,
  plainExcerpt,
  type CompanionContext,
  type CompanionDraft,
  type CompanionMessage,
  type CompanionReceipt,
} from "../../client/companionClient";
import { companionFocus, type CompanionFocusState } from "../../client/companionFocus";
import type { CompanionLayout } from "../../domain/companionLayout";
import { useOnline } from "../../hooks/useOnline";
import { useT } from "../../i18n";
import { creditScope } from "../credit/creditScope";
import { SendConfirm } from "../credit/SendConfirm.web";
import { CreditLineAfter, CreditLineBeforeDivider, CreditThreadEnd } from "../credit/CreditThreadLines.web";
import { deferredQuestion } from "../credit/deferredQuestion";
import { Announcer, useAnnounce } from "../ui/Announcer.web";
import { ringComposer } from "../ui/highlight";
import { placeholderAttachment } from "./AttachmentChips.web";
import { BubbleActions } from "./BubbleActions.web";
import { companionBridge, type LessonTarget } from "./bridge";
import { CompanionTurn } from "./CompanionTurn.web";
import { Composer, MESSAGE_MAX, type ComposerHandle } from "./Composer.web";
import { DecisionLine } from "./DecisionLine.web";
import { EarlierMessages } from "./EarlierMessages.web";
import { EmptyState } from "./EmptyState.web";
import { LearnerTurn, turnAnchor, type BubbleFooter } from "./LearnerTurn.web";
import { chooseNotice, type PausedCeiling } from "./notices";
import { useCompanionOpenValue } from "./openState";
import { composerPlaceholder } from "./placeholder";
import { dismissRecovered, useRecoveredMessage } from "./recovered";
import { ReplyActions } from "./ReplyActions.web";
import { BackToLesson, ChipRow, replyChips } from "./ReplyChips.web";
import {
  cancelledBeforeSent,
  nextReplyChange,
  repliedAnnouncement,
  replyAnnouncement,
  replyInProgress,
  replyView,
  REPLY_MS,
  type LocalStop,
  type ReplyClock,
  type ReplyView,
} from "./replyStates";
import { ReplyRow } from "./ReplyRow.web";
import { showInLesson } from "./showInLesson";
import type { SendStopState } from "./SendStopButton.web";
import { Thread, type ThreadHandle } from "./Thread.web";
import { continueText, DateDivider, DATE_GAP_MS, DeletedLine, LessonDivider, lessonLabel, VersionLine } from "./ThreadLines.web";
import { turnState, asksLearner, isWithheldHint } from "./turnState";

/** Text in the message box is saved this long after the last keystroke (§3.6). */
export const DRAFT_DEBOUNCE_MS = 300;

/** A closed (completed or capped) course's remaining read-only questions. */
export type ClosedAllowance = { budget?: number; used?: number; remaining: number };

export interface ConversationProps {
  context: CompanionContext;
  messages: readonly CompanionMessage[];
  episodeTitles: Readonly<Record<string, string>>;
  /** The saved draft of this lesson's message box (drafts.ts). */
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: (content: string, consent?: true) => Promise<CompanionReceipt>;
  /** Another request of the page is in flight. The message box never waits for it (§3.6). */
  pending: boolean;
  loaded: boolean;
  /** The conversation could not be read again (useCompanionConversation). */
  error?: string;
  /** This lesson takes no new questions (or every question a closed course allows is used). */
  unavailable?: boolean;
  storageUnavailable?: boolean;
  /** Stop (or resume) using an earlier message of the learner as context. */
  onExcludeContext?: (messageId: string, excluded: boolean) => Promise<void>;
  /** Delete one of the learner's questions and its answer. */
  onDeleteMessage?: (messageId: string) => Promise<void>;
  /** Cancel a question before it is asked, or stop its reply. */
  onCancelQuestion?: (messageId: string) => Promise<void>;
  /** Replies being written, streamed before Core has checked them. */
  drafts?: readonly CompanionDraft[];
  /** False while the event stream reconnects; a draft continues once it is back. */
  streamConnected?: boolean;
  /** Whether a companion job can answer, as the server says; nothing shows while it is ready or
   * unknown (§3.13). */
  availability?: "ready" | "not_set_up" | "unknown" | undefined;
  server?: ServerSnapshot;
  api?: CourseApi;
  /** The time checks are judged at (expiry), as the host keeps it. */
  now?: number;
  /** Where the companion is (the composer grows less on a phone or in a short window). */
  layout?: CompanionLayout;
  /** Reads the conversation again ("Try again", "Refresh"). */
  onRefresh?: () => void;
  /** A closed course's questions: how many are left, or that none are. */
  closed?: { allowance: ClosedAllowance; exhausted: boolean };
  /** Two versions of this draft were written at once (another tab). */
  draftConflict?: boolean;
  onDraftChoice?: (keep: "shown" | "other") => void;
  /** Outside a lesson: the lesson "Go to {lesson}" opens. */
  nextLesson?: { episodeId: string; title: string };
}

/** A question of this page that is not (or not yet) a saved message. */
interface LocalTurn {
  key: string;
  text: string;
  status: "sending" | "sent" | "held" | "failed" | "unconfirmed" | "rateLimited";
  consent?: true;
  episodeId?: string;
  sentAt: number;
  messageId?: string;
  retryAt?: number;
  /** The text came from the message box (not a chip): it goes back there on failure. */
  fromBox: boolean;
  /** The learner's saved questions when it was sent (its own row is a new one). */
  before: readonly string[];
}

const deleted = (message: CompanionMessage) => message.content === "[deleted]" || message.content === "[erased]";
let localCount = 0;
const localKey = () => `local-${Date.now().toString(36)}-${++localCount}`;

function useCompanionFocus() {
  const [focus, setFocus] = useState<CompanionFocusState>(companionFocus.get());
  useEffect(() => companionFocus.subscribe(setFocus), []);
  return focus;
}

/**
 * The companion's conversation (final design §3): the thread and its composer, as a familiar
 * chat. Every state of a reply lives in its reply row and in the round button; limitations take
 * the one notice above the composer. One status region announces what changed, once.
 */
export function Conversation(props: ConversationProps) {
  return (
    <Announcer className="cc-chat-status">
      <ConversationBody {...props} />
    </Announcer>
  );
}

function ConversationBody({
  context,
  messages,
  episodeTitles,
  draft,
  onDraftChange,
  onSend,
  loaded,
  error,
  unavailable,
  storageUnavailable,
  onExcludeContext,
  onDeleteMessage,
  onCancelQuestion,
  drafts = [],
  streamConnected = true,
  availability,
  server,
  api,
  now: checkNow = Date.now(),
  layout,
  onRefresh,
  closed,
  draftConflict,
  onDraftChoice,
  nextLesson,
}: ConversationProps) {
  const t = useT();
  const announce = useAnnounce();
  const online = useOnline();
  const focus = useCompanionFocus();
  const open = useCompanionOpenValue("open");
  const recovered = useRecoveredMessage();
  const inLesson = Boolean(context.episodeId);
  const composer = useRef<ComposerHandle>(null);
  const thread = useRef<ThreadHandle>(null);
  const root = useRef<HTMLDivElement>(null);

  // The message box: shown at once, saved 300 ms after the last keystroke. A draft changed
  // elsewhere (another tab, a choice between versions) replaces what is shown.
  const [value, setValue] = useState(draft);
  const written = useRef(draft);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ draft, value, onDraftChange, episodeId: context.episodeId });
  latest.current = { draft, value, onDraftChange, episodeId: context.episodeId };
  useEffect(() => {
    if (draft === written.current) return;
    written.current = draft;
    setValue(draft);
  }, [draft]);
  const save = useCallback((text: string) => {
    clearTimeout(saveTimer.current);
    // The drafts store keeps at most a message's length; text over it stays in the box (and says
    // how far over it is) instead of being cut when the stored copy comes back.
    written.current = text.slice(0, MESSAGE_MAX);
    latest.current.onDraftChange(text);
  }, []);
  const change = (text: string) => {
    setValue(text);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(text), DRAFT_DEBOUNCE_MS);
  };
  // Leaving (another lesson, closing): what was typed is saved now.
  useEffect(() => () => {
    if (saveTimer.current === undefined) return;
    clearTimeout(saveTimer.current);
    if (latest.current.value !== written.current) latest.current.onDraftChange(latest.current.value);
  }, []);
  /** Puts text in the box with the caret at the end (and saves it at once). */
  const fill = useCallback((text: string, { focusBox = true }: { focusBox?: boolean } = {}) => {
    setValue(text);
    save(text);
    if (!focusBox) return;
    requestAnimationFrame(() => {
      const field = composer.current?.textarea();
      if (!field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(text.length, text.length);
    });
  }, [save]);
  /** Puts a question's text back in the box without losing what is there (§3.6: a draft is kept
   * until the server accepts it): an empty box takes it; a box with another draft keeps that draft
   * and takes the text after it, on a new paragraph. */
  const putBack = useCallback((text: string) => {
    const current = latest.current.value;
    if (!current.trim() || current.trim() === text.trim()) return fill(text);
    fill(`${current.replace(/\s+$/u, "")}\n\n${text}`);
  }, [fill]);

  const [locals, setLocals] = useState<LocalTurn[]>([]);
  const [stops, setStops] = useState<Record<string, LocalStop>>({});
  const [confirm, setConfirm] = useState<{ text: string; fromBox: boolean } | null>(null);
  const [correcting, setCorrecting] = useState("");
  const [, setTick] = useState(0);
  const now = Date.now();
  const updateLocal = (key: string, patch: Partial<LocalTurn> | null) =>
    setLocals((list) => (patch ? list.map((item) => (item.key === key ? { ...item, ...patch } : item)) : list.filter((item) => item.key !== key)));

  // A selection belongs to the lesson it was made in; consent and holds belong to it too.
  useEffect(() => {
    setConfirm(null);
    companionFocus.clear();
    setLocals((list) => list.filter((item) => item.status === "sent"));
  }, [context.enrollmentId, context.episodeId]);

  // Each question's clock: when it was sent (or first seen waiting), its draft's last frame, and
  // when its checking began. Kept for this page only.
  const clocks = useRef(new Map<string, ReplyClock>());
  const cancelledHere = useRef(new Set<string>());
  const frames = useRef(new Map<string, number>());
  const answered = (message: CompanionMessage) =>
    Boolean(message.job_id) && messages.some((row) => row.role === "assistant" && row.job_id === message.job_id);
  // A question being sent is matched to its saved row as soon as the conversation has it (the event
  // stream can bring it before the send's own answer): the same text, a row that was not there when
  // it was sent. Then it shows once, in the same place.
  const matched = new Map<string, string>();
  for (const item of locals) {
    const id = item.messageId ?? messages.find((row) => row.role === "learner" && row.content === item.text && !item.before.includes(row.id) &&
      ![...matched.values()].includes(row.id) && !locals.some((other) => other.messageId === row.id))?.id;
    if (id) matched.set(item.key, id);
  }
  const sentAtByMessage = new Map(locals.filter((item) => matched.has(item.key)).map((item) => [matched.get(item.key)!, item.sentAt]));
  const keyByMessage = new Map(locals.filter((item) => matched.has(item.key)).map((item) => [matched.get(item.key)!, item.key]));
  function clockFor(message: CompanionMessage, draftOf?: CompanionDraft): ReplyClock {
    let clock = clocks.current.get(message.id);
    if (!clock) clocks.current.set(message.id, (clock = { since: sentAtByMessage.get(message.id) ?? now }));
    if (draftOf?.text) {
      const seen = frames.current.get(draftOf.jobId);
      if (seen !== draftOf.text.length) {
        frames.current.set(draftOf.jobId, draftOf.text.length);
        clock.lastFrame = now;
      }
    }
    const checking = draftOf ? draftOf.state === "complete" || Boolean(draftOf.checking) : ["verifying", "ready"].includes(message.job_state ?? "");
    if (checking && clock.checkingSince === undefined) clock.checkingSince = now;
    return clock;
  }

  // The reply view of every question, and the one whose reply is on its way.
  // A question the learner cancelled here before its call was sent was never asked: it leaves the
  // thread (its text went back to the box). One cancelled earlier stays, as the learner's own text.
  // The server confirmed the cancel before the conversation is read again (the event that reads it
  // comes later): until then the saved row still reads as waiting, and it leaves the thread too, so
  // it is never shown, held as running, or announced as being replied to after its cancel.
  const shown = messages.filter((message) => {
    if (message.role !== "learner" || !cancelledHere.current.has(message.id)) return true;
    const replyDraft = companionDraftFor(message, messages, drafts);
    return !(cancelledBeforeSent(message, replyDraft) || (!message.job_sent && !replyDraft && companionHasPending([message])));
  });
  const views = new Map<string, { view: ReplyView; draft?: CompanionDraft; clock: ReplyClock }>();
  const newestQuestion = shown.findLast((message) => message.role === "learner" && !deleted(message))?.id;
  let running: CompanionMessage | undefined;
  for (const message of shown) {
    if (message.role !== "learner" || deleted(message)) continue;
    const replyDraft = companionDraftFor(message, messages, drafts);
    const clock = clockFor(message, replyDraft);
    const view = replyView({ message, draft: replyDraft, answered: answered(message), stop: stops[message.id], clock, now, connected: streamConnected, notSetUp: availability === "not_set_up" });
    views.set(message.id, { view, ...(replyDraft ? { draft: replyDraft } : {}), clock });
    // Only the newest question holds the round button: an older one still waiting (a reply that
    // never came) shows its own row and never locks the composer.
    if (message.id === newestQuestion && !cancelledHere.current.has(message.id) && replyInProgress(message, view, stops[message.id])) running = message;
  }
  // A question being sent, or accepted and not yet read back with the conversation.
  const sending = locals.find((item) =>
    (item.status === "sending" && !matched.has(item.key)) || (item.status === "sent" && !!item.messageId && !messages.some((message) => message.id === item.messageId)));
  // With no companion set up a question waits to be sent: the round button stays Send (§3.5).
  const inProgress = Boolean(running || (sending && availability !== "not_set_up"));
  const stopping = Object.values(stops).some((stop) => stop.state === "stopping");

  // Re-render when a view can change by time alone (400 ms, 1 s, 8 s, 15 s, 45 s; a countdown).
  useEffect(() => {
    const waits = [...views.values()].map(({ clock, draft: replyDraft }) => nextReplyChange({ clock, now, ...(replyDraft ? { draft: replyDraft } : {}) }));
    if (locals.some((item) => item.status === "rateLimited")) waits.push(1000 - (now % 1000));
    // A question not yet read back shows its preparing line at 400 ms and its slow line at 8 s too.
    for (const item of locals)
      if (item.status === "sending" || item.status === "sent")
        for (const at of [item.sentAt + REPLY_MS.preparing, item.sentAt + REPLY_MS.slow]) if (at > now) waits.push(at - now);
    const wait = waits.filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b)[0];
    if (wait === undefined) return;
    const timer = setTimeout(() => setTick((tick) => tick + 1), Math.max(16, wait + 5));
    return () => clearTimeout(timer);
  });

  // Announcements (§3.5 "Announced", §6): each once, when it becomes true.
  const said = useRef(new Map<string, string>());
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    for (const [id, { view, clock }] of views) {
      // A question the learner cancelled here is not being replied to: whatever is read after the
      // cancel, its "Question cancelled" stays the last thing said about it.
      if (cancelledHere.current.has(id) && (view.kind === "preparing" || view.kind === "streaming" || view.kind === "checking")) continue;
      const kind =
        view.kind === "preparing" ? (view.slow ? "slow" : now - clock.since >= REPLY_MS.announce ? "replying" : "")
        : view.kind === "streaming" ? (view.line === "stalled" ? "stalled" : view.line === "offline" ? "offline" : "")
        : view.kind === "stopped" ? (stops[id] ? "stopped" : "")
        : view.kind === "ended" ? "ended"
        : view.kind === "held" ? "held"
        : view.kind === "notSent" ? "notSent"
        : "";
      const failed = stops[id]?.state === "failed" ? "stopFailed" : "";
      for (const next of [kind, failed]) {
        if (!next || said.current.get(`${id}:${next}`)) continue;
        said.current.set(`${id}:${next}`, "1");
        announce(replyAnnouncement(next as Parameters<typeof replyAnnouncement>[0], t));
      }
    }
    // A rate-limited question's countdown reached 0 (§3.5): said once for that try.
    for (const item of locals) {
      if (item.status !== "rateLimited" || !item.retryAt || item.retryAt > now) continue;
      const mark = `${item.key}:canAskAgain:${item.retryAt}`;
      if (said.current.get(mark)) continue;
      said.current.set(mark, "1");
      announce(replyAnnouncement("canAskAgain", t));
    }
    // A reply that arrives (not one already there when the conversation loaded) is read once.
    if (!loaded) return;
    const replies = messages.filter((message) => message.role === "assistant" && !deleted(message));
    if (known.current === null) {
      known.current = new Set(replies.map((message) => message.id));
      return;
    }
    for (const reply of replies) {
      if (known.current.has(reply.id)) continue;
      known.current.add(reply.id);
      announce(repliedAnnouncement(plainExcerpt(reply.content), t));
    }
  });

  // The collapsed sheet's one line (bridge.ts `latest`): the reply on its way, or the latest one.
  const lastReply = shown.findLast((message) => message.role === "assistant" && !deleted(message));
  const runningView = running ? views.get(running.id)?.view : undefined;
  // The dots give way to the text at its first token (M8): a streaming line is the text alone.
  const latestLine = runningView?.kind === "streaming"
    ? { text: plainExcerpt(runningView.text).slice(0, 160), busy: false }
    : inProgress
      ? { text: t("conversation.preparing"), busy: true }
      : lastReply
        ? { text: plainExcerpt(lastReply.content).slice(0, 160), busy: false }
        : null;
  useEffect(() => {
    companionBridge.updateActivity({ latest: latestLine });
  }, [latestLine?.text, latestLine?.busy]);
  useEffect(() => () => companionBridge.updateActivity({ latest: null }), []);

  // Whose turn it is, and what the box says.
  const turn = turnState(shown, { inProgress });
  const emptyThread = loaded && !shown.length && !locals.length;
  const placeholder = composerPlaceholder({
    inLesson,
    emptyThread,
    yourTurn: turn.yourTurn,
    inProgress,
    ...(placeholderAttachment(focus) ? { attachment: placeholderAttachment(focus) } : {}),
  }, t);

  // Credit: whether the next message would turn an open counted check into practice.
  const scope = server ? creditScope(server, context.episodeId, checkNow, focus.check?.challengeId) : context.independentChallengeIds;
  const needsConsent = inLesson && scope.length > 0;

  // The notice slot (§3.6): one item by priority.
  const held = shown.filter((message) => message.role === "learner" && companionHasPending([message]));
  const paused = held.findLast(companionHeldByLimit)?.job_ceiling as PausedCeiling | undefined;
  const notSetUp = availability === "not_set_up" || held.some((message) => message.job_reason === "configuration_missing" || message.job_state === "configuration_pending");
  const exhausted = Boolean(closed?.exhausted);
  const { notice, creditInMeta } = chooseNotice({
    exhausted,
    ...(paused ? { paused } : {}),
    notSetUp,
    lessonUnavailable: Boolean(unavailable) && !exhausted,
    outsideLesson: !inLesson,
    ...(nextLesson ? { next: nextLesson } : {}),
    offline: !online,
    draftConflict: Boolean(draftConflict),
    recovered,
    storage: Boolean(storageUnavailable),
    ...(closed && !closed.exhausted ? { closed: closed.allowance } : {}),
    credit: needsConsent,
  });
  // Outside a lesson the pill shows with the draft carried from the lesson (Send off, "Keep
  // drafting. Send it from a lesson.", §3.6) and stays while the learner is on this page, even when
  // they empty it; an empty thread outside a lesson has no pill (§3.10). Only a closed course with
  // no questions left takes it away in a lesson.
  const draftedOutside = useRef(false);
  if (inLesson) draftedOutside.current = false;
  else if (value.trim()) draftedOutside.current = true;
  const showPill = !exhausted && (inLesson || draftedOutside.current);
  const blocked = !inLesson || (Boolean(unavailable) && !exhausted);
  const button: SendStopState = stopping
    ? "stopping"
    : inProgress
      ? "running"
      : blocked
        ? "blocked"
        : value.length > MESSAGE_MAX
          ? "over"
          : !value.trim()
            ? "empty"
            : !online
              ? "offline"
              : "ready";

  /** Sends `text` as the learner's next turn, asking for consent first when it would turn an
   * open counted check into practice. Errors stay with the question, never in the page. True once
   * the server has accepted it. */
  async function submit(text: string, { consent, fromBox, key }: { consent?: true; fromBox: boolean; key?: string }): Promise<boolean> {
    if (!text.trim() || blocked || exhausted || text.length > MESSAGE_MAX) return false;
    if (!consent && needsConsent) {
      setConfirm({ text, fromBox });
      return false;
    }
    setConfirm(null);
    // The same text as a question of this page that could not be sent (or was rate-limited) is that
    // question asked again, however it is sent: its turn is reused, so it never shows twice and its
    // "Try again" goes with it. Sent from the box, where its text went back, an edit of it counts too.
    const same = (item: LocalTurn) =>
      item.text.trim() === text.trim() || (fromBox && item.fromBox && text.includes(item.text.trim()));
    const stale = key ? [] : locals.filter((item) => (item.status === "failed" || item.status === "rateLimited") && same(item));
    const id = key ?? stale[0]?.key ?? localKey();
    const superseded = new Set(stale.map((item) => item.key));
    const sentAt = Date.now();
    if (fromBox) {
      // The box clears at once (the bubble shows the text); the saved draft goes only once the
      // server accepted the message.
      clearTimeout(saveTimer.current);
      setValue("");
    }
    const turnRecord: LocalTurn = { key: id, text, status: online ? "sending" : "held", ...(consent ? { consent } : {}), episodeId: context.episodeId, sentAt, fromBox,
      before: messages.filter((row) => row.role === "learner").map((row) => row.id) };
    setLocals((list) => [...list.filter((item) => item.key !== id && !superseded.has(item.key)), turnRecord]);
    anchorNext.current = id;
    if (!online) {
      announce(replyAnnouncement("held", t));
      return false;
    }
    const scopeId = context.episodeId;
    // The text goes back to the box (its saved draft still holds it: it is cleared only once the
    // server accepted the message).
    const giveBack = () => {
      if (!fromBox || latest.current.episodeId !== scopeId || latest.current.value) return;
      setValue(text);
      if (latest.current.draft !== text) save(text);
    };
    try {
      const receipt = await onSend(text, consent);
      if (!receipt?.messageId || receipt.state !== "queued")
        // i18n-ignore: internal signal, caught below and shown as "save not confirmed"
        throw new Error("Unconfirmed companion response");
      clocks.current.set(receipt.messageId, { since: sentAt });
      updateLocal(id, { status: "sent", messageId: receipt.messageId });
      // A question saved for after the check is done once its text is sent, however it was sent.
      const enrollment = server?.enrollmentId;
      if (enrollment && scopeId && deferredQuestion.get(enrollment, scopeId)?.text.trim() === text.trim()) deferredQuestion.clear(enrollment, scopeId);
      // A recovered message was there to check before sending another; one was sent now.
      dismissRecovered();
      if (fromBox && latest.current.draft === text) save("");
      if (stopAfterSend.current.delete(id)) void stopQuestion(receipt.messageId, text, true);
      return true;
    } catch (cause) {
      stopAfterSend.current.delete(id);
      if (cause instanceof CourseApiError && cause.code === "ASSESSMENT_HELP_CONSENT_REQUIRED") {
        updateLocal(id, null);
        giveBack();
        setConfirm({ text, fromBox });
        return false;
      }
      if (cause instanceof CourseApiError && cause.code === "HELP_BUDGET_EXHAUSTED") {
        updateLocal(id, null);
        giveBack();
        return false;
      }
      const retry = cause instanceof CourseApiError ? Number(cause.details?.retryAfter ?? cause.details?.retryAfterSeconds) : NaN;
      if (cause instanceof CourseApiError && cause.status === 429 && Number.isFinite(retry) && retry > 0) {
        updateLocal(id, { status: "rateLimited", retryAt: Date.now() + retry * 1000 });
        giveBack();
        return false;
      }
      const uncertain = !(cause instanceof CourseApiError) || ["NETWORK_UNCERTAIN", "INVALID_RESPONSE", "READ_TIMEOUT"].includes(cause.code);
      updateLocal(id, { status: uncertain ? "unconfirmed" : "failed" });
      if (!uncertain) giveBack();
      announce(replyAnnouncement(uncertain ? "unconfirmed" : "sendFailed", t));
      return false;
    }
  }

  /**
   * A question saved for after the check, sent now ("Send it now"): asked first like any message.
   * It stays saved until the server accepts it (submit clears it then). While it would still make
   * a counted question practice, or offline, it goes into the message box and waits there like any
   * message; a try that failed is tried again in its own bubble.
   */
  async function sendSaved(text: string): Promise<boolean> {
    if (needsConsent || !online) {
      fill(text);
      if (needsConsent) setConfirm({ text, fromBox: true });
      return false;
    }
    const failed = locals.find((item) => item.status === "failed" && item.text === text);
    return submit(text, { fromBox: false, ...(failed ? { key: failed.key } : {}) });
  }

  // Held while offline: sent once the browser is back online, from the same lesson.
  useEffect(() => {
    if (!online) return;
    const waiting = locals.filter((item) => item.status === "held" && item.episodeId === context.episodeId);
    if (!waiting.length) return;
    announce(replyAnnouncement("backOnline", t));
    for (const item of waiting) void submit(item.text, { ...(item.consent ? { consent: item.consent } : {}), fromBox: false, key: item.key });
  }, [online]);

  /** Stops the reply on its way. Before its call was sent the question is cancelled and its text
   * goes back to the box; after, the text on screen stays (muted, never saved; Q10). */
  const stopAfterSend = useRef(new Set<string>());
  async function stopQuestion(messageId: string, text: string, beforeSent: boolean) {
    if (!onCancelQuestion) return;
    const replyDraft = views.get(messageId)?.draft;
    const partial = beforeSent ? "" : (replyDraft?.checking ? "" : replyDraft?.text ?? "");
    setStops((all) => ({ ...all, [messageId]: { state: "stopping", partial } }));
    try {
      await onCancelQuestion(messageId);
      if (beforeSent) {
        cancelledHere.current.add(messageId);
        setStops(({ [messageId]: _, ...rest }) => rest);
        // Its bubble of this page goes too (a send whose answer came before the conversation was
        // read again would otherwise show it as still being prepared).
        setLocals((list) => list.filter((item) => item.messageId !== messageId && keyByMessage.get(messageId) !== item.key));
        putBack(text);
        announce(replyAnnouncement("cancelled", t));
      } else setStops((all) => ({ ...all, [messageId]: { state: "stopped", partial } }));
    } catch {
      setStops((all) => ({ ...all, [messageId]: { state: "failed", partial } }));
    }
  }
  function stop(): boolean {
    if (sending?.messageId) {
      void stopQuestion(sending.messageId, sending.text, true);
      return true;
    }
    if (sending) {
      stopAfterSend.current.add(sending.key);
      return true;
    }
    if (!running) return false;
    const replyDraft = views.get(running.id)?.draft;
    void stopQuestion(running.id, running.content, !companionReplyStarted(running, replyDraft));
    return true;
  }
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => companionBridge.registerStop(() => stopRef.current()), []);

  // Requests from elsewhere in the app (bridge.ts): text for the box, focus, a message to show.
  const wasOpen = useRef(open);
  useEffect(() => {
    wasOpen.current = open;
  }, [open]);
  const pendingReveal = useRef<string | null>(null);
  useEffect(
    () =>
      companionBridge.onCompose((request) => {
        if (request.text !== undefined) fill(request.text, { focusBox: false });
        if (request.revealMessageId) pendingReveal.current = request.revealMessageId;
        requestAnimationFrame(() => {
          if (request.focus !== false) {
            const field = composer.current?.textarea();
            field?.focus({ preventScroll: true });
            const end = field?.value.length ?? 0;
            field?.setSelectionRange(end, end);
          }
          // Text or an attachment put into a composer that was already open is marked (M15): "Ask
          // the companion" at a check (or a selection, code lines, a video moment, a part of an
          // illustration) adds only its chip.
          const pill = composer.current?.pill();
          const attached = ["check", "selection", "code", "video", "illustration"].includes(request.source);
          if ((request.text !== undefined || attached) && wasOpen.current && pill) ringComposer(pill);
          revealPending();
        });
      }),
    [],
  );
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  function revealPending() {
    const id = pendingReveal.current;
    if (!id || !loadedRef.current) return;
    const element = thread.current?.element()?.querySelector<HTMLElement>(`[data-message-id="${id.replace(/["\\]/g, "")}"]`);
    if (!element) return;
    pendingReveal.current = null;
    thread.current?.reveal(element);
  }

  // Anchor on send (G1): the new question near the top, the reply growing under it.
  const anchorNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = anchorNext.current;
    if (!key) return;
    const scroller = thread.current?.element();
    const bubble = scroller?.querySelector<HTMLElement>(`[data-turn-key="${key}"] .cc-chat-bubble`);
    if (!bubble) return;
    anchorNext.current = null;
    // Answering a question: the question's first line is anchored instead, when it fits.
    const questions = scroller ? [...scroller.querySelectorAll<HTMLElement>("[data-cc-question]")] : [];
    const asked = questions.filter((node) => node.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
    thread.current?.anchor(bubble, asked ?? null);
  });

  // Opening: at the start of the oldest unread reply, else at the latest (§3.8 item 3). The
  // bridge's unread fields are cleared as soon as the thread shows (unread.ts), before the thread
  // reports that it was shown, so the oldest unread reply seen while it was hidden is kept here
  // until an opening uses it.
  const unreadAtOpen = useRef(companionBridge.activity().firstUnreadId);
  useEffect(() => {
    unreadAtOpen.current = companionBridge.activity().firstUnreadId;
    return companionBridge.onActivity((activity) => {
      if (activity.firstUnreadId) unreadAtOpen.current = activity.firstUnreadId;
      // Read some other way while hidden (another enrollment, the record cleared): nothing to open at.
      else if (!thread.current?.element()?.getClientRects().length) unreadAtOpen.current = undefined;
    });
  }, [context.enrollmentId]);
  const openAtStart = useCallback(() => {
    const scroller = thread.current?.element();
    const unread = companionBridge.activity().firstUnreadId ?? unreadAtOpen.current;
    // Used once it shows; a load behind a closed companion keeps it for the opening.
    if (scroller?.getClientRects().length) unreadAtOpen.current = undefined;
    const element = unread ? scroller?.querySelector<HTMLElement>(`[data-message-id="${unread.replace(/["\\]/g, "")}"]`) : null;
    // A conversation with no messages opens at the start of its empty state (§3.10): where the
    // learner is comes first, also when the empty state is taller than a sheet at Half.
    const empty = scroller?.querySelector<HTMLElement>(".cc-chat-empty");
    thread.current?.open(element ?? empty ?? null);
    revealPending();
  }, []);
  useLayoutEffect(() => {
    if (loaded) openAtStart();
  }, [loaded, context.enrollmentId]);

  // The composer zone never takes more than 40 % of the thread (§6 reflow): chips fold, and the
  // box grows at most to 40 % of the companion's height.
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver !== "function") return;
    const measure = () => {
      const height = node.clientHeight;
      if (!height) return;
      // Written only when it changes: the observer watches this node, and a write that resizes it
      // again from its own callback is a loop.
      const cap = `${Math.round(height * 0.4)}px`;
      if (node.style.getPropertyValue("--cc-composer-cap") !== cap) node.style.setProperty("--cc-composer-cap", cap);
      const zone = node.querySelector<HTMLElement>(".cc-chat-composer")?.offsetHeight ?? 0;
      setFolded(zone > 0.4 * Math.max(1, height - zone));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // The zone grows on its own too (a notice, an attachment, more lines).
    const zone = node.querySelector<HTMLElement>(".cc-chat-composer");
    if (zone) observer.observe(zone);
    measure();
    return () => observer.disconnect();
  }, []);

  // A change that fails rejects: the delete confirm or the reply it was made from says so in
  // place, so the thread has no notice of its own for it.
  async function correct(messageId: string, run: () => Promise<void>) {
    setCorrecting(messageId);
    try {
      await run();
    } finally {
      setCorrecting("");
    }
  }
  const remove = onDeleteMessage ? (messageId: string) => correct(messageId, () => onDeleteMessage(messageId)) : undefined;
  const exclude = onExcludeContext
    ? (messageId: string, excluded: boolean) => correct(messageId, () => onExcludeContext(messageId, excluded))
    : undefined;
  // The anchor chip above a question is a jump like "Try question 1": the sheet makes room and
  // focus view goes back beside the lesson first (showInLesson).
  const showLesson = (target: LessonTarget) => showInLesson(target, context.episodeId);
  // "Ask again" puts the question back in the box, after whatever the learner has written since.
  // A stalled reply still on its way is given up first (cancelled like a Stop, without the
  // learner's stop line), so the round button is Send again and the next Enter asks it.
  const askAgain = (message: CompanionMessage) => {
    const entry = views.get(message.id);
    if (entry?.view.kind === "streaming" && entry.view.line === "stalled" && !stops[message.id] && replyInProgress(message, entry.view)) {
      const partial = entry.view.text;
      setStops((all) => ({ ...all, [message.id]: { state: "abandoned", partial } }));
      if (onCancelQuestion)
        onCancelQuestion(message.id).catch(() => setStops((all) => ({ ...all, [message.id]: { state: "failed", partial } })));
    }
    putBack(message.content);
  };
  // A chip is the learner's turn: it goes, and the focus stays in the message box, as after a send
  // (§6), instead of falling to the page with the chip row.
  const sendChip = (text: string) => {
    void submit(text, { fromBox: false });
    composer.current?.focus();
  };

  // What the conversation held when it was first read: those replies are there, not arriving, so
  // they do not fade in (M1, M7 are for what arrives).
  const firstRead = useRef<ReadonlySet<string> | null>(null);
  if (loaded && firstRead.current === null) firstRead.current = new Set(messages.map((message) => message.id));
  // Earlier messages read on request come above the first read: they are not arriving either.
  const firstKnown = firstRead.current ? messages.findIndex((message) => firstRead.current!.has(message.id)) : -1;
  const earlier = new Set(messages.slice(0, Math.max(0, firstKnown)).map((message) => message.id));
  const arriving = (id: string) => firstRead.current !== null && !firstRead.current.has(id) && !earlier.has(id);

  // The thread's items, in order: dividers, turns and their reply rows.
  const conversation = { enrollmentId: context.enrollmentId, episodeTitles, server };
  // A question of this page not yet read back is the latest: the saved one before it gives up
  // "Ask again" in the same frame as the new bubble shows, so nothing moves once it is anchored.
  const unsaved = locals.some((item) => {
    const saved = matched.get(item.key);
    return !saved || !messages.some((message) => message.id === saved);
  });
  const latestQuestion = unsaved ? undefined : shown.findLast((message) => message.role === "learner")?.id;
  const latestReply = lastReply?.id;
  // The reply whose actions stay shown: the newest one while nothing was asked after it. Once a
  // newer question is on its way (preparing, streaming, stopped, held), the earlier reply's row
  // shows on hover or focus only (§3.7).
  const settledReply = unsaved ? undefined : turn.latestReplyId;
  const items: React.ReactNode[] = [];
  let previous: CompanionMessage | undefined;
  let lessonOf: string | null | undefined;
  let first = true;
  for (const message of shown) {
    if (message.role === "assistant" && deleted(message)) continue;
    const at = Date.parse(message.created_at);
    if (!previous || (Number.isFinite(at) && at - Date.parse(previous.created_at) > DATE_GAP_MS))
      items.push(<DateDivider key={`date-${message.id}`} iso={message.created_at} now={now} />);
    if (previous?.context.courseDigest && message.context.courseDigest && previous.context.courseDigest !== message.context.courseDigest)
      items.push(<VersionLine key={`version-${message.id}`} />);
    // The lesson a message belongs to: its own, or (a reply saved before replies carried their
    // lesson) its question's. A divider names it where it changes.
    const question = message.role === "assistant" && message.job_id ? shown.find((row) => row.role === "learner" && row.job_id === message.job_id) : undefined;
    // A deleted question keeps no lesson: its line stands where it was, in the lesson around it,
    // and never starts a lesson of its own (§3.4).
    const episode = message.role === "learner" && deleted(message) && !message.context.episodeId
      ? first ? (shown.slice(shown.indexOf(message) + 1).find((row) => !deleted(row))?.context.episodeId ?? null) : lessonOf ?? null
      : message.context.episodeId ?? question?.context.episodeId ?? null;
    if (first || episode !== lessonOf) {
      if (!first && lessonOf) items.push(<CreditLineBeforeDivider key={`credit-${message.id}`} episodeId={lessonOf} server={server} />);
      const label = lessonLabel(episode, context.episodeId, episodeTitles, t);
      items.push(<LessonDivider key={`lesson-${message.id}`} label={label} known={Boolean(episode && Object.hasOwn(episodeTitles, episode))} />);
      lessonOf = episode;
      first = false;
    }
    if (message.role === "learner") {
      if (deleted(message)) {
        items.push(<DeletedLine key={message.id} />);
        previous = message;
        continue;
      }
      const entry = views.get(message.id);
      const view = entry?.view ?? { kind: "none" as const };
      const footer: BubbleFooter | undefined =
        view.kind === "held"
          ? { kind: "held", ...(onCancelQuestion ? { onCancel: () => void stopQuestion(message.id, message.content, true) } : {}) }
          : view.kind === "notSent"
            ? { kind: "notSent", onEdit: () => fill(message.content) }
            : undefined;
      const key = keyByMessage.get(message.id) ?? message.id;
      items.push(
        <div key={key} data-turn-key={key} className="cc-chat-item">
          <LearnerTurn
            id={`cc-turn-${message.id}`}
            messageId={message.id}
            text={message.content}
            anchor={turnAnchor(message, t)}
            onAnchor={showLesson}
            footer={footer}
            actions={
              <BubbleActions
                message={message}
                latest={message.id === latestQuestion}
                inProgress={correcting === message.id}
                {...(remove ? { onDelete: remove } : {})}
                onEditResend={(row) => fill(row.content)}
                {...(exclude ? { onExclude: exclude } : {})}
              />
            }
          />
          {/* Under the question that caused it, above its reply row: it stays put when the reply
              comes (the reply takes the row's place below it). */}
          <CreditLineAfter message={message} />
          <ReplyRow
            view={view}
            latest={message.id === latestQuestion}
            onAskAgain={() => askAgain(message)}
            fresh={arriving(message.id)}
          />
        </div>,
      );
    } else {
      const latestOne = message.id === latestReply && message.id === turn.latestReplyId;
      const chipsShown = latestOne && inLesson && !value && !exhausted && !blocked;
      items.push(
        <CompanionTurn
          key={message.id}
          message={message}
          label={previous?.role !== "assistant"}
          asks={asksLearner(message)}
          yourTurn={latestOne && turn.yourTurn}
          hint={isWithheldHint(message)}
          fresh={arriving(message.id)}
          {...(latestOne && inLesson && !blocked ? { onContinue: () => sendChip(continueText(t)) } : {})}
          actions={
            <div className="cc-chat-reply-actions">
            <ReplyActions
              message={message}
              messages={messages}
              conversation={conversation}
              latest={message.id === settledReply}
              context={context}
              busy={correcting}
              {...(exclude ? { onExclude: exclude } : {})}
            />
            </div>
          }
          chips={chipsShown ? (() => {
            const row = <ChipRow chips={replyChips(needsConsent ? { ...turn, showMeHow: false } : turn, t)} onSend={sendChip} onFill={(text) => fill(text)} folded={folded} fresh={arriving(message.id)} label={t("conversation.suggestions")} />;
            // A reply that ends a run of practice: back to the part the learner was on (showInLesson).
            return turn.backToLesson
              ? <BackToLesson chips={row} onBack={() => showLesson({ episodeId: message.context.episodeId ?? context.episodeId, blockId: context.blockId ?? message.context.blockId ?? undefined, focus: "block" })} />
              : row;
          })() : undefined}
        />,
      );
    }
    previous = message;
  }
  // Questions of this page not yet in the saved conversation.
  for (const item of locals) {
    const saved = matched.get(item.key);
    if (saved && messages.some((message) => message.id === saved)) continue;
    const footer: BubbleFooter | undefined =
      item.status === "held"
        ? {
            kind: "held",
            onCancel: () => {
              updateLocal(item.key, null);
              putBack(item.text);
              announce(replyAnnouncement("cancelled", t));
            },
          }
        : item.status === "failed"
          ? {
              kind: "sendFailed",
              onRetry: () => {
                // The text went back to the box: sent again, it leaves the box as a send does (and
                // comes back if this try fails too). The focus stays in the box.
                const inBox = latest.current.value === item.text;
                void submit(item.text, { ...(item.consent ? { consent: item.consent } : {}), fromBox: inBox, key: item.key });
                composer.current?.focus();
              },
            }
          : item.status === "unconfirmed"
            ? { kind: "unconfirmed", ...(onRefresh ? { onRefresh: () => { updateLocal(item.key, null); onRefresh(); } } : {}) }
            : undefined;
    const seconds = item.status === "rateLimited" && item.retryAt ? Math.max(0, (item.retryAt - now) / 1000) : undefined;
    // The same dividers as the saved question will have, so nothing moves when it is read back.
    const sentIso = new Date(item.sentAt).toISOString();
    if (!previous || item.sentAt - Date.parse(previous.created_at) > DATE_GAP_MS) items.push(<DateDivider key={`date-${item.key}`} iso={sentIso} now={now} />);
    const episode = item.episodeId ?? null;
    if (first || episode !== lessonOf) {
      if (!first && lessonOf) items.push(<CreditLineBeforeDivider key={`credit-${item.key}`} episodeId={lessonOf} server={server} />);
      items.push(<LessonDivider key={`lesson-${item.key}`} label={lessonLabel(episode, context.episodeId, episodeTitles, t)} known={Boolean(episode && Object.hasOwn(episodeTitles, episode))} />);
      lessonOf = episode;
      first = false;
    }
    previous = { id: item.key, role: "learner", content: item.text, context: { ...(item.episodeId ? { episodeId: item.episodeId } : {}) }, created_at: sentIso };
    items.push(
      <div key={item.key} data-turn-key={item.key} className="cc-chat-item">
        <LearnerTurn id={`cc-turn-${item.key}`} text={item.text} footer={footer} />
        {seconds !== undefined && <ReplyRow view={{ kind: "none" }} latest rateLimited={seconds} />}
        {/* With no companion set up the question is held once it is read back: never "Preparing". */}
        {(item.status === "sending" || item.status === "sent") && availability !== "not_set_up" && now - item.sentAt >= REPLY_MS.preparing && (
          <ReplyRow view={{ kind: "preparing", slow: now - item.sentAt >= REPLY_MS.slow }} latest={false} />
        )}
      </div>,
    );
  }

  return (
    <div ref={root} className="cc-chat" data-in-progress={inProgress ? "true" : undefined} data-sheet={layout?.placement === "sheet" ? (layout.sheet ?? "phone") : undefined}>
      <Thread ref={thread} loaded={loaded} failed={Boolean(error)} empty={emptyThread} {...(onRefresh ? { onRetry: onRefresh } : {})} onShown={openAtStart}>
        <EarlierMessages conversation={conversation} />
        {items}
        {/* A conversation that could not be read is not an empty one. */}
        {emptyThread && !error && (
          <EmptyState
            {...(context.episodeTitle ? { lesson: context.episodeTitle } : {})}
            {...(context.blockTitle ? { part: context.blockTitle } : {})}
            inLesson={inLesson}
            onFill={(text) => fill(text)}
            folded={folded}
            showChips={!value && !blocked && !exhausted}
          />
        )}
        <DecisionLine api={api} server={server} />
        <CreditThreadEnd onSend={sendSaved} server={server} episodeId={context.episodeId} />
      </Thread>
      <Composer
        ref={composer}
        value={value}
        onChange={change}
        placeholder={placeholder}
        focus={focus}
        {...(notice ? { notice } : {})}
        creditInMeta={creditInMeta}
        button={button}
        running={inProgress}
        onSend={(byKeyboard) => {
          void submit(value, { fromBox: true });
          // Focus stays in the message box after a send (§3.5, §6), a tap on a touch screen too:
          // left on the round button, which turns into Stop, a second tap would stop the reply.
          if (!byKeyboard) composer.current?.focus();
        }}
        onStop={() => void stop()}
        confirm={
          confirm ? (
            <SendConfirm
              server={server}
              episodeId={context.episodeId}
              now={checkNow}
              pending={false}
              sendDisabled={blocked}
              onKeep={() => {
                setConfirm(null);
                composer.current?.focus();
              }}
              onSendAsPractice={() => {
                void submit(confirm.text, { consent: true, fromBox: confirm.fromBox });
                // The confirm row goes: the focus it had stays in the message box, as after a send.
                composer.current?.focus();
              }}
              // "Save for after the question" sets the message aside (deferredQuestion.ts) and
              // empties the box; a question already saved there is not saved twice.
              {...(server?.enrollmentId && context.episodeId && deferredQuestion.get(server.enrollmentId, context.episodeId)?.text.trim() === confirm.text.trim()
                ? {}
                : {
                    draft: confirm.text,
                    onSaveForLater: () => {
                      if (confirm.fromBox) {
                        setValue("");
                        save("");
                      }
                      setConfirm(null);
                    },
                  })}
            />
          ) : undefined
        }
        showPill={showPill}
        maxLines={layout?.sheet === "short" ? 3 : layout?.sheet === "phone" ? 5 : 8}
        server={server}
        episodeId={context.episodeId}
        now={checkNow}
        {...(onDraftChoice ? { onDraftChoice } : {})}
        onShowRecovered={() => {
          dismissRecovered();
          const question = latestQuestion && thread.current?.element()?.querySelector<HTMLElement>(`[data-message-id="${latestQuestion}"]`);
          if (question) thread.current?.reveal(question);
        }}
      />
    </div>
  );
}
