import React from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextInput } from "react-native";
import { ConnectedCompanion, lessonLabel, panelScroller, sentNoticeKey } from "../src/components/ConnectedCompanion";
import { stripBidiControls } from "@course-core/i18n";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";
import { CompanionDock } from "../src/components/CompanionDock.web";
import { companionOpen } from "../src/connected/companion/openState";
import { companionLayout } from "../src/domain/companionLayout";
import {
  createCompanionClient,
  companionJobLabel,
  companionState,
  companionHasPending,
  companionCanAskAgain,
  companionCouldNotAnswer,
  companionWithheldNote,
  plainExcerpt,
  type CompanionContextUsed,
  applyDraftFrame,
  type CompanionDraft,
  type CompanionContext,
  type CompanionMessage,
  type ContextualCompanionClient,
} from "../src/client/companionClient";
import { createCourseApi } from "../src/client/apiClient";
import { useCompanionConversation } from "../src/hooks/useCompanionConversation";
import { createConnectedDraftStore } from "../src/connected/drafts";
import { connectedSnapshot } from "./connectedFixtures";
import { companionFocus, selectedLines } from "../src/client/companionFocus";
import { pressWhenReady } from "./pressWhenReady";
import { context, message, receipt } from "./companionFixtures";

// Split from companion.test.tsx: the companion client (commands, polling, focus, cancel, event stream, draft frames).

