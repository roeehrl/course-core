import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_FALLBACK_POLL_MS,
  COMPANION_SAFETY_POLL_MS,
  useCompanionConversation,
} from "../src/hooks/useCompanionConversation";
import type { CompanionMessage, ContextualCompanionClient } from "../src/client/companionClient";

const answered: CompanionMessage = {
  id: "q",
  role: "learner",
  content: "Why does it change?",
  context: { episodeId: "intro" },
  created_at: "2026-01-01",
  job_state: "succeeded",
};
const queued: CompanionMessage = { ...answered, id: "q2", job_state: "queued", job_id: "job" };

/** A fake event stream: each GET .../events/stream opens one that the test writes to. */
function fakeStream() {
  const encoder = new TextEncoder();
  const opened: { url: string; push(text: string): void; signal: AbortSignal }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    let push: (text: string) => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
      },
    });
    opened.push({ url, push: (text) => push(text), signal: init.signal! });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const event = (id: number, type: string) =>
    `id: ${id}\nevent: learning-event\ndata: ${JSON.stringify({ event_type: type })}\n\n`;
  return { opened, event };
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("companion conversation, event-driven", () => {
  it("keeps one stream across course revisions and the panel opening, and does not poll while it is up", async () => {
    const stream = fakeStream();
    const load = vi.fn().mockResolvedValue([answered]);
    const client: ContextualCompanionClient = { load, send: vi.fn() };
    let renders = 0;
    const { rerender, result, unmount } = renderHook(
      ({ open, revision }) => {
        renders++;
        return useCompanionConversation(client, "e", open, revision);
      },
      { initialProps: { open: true, revision: 1 } },
    );
    await waitFor(() => expect(stream.opened).toHaveLength(1));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(load).toHaveBeenCalledTimes(1);
    const first = result.current;
    const rendersAfterLoad = renders;
    // The open panel used to read the conversation every 3 s; with the stream up it waits for events.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 3500)));
    expect(load).toHaveBeenCalledTimes(1);
    expect(renders).toBe(rendersAfterLoad);
    // A new revision re-reads once over the same stream; the same answer changes nothing.
    rerender({ open: true, revision: 2 });
    rerender({ open: false, revision: 3 });
    rerender({ open: true, revision: 3 });
    await settle();
    expect(stream.opened).toHaveLength(1);
    expect(stream.opened[0]!.signal.aborted).toBe(false);
    expect(load.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(load.mock.calls.length).toBeLessThanOrEqual(4);
    expect(result.current).toBe(first);
    // Only the three rerenders above: no state update came from the identical reads.
    expect(renders).toBe(rendersAfterLoad + 3);
    // An unrelated event reads nothing; a companion event reads at once and shows the change.
    const before = load.mock.calls.length;
    stream.opened[0]!.push(stream.event(5, "block.read"));
    await settle();
    expect(load).toHaveBeenCalledTimes(before);
    load.mockResolvedValue([answered, { ...answered, id: "a", role: "assistant", content: "Because." }]);
    stream.opened[0]!.push(stream.event(6, "companion.answered"));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(load).toHaveBeenCalledTimes(before + 1);
    unmount();
    expect(stream.opened[0]!.signal.aborted).toBe(true);
  }, 10000);

  it("reads a replayed burst of events with at most two requests", async () => {
    const stream = fakeStream();
    let release: () => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<readonly CompanionMessage[]>((resolve) => {
          release = () => resolve([answered]);
        }),
    );
    const client: ContextualCompanionClient = { load, send: vi.fn() };
    renderHook(() => useCompanionConversation(client, "e", true, 1));
    await waitFor(() => expect(stream.opened).toHaveLength(1));
    // A fresh stream replays the enrollment's history: many companion events in one chunk.
    stream.opened[0]!.push(
      Array.from({ length: 40 }, (_, i) => stream.event(i + 1, i % 2 ? "companion.answered" : "companion.asked")).join(""),
    );
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await act(async () => release());
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("falls back to polling only while the stream is down, and to a slow safety read while a reply is due", async () => {
    vi.useFakeTimers();
    // No stream at all (refused): the open panel reads every few seconds.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429 })));
    const load = vi.fn().mockResolvedValue([answered]);
    const client: ContextualCompanionClient = { load, send: vi.fn() };
    let renders = 0;
    const { rerender, unmount } = renderHook(
      ({ open }) => {
        renders++;
        return useCompanionConversation(client, "e", open, 1);
      },
      { initialProps: { open: true } },
    );
    await act(async () => {});
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    const settled = renders;
    await act(async () => vi.advanceTimersByTimeAsync(COMPANION_FALLBACK_POLL_MS * 3));
    expect(load).toHaveBeenCalledTimes(4);
    // Identical answers: no state update, so no render.
    expect(renders).toBe(settled);
    // Closed with nothing pending: no reads.
    rerender({ open: false });
    await act(async () => {});
    const closed = load.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(COMPANION_FALLBACK_POLL_MS * 3));
    expect(load).toHaveBeenCalledTimes(closed);
    unmount();
    vi.useRealTimers();

    // Stream up and a reply due: only the slow safety read.
    vi.unstubAllGlobals();
    const stream = fakeStream();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = vi.fn().mockResolvedValue([queued]);
    const due: ContextualCompanionClient = { load: pending, send: vi.fn() };
    renderHook(() => useCompanionConversation(due, "e", false, 1));
    await vi.waitFor(() => expect(stream.opened).toHaveLength(1));
    await act(async () => {});
    expect(pending).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(COMPANION_SAFETY_POLL_MS - 100));
    expect(pending).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(pending).toHaveBeenCalledTimes(2);
  });

  it("keeps the shown messages and reports a failed read once, without re-rendering on each repeat", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 429 })));
    const load = vi.fn().mockResolvedValueOnce([answered]).mockRejectedValue(new Error("down"));
    const client: ContextualCompanionClient = { load, send: vi.fn() };
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useCompanionConversation(client, "e", true, 1);
    });
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(COMPANION_FALLBACK_POLL_MS));
    expect(result.current.error).not.toBe("");
    expect(result.current.messages).toEqual([answered]);
    const failedRenders = renders;
    await act(async () => vi.advanceTimersByTimeAsync(COMPANION_FALLBACK_POLL_MS * 2));
    expect(load).toHaveBeenCalledTimes(4);
    expect(renders).toBe(failedRenders);
  });
});
