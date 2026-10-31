import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { isAbortError, pageDepartureSignal } from "../client/apiClient";
import { useT } from "../i18n";
import {
  applyDraftFrame,
  companionHasPending,
  type CompanionDraft,
  type CompanionMessage,
  type ContextualCompanionClient,
} from "../client/companionClient";
/** How often the conversation is read again while the event stream is down (and the panel is open or a reply is due). */
export const COMPANION_FALLBACK_POLL_MS = 5000;
/** A slow safety read while a reply is due and the stream is up, in case an event was lost. */
export const COMPANION_SAFETY_POLL_MS = 30000;
/** Once a reply's draft has ended or its check has finished (`companion.reply.checked`), the stored
 * reply or its outcome is moments away: read at this pace for a short while, so a signal that is
 * lost (or a step that records no event) costs seconds, not the safety read. */
export const COMPANION_SETTLING_POLL_MS = 2000;
/** How many settling reads follow one such signal (20 s in all), before the safety read again. */
export const COMPANION_SETTLING_READS = 10;
/** While a question is not yet prepared into a job, a refusal at preparation (closed-course
 * budget, access policy) records no event of its own; and while its job waits to be picked up,
 * the moment its call is sent is signalled only by the draft opening on this stream (from the
 * process that sends it). Both are read at the fallback pace, so a lost signal shows within
 * seconds, not at the safety read. */
const awaitingStart = (messages: readonly CompanionMessage[], drafted: ReadonlySet<string>) =>
  messages.some((message) => message.role === "learner" && companionHasPending([message]) &&
    (!message.job_id || ((!message.job_state || message.job_state === "queued") && !drafted.has(message.id))));
type Drafts = Readonly<Record<string, CompanionDraft>>;
type HeldDrafts = { id: string; drafts: Drafts; connected: boolean };
const NO_DRAFTS: readonly CompanionDraft[] = [];
type Saved = {
  client: ContextualCompanionClient;
  id: string;
  messages: readonly CompanionMessage[];
  /** The last refresh failed; translated when returned, so it follows the UI locale. */
  failed: boolean;
  loaded: boolean;
};
/**
 * The companion conversation for one enrollment, kept current by events, not by polling.
 *
 * One event stream per enrollment stays open for the life of the panel: a new course revision
 * or opening the panel re-reads the conversation over it, without reopening the stream. A
 * companion event (question saved, answer recorded, supervisor applied) reads it at once.
 * Polling is only a fallback while the stream is down. A read that returns the same messages
 * changes no state, so nothing re-renders when nothing changed. A reply being written arrives on
 * the same stream as draft frames (`companion-draft`), kept per enrollment and never stored.
 */