afterEach(() => vi.useRealTimers());
/** A window that docks the companion beside the lesson, or one that shows it as a sheet. */
const dockLayout = (wide: boolean) => (wide ? companionLayout(1440, 960) : companionLayout(390, 844));
describe("persisted companion integration", () => {
  it("calls implemented endpoints with CSRF, explicit consent, snapshot revision and idempotency", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [message] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    const client = createCompanionClient(
        createCourseApi({ fetch: fetcher, csrf: () => "csrf" }),
      ),
      abort = new AbortController();
    expect(await client.load("e", abort.signal)).toEqual([message]);
    // The read is cancellable: the caller's signal is combined with the page's own
    // (caller cancellation is covered in apiClient.test.ts).
    expect(fetcher.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    await client.send(connectedSnapshot(), {
      episodeId: "intro",
      content: "hello",
    });
    expect(fetcher.mock.calls[1]![0]).toBe(
      "/api/enrollments/enrollment-1/companion",
    );
    const payload = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(payload.expectedRevision).toBe(1);
    expect(payload.idempotencyKey).toBeTruthy();
    expect(payload).not.toHaveProperty("allowAssessmentAssistance");
  });
  it("polls modestly for saved queued work and aborts when context or account changes", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue([message]);
    const client: ContextualCompanionClient = { load, send: vi.fn() };
    const { rerender, unmount } = renderHook(
      ({ id, open }) => useCompanionConversation(client, id, open, 1),
      { initialProps: { id: "a", open: false } },
    );
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(load).toHaveBeenCalledTimes(2);
    const oldSignal = load.mock.calls[1]![1] as AbortSignal;
    rerender({ id: "b", open: true });
    expect(oldSignal.aborted).toBe(true);
    await act(async () => {});
    expect(load.mock.calls.at(-1)?.[0]).toBe("b");
    unmount();
    expect((load.mock.calls.at(-1)![1] as AbortSignal).aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("attaches the learner's focus to the next message only, with the course version and UI revision", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(receipt)));
    const client = createCompanionClient(
      createCourseApi({ fetch: fetcher, csrf: () => "csrf" }),
    );
    const snapshot = connectedSnapshot();
    companionFocus.setSelection({ kind: "text", excerpt: "no greater than" });
    companionFocus.setMedia({ mediaId: "walkthrough", label: "Course video", playbackSeconds: 83.3 });
    await client.send(snapshot, { episodeId: "intro", content: "About this?" });
    const payload = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(payload).toMatchObject({
      uiRevision: snapshot.revision,
      selection: { kind: "text", excerpt: "no greater than", courseDigest: snapshot.courseDigest },
      media: { mediaId: "walkthrough", playbackSeconds: 83.3, courseDigest: snapshot.courseDigest },
    });
    // Sent once, then cleared.
    expect(companionFocus.get()).toEqual({});
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...receipt, messageId: "m2" })));
    await client.send({ ...snapshot, revision: 3 }, { episodeId: "intro", content: "Next" });
    const next = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(next).not.toHaveProperty("selection");
    expect(next).not.toHaveProperty("media");
    expect(selectedLines("a\nbb\nccc", 2, 6)).toEqual({ lineStart: 2, lineEnd: 3 });
  });
  it("sends an attached check as the next message's challengeId, once", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(receipt)));
    const client = createCompanionClient(createCourseApi({ fetch: fetcher, csrf: () => "csrf" }));
    const snapshot = connectedSnapshot();
    companionFocus.setCheck({ challengeId: "c1", ordinal: 2 });
    await client.send(snapshot, { episodeId: "intro", content: "About question 2?" });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ challengeId: "c1" });
    expect(companionFocus.get()).toEqual({});
    await client.send({ ...snapshot, revision: 3 }, { episodeId: "intro", content: "Next" });
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).not.toHaveProperty("challengeId");
  });
  it("sends a cancel command for one question and checks its receipt", async () => {
    const command = vi.fn().mockResolvedValue({ messageId: "m", cancelled: true, revision: 3 }), snapshot = connectedSnapshot();
    const client = createCompanionClient({ command } as unknown as Parameters<typeof createCompanionClient>[0]);
    await expect(client.cancelQuestion!(snapshot, "m")).resolves.toEqual({ messageId: "m", cancelled: true, revision: 3 });
    expect(command).toHaveBeenCalledWith(snapshot, "companion/messages/m/cancel", {});
    command.mockResolvedValueOnce({ messageId: "other", cancelled: true, revision: 3 });
    await expect(client.cancelQuestion!(snapshot, "m")).rejects.toThrow();
  });
  it("reloads at once when the event stream reports a question or an answer, resumes after the last id and stops on 4xx", async () => {
    const encoder = new TextEncoder();
    let push: (text: string) => void = () => {}, end: () => void = () => {};
    const requests: { url: string; headers: Record<string, string>; signal: AbortSignal }[] = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string>, signal: init.signal! });
      if (requests.length === 3) return new Response(null, { status: 410 });
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        push = (text) => controller.enqueue(encoder.encode(text));
        end = () => controller.close();
      } });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const load = vi.fn().mockResolvedValue([]);
      const client: ContextualCompanionClient = { load, send: vi.fn() };
      const { unmount } = renderHook(() => useCompanionConversation(client, "e 1", false, 1));
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]!.url).toBe("/api/enrollments/e%201/events/stream");
      expect(requests[0]!.headers.Accept).toBe("text/event-stream");
      expect(load).toHaveBeenCalledTimes(1);
      push(`id: 7\nevent: learning-event\ndata: ${JSON.stringify({ event_type: "block.read" })}\n\n`);
      await new Promise((r) => setTimeout(r, 20));
      expect(load).toHaveBeenCalledTimes(1);
      push(`id: 8\nevent: learning-event\ndata: ${JSON.stringify({ event_type: "supervisor.applied" })}\n\n: heartbeat\n\nevent: learning-event\ndata: not json\n\n`);
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      // The server ends the stream (reconnect): the client resumes after the last id.
      push("event: reconnect\ndata: {}\n\n");
      end();
      await waitFor(() => expect(requests).toHaveLength(2), { timeout: 5000 });
      expect(requests[1]!.headers["Last-Event-ID"]).toBe("8");
      // A 4xx (erased, signed out, too many streams) stops it for good.
      end();
      await waitFor(() => expect(requests).toHaveLength(3), { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 50));
      expect(requests).toHaveLength(3);
      unmount();
      // An open stream is aborted when the panel unmounts, and when the page starts to leave.
      const second = renderHook(() => useCompanionConversation(client, "e 2", false, 1));
      await waitFor(() => expect(requests).toHaveLength(4));
      second.unmount();
      expect(requests[3]!.signal.aborted).toBe(true);
      const third = renderHook(() => useCompanionConversation(client, "e 3", false, 1));
      await waitFor(() => expect(requests).toHaveLength(5));
      window.dispatchEvent(new Event("beforeunload"));
      expect(requests[4]!.signal.aborted).toBe(true);
      third.unmount();
      window.dispatchEvent(new Event("pageshow"));
    } finally { vi.unstubAllGlobals(); }
  }, 15000);
});

