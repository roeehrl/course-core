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
const context: CompanionContext = {
  enrollmentId: "e",
  courseDigest: "digest",
  snapshotRevision: 1,
  courseTitle: "Study",
  episodeId: "intro",
  episodeTitle: "Notice change",
  independentChallengeIds: ["active-check"],
};
const message: CompanionMessage = {
  id: "m",
  role: "learner",
  content: "Why does it change?",
  context: { episodeId: "intro" },
  created_at: "2026-01-01",
  job_state: "queued",
  job_id: "job",
};
const receipt = {
  messageId: "m",
  eventId: "event",
  revision: 2,
  state: "queued" as const,
  downgradedChallengeIds: ["active-check"],
};
afterEach(() => vi.useRealTimers());
describe("persisted companion integration", () => {
  it("requires a clear choice and never silently sets assessment assistance consent", async () => {
    const send = vi.fn().mockResolvedValue(receipt),
      change = vi.fn();
    render(
      <ConnectedCompanion
        context={context}
        messages={[]}
        episodeTitles={{ intro: "Notice change" }}
        draft="Question"
        onDraftChange={change}
        onSend={send}
        pending={false}
        loaded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Keep independent attempt" }),
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Message to your companion" }),
    ).toHaveValue("Question");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to practice & send" }),
    );
    await waitFor(() => expect(send).toHaveBeenCalledWith("Question", true));
    await waitFor(() => expect(change).toHaveBeenCalledWith(""));
    expect(screen.getByText(/Waiting for the companion service/)).toBeVisible();
  });
  it("shows actual saved messages, source lesson and configuration state without raw provider reasons", () => {
    render(
      <ConnectedCompanion
        context={context}
        messages={[
          {
            ...message,
            job_state: "waiting",
            job_reason: "configuration_missing",
          },
        ]}
        episodeTitles={{ intro: "Notice change" }}
        draft=""
        onDraftChange={() => {}}
        onSend={vi.fn()}
        pending={false}
        loaded
      />,
    );
    expect(screen.getByText("Why does it change?")).toBeVisible();
    expect(screen.getByText("From: Notice change (this lesson)")).toBeVisible();
    expect(screen.getByText(/Waiting for service configuration/)).toBeVisible();
    expect(
      companionJobLabel({
        ...message,
        job_state: "failed",
        job_reason: "secret-provider-token",
      }),
    ).not.toContain("secret");
  });
  it("labels each reply with the lesson its question was asked in, including old rows", () => {
    const reply = (id: string, episodeId?: string): CompanionMessage => ({
      id, role: "assistant", content: `Reply ${id}`, context: episodeId ? { episodeId } : {}, created_at: "2026-01-02", job_id: id,
    });
    render(
      <ConnectedCompanion
        context={context}
        messages={[
          { ...message, id: "q-here" }, reply("here", "intro"),
          { ...message, id: "q-there", content: "Earlier?", context: { episodeId: "before" } }, reply("there", "before"),
          reply("legacy"), reply("gone", "removed"),
        ]}
        episodeTitles={{ intro: "Notice change", before: "Rates of change" }}
        draft=""
        onDraftChange={() => {}}
        onSend={vi.fn()}
        pending={false}
        loaded
      />,
    );
    expect(screen.getAllByText("From: Notice change (this lesson)")).toHaveLength(1);
    expect(screen.getByText("About: Notice change (this lesson)")).toBeVisible();
    expect(screen.getByText("From: Rates of change")).toBeVisible();
    expect(screen.getByText("About: Rates of change")).toBeVisible();
    expect(screen.getByText("About: Lesson not recorded")).toBeVisible();
    expect(screen.getByText("About: A lesson no longer in this course")).toBeVisible();
    expect(screen.queryByText(/Earlier lesson/)).not.toBeInTheDocument();
    // Only the course's own titles name a lesson.
    expect(lessonLabel("toString", "intro", {})).toBe("A lesson no longer in this course");
    expect(lessonLabel(null, "intro", { intro: "Notice change" })).toBe("Lesson not recorded");
    expect(lessonLabel("intro", undefined, { intro: "Notice change" })).toBe("Notice change");
  });
  it("names lessons in Hebrew with the course title isolated", () => {
    const { t } = createLearnerTranslator("he");
    expect(lessonLabel(null, "intro", {}, t)).toBe("השיעור לא תועד");
    expect(lessonLabel("gone", "intro", {}, t)).toBe("שיעור שכבר לא נמצא בקורס הזה");
    const current = lessonLabel("intro", "intro", { intro: "Notice change" }, t);
    expect(current).toContain("\u2068Notice change\u2069");
    expect(stripBidiControls(current)).toBe("Notice change (השיעור הזה)");
  });
  it("shows a refused question as not sent and stops waiting for it", () => {
    expect(companionJobLabel({ ...message, job_state: "refused" })).toBe(
      "Not sent · this question could not be passed on to the AI service · nothing was used · you can ask it again",
    );
    expect(companionHasPending([{ ...message, job_state: "refused" }])).toBe(false);
    expect(companionHasPending([{ ...message, job_state: null }])).toBe(true);
  });
  it("says a reply Core refused was not shown, and puts the question back in the draft to ask again", async () => {
    const refused = { ...message, job_state: "failed", job_reason: "verification_rejected", refusal_reason: "output_too_large" };
    expect(companionJobLabel(refused)).toBe("Reply not shown · it did not pass the checks, so nothing of it was kept · you can ask your question again");
    expect(companionHasPending([refused])).toBe(false);
    // Other failures keep the general label; like a stalled call (no reply came, nothing can settle
    // it any more) they read as unavailable and can be asked again (live finding U2).
    expect(companionJobLabel({ ...message, job_state: "failed", job_reason: "deadline_exceeded" })).toBe("Reply unavailable · it could not be prepared · you can ask your question again");
    const stalled = { ...message, id: "stalled", content: "Which option is right?", job_state: "waiting", job_reason: "provider_uncertain", job_stalled: true };
    expect(companionJobLabel(stalled)).toBe("Reply unavailable · the AI service didn't answer in time · you can ask your question again");
    expect(companionHasPending([stalled])).toBe(false);
    // Waiting without that mark (a receipt may still settle it) is still in progress.
    expect(companionHasPending([{ ...stalled, job_stalled: false }])).toBe(true);
    expect(companionJobLabel({ ...stalled, job_stalled: null })).toBe("Taking longer than usual · your question is saved");
    // A reply that stopped coming part way (settled at its reported usage) reads as stalled part way,
    // never as refused by the checks.
    const partWay = { ...message, job_state: "failed", job_reason: "verification_rejected", refusal_reason: "provider_stream_stalled" };
    expect(companionJobLabel(partWay))
      .toBe("Reply unavailable · the AI service stopped part way through, so nothing of the reply was kept · you can ask your question again");
    expect(companionCouldNotAnswer(partWay)).toBe(false);
    expect(companionCanAskAgain(partWay)).toBe(true);
    // Core closed the call because the learner stopped it: stopped, not refused.
    const closed = { ...message, job_state: "failed", job_reason: "verification_rejected", refusal_reason: "provider_stream_stopped" };
    expect(companionJobLabel(closed)).toMatch(/^Stopped after it was sent · nothing of the reply was kept/);
    expect(companionCouldNotAnswer(closed)).toBe(false);
    const change = vi.fn();
    render(
      <ConnectedCompanion
        context={context}
        messages={[refused, { ...message, id: "other", content: "Still waiting?", job_state: "failed", job_reason: "deadline_exceeded" }, stalled]}
        episodeTitles={{ intro: "Notice change" }}
        draft=""
        onDraftChange={change}
        onSend={vi.fn()}
        pending={false}
        loaded
        onCancelQuestion={vi.fn()}
      />,
    );
    expect(screen.getByText(/^Reply not shown · it did not pass the checks/)).toBeVisible();
    expect(screen.getByText(/the AI service didn't answer in time/)).toBeVisible();
    // No controls for a reply that will never come.
    expect(screen.queryByRole("button", { name: "Stop waiting for this answer" })).toBeNull();
    const again = screen.getAllByRole("button", { name: "Ask this question again" });
    expect(again).toHaveLength(3);
    fireEvent.click(again[0]!);
    expect(change).toHaveBeenCalledWith(message.content);
    fireEvent.click(again[2]!);
    expect(change).toHaveBeenLastCalledWith("Which option is right?");
  });
  it("keeps drafts on failed sends and sends no consent flag without an independent check", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline")),
      change = vi.fn();
    render(
      <ConnectedCompanion
        context={{ ...context, independentChallengeIds: [] }}
        messages={[]}
        episodeTitles={{}}
        draft="Keep me"
        onDraftChange={change}
        onSend={send}
        pending={false}
        loaded
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith("Keep me", undefined),
    );
    expect(change).not.toHaveBeenCalled();
    expect(
      screen.getByRole("textbox", { name: "Message to your companion" }),
    ).toHaveValue("Keep me");
  });
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
  it("keeps the same textarea through responsive changes and traps/restores drawer focus", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.append(trigger);
    trigger.focus();
    const close = vi.fn();
    const renderDock = (wide: boolean, open: boolean) => (
      <CompanionDock wide={wide} open={open} onOpenChange={close}>
        <textarea aria-label="Draft" defaultValue="Keep this" />
      </CompanionDock>
    );
    const { rerender } = render(renderDock(false, true));
    const input = screen.getByRole("textbox", { name: "Draft" });
    input.focus();
    (input as HTMLTextAreaElement).setSelectionRange(2, 5);
    rerender(renderDock(true, true));
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe(2);
    rerender(renderDock(false, true));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledWith(false);
    rerender(renderDock(false, false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    trigger.remove();
  });
  it("collapses the pane beside the lesson without unmounting the draft, and moves it into a sheet when the window narrows", async () => {
    const onOpen = vi.fn(), onCollapse = vi.fn();
    const renderDock = (wide: boolean, open: boolean, collapsed: boolean) => (
      <CompanionDock wide={wide} open={open} onOpenChange={onOpen} collapsed={collapsed} onCollapsedChange={onCollapse}>
        <textarea aria-label="Draft" defaultValue="Keep this" />
      </CompanionDock>
    );
    const { rerender } = render(renderDock(true, false, false));
    const input = screen.getByRole("textbox", { name: "Draft" });
    expect(screen.getByRole("complementary", { name: "Your companion" })).toBeVisible();
    expect(document.querySelector(".connected-companion-trigger")).not.toBeVisible();
    const close = screen.getByRole("button", { name: "Close companion" });
    expect(close).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(close);
    expect(onCollapse).toHaveBeenLastCalledWith(true);
    rerender(renderDock(true, false, true));
    // Hidden, not removed: the draft keeps its value for when the pane returns.
    expect(screen.getByRole("textbox", { name: "Draft", hidden: true })).toBe(input);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Companion" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    await act(async () => {});
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(onCollapse).toHaveBeenLastCalledWith(false);
    rerender(renderDock(true, false, false));
    input.focus();
    // Narrowing to a compact window while typing keeps the learner in the companion.
    rerender(renderDock(false, false, false));
    expect(onOpen).toHaveBeenLastCalledWith(true);
    rerender(renderDock(false, true, false));
    expect(screen.getByRole("dialog", { name: "Your companion" })).toBeVisible();
    expect(input).toHaveFocus();
    // Widening with the sheet open shows the pane even if it had been collapsed.
    onCollapse.mockClear();
    rerender(renderDock(false, true, true));
    rerender(renderDock(true, true, true));
    expect(onCollapse).toHaveBeenCalledWith(false);
  });
  it("closes the sheet with Escape even from a React Native text input, which stops key events bubbling", () => {
    const close = vi.fn();
    render(
      <CompanionDock wide={false} open onOpenChange={close}>
        <TextInput accessibilityLabel="Message" defaultValue="Keep this" />
      </CompanionDock>,
    );
    const input = screen.getByRole("textbox", { name: "Message" });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledWith(false);
  });
  it("isolates drafts by account and keeps them in memory when storage is denied", () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
    const a = createConnectedDraftStore("a", store);
    a.write("lesson", "saved");
    expect(createConnectedDraftStore("a", store).read("lesson")).toBe("saved");
    expect(createConnectedDraftStore("b", store).read("lesson")).toBe("");
    const denied = createConnectedDraftStore("a", {
      getItem() {
        throw Error();
      },
      setItem() {
        throw Error();
      },
      removeItem() {
        throw Error();
      },
    });
    denied.write("answer", "never lose");
    expect(denied.read("answer")).toBe("never lose");
    expect(denied.unavailable).toBe(true);
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
  it("shows what an answer used, attached to its own lesson, and lets the learner stop reusing a message", async () => {
    companionFocus.setSelection({ kind: "visual_node", blockId: "diagram", nodeId: "meter", label: "Meter bar" });
    const exclude = vi.fn().mockResolvedValue(undefined);
    const reply: CompanionMessage = {
      id: "a",
      role: "assistant",
      content: "Because the minimum may equal another member.",
      context: {},
      created_at: "2026-01-02",
      job_id: "job",
      context_used: {
        episodeId: "intro", blockId: null, answersMessageId: "m", contextRevision: 4, courseDigest: "digest", recentEventCursor: "9",
        history: [{ messageId: "old", role: "learner", excerpt: "An earlier question", clipped: false, excluded: false }],
        summary: { count: 1, omitted: 0, sourceEventIds: ["e1"], items: [{ messageId: "older", eventId: "e1", excerpt: "The first question", excluded: true }] },
        selection: { kind: "formula", excerpt: "a <= b" }, media: { mediaId: "walkthrough", playbackSeconds: 83 }, simulation: null,
        evidenceCount: 2, assessmentMode: "none",
        constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: false, policyRevision: 1, digest: "d" },
      },
    };
    render(
      <ConnectedCompanion
        context={{ ...context, episodeId: "next", episodeTitle: "Next lesson" }}
        messages={[message, reply]}
        episodeTitles={{ intro: "Notice change", next: "Next lesson" }}
        draft=""
        onDraftChange={() => {}}
        onSend={vi.fn()}
        onExcludeContext={exclude}
        pending={false}
        loaded
      />,
    );
    // The selection made in another lesson was dropped when the lesson changed.
    expect(screen.queryByText(/Attached to your next message/)).not.toBeInTheDocument();
    expect(screen.getByText("About: Notice change")).toBeVisible();
    expect(screen.queryByText(/Earlier lesson/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show context used" }));
    expect(screen.getByText("Answering: “Why does it change?”")).toBeVisible();
    expect(screen.getByText(/You pointed at \(Formula or code example\): “a <= b”/)).toBeVisible();
    expect(screen.getByText("Course video at 1:23")).toBeVisible();
    expect(screen.getByText(/no independent check open · no extra practice beyond the lesson/)).toBeVisible();
    expect(screen.getByText(/Context version 4/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Don’t use this message again" }));
    await waitFor(() => expect(exclude).toHaveBeenCalledWith("old", true));
    await pressWhenReady(screen.getByRole("button", { name: "Use this question again" }));
    await waitFor(() => expect(exclude).toHaveBeenCalledWith("older", false));
    // A focus chosen in this lesson is shown and removable.
    act(() => companionFocus.setSelection({ kind: "code", excerpt: "return x", lineStart: 3, lineEnd: 4, codeSnapshotHash: "a".repeat(64) }));
    expect(screen.getByText("Your code, lines 3–4")).toBeVisible();
    await pressWhenReady(screen.getByRole("button", { name: "Remove selection" }));
    expect(companionFocus.get().selection).toBeUndefined();
  });

  it("deletes a question only after confirming, and offers nothing for a deleted one", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ConnectedCompanion context={context} messages={[message]} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={() => {}}
        onSend={vi.fn()} onDeleteMessage={remove} pending={false} loaded />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete this question" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Suggestions based on it are revoked/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep question" }));
    expect(screen.queryByRole("button", { name: "Delete question" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete this question" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete question" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("m"));
    rerender(
      <ConnectedCompanion context={context} messages={[{ ...message, content: "[deleted]" }]} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={() => {}}
        onSend={vi.fn()} onDeleteMessage={remove} pending={false} loaded />,
    );
    expect(screen.queryByRole("button", { name: "Delete this question" })).not.toBeInTheDocument();
  });
  it("keeps past messages and offers cancel or retry while the last question is still being worked on", async () => {
    const waiting: CompanionMessage = { ...message, id: "w", content: "Frozen layers?", job_state: "waiting", job_reason: "provider_uncertain" };
    const answered: CompanionMessage[] = [
      { ...message, id: "q1", content: "Why does w go up?", job_state: "applied" },
      { id: "a1", role: "assistant", content: "Because the step subtracts a negative.", context: { episodeId: "intro", cutShort: true }, created_at: "2026-01-02", job_id: "job" },
    ];
    const cancelQuestion = vi.fn().mockResolvedValue(undefined), draft = vi.fn();
    render(
      <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[...answered, waiting]} episodeTitles={{ intro: "Notice change" }}
        draft="" onDraftChange={draft} onSend={vi.fn()} onCancelQuestion={cancelQuestion} pending={false} loaded />,
    );
    expect(screen.getByText("Because the step subtracts a negative.")).toBeVisible();
    expect(screen.getByText(/This reply was cut short/)).toBeVisible();
    expect(screen.getByText("Companion: A reply is taking longer than usual · you can keep reading and asking")).toBeVisible();
    expect(screen.getByText("Taking longer than usual · your question is saved")).toBeVisible();
    expect(screen.queryByText(/Companion service unavailable/)).not.toBeInTheDocument();
    // Only the waiting question offers cancel and retry; an answered one does not.
    expect(screen.getAllByRole("button", { name: "Stop waiting for this answer" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel and ask again" }));
    await waitFor(() => expect(cancelQuestion).toHaveBeenCalledWith("w"));
    await waitFor(() => expect(draft).toHaveBeenCalledWith("Frozen layers?"));
    await pressWhenReady(screen.getByRole("button", { name: "Stop waiting for this answer" }));
    await waitFor(() => expect(cancelQuestion).toHaveBeenCalledTimes(2));
    expect(draft).toHaveBeenCalledTimes(1);
  });
  it("labels waiting, cancelled and building questions in Hebrew too, and hides cancel while a reply is being built", () => {
    const { t } = createLearnerTranslator("he");
    expect(companionJobLabel({ ...message, job_state: "waiting" }, t)).toBe("מתעכבת יותר מהרגיל · השאלה שלך נשמרה");
    expect(companionJobLabel({ ...message, job_state: "cancelled" })).toBe("Cancelled before it was sent · nothing was used · your message is saved");
    expect(companionJobLabel({ ...message, job_state: "cancelled", job_sent: true }))
      .toBe("Stopped after it was sent · nothing of the reply was kept · what the call used until then counts toward this course's AI use");
    expect(companionJobLabel({ ...message, job_state: "cancelled", job_sent: true }, t)).toBe("נעצרה אחרי שנשלחה · שום חלק מהתשובה לא נשמר · מה שהבקשה ניצלה עד אז נספר בשימוש של הקורס ב-AI");
    expect(companionJobLabel({ ...message, job_state: "running" }, t)).toBe("נשלחה · התשובה נכתבת עכשיו");
    expect(companionJobLabel({ ...message, job_state: "queued" }, t)).toBe("בתור · עוד לא נשלחה");
    expect(companionHasPending([{ ...message, job_state: "cancelled" }])).toBe(false);
    render(
      <ConnectedCompanion context={context} messages={[{ ...message, job_state: "running" }]} episodeTitles={{ intro: "Notice change" }}
        draft="" onDraftChange={() => {}} onSend={vi.fn()} onCancelQuestion={vi.fn()} pending={false} loaded />,
    );
    expect(screen.queryByRole("button", { name: "Stop waiting for this answer" })).not.toBeInTheDocument();
  });
  it("sends a cancel command for one question and checks its receipt", async () => {
    const command = vi.fn().mockResolvedValue({ messageId: "m", cancelled: true, revision: 3 }), snapshot = connectedSnapshot();
    const client = createCompanionClient({ command } as unknown as Parameters<typeof createCompanionClient>[0]);
    await expect(client.cancelQuestion!(snapshot, "m")).resolves.toEqual({ messageId: "m", cancelled: true, revision: 3 });
    expect(command).toHaveBeenCalledWith(snapshot, "companion/messages/m/cancel", {});
    command.mockResolvedValueOnce({ messageId: "other", cancelled: true, revision: 3 });
    await expect(client.cancelQuestion!(snapshot, "m")).rejects.toThrow();
  });
  it("derives truthful companion states from saved jobs and the browser", () => {
    const at = (job_state: string | null, job_reason: string | null = null): CompanionMessage => ({ ...message, job_state, job_reason });
    expect(companionState([at("running")], { online: false, awaitingChoice: true })).toBe("offline");
    expect(companionState([at("running")], { online: true, awaitingChoice: true })).toBe("waiting_for_you");
    expect(companionState([at("running")], { online: true, awaitingChoice: false })).toBe("building");
    expect(companionState([at("verifying")], { online: true, awaitingChoice: false })).toBe("checking");
    expect(companionState([at("queued", "configuration_missing")], { online: true, awaitingChoice: false })).toBe("unavailable");
    // A question held up by the service is "still working", never the whole companion unavailable.
    expect(companionState([at("budget_wait")], { online: true, awaitingChoice: false })).toBe("still_working");
    expect(companionState([at("waiting", "provider_uncertain")], { online: true, awaitingChoice: false })).toBe("still_working");
    expect(companionState([at("waiting", "configuration_missing")], { online: true, awaitingChoice: false })).toBe("unavailable");
    expect(companionState([at("configuration_pending")], { online: true, awaitingChoice: false })).toBe("unavailable");
    expect(companionState([at("queued")], { online: true, awaitingChoice: false })).toBe("queued");
    expect(companionState([at("applied")], { online: true, awaitingChoice: false })).toBe("available");
    expect(companionState([], { online: true, awaitingChoice: false })).toBe("available");
  });
  it("holds a question while offline and sends it once when the connection returns", async () => {
    const send = vi.fn().mockResolvedValue({ ...receipt, downgradedChallengeIds: [] });
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(
      <ConnectedCompanion
        context={{ ...context, independentChallengeIds: [] }}
        messages={[]}
        episodeTitles={{ intro: "Notice change" }}
        draft="Kept while offline"
        onDraftChange={() => {}}
        onSend={send}
        pending={false}
        loaded
        availability="ready"
      />,
    );
    expect(screen.getByRole("status", { name: /Companion status: Offline/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send when back online" }));
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByText(/held on this device/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Waiting for connection…" })).toBeDisabled();
    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith("Kept while offline", undefined);
    expect(screen.getByRole("status", { name: /Companion status: Available/ })).toBeVisible();
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
  it("shows a streaming draft labelled as unchecked, outside the live announcements, with one replying status", () => {
    show({ drafts: [draft()] });
    const region = screen.getByLabelText("Reply being written, not yet checked");
    expect(region).toHaveAttribute("aria-live", "off");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Compare them on a number line.", { exact: false })).toBeVisible();
    expect(screen.getByText(/not checked yet/)).toBeVisible();
    expect(screen.getByRole("status", { name: /Writing a reply/ })).toBeVisible();
    expect(companionState([pending], { online: true, awaitingChoice: false, drafts: [draft()] })).toBe("replying");
  });
  it("tells the learner the stream is reconnecting, and replaces the draft by the stored reply", () => {
    const { rerender } = show({ drafts: [draft()], streamConnected: false });
    expect(screen.getByText(/Connection lost · the reply continues/)).toBeVisible();
    const answer: CompanionMessage = { id: "a", role: "assistant", content: "Stored and checked reply.", context: { episodeId: "intro" }, created_at: "2026-01-01", job_id: "job" };
    rerender(<ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[{ ...message, job_state: "applied" }, answer]} episodeTitles={{ intro: "Notice change" }}
      draft="" onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded drafts={[draft({ state: "complete" })]} />);
    expect(screen.queryByLabelText("Reply being written, not yet checked")).toBeNull();
    expect(screen.getByText("Stored and checked reply.")).toBeVisible();
  });
  it("a withdrawn or stopped draft is said once, by the question's label, and why", () => {
    const again = (drafts: CompanionDraft[]) => rerender(<ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[pending]} episodeTitles={{}}
      draft="" onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded drafts={drafts} />);
    const { rerender, container } = show({ drafts: [draft({ state: "withdrawn", text: "", shown: true, reason: "output_refused" })] });
    expect(screen.getByText("Reply not shown · it did not pass the checks, so nothing of it was kept")).toBeVisible();
    again([draft({ state: "withdrawn", text: "", shown: true, reason: "check_answer_withheld" })]);
    expect(screen.getByText(/^Reply withheld · it gave away the answer to one of the course's checks/)).toBeVisible();
    expect(screen.queryByText(/did not pass the checks/)).toBeNull();
    again([draft({ state: "withdrawn", text: "", shown: true, reason: "provider_failed" })]);
    expect(screen.getByText("The reply stopped part way through · nothing of it was kept")).toBeVisible();
    expect(screen.queryByText(/did not pass the checks/)).toBeNull();
    again([draft({ state: "cancelled", text: "" })]);
    expect(screen.getByText(/^Stopped after it was sent · nothing of the reply was kept/)).toBeVisible();
    // Never a second sentence under the card.
    expect(container.textContent).not.toMatch(/withdrawn because|You stopped this reply/);
  });
  it("a reply about a graded check is checked out of sight: no draft text, a checking state and Stop (en and he)", () => {
    let drafts = applyDraftFrame({}, frame(0, "", "streaming", { checking: true }));
    expect(drafts.job).toMatchObject({ checking: true, text: "", shown: false });
    // The mark stays when a later frame (a reconnect, the end) does not repeat it.
    drafts = applyDraftFrame(drafts, frame(0, "", "complete"));
    expect(drafts.job).toMatchObject({ checking: true, state: "complete" });
    const checking = draft({ text: "", shown: false, checking: true });
    expect(companionJobLabel(pending, undefined, checking)).toBe("Checking this reply…");
    expect(companionJobLabel(pending, createLearnerTranslator("he").t, checking)).toBe("בודקים את התשובה…");
    expect(companionState([pending], { online: true, awaitingChoice: false, drafts: [checking] })).toBe("checking");
    expect(companionState([pending], { online: true, awaitingChoice: false, drafts: [checking, draft({ jobId: "other" })] })).toBe("replying");
    show({ drafts: [checking], onCancelQuestion: vi.fn() });
    expect(screen.queryByLabelText("Reply being written, not yet checked")).toBeNull();
    expect(screen.getByText("Checking this reply…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop this reply" })).toBeVisible();
  });
  it("lets the learner stop a reply being prepared, reports a failure, and offers no stop once it is answered or stopped", async () => {
    let fail: (error: Error) => void = () => {};
    const cancel = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValueOnce(undefined);
    const { rerender } = show({ onCancelQuestion: cancel });
    fireEvent.click(screen.getByRole("button", { name: "Stop this reply" }));
    // One stop at a time: a second press while the first is on its way sends nothing more.
    const stopping = screen.getByRole("button", { name: "Stopping…" });
    expect(stopping).toBeDisabled();
    fireEvent.click(stopping);
    expect(cancel).toHaveBeenCalledTimes(1);
    // The first stop fails. The failure is settled inside act so React finishes that update,
    // effects included, before the next press: react-native-web's Pressable takes its new
    // `disabled` in an effect, a moment after the enabled button is already in the page.
    await act(async () => fail(new Error("offline")));
    expect(screen.getByText(/could not be stopped/)).toBeVisible();
    // The first press after the failure is taken, and a stop that works clears the failure.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop this reply" })));
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenNthCalledWith(2, "m");
    expect(screen.queryByText(/could not be stopped/)).toBeNull();
    rerender(<ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[{ ...pending, job_state: "cancelled" }]} episodeTitles={{}} draft=""
      onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded onCancelQuestion={cancel} />);
    expect(screen.queryByRole("button", { name: "Stop this reply" })).toBeNull();
    expect(screen.getByText(/Cancelled before it was sent · nothing was used · your message is saved/)).toBeVisible();
    expect(companionHasPending([{ ...pending, job_state: "cancelled" }])).toBe(false);
  });
  it("offers one way to stop: cancel and retry while the question waits, Stop once the reply is being written", () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const { rerender } = show({ onCancelQuestion: cancel, messages: [{ ...pending, job_state: "queued" }] });
    expect(screen.queryByRole("button", { name: "Stop this reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop waiting for this answer" })).toBeVisible();
    rerender(<ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[pending]} episodeTitles={{}} draft=""
      onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded onCancelQuestion={cancel} />);
    expect(screen.getByRole("button", { name: "Stop this reply" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop waiting for this answer" })).toBeNull();
  });
  it("switches to Stop as soon as the reply's call is sent, even while the saved job still reads queued", () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const queued = { ...message, job_state: "queued" };
    const { rerender } = show({ onCancelQuestion: cancel, messages: [queued] });
    expect(screen.getByText("Queued · not sent yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop waiting for this answer" })).toBeVisible();
    const again = (drafts: CompanionDraft[], messages: CompanionMessage[] = [queued]) => rerender(
      <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={messages} episodeTitles={{}} draft=""
        onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded onCancelQuestion={cancel} drafts={drafts} />);
    // The dispatch frame: no text yet, but the call is out.
    again([draft({ text: "", shown: false })]);
    expect(screen.getByRole("button", { name: "Stop this reply" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop waiting for this answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel and ask again" })).toBeNull();
    expect(screen.getByText("Sent · a reply is being written")).toBeVisible();
    expect(screen.getByRole("status", { name: /Writing a reply/ })).toBeVisible();
    // The first sentence: still Stop, never the queued controls (job not re-read yet).
    again([draft()]);
    expect(screen.getByRole("button", { name: "Stop this reply" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop waiting for this answer" })).toBeNull();
    // A question without its job id yet (read before preparation) is matched by message.
    again([draft()], [{ ...queued, job_id: null }]);
    expect(screen.getByRole("button", { name: "Stop this reply" })).toBeVisible();
    // Stopped: the label says so, and is honest that the sent call counts.
    again([draft({ state: "cancelled", text: "" })]);
    expect(screen.queryByRole("button", { name: "Stop this reply" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop waiting for this answer" })).toBeNull();
    expect(screen.getByText(/Stopped after it was sent · nothing of the reply was kept · what the call used until then counts/)).toBeVisible();
    expect(companionState([queued], { online: true, awaitingChoice: false, drafts: [draft({ text: "" })] })).toBe("replying");
  });
  it("shows the same switch in Hebrew", () => {
    const he = createLearnerTranslator("he");
    render(
      <I18nProvider value={he}>
        <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[{ ...message, job_state: "queued" }]} episodeTitles={{}}
          draft="" onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded onCancelQuestion={vi.fn()} drafts={[draft({ text: "", shown: false })]} />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "עצירת התשובה" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "להפסיק לחכות לתשובה הזו" })).toBeNull();
    expect(screen.getByText("נשלחה · התשובה נכתבת עכשיו")).toBeVisible();
  });
});

describe("live companion findings (0.1.57 re-test)", () => {
  const draft = (extra: Partial<CompanionDraft> = {}): CompanionDraft => ({ jobId: "job", messageId: "m", text: "Compare them on a number line. ", state: "streaming", shown: true, ...extra });
  const panel = (messages: CompanionMessage[], props: Partial<React.ComponentProps<typeof ConnectedCompanion>> = {}) => (
    <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={messages} episodeTitles={{}} draft="" onDraftChange={vi.fn()}
      onSend={vi.fn()} pending={false} loaded onCancelQuestion={vi.fn()} {...props} />
  );
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });
  /** The companion pane's own scrolling box (500px tall) around the panel, in jsdom: every node
   * below the first 500px reports itself at 900px, below the view, and scrolls are recorded. */
  function scrollingPane() {
    const pane = document.createElement("div");
    pane.style.overflowY = "auto";
    Object.defineProperty(pane, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(pane, "scrollHeight", { value: 4000, configurable: true });
    const scrolls: { by?: number; to?: number; element?: string }[] = [];
    pane.scrollBy = vi.fn(function (options?: ScrollToOptions | number) { scrolls.push({ by: (options as ScrollToOptions).top }); }) as typeof pane.scrollBy;
    let top = 0;
    Object.defineProperty(pane, "scrollTop", { get: () => top, set: (value: number) => { top = value; scrolls.push({ to: value }); }, configurable: true });
    const rect = (y: number, height: number) => ({ top: y, bottom: y + height, left: 0, right: 300, width: 300, height, x: 0, y, toJSON: () => ({}) });
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this === pane) return rect(0, 500) as DOMRect;
      const label = this.getAttribute("aria-label") ?? "";
      return (label.startsWith("Reply being written") || /stored reply/.test(this.textContent ?? "") ? rect(900, 120) : rect(100, 40)) as DOMRect;
    };
    document.body.append(pane);
    return { pane, scrolls, restore: () => { Element.prototype.getBoundingClientRect = original; pane.remove(); } };
  }
  it("opens at the latest messages and brings a reply into view by scrolling only its pane, never the page", () => {
    const { pane, scrolls, restore } = scrollingPane();
    const page = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    try {
      const earlier: CompanionMessage[] = [
        { ...message, id: "q0", job_state: "applied", job_id: "j0" },
        { id: "a0", role: "assistant", content: "An earlier answer.", context: { episodeId: "intro" }, created_at: "2026-01-01", job_id: "j0" },
      ];
      const asked = { ...message, job_state: "running" };
      const { rerender } = render(panel([...earlier, asked]), { container: pane });
      // The first load opens at the end of the conversation (its latest messages and the message
      // box), not at its oldest message.
      expect(scrolls).toContainEqual({ to: 4000 });
      scrolls.length = 0;
      rerender(panel([...earlier, asked], { drafts: [draft()] }));
      // The draft, below the view, is brought into it by the least scroll of the pane.
      expect(scrolls).toEqual([{ by: 520 }]);
      // It follows the draft as it grows.
      rerender(panel([...earlier, asked], { drafts: [draft({ text: "Compare them on a number line. The one farther left is smaller. " })] }));
      expect(scrolls).toHaveLength(2);
      // The stored reply that replaces it is brought into view too.
      const answer: CompanionMessage = { id: "a1", role: "assistant", content: "The stored reply.", context: { episodeId: "intro" }, created_at: "2026-01-02", job_id: "job" };
      rerender(panel([...earlier, { ...asked, job_state: "applied" }, answer], { drafts: [draft({ state: "complete" })] }));
      expect(scrolls).toHaveLength(3);
      // After the learner scrolls the panel, a growing reply keeps their place.
      const later = [...earlier, { ...asked, job_state: "applied" }, answer, { ...message, id: "m2", job_state: "running", job_id: "job2" }];
      rerender(panel(later, { drafts: [draft({ state: "complete" }), draft({ jobId: "job2", messageId: "m2", text: "A new reply starts. " })] }));
      expect(scrolls).toHaveLength(4);
      fireEvent.wheel(pane.firstElementChild!);
      rerender(panel(later, { drafts: [draft({ state: "complete" }), draft({ jobId: "job2", messageId: "m2", text: "A new reply starts. And it grows. " })] }));
      expect(scrolls).toHaveLength(4);
      // Nothing scrolled the page or asked the browser to scroll every box up to the window.
      expect(page).not.toHaveBeenCalled();
      expect(into).not.toHaveBeenCalled();
    } finally {
      restore();
      page.mockRestore();
    }
  });
  it("finds the pane's own scrolling box, never the page, and scrolls it the least", () => {
    const outer = document.createElement("div"), inner = document.createElement("div"), item = document.createElement("p");
    inner.style.overflowY = "auto";
    inner.append(item);
    outer.append(inner);
    document.body.append(outer);
    expect(panelScroller(item)).toBe(inner);
    inner.style.overflowY = "visible";
    // No scrolling box of its own: nothing is scrolled (not the document).
    expect(panelScroller(item)).toBeNull();
    outer.remove();
  });
  it("offers Ask again on a question that was stopped or cancelled, restoring its text", () => {
    const onDraftChange = vi.fn();
    const { rerender } = render(panel([{ ...message, job_state: "queued" }], { onDraftChange, drafts: [draft({ state: "cancelled", text: "" })] }));
    expect(screen.getByText(/^Stopped after it was sent · nothing of the reply was kept/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ask this question again" }));
    expect(onDraftChange).toHaveBeenCalledWith("Why does it change?");
    rerender(panel([{ ...message, job_state: "cancelled", job_sent: true }], { onDraftChange }));
    expect(screen.getByRole("button", { name: "Ask this question again" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop waiting for this answer" })).toBeNull();
    // Not on a question still waiting or answered, nor on a deleted one.
    expect(companionCanAskAgain({ ...message, job_state: "queued" })).toBe(false);
    expect(companionCanAskAgain({ ...message, job_state: "applied" })).toBe(false);
    expect(companionCanAskAgain({ ...message, job_state: "cancelled", content: "[deleted]" })).toBe(false);
  });
  it("says in Hebrew that an unchecked draft may change or be removed, not that it may continue", () => {
    render(<I18nProvider value={createLearnerTranslator("he")}>{panel([{ ...message, job_state: "running" }], { drafts: [draft()] })}</I18nProvider>);
    expect(screen.getByText("בכתיבה · עדיין לא נבדקה, ולכן ייתכן שתשתנה או שתוסר")).toBeVisible();
    expect(screen.queryByText(/להימשך/)).toBeNull();
  });
  it("shows context used as plain words, not Markdown or TeX", () => {
    expect(plainExcerpt("* **Application state, not training:** Saving logs")).toBe("Application state, not training: Saving logs");
    expect(plainExcerpt("### Step 0: Setup from *Checkpoint*")).toBe("Step 0: Setup from Checkpoint");
    expect(plainExcerpt("loading parameters into $w$ and running $w=2$ to $w=2.6$")).toBe("loading parameters into w and running w=2 to w=2.6");
    expect(plainExcerpt("$$\\frac{dL}{dw} = -6$$ and \\text{w\\_new} = 2 - 0.1 \\cdot 6")).toBe("dL/dw = -6 and w_new = 2 - 0.1 · 6");
    expect(plainExcerpt("| Boundary | Weight |\n|---|---|\n| a | b |")).toBe("Boundary · Weight a · b");
    expect(plainExcerpt("Use `prediction = w*x` or [the lesson](https://example.com)")).toBe("Use prediction = w*x or the lesson");
    // Plain text that uses the same characters keeps them.
    expect(plainExcerpt("2*3*4, w_new, snake_case and $5 or $6")).toBe("2*3*4, w_new, snake_case and $5 or $6");
    expect(plainExcerpt("לא, זו אינה הסקה טהורה אלא **כוונון עדין (fine-tuning)**")).toBe("לא, זו אינה הסקה טהורה אלא כוונון עדין (fine-tuning)");
    const used: CompanionContextUsed = { episodeId: "intro", blockId: null, answersMessageId: "m", contextRevision: 2, courseDigest: "digest", recentEventCursor: null,
      history: [{ messageId: "a0", role: "assistant", excerpt: "**Fine-tuning** updates *weights* by $w - \\eta g$", clipped: false, excluded: false }],
      summary: null, selection: null, media: null, simulation: null, evidenceCount: 0, assessmentMode: "none",
      constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: false, policyRevision: 1, digest: "d" } };
    render(panel([{ ...message, job_state: "applied" }, { id: "a", role: "assistant", content: "Reply", context: { episodeId: "intro" }, created_at: "2026-01-02", job_id: "job", context_used: used }]));
    fireEvent.click(screen.getByRole("button", { name: "Show context used" }));
    expect(screen.getByText(/Companion: “Fine-tuning updates weights by w - η g”/)).toBeVisible();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });
});

describe("help paused by a spending limit", () => {
  const held = (ceiling: string): CompanionMessage => ({ ...message, job_state: "budget_wait", job_reason: "budget_exhausted", job_ceiling: ceiling });
  function show(messages: CompanionMessage[], locale: "en" | "he" = "en") {
    return render(
      <I18nProvider value={createLearnerTranslator(locale)}>
        <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={messages} episodeTitles={{}}
          draft="" onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded onCancelQuestion={vi.fn()} />
      </I18nProvider>,
    );
  }
  it("says plainly that help is paused at the course's AI budget and that staff were told, and keeps cancel and ask again", () => {
    show([held("workspace")]);
    expect(screen.getByText("Companion: Help is paused · your question is saved")).toBeVisible();
    expect(screen.getByText(/Help is paused · this course's AI budget is used up, so the companion can't answer for now\. Course staff have been told\./)).toBeVisible();
    // One helper is named, the companion; never a second one (0.1.58 qualification).
    for (const ceiling of ["workspace", "enrollment", "daily", "artifact"]) expect(companionJobLabel(held(ceiling))).not.toMatch(/tutor/i);
    expect(screen.queryByText(/Taking longer than usual/)).toBeNull();
    // Paused is not "waiting for a reply": the notice after sending does not say so.
    expect(screen.queryByText(/Waiting for the companion service/)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop waiting for this answer" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel and ask again" })).toBeVisible();
    expect(companionState([held("workspace")], { online: true, awaitingChoice: false })).toBe("paused");
  });
  it("names the learner's own limit, and today's limits, differently", () => {
    expect(companionJobLabel(held("enrollment"))).toMatch(/^Help is paused · you've used the AI help set aside for you in this course/);
    expect(companionJobLabel(held("daily"))).toMatch(/^Help is paused for today · you've used today's AI help in this course\..*ask it again tomorrow\.$/);
    expect(companionJobLabel(held("artifact"))).toMatch(/today's AI help for this lesson/);
    // Without a named limit (an older server, or a held call) it stays the general message.
    expect(companionJobLabel({ ...message, job_state: "budget_wait" })).toBe("Taking longer than usual · your question is saved");
    expect(companionJobLabel({ ...message, job_state: "waiting", job_ceiling: "workspace" })).toBe("Taking longer than usual · your question is saved");
  });
  it("in Hebrew names one helper, המנחה, and uses no gendered address", () => {
    show([held("workspace")], "he");
    expect(screen.getByRole("status", { name: /^מצב המנחה: .?העזרה מושהית · השאלה שלך נשמרה.?$/ })).toBeVisible();
    expect(screen.getByText(/תקציב ה-AI של הקורס נוצל במלואו, ולכן אין תשובות מהמנחה כרגע\. צוות הקורס קיבל הודעה\./)).toBeVisible();
    // The learner's own messages are headed "השאלה שלך", the replies "המנחה".
    expect(screen.getAllByText("השאלה שלך").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/מלווה|המפקח|את\/ה/);
    const { t } = createLearnerTranslator("he");
    expect(companionJobLabel(held("enrollment"), t)).toContain("ניצלת את כל עזרת ה-AI שהוקצתה לך בקורס");
    expect(companionJobLabel(held("daily"), t)).toContain("ואפשר לשאול אותה שוב מחר");
    for (const ceiling of ["workspace", "enrollment", "daily", "artifact"])
      expect(companionJobLabel(held(ceiling), t)).not.toMatch(/מלווה|המפקח|את\/ה|תוכל|תוכלי|יכול|מנחה ה-AI/);
  });
});

/*
 * The 0.1.58 qualification found a reply that stalled part way reading both "Reply unavailable ·
 * the AI service didn't answer in time" and "withdrawn because it did not pass the checks", and the
 * "Waiting for the companion service to reply" notice staying after Stop and after a cancelled
 * question. Each outcome now has one statement, the question's label; the notice after sending
 * only waits while a reply can still come.
 */
describe("one statement per companion outcome", () => {
  const draft = (extra: Partial<CompanionDraft> = {}): CompanionDraft => ({ jobId: "job", messageId: "m", text: "", state: "streaming", shown: true, ...extra });
  const q = (extra: Partial<CompanionMessage> = {}): CompanionMessage => ({ ...message, ...extra });
  const answer: CompanionMessage = { id: "a", role: "assistant", content: "Stored reply.", context: { episodeId: "intro" }, created_at: "2026-01-02", job_id: "job" };
  // Every outcome the learner can meet: the saved question, the stream's draft, and what it reads.
  const matrix: [string, CompanionMessage, CompanionDraft | undefined, string, string][] = [
    ["queued", q({ job_state: "queued" }), undefined, "Queued · not sent yet", "בתור · עוד לא נשלחה"],
    ["sent, being written", q({ job_state: "queued" }), draft(), "Sent · a reply is being written", "נשלחה · התשובה נכתבת עכשיו"],
    ["written, being checked", q({ job_state: "running" }), draft({ state: "complete", text: "Done." }), "Reply written · checking it before it is shown", "התשובה נכתבה · בודקים אותה לפני שהיא מוצגת"],
    ["delayed", q({ job_state: "waiting", job_reason: "provider_uncertain" }), undefined, "Taking longer than usual · your question is saved", "מתעכבת יותר מהרגיל · השאלה שלך נשמרה"],
    ["answered", q({ job_state: "applied" }), undefined, "Answered", "נענתה"],
    ["stalled, no reply at all", q({ job_state: "waiting", job_reason: "provider_uncertain", job_stalled: true }), undefined,
      "Reply unavailable · the AI service didn't answer in time · you can ask your question again", "התשובה לא זמינה · שירות ה-AI לא ענה בזמן · אפשר לשאול את השאלה שוב"],
    ["stalled part way, while the outcome is saved", q({ job_state: "running" }), draft({ state: "withdrawn", reason: "provider_failed" }),
      "The reply stopped part way through · nothing of it was kept", "התשובה נקטעה באמצע · שום חלק ממנה לא נשמר"],
    ["stalled part way, saved", q({ job_state: "failed", job_reason: "verification_rejected", refusal_reason: "provider_stream_stalled" }),
      draft({ state: "withdrawn", reason: "provider_failed" }),
      "Reply unavailable · the AI service stopped part way through, so nothing of the reply was kept · you can ask your question again",
      "התשובה לא זמינה · שירות ה-AI הפסיק לענות באמצע, ולכן שום חלק מהתשובה לא נשמר · אפשר לשאול את השאלה שוב"],
    ["withheld (gave away a check's answer)", q({ job_state: "running" }), draft({ state: "withdrawn", reason: "check_answer_withheld" }),
      "Reply withheld · it gave away the answer to one of the course's checks · a hint without the answer follows",
      "התשובה עוכבה · היא חשפה את התשובה לאחת הבדיקות של הקורס · בהמשך יגיע רמז בלי התשובה"],
    ["not kept, it could not be checked", q({ job_state: "running" }), draft({ state: "withdrawn", reason: "check_unverified" }),
      "Reply not shown · it could not be checked against the course's checks, so it was not kept · a hint without the answer follows",
      "התשובה לא הוצגה · לא הייתה אפשרות לבדוק אותה מול הבדיקות של הקורס, ולכן היא לא נשמרה · בהמשך יגיע רמז בלי התשובה"],
    ["refused by the checks", q({ job_state: "failed", job_reason: "verification_rejected", refusal_reason: "output_too_large" }),
      draft({ state: "withdrawn", reason: "output_too_large" }),
      "Reply not shown · it did not pass the checks, so nothing of it was kept · you can ask your question again",
      "התשובה לא הוצגה · היא לא עברה את הבדיקות, ולכן שום חלק ממנה לא נשמר · אפשר לשאול את השאלה שוב"],
    ["stopped by the learner", q({ job_state: "running" }), draft({ state: "cancelled" }),
      "Stopped after it was sent · nothing of the reply was kept · what the call used until then counts toward this course's AI use",
      "נעצרה אחרי שנשלחה · שום חלק מהתשובה לא נשמר · מה שהבקשה ניצלה עד אז נספר בשימוש של הקורס ב-AI"],
    ["stopped, saved", q({ job_state: "cancelled" }), draft({ state: "cancelled" }),
      "Stopped after it was sent · nothing of the reply was kept · what the call used until then counts toward this course's AI use",
      "נעצרה אחרי שנשלחה · שום חלק מהתשובה לא נשמר · מה שהבקשה ניצלה עד אז נספר בשימוש של הקורס ב-AI"],
    ["cancelled before it was sent", q({ job_state: "cancelled" }), undefined,
      "Cancelled before it was sent · nothing was used · your message is saved", "בוטלה לפני שנשלחה · לא נוצל דבר · ההודעה שלך נשמרה"],
    ["failed", q({ job_state: "failed", job_reason: "deadline_exceeded" }), undefined,
      "Reply unavailable · it could not be prepared · you can ask your question again", "התשובה לא זמינה · לא הצלחנו להכין אותה · אפשר לשאול את השאלה שוב"],
    ["never prepared", q({ job_state: "refused", job_id: null }), undefined,
      "Not sent · this question could not be passed on to the AI service · nothing was used · you can ask it again",
      "לא נשלחה · לא ניתן היה להעביר את השאלה לשירות ה-AI · לא נוצל דבר · אפשר לשאול אותה שוב"],
  ];
  it.each(matrix)("%s: one label in English and Hebrew, and nothing else says what happened", (_name, question, streamed, english, hebrew) => {
    const he = createLearnerTranslator("he");
    expect(companionJobLabel(question, undefined, streamed)).toBe(english);
    expect(stripBidiControls(companionJobLabel(question, he.t, streamed)!)).toBe(hebrew);
    // Gender-neutral: the tutor is המנחה and no verb or adjective takes a gender from it.
    expect(hebrew).not.toMatch(/מלווה|המפקח|הצליח|יכול|זמין|ממתין|מכין|בודק /);
    const messages = question.job_state === "applied" ? [question, answer] : [question];
    const { container, unmount } = render(
      <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={messages} episodeTitles={{}} draft="" onDraftChange={vi.fn()}
        onSend={vi.fn()} pending={false} loaded onCancelQuestion={vi.fn()} drafts={streamed ? [streamed] : []} />,
    );
    const text = container.textContent!;
    expect(text.split(english).length - 1).toBe(1);
    // No second, older wording of an end beside it.
    for (const other of [/did not pass the checks/, /didn't answer in time/, /stopped part way/, /Stopped after it was sent/, /withheld/, /Waiting for the companion service/])
      if (!other.test(english)) expect(text).not.toMatch(other);
    unmount();
  });
  it("the hint that replaced a withheld reply says so once it is stored, so the withholding stays visible (en and he)", () => {
    const he = createLearnerTranslator("he");
    const hint = (reason?: string): CompanionMessage => ({ ...answer, content: "Think about what changes.", context: { episodeId: "intro", ...(reason ? { checkAnswerWithheld: reason } : {}) } });
    expect(companionWithheldNote(hint("check_answer_judged"))).toBe("answer");
    expect(companionWithheldNote(hint("check_option_named"))).toBe("answer");
    expect(companionWithheldNote(hint("check_judge_unavailable"))).toBe("unverified");
    expect(companionWithheldNote(hint("check_keys_unavailable"))).toBe("unverified");
    expect(companionWithheldNote(hint())).toBeUndefined();
    expect(companionWithheldNote({ ...hint("check_answer_judged"), content: "[deleted]" })).toBeUndefined();
    const show = (reply: CompanionMessage, locale?: "he") => render(
      <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={[{ ...message, job_state: "applied" }, reply]} episodeTitles={{}}
        draft="" onDraftChange={vi.fn()} onSend={vi.fn()} pending={false} loaded drafts={[draft({ state: "withdrawn", reason: "check_answer_withheld" })]} />,
      locale ? { wrapper: ({ children }) => <I18nProvider value={he}>{children}</I18nProvider> } : undefined);
    let view = show(hint("check_answer_judged"));
    expect(screen.getByText("This is a hint in place of a reply that gave away the answer to one of the course's checks. That reply was not kept.")).toBeVisible();
    view.unmount();
    view = show(hint("check_judge_unavailable"));
    expect(screen.getByText(/in place of a reply that could not be checked/)).toBeVisible();
    view.unmount();
    view = show(hint());
    expect(view.container.textContent).not.toMatch(/in place of a reply/);
    view.unmount();
    view = show(hint("check_answer_judged"), "he");
    expect(screen.getByText("זה רמז במקום תשובה שחשפה את התשובה לאחת הבדיקות של הקורס. התשובה ההיא לא נשמרה.", { exact: false })).toBeVisible();
    view.unmount();
    expect(he.t("connectedCompanion.withheld.answer")).toBe("זה רמז במקום תשובה שחשפה את התשובה לאחת הבדיקות של הקורס. התשובה ההיא לא נשמרה.");
    for (const key of ["connectedCompanion.withheld.answer", "connectedCompanion.withheld.unverified", "companionClient.job.unverified"] as const)
      expect(he.t(key)).not.toMatch(/מלווה|המפקח|הצליח|יכול|זמין|ממתין|מכין|בודק /);
  });
  it("does not say a reply is being built once its draft was withdrawn or stopped", () => {
    const running = q({ job_state: "running" });
    expect(companionState([running], { online: true, awaitingChoice: false })).toBe("building");
    for (const state of ["withdrawn", "cancelled"] as const)
      expect(companionState([running], { online: true, awaitingChoice: false, drafts: [draft({ state, reason: "provider_failed" })] })).toBe("available");
  });
  it("puts the stalled, stopped, refused and failed questions back in the draft to ask again, and not the waiting ones", () => {
    for (const [name, question, streamed] of matrix) {
      const ends = /stalled, no|stalled part way, saved|refused|stopped|cancelled|failed|never prepared/.test(name);
      expect([name, companionCanAskAgain(question, streamed)]).toEqual([name, ends]);
    }
  });
  it("keeps the notice after sending only while a reply can still come", () => {
    const key = (question: CompanionMessage | undefined, streamed?: CompanionDraft, extra: CompanionMessage[] = []) =>
      sentNoticeKey("m", question ? [question, ...extra] : extra, streamed ? [streamed] : []);
    expect(sentNoticeKey(undefined, [q()])).toBeUndefined();
    // Saved but not read back yet, queued, sent, being written or checked: waiting is true.
    expect(key(undefined)).toBe("connectedCompanion.sent.waiting");
    expect(key(q({ job_state: "queued" }))).toBe("connectedCompanion.sent.waiting");
    expect(key(q({ job_state: "queued" }), draft())).toBe("connectedCompanion.sent.waiting");
    expect(key(q({ job_state: "verifying" }))).toBe("connectedCompanion.sent.waiting");
    expect(key(q({ job_state: "applied" }), undefined, [answer])).toBe("connectedCompanion.sent.replied");
    // Every other end, and a pause by a spending limit, is said by the card alone.
    for (const [question, streamed] of [
      [q({ job_state: "running" }), draft({ state: "cancelled" })],
      [q({ job_state: "cancelled" }), undefined],
      [q({ job_state: "cancelled", job_sent: true }), undefined],
      [q({ job_state: "running" }), draft({ state: "withdrawn", reason: "provider_failed" })],
      [q({ job_state: "waiting", job_stalled: true }), undefined],
      [q({ job_state: "failed", refusal_reason: "output_too_large" }), undefined],
      [q({ job_state: "refused" }), undefined],
      [q({ job_state: "budget_wait", job_reason: "budget_exhausted", job_ceiling: "workspace" }), undefined],
      [q({ content: "[deleted]", job_state: "cancelled" }), undefined],
    ] as [CompanionMessage, CompanionDraft | undefined][])
      expect([question.job_state, streamed?.state, key(question, streamed)]).toEqual([question.job_state, streamed?.state, undefined]);
  });
  it("clears 'Waiting for the companion service' after Stop and after a cancelled queued question, in English and Hebrew", async () => {
    for (const locale of ["en", "he"] as const) {
      const i18n = createLearnerTranslator(locale);
      const waiting = stripBidiControls(i18n.t("connectedCompanion.sent.waiting"));
      const send = vi.fn().mockResolvedValue(receipt);
      const panel = (messages: CompanionMessage[], drafts: CompanionDraft[] = [], draftText = "") => (
        <I18nProvider value={i18n}>
          <ConnectedCompanion context={{ ...context, independentChallengeIds: [] }} messages={messages} episodeTitles={{}} draft={draftText} onDraftChange={vi.fn()}
            onSend={send} pending={false} loaded onCancelQuestion={vi.fn()} drafts={drafts} />
        </I18nProvider>
      );
      const { rerender, unmount } = render(panel([], [], "Why does it change?"));
      fireEvent.click(screen.getByRole("button", { name: i18n.t("connectedCompanion.send.send") }));
      await waitFor(() => expect(screen.getByText(waiting)).toBeVisible());
      rerender(panel([q({ job_state: "queued" })]));
      expect(screen.getByText(waiting)).toBeVisible();
      rerender(panel([q({ job_state: "queued" })], [draft({ text: "Compare them. " })]));
      expect(screen.getByText(waiting)).toBeVisible();
      // Stop: the draft ends, then the saved job reads cancelled. Neither still waits.
      rerender(panel([q({ job_state: "queued" })], [draft({ state: "cancelled" })]));
      expect(screen.queryByText(waiting)).toBeNull();
      rerender(panel([q({ job_state: "cancelled", job_sent: true })], [draft({ state: "cancelled" })]));
      expect(screen.queryByText(waiting)).toBeNull();
      expect(screen.getByText(stripBidiControls(i18n.t("companionClient.job.cancelledSent")))).toBeVisible();
      // A queued question cancelled before it was sent.
      rerender(panel([q({ job_state: "cancelled" })]));
      expect(screen.queryByText(waiting)).toBeNull();
      expect(screen.getByText(stripBidiControls(i18n.t("companionClient.job.cancelled")))).toBeVisible();
      unmount();
    }
  });
});

describe("the companion's state comes from the server's availability", () => {
  const props = (overrides: Partial<React.ComponentProps<typeof ConnectedCompanion>> = {}) => ({
    context,
    messages: [],
    episodeTitles: { intro: "Notice change" },
    draft: "",
    onDraftChange: () => {},
    onSend: vi.fn(),
    pending: false,
    loaded: true,
    ...overrides,
  });
  it("says Available only when a companion job can answer, and that it is not turned on otherwise", () => {
    const { rerender } = render(<ConnectedCompanion {...props({ availability: "not_set_up" })} />);
    expect(screen.getByRole("status", { name: /^Companion status: Not turned on for this course yet/ })).toBeVisible();
    expect(screen.queryByText(/Companion: Available/)).toBeNull();
    rerender(<ConnectedCompanion {...props()} />);
    expect(screen.getByRole("status", { name: "Companion status: Checking whether it is on…" })).toBeVisible();
    rerender(<ConnectedCompanion {...props({ availability: "ready" })} />);
    expect(screen.getByRole("status", { name: "Companion status: Available" })).toBeVisible();
  });
  it("outside a lesson shows no empty conversation, no place labels and no disabled composer", () => {
    render(<ConnectedCompanion {...props({ context: { ...context, episodeId: undefined, episodeTitle: undefined, blockId: undefined, blockTitle: undefined }, availability: "not_set_up" })} />);
    expect(screen.queryByText("Your saved conversation")).toBeNull();
    expect(screen.queryByText("Following your place")).toBeNull();
    expect(screen.queryByText("Course roadmap")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.queryByText(/Open a lesson before sending/)).toBeNull();
    expect(screen.getByText(/Ask from inside a lesson/)).toBeVisible();
  });
  it("keeps a draft started in a lesson, and the saved conversation's badge once there are messages", () => {
    const message = { id: "m1", role: "learner" as const, content: "Why?", context: { episodeId: "intro" }, created_at: "2026-10-01T10:00:00Z" };
    render(<ConnectedCompanion {...props({ context: { ...context, episodeId: undefined, episodeTitle: undefined }, draft: "Half a question", messages: [message] as never, availability: "ready" })} />);
    expect(screen.getByText("Your saved conversation")).toBeVisible();
    expect(screen.getByDisplayValue("Half a question")).toBeVisible();
    expect(screen.getByText(/Open a lesson before sending/)).toBeVisible();
  });
});