export function useCompanionConversation(
  client: ContextualCompanionClient,
  enrollmentId: string | undefined,
  open: boolean,
  revision: number,
) {
  const t = useT();
  const [saved, setSaved] = useState<Saved>();
  // The current panel state, read by the stream effect without restarting it.
  const openNow = useRef(open);
  openNow.current = open;
  const reread = useRef<(() => void) | undefined>(undefined);
  const lastSeen = useRef({ open, revision });
  // Replies being written, as streamed over the event stream; kept per enrollment and never stored.
  const [drafts, setDrafts] = useState<HeldDrafts>();
  useEffect(() => {
    if (!enrollmentId) return;
    setDrafts({ id: enrollmentId, drafts: {}, connected: true });
    const updateDrafts = (change: (old: HeldDrafts) => HeldDrafts) =>
      setDrafts((old) => change(old?.id === enrollmentId ? old : { id: enrollmentId, drafts: {}, connected: true }));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false, unprepared = false;
    // Questions whose reply has started on this stream (a draft opened), and the jobs seen so far.
    const drafted = new Set<string>(), seenJobs = new Set<string>();
    let streaming = false;
    // Settling reads left for a reply that just finished being written or checked.
    let settling = 0;
    // One read at a time; requests while one runs (a replayed burst of events) read once more after it.
    let running = false, again = false;
    // The text of the last messages read, to tell a real change from an identical answer.
    let shown: string | undefined, failedShown = false;
    const schedule = () => {
      clearTimeout(timer);
      if (controller.signal.aborted) return;
      const settle = streaming && !unprepared && pending && settling > 0;
      if (settle) settling -= 1;
      const delay = streaming
        ? unprepared ? COMPANION_FALLBACK_POLL_MS
          : pending ? settle ? COMPANION_SETTLING_POLL_MS : COMPANION_SAFETY_POLL_MS : undefined
        : openNow.current || pending ? COMPANION_FALLBACK_POLL_MS : undefined;
      if (delay !== undefined) timer = setTimeout(() => void load(), delay);
    };
    async function load(): Promise<void> {
      if (running) {
        again = true;
        return;
      }
      running = true;
      clearTimeout(timer);
      try {
        const messages = await client.load(enrollmentId!, controller.signal);
        if (controller.signal.aborted) return;
        pending = companionHasPending(messages);
        unprepared = awaitingStart(messages, drafted);
        const text = JSON.stringify(messages);
        // An identical answer sets no state at all (even an updater that returns the old state
        // can cost a render). A change is applied as a transition, so a read never holds back
        // the paint of what the learner just did.
        if (text !== shown || failedShown) {
          const changed = text !== shown;
          startTransition(() =>
            changed
              ? setSaved({ client, id: enrollmentId!, messages, failed: false, loaded: true })
              : setSaved((old) => old && { ...old, failed: false }),
          );
          shown = text;
          failedShown = false;
        }
      } catch (error) {
        // Cancelled (by this effect or by leaving the page): nothing failed.
        if (controller.signal.aborted || isAbortError(error)) return;
        if (!failedShown) {
          failedShown = true;
          startTransition(() =>
            setSaved((old) => ({
              client,
              id: enrollmentId!,
              messages: old?.client === client && old.id === enrollmentId ? old.messages : [],
              failed: true,
              loaded: true,
            })),
          );
        }
      } finally {
        running = false;
      }
      if (again) {
        again = false;
        return load();
      }
      schedule();
    }
    // The enrollment's resumable event stream reads the conversation again as soon as a
    // question or an answer is recorded.
    const onEvent = (type: string) => {
      // The check of a reply ended (kept, withheld or failed): its stored outcome follows shortly.
      // This event comes from the database, so it reaches this stream from any API process.
      if (type === "companion.reply.checked") settling = COMPANION_SETTLING_READS;
      if (/^(companion\.|supervisor\.applied$)/.test(type)) void load();
    };
    void followEventStream(
      `/api/enrollments/${encodeURIComponent(enrollmentId)}/events/stream`,
      controller.signal,
      {
        onOpen: () => {
          streaming = true;
          updateDrafts((old) => (old.connected ? old : { ...old, connected: true }));
          // A new stream replays the enrollment's events and a resumed one continues after
          // the last id, so nothing recorded meanwhile is missed; the fallback timer stops.
          if (!running) schedule();
        },
        onDown: () => {
          streaming = false;
          updateDrafts((old) => (old.connected ? { ...old, connected: false } : old));
          schedule();
        },
        onEvent,
        onDraft: (frame) => {
          updateDrafts((old) => ({ ...old, drafts: applyDraftFrame(old.drafts, frame) }));
          const { state, jobId, messageId } = (frame ?? {}) as { state?: unknown; jobId?: unknown; messageId?: unknown };
          if (typeof messageId === "string") drafted.add(messageId);
          // The first frame of a job is its dispatch: the panel already shows the reply as under
          // way from the frame itself; the saved job is read once to match. A finished draft means
          // the stored reply (or its refusal) is close: read it now. Reads are coalesced.
          const first = typeof jobId === "string" && !seenJobs.has(jobId);
          if (first && seenJobs.size < 1000) seenJobs.add(jobId);
          if (state === "complete" || state === "withdrawn") settling = COMPANION_SETTLING_READS;
          if (first || state === "complete" || state === "withdrawn") void load();
        },
      },
    );
    reread.current = () => void load();
    lastSeen.current = { open: openNow.current, revision };
    void load();
    return () => {
      reread.current = undefined;
      controller.abort();
      clearTimeout(timer);
    };
    // The revision and the panel state are followed by the effect below, in place.
  }, [client, enrollmentId]);
  useEffect(() => {
    const seen = lastSeen.current;
    if (seen.open === open && seen.revision === revision) return;
    lastSeen.current = { open, revision };
    // A new course revision, or the panel opening or closing: read once over the open stream
    // (which also resets the fallback timer for the new panel state).
    reread.current?.();
  }, [open, revision]);
  const conversation = saved?.client !== client || saved.id !== enrollmentId
    ? EMPTY
    : saved.failed ? withError(saved, t("useCompanionConversation.refreshFailed")) : withoutError(saved);
  const held = drafts?.id === enrollmentId ? drafts : undefined;
  // Keeps its identity while neither the conversation nor the drafts changed.
  return useMemo(() => ({
    ...conversation,
    drafts: held ? Object.values(held.drafts) : NO_DRAFTS,
    /** False while the event stream is reconnecting; a draft resumes once it is back. */
    streamConnected: held?.connected ?? true,
  }), [conversation, held]);
}
const EMPTY = { messages: [] as readonly CompanionMessage[], error: "", loaded: false };
// The returned object keeps its identity while the conversation is unchanged, so a memoized
// panel given it does not re-render.
const results = new WeakMap<Saved, { messages: readonly CompanionMessage[]; error: string; loaded: boolean }>();
function withoutError(saved: Saved) {
  let result = results.get(saved);
  if (!result) results.set(saved, (result = { messages: saved.messages, error: "", loaded: saved.loaded }));
  return result;
}
function withError(saved: Saved, error: string) {
  return { messages: saved.messages, error, loaded: saved.loaded };
}