describe("streamed companion replies (T01)", () => {
  const frame = (offset: number, text: string, state = "streaming", extra = {}) => ({ jobId: "job", messageId: "m", offset, text, state, ...extra });
  it("applies frames by offset, restores a whole draft on reconnect, ignores gaps and malformed frames, and keeps nothing when withdrawn", () => {
    let drafts = applyDraftFrame({}, frame(0, "Compare the values. "));
    drafts = applyDraftFrame(drafts, frame(20, "Left is smaller."));
    expect(drafts.job!.text).toBe("Compare the values. Left is smaller.");
    // A gap (a frame lost while reconnecting) is ignored until the whole draft comes again.
    expect(applyDraftFrame(drafts, frame(99, "lost"))).toBe(drafts);
    expect(applyDraftFrame(drafts, { jobId: 1 })).toBe(drafts);
    expect(applyDraftFrame(drafts, frame(0, "x", "invented"))).toBe(drafts);
    drafts = applyDraftFrame(drafts, frame(0, "Compare the values. Left is smaller. Done.", "complete"));
    expect(drafts.job).toMatchObject({ state: "complete", text: "Compare the values. Left is smaller. Done.", shown: true });
    const withdrawn = applyDraftFrame(drafts, frame(0, "", "withdrawn", { reason: "provider_refused" }));
    expect(withdrawn.job).toMatchObject({ state: "withdrawn", text: "", shown: true, reason: "provider_refused" });
    expect(applyDraftFrame({}, frame(0, "x".repeat(16001)))).toEqual({});
  });
  it("reads companion-draft frames from the event stream into the hook", async () => {
    const encoder = new TextEncoder();
    let push: (text: string) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { push = (text) => controller.enqueue(encoder.encode(text)); } }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }));
    try {
      const load = vi.fn().mockResolvedValue([message]);
      const client: ContextualCompanionClient = { load, send: vi.fn() };
      const { result, unmount } = renderHook(() => useCompanionConversation(client, "e", false, 1));
      await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      // The dispatch frame (no text yet) opens the draft and reads the saved job once.
      push(`event: companion-draft\ndata: ${JSON.stringify(frame(0, ""))}\n\n`);
      await waitFor(() => expect(result.current.drafts).toEqual([expect.objectContaining({ jobId: "job", text: "", state: "streaming", shown: false })]));
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      push(`event: companion-draft\ndata: ${JSON.stringify(frame(0, "First sentence. "))}\n\n`);
      await waitFor(() => expect(result.current.drafts).toEqual([expect.objectContaining({ jobId: "job", text: "First sentence. ", state: "streaming" })]));
      push(`event: companion-draft\ndata: ${JSON.stringify(frame(16, "Second.", "streaming"))}\n\nevent: companion-draft\ndata: {broken\n\n`);
      await waitFor(() => expect(result.current.drafts[0]!.text).toBe("First sentence. Second."));
      // Later frames of the same reply read nothing; a finished draft reads the stored conversation at once.
      expect(load).toHaveBeenCalledTimes(2);
      push(`event: companion-draft\ndata: ${JSON.stringify(frame(0, "First sentence. Second.", "complete"))}\n\n`);
      await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
      unmount();
    } finally { vi.unstubAllGlobals(); }
  });
  const draft = (extra: Partial<CompanionDraft> = {}): CompanionDraft => ({ jobId: "job", messageId: "m", text: "Compare them on a number line. ", state: "streaming", shown: true, ...extra });
  const pending = { ...message, job_state: "running" };
  function show(props: Partial<React.ComponentProps<typeof ConnectedCompanion>> = {}) {
    return render(
      <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[pending]} episodeTitles={{ intro: "Notice change" }}
        draft="" onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded {...props} />,
    );
  }
});
