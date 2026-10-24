import { useEffect, useState } from "react";
import { isAbortError, pageDepartureSignal } from "../client/apiClient";
import { useT } from "../i18n";
import {
  applyDraftFrame,
  companionHasPending,
  type CompanionDraft,
  type CompanionMessage,
  type ContextualCompanionClient,
} from "../client/companionClient";
type Drafts = Readonly<Record<string, CompanionDraft>>;
const NO_DRAFTS: readonly CompanionDraft[] = [];
export function useCompanionConversation(
  client: ContextualCompanionClient,
  enrollmentId: string | undefined,
  open: boolean,
  revision: number,
) {
  const t = useT();
  const [saved, setSaved] = useState<{
    client: ContextualCompanionClient;
    id: string;
    messages: readonly CompanionMessage[];
    /** The last refresh failed; translated when returned, so it follows the UI locale. */
    failed: boolean;
    loaded: boolean;
  }>();
  // Replies being written, as streamed over the event stream; kept per enrollment and never stored.
  const [drafts, setDrafts] = useState<{ id: string; drafts: Drafts; connected: boolean }>();
  useEffect(() => {
    if (!enrollmentId) return;
    setDrafts({ id: enrollmentId, drafts: {}, connected: true });
    const updateDrafts = (change: (old: { id: string; drafts: Drafts; connected: boolean }) => { id: string; drafts: Drafts; connected: boolean }) =>
      setDrafts((old) => change(old?.id === enrollmentId ? old : { id: enrollmentId, drafts: {}, connected: true }));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    // The enrollment's resumable event stream reloads the conversation as soon as a question
    // or an answer is recorded; polling continues more slowly as the fallback.
    let streaming = false;
    const onEvent = (type: string) => {
      if (/^(companion\.|supervisor\.applied$)/.test(type)) {
        clearTimeout(timer);
        void load();
      }
    };
    void followEventStream(
      `/api/enrollments/${encodeURIComponent(enrollmentId)}/events/stream`,
      controller.signal,
      {
        onOpen: () => {
          streaming = true;
          updateDrafts((old) => ({ ...old, connected: true }));
        },
        onDown: () => {
          streaming = false;
          updateDrafts((old) => ({ ...old, connected: false }));
        },
        onEvent,
        onDraft: (frame) => {
          updateDrafts((old) => ({ ...old, drafts: applyDraftFrame(old.drafts, frame) }));
          // A finished draft means the stored reply (or its refusal) is close: read it now.
          const state = (frame as { state?: unknown } | null)?.state;
          if (state === "complete" || state === "withdrawn") {
            clearTimeout(timer);
            void load();
          }
        },
      },
    );
    async function load() {
      try {
        const messages = await client.load(enrollmentId!, controller.signal);
        if (controller.signal.aborted) return;
        pending = companionHasPending(messages);
        setSaved({
          client,
          id: enrollmentId!,
          messages,
          failed: false,
          loaded: true,
        });
      } catch (error) {
        // Cancelled (by this effect or by leaving the page): nothing failed.
        if (controller.signal.aborted || isAbortError(error)) return;
        setSaved((old) => ({
          client,
          id: enrollmentId!,
          messages:
            old?.client === client && old.id === enrollmentId
              ? old.messages
              : [],
          failed: true,
          loaded: true,
        }));
      }
      if (!controller.signal.aborted && (open || pending)) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), open ? 3000 : streaming ? 10000 : 5000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, enrollmentId, open, revision]);
  const held = drafts?.id === enrollmentId ? drafts : undefined;
  const live = {
    drafts: held ? Object.values(held.drafts) : NO_DRAFTS,
    /** False while the event stream is reconnecting; a draft resumes once it is back. */
    streamConnected: held?.connected ?? true,
  };
  if (saved?.client !== client || saved.id !== enrollmentId)
    return { messages: [] as readonly CompanionMessage[], error: "", loaded: false, ...live };
  const { failed, ...rest } = saved;
  return { ...rest, error: failed ? t("useCompanionConversation.refreshFailed") : "", ...live };
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