/**
 * Reads a Server-Sent Events stream with fetch, not EventSource: a failed or
 * aborted EventSource load is reported by some browsers (WebKit) as an
 * uncaught page error, while a fetch failure is an ordinary rejection. Resumes
 * with Last-Event-ID, backs off on network failure, honours the server's
 * `reconnect` and `closed` events, and stops for good on a 4xx (signed out,
 * no access, erased, too many streams) so polling takes over.
 */
export async function followEventStream(
  url: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
) {
  if (typeof fetch !== "function" || typeof TextDecoder === "undefined") return;
  // Leaving the page aborts the stream first: a long-lived request the browser has to
  // cancel itself is reported by WebKit as an uncaught "access control checks" error.
  // The stream then stays stopped and polling carries on if the page stays.
  const leaving = pageDepartureSignal();
  if (leaving.aborted) return;
  const local = new AbortController(), stopLocal = () => local.abort();
  signal.addEventListener("abort", stopLocal, { once: true });
  leaving.addEventListener("abort", stopLocal, { once: true });
  try {
    await follow(url, local.signal, handlers);
  } finally {
    signal.removeEventListener("abort", stopLocal);
    leaving.removeEventListener("abort", stopLocal);
  }
}
interface StreamHandlers {
  onOpen(): void;
  onDown(): void;
  onEvent(type: string): void;
  /** A streamed companion draft frame (`companion-draft`), parsed but not yet validated. */
  onDraft?(frame: unknown): void;
}
async function follow(
  url: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
) {
  let last: string | undefined;
  let delay = 3000;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  while (!signal.aborted) {
    let stop = false;
    try {
      const response = await fetch(url, {
        signal,
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "text/event-stream", ...(last ? { "Last-Event-ID": last } : {}) },
      });
      if (response.status >= 400 && response.status < 500) return;
      if (!response.ok || !response.body) throw new Error("stream unavailable");
      handlers.onOpen();
      delay = 3000;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let event = "message", data = "", id: string | undefined;
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) id = line.slice(4);
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (id && /^[0-9]{1,18}$/.test(id)) last = id;
          if (event === "closed") stop = true;
          if (event === "companion-draft" && handlers.onDraft) {
            try {
              handlers.onDraft(JSON.parse(data));
            } catch {
              /* malformed: the stored reply still arrives */
            }
          }
          if (event === "learning-event") {
            try {
              const type = (JSON.parse(data) as { event_type?: unknown }).event_type;
              if (typeof type === "string") handlers.onEvent(type);
            } catch {
              /* not ours to interpret */
            }
          }
        }
        if (stop) break;
      }
      if (stop) await reader.cancel().catch(() => undefined);
    } catch {
      if (signal.aborted) return;
      delay = Math.min(delay * 2, 60000);
    }
    handlers.onDown();
    if (stop || signal.aborted) return;
    await wait(delay);
  }
}
