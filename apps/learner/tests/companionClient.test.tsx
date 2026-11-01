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
import { ConnectedCompanion, lessonLabel } from "../src/components/ConnectedCompanion";
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
import { conversationActions } from "../src/connected/companion/conversationActions";

// Split from companion.test.tsx: the companion client (commands, votes, earlier pages, polling, focus, cancel, event stream, draft frames).

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
  it("votes on a reply and reads earlier pages with CSRF, the snapshot revision and an idempotency key", async () => {
    const older = { ...message, id: "older", content: "An earlier question" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [message], earlier: true, before: "cursor-1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [older], earlier: false, before: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "a", feedback: { vote: "not_helpful", reported: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "STALE_REVISION" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 7 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "a", feedback: { vote: null, reported: true } })));
    const client = createCompanionClient(createCourseApi({ fetch: fetcher, csrf: () => "csrf" }));
    // The latest page says whether older messages remain, and the cursor that reads them.
    const latest = await client.load("e");
    expect(client.pageOf!(latest)).toEqual({ earlier: true, before: "cursor-1" });
    expect(client.pageOf!([message])).toBeUndefined();
    expect(await client.loadEarlier!("e", "cursor-1")).toEqual({ messages: [older], earlier: false, before: null });
    expect(fetcher.mock.calls[1]![0]).toBe("/api/enrollments/e/companion?before=cursor-1");
    expect(fetcher.mock.calls[1]![1]?.method).toBe("GET");
    // A vote: CSRF, the snapshot's revision and a fresh idempotency key; never queued as a pending command.
    expect(await client.vote!({ enrollmentId: "e", revision: 3 }, "a", { vote: "not_helpful", comment: "It skipped a step." }))
      .toEqual({ messageId: "a", feedback: { vote: "not_helpful", reported: false } });
    const [url, init] = fetcher.mock.calls[2]!;
    expect(url).toBe("/api/enrollments/e/companion/messages/a/feedback");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf");
    const body = JSON.parse(init!.body as string);
    expect(body).toMatchObject({ vote: "not_helpful", comment: "It skipped a step.", expectedRevision: 3 });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    // A revision that moved on is read again once, with a new key.
    expect((await client.vote!({ enrollmentId: "e", revision: 3 }, "a", { vote: null, report: true })).feedback).toEqual({ vote: null, reported: true });
    expect(fetcher.mock.calls[4]![0]).toBe("/api/enrollments/e");
    const retried = JSON.parse(fetcher.mock.calls[5]![1]!.body as string);
    expect(retried).toMatchObject({ vote: null, report: true, expectedRevision: 7 });
    expect(retried.idempotencyKey).not.toBe(JSON.parse(fetcher.mock.calls[3]![1]!.body as string).idempotencyKey);
    // A malformed page or receipt is refused.
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ ...message, role: "assistant", feedback: { vote: "great", reported: false } }] })));
    await expect(client.load("e")).rejects.toThrow("Invalid companion message response");
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ messageId: "other", feedback: { vote: null, reported: false } })));
    await expect(client.vote!({ enrollmentId: "e", revision: 7 }, "a", { vote: null })).rejects.toThrow("Invalid companion feedback receipt");
  });
  it("keeps earlier pages apart from the latest page: prepended once, joined by messages the latest page lets go, with votes on top", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    try {
      const row = (index: number): CompanionMessage => ({ ...message, id: `m${index}`, content: `Message ${index}`, job_state: "applied" });
      let page = [row(3), row(4), row(5)];
      const load = vi.fn(async () => page);
      const loadEarlier = vi.fn().mockResolvedValue({ messages: [row(1), row(2)], earlier: false, before: null });
      const vote = vi.fn().mockResolvedValue({ messageId: "m4", feedback: { vote: "helpful", reported: false } });
      const pages = new WeakMap<readonly CompanionMessage[], { earlier: boolean; before: string | null }>();
      const client: ContextualCompanionClient = { load: async () => { const read = await load(); pages.set(read, { earlier: true, before: "c3" }); return read; },
        pageOf: (messages) => pages.get(messages), loadEarlier, vote, send: vi.fn() };
      const { result, rerender } = renderHook(({ revision }) => useCompanionConversation(client, "e", true, revision), { initialProps: { revision: 1 } });
      await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["m3", "m4", "m5"]));
      await waitFor(() => expect(conversationActions.get("e").earlier).toBe(true));
      const latest = result.current;
      await act(() => conversationActions.get("e").loadEarlier());
      expect(loadEarlier).toHaveBeenCalledWith("e", "c3");
      expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
      await waitFor(() => expect(conversationActions.get("e")).toMatchObject({ earlier: false, loading: false, failed: false }));
      expect(result.current).not.toBe(latest);
      // A new message pushes the oldest out of the latest page: it stays, between the two.
      page = [row(4), row(5), row(6)];
      rerender({ revision: 2 });
      await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]));
      // A vote shows on its reply at once; a change saved elsewhere reaches the earlier pages.
      await act(async () => void (await conversationActions.get("e").vote!("m4", { vote: "helpful" })));
      expect(vote).toHaveBeenCalledWith({ enrollmentId: "e", revision: 2 }, "m4", { vote: "helpful" });
      expect(result.current.messages.find((m) => m.id === "m4")?.feedback).toEqual({ vote: "helpful", reported: false });
      act(() => conversationActions.changedEverywhere({ deleted: "m1" }));
      expect(result.current.messages.find((m) => m.id === "m1")?.content).toBe("[deleted]");
      // Without earlier pages or votes the hook returns the latest page as it is.
      const plain: ContextualCompanionClient = { load: vi.fn().mockResolvedValue([message]), send: vi.fn() };
      const other = renderHook(() => useCompanionConversation(plain, "f", true, 1));
      await waitFor(() => expect(other.result.current.loaded).toBe(true));
      expect(conversationActions.get("f")).toMatchObject({ earlier: false });
      expect(conversationActions.get("f").vote).toBeUndefined();
      other.unmount();
    } finally { vi.unstubAllGlobals(); }
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
