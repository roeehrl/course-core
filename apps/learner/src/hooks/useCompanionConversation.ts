import { useEffect, useState } from "react";
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
      } catch {
        if (controller.signal.aborted) return;
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
      if (!controller.signal.aborted && (open || pending))
        timer = setTimeout(() => void load(), open ? 3000 : 5000);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, enrollmentId, open, revision]);
  return saved?.client === client && saved.id === enrollmentId
    ? saved
    : { messages: [] as readonly CompanionMessage[], error: "", loaded: false };
}
