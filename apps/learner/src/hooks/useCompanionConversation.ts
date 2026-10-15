import { useEffect, useState } from "react";
import { isAbortError } from "../client/apiClient";
import {
  companionHasPending,
  type CompanionMessage,
  type ContextualCompanionClient,
} from "../client/companionClient";
export function useCompanionConversation(
  client: ContextualCompanionClient,
  enrollmentId: string | undefined,
  open: boolean,
  revision: number,
) {
  const [saved, setSaved] = useState<{
    client: ContextualCompanionClient;
    id: string;
    messages: readonly CompanionMessage[];
    error: string;
    loaded: boolean;
  }>();
  useEffect(() => {
    if (!enrollmentId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    // A resumable event stream, when the browser has one, reloads the conversation as soon as
    // a question or an answer is recorded; polling continues more slowly as the fallback.
    let streaming = false;
    const stream =
      typeof EventSource === "undefined"
        ? undefined
        : new EventSource(
            `/api/enrollments/${encodeURIComponent(enrollmentId)}/events/stream`,
          );
    stream?.addEventListener("open", () => {
      streaming = true;
    });
    stream?.addEventListener("error", () => {
      streaming = false;
    });
    stream?.addEventListener("learning-event", (message) => {
      try {
        const type = (JSON.parse((message as MessageEvent<string>).data) as { event_type?: unknown }).event_type;
        if (typeof type === "string" && /^(companion\.|supervisor\.applied$)/.test(type)) {
          clearTimeout(timer);
          void load();
        }
      } catch {
        /* not ours to interpret */
      }
    });
    async function load() {
      try {
        const messages = await client.load(enrollmentId!, controller.signal);
        if (controller.signal.aborted) return;
        pending = companionHasPending(messages);
        setSaved({
          client,
          id: enrollmentId!,
          messages,
          error: "",
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
          error:
            "Conversation could not be refreshed. Your draft is preserved.",
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
      stream?.close();
    };
  }, [client, enrollmentId, open, revision]);
  return saved?.client === client && saved.id === enrollmentId
    ? saved
    : { messages: [] as readonly CompanionMessage[], error: "", loaded: false };
}
