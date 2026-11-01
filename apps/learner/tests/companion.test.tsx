import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedCompanion, lessonLabel } from "../src/components/ConnectedCompanion";
import { stripBidiControls } from "@course-core/i18n";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";
import {
  applyDraftFrame,
  companionHasPending,
  companionJobLabel,
  companionState,
  companionStateText,
  type CompanionDraft,
  type CompanionMessage,
} from "../src/client/companionClient";
import { CourseApiError } from "../src/client/apiClient";
import { createConnectedDraftStore } from "../src/connected/drafts";
import { context, message, receipt } from "./companionFixtures";
import { companionBridge, resetCompanionBridge } from "../src/connected/companion/bridge";
import { pressWhenReady } from "./pressWhenReady";

/*
 * The companion's conversation as a familiar chat (final design §3): the saved messages as a
 * thread, every state of a reply in its own row, one notice above the composer, and one status
 * region that says each change once. Timed states are replyStates.test.ts; the composer's keys
 * composer.test.tsx.
 */
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetCompanionBridge();
});
type Props = React.ComponentProps<typeof ConnectedCompanion>;
const base: Props = {
  context: { ...context, independentChallengeIds: [] },
  messages: [],
  episodeTitles: { intro: "Notice change" },
  draft: "",
  onDraftChange: () => {},
  onSend: vi.fn(),
  pending: false,
  loaded: true,
};
function show(props: Partial<Props> = {}, locale: "en" | "he" = "en") {
  const view = (extra: Partial<Props>) => (
    <I18nProvider value={createLearnerTranslator(locale)}>
      <ConnectedCompanion {...base} {...extra} />
    </I18nProvider>
  );
  const result = render(view(props));
  return { ...result, again: (extra: Partial<Props>) => result.rerender(view({ ...props, ...extra })) };
}
const status = () => document.querySelector<HTMLElement>("[data-cc-announcer]")!;
/** What the page shows, without the hidden status region (which repeats a sentence once). */
const visibleText = (container: HTMLElement) => {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-cc-announcer]").forEach((node) => node.remove());
  return copy.textContent ?? "";
};
const reply = (id: string, content: string, extra: Partial<CompanionMessage> = {}): CompanionMessage => ({
  id, role: "assistant", content, context: { episodeId: "intro" }, created_at: "2026-01-02T10:00:00Z", job_id: id, ...extra,
});

describe("persisted companion integration", () => {
  it("takes text from elsewhere in the app into the message box, made before or after it listens", async () => {
    companionBridge.compose({ source: "check", text: "Why is 2 the smaller one?", focus: false });
    const change = vi.fn();
    show({ context, draft: "", onDraftChange: change });
    await act(async () => {});
    expect(change).toHaveBeenCalledWith("Why is 2 the smaller one?");
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Why is 2 the smaller one?");
    act(() => companionBridge.compose({ source: "nudge", text: "And for three values?" }));
    expect(change).toHaveBeenLastCalledWith("And for three values?");
  });

  it("shows the saved messages as a chat: a bubble, the reply as prose, the lesson once, and no status line, badge or place block", () => {
    show({ messages: [{ ...message, job_state: "applied" }, reply("job", "Because the minimum may equal another member.")] });
    const log = screen.getByRole("log", { name: "Saved companion messages" });
    expect(log).toHaveAttribute("aria-live", "off");
    expect(log).toHaveAttribute("tabindex", "0");
    // The question is a bubble with no "You" label; screen readers hear "You said".
    const question = within(log).getByRole("article", { name: "You said" });
    expect(question.querySelector(".cc-chat-bubble")).toHaveTextContent("Why does it change?");
    expect(within(question).getByText("Why does it change?")).toHaveAttribute("dir", "auto");
    expect(within(log).getByRole("article", { name: "Companion said" })).toHaveTextContent("Because the minimum may equal another member.");
    expect(within(log).getAllByText("Notice change")).toHaveLength(1);
    for (const gone of [/Companion: /, /Your saved conversation/, /Asking about/, /^Available$/, /From: /, /About: /, /Answered/, /Message saved/, /^You$/])
      expect(screen.queryByText(gone)).toBeNull();
    // No timestamps in the turns: dates sit in start-aligned divider lines only.
    expect(log.querySelectorAll("article time")).toHaveLength(0);
    expect(log.querySelectorAll(".cc-chat-divider time").length).toBeGreaterThan(0);
    expect(companionJobLabel({ ...message, job_state: "failed", job_reason: "secret-provider-token" })).not.toContain("secret");
  });

  it("names each lesson once, in a divider where it changes, including old rows", () => {
    show({
      messages: [
        { ...message, id: "q-here", job_id: "here", job_state: "applied" }, reply("here", "Reply here"),
        { ...message, id: "q-there", job_id: "there", content: "Earlier?", context: { episodeId: "before" }, job_state: "applied" }, reply("there", "Reply there", { context: {} }),
        { ...message, id: "q-legacy", job_id: "legacy", content: "Old row?", context: {}, job_state: "applied" }, reply("legacy", "Legacy reply", { context: {} }),
        { ...message, id: "q-gone", job_id: "gone", content: "Gone?", context: { episodeId: "removed" }, job_state: "applied" }, reply("gone", "Gone reply", { context: { episodeId: "removed" } }),
        // A note saved before replies recorded their lesson, with no question.
        reply("orphan", "A note", { context: {}, job_id: null }),
      ],
      episodeTitles: { intro: "Notice change", before: "Rates of change" },
    });
    const log = screen.getByRole("log");
    for (const divider of ["Notice change", "Rates of change", "A lesson no longer in this course"])
      expect(within(log).getAllByText(divider)).toHaveLength(1);
    // A reply without its own lesson takes its question's; the old row and the note have none.
    expect(within(log).getAllByText("Lesson not recorded")).toHaveLength(2);
    // Only the course's own titles name a lesson.
    expect(lessonLabel("toString", "intro", {})).toBe("A lesson no longer in this course");
    expect(lessonLabel(null, "intro", { intro: "Notice change" })).toBe("Lesson not recorded");
    expect(lessonLabel("intro", "intro", { intro: "Notice change" })).toBe("Notice change");
  });

  it("names lessons in Hebrew, and a deleted question is one line", () => {
    const { t } = createLearnerTranslator("he");
    expect(lessonLabel(null, "intro", {}, t)).toBe("השיעור לא נרשם");
    expect(lessonLabel("gone", "intro", {}, t)).toBe("שיעור שכבר לא בקורס");
    show({ messages: [{ ...message, content: "[deleted]", job_state: "applied" }, reply("job", "[deleted]")] });
    expect(screen.getByText("You deleted a question.")).toBeVisible();
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("says when the course moved to a newer version, and a reply that reached its length limit offers Continue", async () => {
    const send = vi.fn().mockResolvedValue({ ...receipt, downgradedChallengeIds: [] });
    show({
      onSend: send,
      messages: [
        { ...message, id: "q1", job_id: "a1", job_state: "applied", context: { episodeId: "intro", courseDigest: "v1" } },
        reply("a1", "First.", { context: { episodeId: "intro", courseDigest: "v1" } }),
        { ...message, id: "q2", job_id: "a2", job_state: "applied", context: { episodeId: "intro", courseDigest: "v2" } },
        reply("a2", "Long reply", { context: { episodeId: "intro", courseDigest: "v2", cutShort: true } }),
      ],
    });
    expect(screen.getByText("Your course moved to a newer version. Earlier messages stay here.")).toBeVisible();
    expect(screen.getByText("This reply reached its length limit.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("Please continue.", undefined));
  });

  it("keeps drafts on failed sends, says so on the question, and sends no consent flag without an independent check", async () => {
    const send = vi.fn().mockRejectedValue(new CourseApiError("INVALID_REQUEST", 400));
    const change = vi.fn();
    show({ draft: "Keep me", onDraftChange: change, onSend: send });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("Keep me", undefined));
    expect(await within(screen.getByRole("log")).findByText("Couldn't send. Your text is back in the box.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Keep me");
    // The saved draft was never cleared: nothing was accepted.
    expect(change).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent("Couldn't send. Your text is back in the box.");
  });

  it("shows a question once when the conversation brings it back before its send is confirmed", async () => {
    let confirm: (value: typeof receipt) => void = () => {};
    const send = vi.fn(() => new Promise<typeof receipt>((resolve) => { confirm = resolve; }));
    const { again } = show({ draft: "Only once", onSend: send });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const log = screen.getByRole("log");
    expect(within(log).getAllByText("Only once")).toHaveLength(1);
    // The event stream is faster than the send's answer.
    again({ draft: "Only once", onSend: send, messages: [{ ...message, id: "saved", content: "Only once", job_state: "queued" }] });
    expect(within(log).getAllByText("Only once")).toHaveLength(1);
    await act(async () => confirm({ ...receipt, messageId: "saved", downgradedChallengeIds: [] }));
    expect(within(log).getAllByText("Only once")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stop reply" })).toBeVisible();
  });

  it("says a save it could not confirm on the question, with Refresh, and keeps the text out of the box", async () => {
    const send = vi.fn().mockRejectedValue(new CourseApiError("NETWORK_UNCERTAIN", 0));
    const refresh = vi.fn();
    show({ draft: "Did it save?", onSend: send, onRefresh: refresh });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await within(screen.getByRole("log")).findByText(/We couldn't confirm your message was saved/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("");
    await pressWhenReady(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("counts down a rate limit only for an HTTP 429 that says when to ask again", async () => {
    const send = vi.fn().mockRejectedValue(new CourseApiError("RATE_LIMITED", 429, { retryAfter: 42 }));
    show({ draft: "Too fast?", onSend: send });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Too many questions at once. You can ask again in 0:42.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Too fast?");
  });

  it("isolates drafts by account and keeps them in memory when storage is denied", () => {
    const map = new Map<string, string>();
    const store = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
    const a = createConnectedDraftStore("a", store);
    a.write("lesson", "saved");
    expect(createConnectedDraftStore("a", store).read("lesson")).toBe("saved");
    expect(createConnectedDraftStore("b", store).read("lesson")).toBe("");
    const fail = () => {
      throw Error();
    };
    const denied = createConnectedDraftStore("a", { getItem: fail, setItem: fail, removeItem: fail });
    denied.write("answer", "never lose");
    expect(denied.read("answer")).toBe("never lose");
    expect(denied.unavailable).toBe(true);
    show({ storageUnavailable: true });
    expect(screen.getByText("Your draft is kept in this tab only, because browser storage is off.")).toBeVisible();
  });

  it("saves typing 300 ms after the last key, and a draft changed elsewhere replaces what is shown", () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const { again } = show({ onDraftChange: change });
    const box = screen.getByRole("textbox", { name: "Message to your companion" });
    fireEvent.change(box, { target: { value: "W" } });
    fireEvent.change(box, { target: { value: "Why" } });
    act(() => void vi.advanceTimersByTime(299));
    expect(change).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(change).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledWith("Why");
    again({ onDraftChange: change, draft: "From another tab" });
    expect(box).toHaveValue("From another tab");
  });

  it("keeps text over the length limit in the box when the saved draft comes back cut to the limit", () => {
    vi.useFakeTimers();
    const long = "x".repeat(4212);
    const change = vi.fn();
    const { again } = show({ onDraftChange: change });
    const box = screen.getByRole("textbox", { name: "Message to your companion" });
    fireEvent.change(box, { target: { value: long } });
    act(() => void vi.advanceTimersByTime(300));
    expect(change).toHaveBeenCalledWith(long);
    // The drafts store keeps a message's length at most (drafts.ts).
    again({ onDraftChange: change, draft: long.slice(0, 4000) });
    expect(box).toHaveValue(long);
    expect(screen.getByText("212 characters over")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "true");
  });

  it("a new question takes Ask again from the one before in the same frame it shows, so nothing moves after it is anchored", async () => {
    const send = vi.fn(() => new Promise<never>(() => {}));
    show({ onSend: send, messages: [{ ...message, job_state: "waiting", job_reason: "provider_uncertain", job_stalled: true }] });
    expect(screen.getByRole("button", { name: "Ask again" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to your companion" }), { target: { value: "And now?" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(send).toHaveBeenCalled();
    expect(screen.getByText("And now?")).toBeVisible();
    expect(screen.getByText("No reply came through.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Ask again" })).toBeNull();
  });

  it("a conversation that could not be read is not shown as an empty one", () => {
    show({ error: "unavailable", onRefresh: () => {} });
    expect(screen.getByText("Couldn't refresh the conversation. Your draft is safe.")).toBeVisible();
    expect(screen.queryByText("Ask anything about this lesson")).toBeNull();
  });

  it("derives truthful companion states from saved jobs and the browser", () => {
    const at = (job_state: string | null, job_reason: string | null = null): CompanionMessage => ({ ...message, job_state, job_reason });
    expect(companionState([at("running")], { online: false, awaitingChoice: true })).toBe("offline");
    expect(companionState([at("running")], { online: true, awaitingChoice: true })).toBe("waiting_for_you");
    expect(companionState([at("running")], { online: true, awaitingChoice: false })).toBe("building");
    expect(companionState([at("verifying")], { online: true, awaitingChoice: false })).toBe("checking");
    expect(companionState([at("queued", "configuration_missing")], { online: true, awaitingChoice: false })).toBe("unavailable");
    expect(companionState([at("budget_wait")], { online: true, awaitingChoice: false })).toBe("still_working");
    expect(companionState([at("waiting", "configuration_missing")], { online: true, awaitingChoice: false })).toBe("unavailable");
    expect(companionState([at("queued")], { online: true, awaitingChoice: false })).toBe("queued");
    expect(companionState([at("applied")], { online: true, awaitingChoice: false })).toBe("available");
    // Idle is never a state of its own: the collapsed sheet just says "Companion".
    expect(companionStateText("available")).toBe("Companion");
    expect(companionStateText("building")).toBe("Preparing a reply…");
  });

  it("holds a question while offline, with Cancel, and sends it once the connection returns", async () => {
    const send = vi.fn().mockResolvedValue({ ...receipt, downgradedChallengeIds: [] });
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    show({ draft: "Kept while offline", onSend: send, availability: "ready" });
    expect(screen.getByText("You're offline. Your message sends when you reconnect.")).toBeVisible();
    // Send stays enabled, with its clock badge.
    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toHaveAttribute("title", "Sends when you're back online");
    fireEvent.click(button);
    expect(send).not.toHaveBeenCalled();
    const log = screen.getByRole("log");
    expect(within(log).getByText("Kept while offline")).toBeVisible();
    expect(within(log).getByText("Waiting to send")).toBeVisible();
    expect(within(log).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("");
    online.mockReturnValue(true);
    await act(async () => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith("Kept while offline", undefined);
    expect(status()).toHaveTextContent("Back online. Sending your question.");
    expect(screen.queryByText("Waiting to send")).toBeNull();
  });

  it("puts a question held offline back in the box when the learner cancels it", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    show({ draft: "Never mind" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(within(screen.getByRole("log")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Never mind");
    expect(within(screen.getByRole("log")).queryByText("Never mind")).toBeNull();
  });
});

describe("streamed companion replies (T01)", () => {
  const frame = (offset: number, text: string, state = "streaming", extra = {}) => ({ jobId: "job", messageId: "m", offset, text, state, ...extra });
  const draft = (extra: Partial<CompanionDraft> = {}): CompanionDraft => ({ jobId: "job", messageId: "m", text: "Compare them on a number line. ", state: "streaming", shown: true, ...extra });
  const pending: CompanionMessage = { ...message, job_state: "running" };

  it("shows a streaming draft in place of the dots, outside the live announcements, with the round button as Stop", () => {
    show({ messages: [pending], drafts: [draft()], onCancelQuestion: vi.fn() });
    const row = screen.getByRole("article", { name: "Companion said" });
    expect(row).toHaveAttribute("data-reply-state", "streaming");
    expect(row.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(row).getByText("Compare them on a number line.", { exact: false })).toBeVisible();
    // No "not yet checked" label; the text is never in a live region.
    expect(screen.queryByText(/not checked|unchecked|not yet checked/)).toBeNull();
    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "off");
    expect(status()).not.toHaveTextContent("Compare them");
    expect(row.querySelector('[data-cc-caret="live"]')).not.toBeNull();
    const stop = screen.getByRole("button", { name: "Stop reply" });
    expect(stop).toHaveAttribute("title", "Stop (Esc)");
    expect(companionState([pending], { online: true, awaitingChoice: false, drafts: [draft()] })).toBe("replying");
  });

  it("says when the connection drops mid-reply, and the stored reply replaces the draft", () => {
    const { again } = show({ messages: [pending], drafts: [draft()], streamConnected: false });
    expect(within(screen.getByRole("log")).getByText("Connection lost. The reply continues when you're back online.")).toBeVisible();
    again({ messages: [{ ...message, job_state: "applied" }, reply("job", "Stored and checked reply.")], drafts: [draft({ state: "complete" })], streamConnected: true });
    expect(within(screen.getByRole("log")).queryByText("Connection lost. The reply continues when you're back online.")).toBeNull();
    expect(screen.getByText("Stored and checked reply.")).toBeVisible();
    expect(screen.getAllByRole("article", { name: "Companion said" })).toHaveLength(1);
  });

  it("replaces a refused draft in place by why it was not shown, said once, with Ask again", () => {
    const { again, container } = show({ messages: [pending], drafts: [draft({ state: "withdrawn", text: "", reason: "output_refused" })] });
    expect(screen.getByText("This reply was removed because it didn't pass the course's checks.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ask again" })).toBeVisible();
    again({ drafts: [draft({ state: "withdrawn", text: "", reason: "provider_failed" })] });
    expect(screen.getByText("The reply stopped partway.")).toBeVisible();
    expect(screen.queryByText(/didn't pass the course's checks/)).toBeNull();
    // A withheld reply is checked while Core's hint takes its place: nothing of it shows.
    again({ drafts: [draft({ state: "withdrawn", text: "", reason: "check_answer_withheld" })] });
    expect(container.textContent).not.toMatch(/removed|stopped partway|Compare them/);
    expect(status()).toHaveTextContent("Couldn't reply. You can ask again.");
  });

  it("a reply about a graded check is checked out of sight: no draft text, then 'Checking the reply…', with Stop (en and he)", () => {
    vi.useFakeTimers();
    let drafts = applyDraftFrame({}, frame(0, "", "streaming", { checking: true }));
    expect(drafts.job).toMatchObject({ checking: true, text: "", shown: false });
    drafts = applyDraftFrame(drafts, frame(0, "", "complete"));
    expect(drafts.job).toMatchObject({ checking: true, state: "complete" });
    const checking = draft({ text: "", shown: false, checking: true });
    expect(companionJobLabel(pending, undefined, checking)).toBe("Checking the reply…");
    expect(companionJobLabel(pending, createLearnerTranslator("he").t, checking)).toBe("התשובה בבדיקה…");
    show({ messages: [pending], drafts: [checking], onCancelQuestion: vi.fn() });
    expect(screen.queryByText("Checking the reply…")).toBeNull();
    act(() => void vi.advanceTimersByTime(1100));
    expect(screen.getByText("Checking the reply…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop reply" })).toBeVisible();
  });

  it("keeps the partial text after the learner's Stop, muted, never saved (Q10), and says a failed stop", async () => {
    let fail: (error: Error) => void = () => {};
    const cancel = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }))
      .mockResolvedValueOnce(undefined);
    const send = vi.fn();
    show({ messages: [pending], drafts: [draft()], onCancelQuestion: cancel, onSend: send });
    fireEvent.click(screen.getByRole("button", { name: "Stop reply" }));
    // One element in every state: stopping keeps the same button, busy; a second press sends nothing.
    const stopping = screen.getByRole("button", { name: "Stop reply" });
    expect(stopping).toHaveAttribute("aria-busy", "true");
    fireEvent.click(stopping);
    expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error("offline")));
    expect(within(screen.getByRole("log")).getByText("Couldn't stop the reply. Try again, or delete the question.")).toBeVisible();
    expect(status()).toHaveTextContent("Couldn't stop the reply.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop reply" })));
    expect(cancel).toHaveBeenNthCalledWith(2, "m");
    expect(screen.getByText("You stopped this reply. This part wasn't checked, so it won't be saved.")).toBeVisible();
    const muted = document.querySelector(".cc-chat-prose.is-muted")!;
    expect(muted).toHaveTextContent("Compare them on a number line.");
    expect(within(screen.getByRole("log")).queryByText(/Couldn't stop/)).toBeNull();
    expect(status()).toHaveTextContent("Reply stopped");
    // Never sent anywhere: the partial text lives on this page only.
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ask again" }));
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Why does it change?");
  });

  it("after a reload, a stopped reply says only that it was stopped", () => {
    show({ messages: [{ ...message, job_state: "cancelled", job_sent: true }] });
    expect(screen.getByText("You stopped this reply.")).toBeVisible();
    expect(screen.queryByText(/wasn't checked/)).toBeNull();
    expect(screen.getByRole("button", { name: "Ask again" })).toBeVisible();
  });

  it("stopping a question before its call was sent cancels it and puts its text back in the box", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const queued: CompanionMessage = { ...message, job_state: "queued" };
    const { again } = show({ messages: [queued], onCancelQuestion: cancel });
    fireEvent.click(screen.getByRole("button", { name: "Stop reply" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("m"));
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Why does it change?");
    expect(status()).toHaveTextContent("Question cancelled. Your text is back in the box.");
    // Once saved as cancelled before it was sent, the question was never asked: it leaves the thread.
    again({ messages: [{ ...queued, job_state: "cancelled" }], onCancelQuestion: cancel });
    expect(within(screen.getByRole("log")).queryByText("Why does it change?")).toBeNull();
  });

  it("switches to Stop as soon as the reply's call is sent, even while the saved job still reads queued", () => {
    const queued = { ...message, job_state: "queued" };
    expect(companionJobLabel(queued)).toBeUndefined();
    const { again } = show({ messages: [queued], onCancelQuestion: vi.fn(), drafts: [draft({ text: "", shown: false })] });
    expect(screen.getByRole("button", { name: "Stop reply" })).toBeVisible();
    again({ drafts: [draft()] });
    expect(screen.getByText("Compare them on a number line.", { exact: false })).toBeVisible();
    again({ drafts: [draft({ state: "cancelled", text: "" })] });
    expect(screen.getByRole("button", { name: "Send" })).toBeVisible();
    expect(screen.getByText("You stopped this reply.")).toBeVisible();
    expect(companionState([queued], { online: true, awaitingChoice: false, drafts: [draft({ text: "" })] })).toBe("replying");
  });

  it("shows the same states in Hebrew", () => {
    show({ messages: [{ ...message, job_state: "queued" }], onCancelQuestion: vi.fn(), drafts: [draft({ text: "", shown: false })] }, "he");
    expect(screen.getByRole("button", { name: "עצירת התשובה" })).toHaveAttribute("title", "עצירה (Esc)");
    expect(screen.getByRole("log", { name: "הודעות שמורות עם המנחה" })).toBeVisible();
  });
});

describe("help paused by a spending limit", () => {
  const held = (ceiling: string): CompanionMessage => ({ ...message, job_state: "budget_wait", job_reason: "budget_exhausted", job_ceiling: ceiling });
  it("says plainly that help is paused at the course's limit and that staff know, with Cancel on the question", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    show({ messages: [held("workspace")], onCancelQuestion: cancel });
    expect(screen.getByText("Help is paused for now. Your question is saved, and course staff know.")).toBeVisible();
    const log = screen.getByRole("log");
    expect(within(log).getByText("Waiting to send")).toBeVisible();
    // Said once: the banner and the question's footer, nothing in a reply row or a header.
    expect(screen.queryByText(/Preparing a reply/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More about this" }));
    expect(screen.getByText("This course has a shared limit on help. Course staff can raise it.")).toBeVisible();
    fireEvent.click(within(log).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("m"));
    expect(companionJobLabel(held("workspace"))).toBe("Waiting to send");
    expect(companionState([held("workspace")], { online: true, awaitingChoice: false })).toBe("paused");
  });
  it("names the learner's own limit, and today's limits, differently", () => {
    const { again } = show({ messages: [held("enrollment")] });
    expect(screen.getByText("Your help limit in this course is used up for now. Your question is saved, and course staff know.")).toBeVisible();
    again({ messages: [held("daily")] });
    expect(screen.getByText("Help is paused until tomorrow. Your question is saved.")).toBeVisible();
    again({ messages: [held("artifact")] });
    expect(screen.getByText("Help for this lesson is paused until tomorrow. Your question is saved.")).toBeVisible();
    // Without a named limit (an older server, or a held call) nothing claims help is paused.
    expect(companionJobLabel({ ...message, job_state: "budget_wait" })).toBeUndefined();
  });
  it("in Hebrew names one helper, המנחה, and uses no gendered address", () => {
    show({ messages: [held("workspace")] }, "he");
    expect(screen.getByText("העזרה מושהית כרגע. השאלה נשמרה, וצוות הקורס יודע.")).toBeVisible();
    expect(within(screen.getByRole("log")).getByText("בהמתנה לשליחה")).toBeVisible();
    expect(screen.getAllByRole("article", { name: "ההודעה שלך" }).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/מלווה|המפקח|את\/ה|תוכל|תוכלי|שלחת|עצרת/);
    const { t } = createLearnerTranslator("he");
    for (const ceiling of ["workspace", "enrollment", "daily", "artifact"])
      expect(companionJobLabel(held(ceiling), t)).not.toMatch(/מלווה|המפקח|את\/ה|תוכל|תוכלי|יכול/);
  });
});

/*
 * Each outcome has one short statement (final design §3.5), said once in one place: the reply row
 * or the question's footer. "Answered" is gone; the reply is the answer.
 */
describe("one statement per companion outcome", () => {
  const draft = (extra: Partial<CompanionDraft> = {}): CompanionDraft => ({ jobId: "job", messageId: "m", text: "", state: "streaming", shown: true, ...extra });
  const q = (extra: Partial<CompanionMessage> = {}): CompanionMessage => ({ ...message, ...extra });
  // The fifth column: the statement shows only after a while (checking for more than 1 s).
  const matrix: [string, CompanionMessage, CompanionDraft | undefined, string | undefined, string | undefined, boolean?][] = [
    ["queued", q({ job_state: "queued" }), undefined, undefined, undefined],
    ["sent, being written", q({ job_state: "queued" }), draft({ text: "Partly" }), undefined, undefined],
    ["written, being checked", q({ job_state: "running" }), draft({ state: "complete", text: "Done." }), "Checking the reply…", "התשובה בבדיקה…", true],
    ["delayed", q({ job_state: "waiting", job_reason: "provider_uncertain" }), undefined, undefined, undefined],
    ["answered", q({ job_state: "applied" }), undefined, undefined, undefined],
    ["stalled, no reply at all", q({ job_state: "waiting", job_reason: "provider_uncertain", job_stalled: true }), undefined, "No reply came through.", "לא התקבלה תשובה."],
    ["stalled part way, while the outcome is saved", q({ job_state: "running" }), draft({ state: "withdrawn", reason: "provider_failed" }), "The reply stopped partway.", "התשובה נקטעה באמצע."],
    ["stalled part way, saved", q({ job_state: "failed", job_reason: "verification_rejected", refusal_reason: "provider_stream_stalled" }), draft({ state: "withdrawn", reason: "provider_failed" }), "The reply stopped partway.", "התשובה נקטעה באמצע."],
    ["refused by the checks", q({ job_state: "failed", job_reason: "verification_rejected", refusal_reason: "output_too_large" }), undefined, "This reply was removed because it didn't pass the course's checks.", "התשובה הוסרה כי לא עברה את בדיקות הקורס."],
    ["stopped by the learner", q({ job_state: "running" }), draft({ state: "cancelled" }), "You stopped this reply.", "התשובה נעצרה."],
    ["stopped, saved", q({ job_state: "cancelled", job_sent: true }), undefined, "You stopped this reply.", "התשובה נעצרה."],
    ["never prepared", q({ job_state: "refused" }), undefined, "This question couldn't be sent. Edit it and try again.", "לא ניתן היה לשלוח את השאלה. אפשר לערוך ולנסות שוב."],
    ["failed", q({ job_state: "dead" }), undefined, "No reply came through.", "לא התקבלה תשובה."],
  ];
  for (const [name, question, streamed, english, hebrew, later] of matrix)
    it(`${name}: one statement in English and Hebrew, and nothing else says what happened`, () => {
      expect(companionJobLabel(question, undefined, streamed)).toBe(english);
      expect(companionJobLabel(question, createLearnerTranslator("he").t, streamed)).toBe(hebrew);
      const answered = question.job_state === "applied" ? [reply("job", "Stored reply.")] : [];
      const { container } = show({ messages: [question, ...answered], drafts: streamed ? [streamed] : [], onCancelQuestion: vi.fn() });
      const text = visibleText(container);
      if (english) expect(text.split(english).length - 1).toBe(later ? 0 : 1);
      for (const other of matrix.map((row) => row[3]).filter((value): value is string => !!value && value !== english))
        expect(text).not.toContain(other);
      expect(text).not.toMatch(/Answered|Queued|Message saved|·/);
    });

  it("a hint that replaced a withheld reply reads as a normal reply in its own language, with the answer chips", () => {
    const hint = reply("job", "אי אפשר לתת את התשובה לבדיקה שנספרת. מה כבר ידוע מהשאלה, ואיזה כלל מהשיעור מתאים?", {
      context: { episodeId: "intro", checkAnswerWithheld: "check_answer_given" },
    });
    show({ messages: [{ ...message, job_state: "applied" }, hint] });
    expect(document.querySelector(".cc-chat-prose[lang='he']")).not.toBeNull();
    expect(screen.queryByText(/That reply was not kept/)).toBeNull();
    expect(screen.getByText("Your turn")).toBeVisible();
    expect(screen.getByRole("button", { name: "Here's my reasoning" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Here's my reasoning" }));
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("My reasoning: ");
  });

  it("announces a reply that arrives once, in full, or by heading navigation when it is long", () => {
    const { again } = show({ messages: [{ ...message, job_state: "running" }] });
    again({ messages: [{ ...message, job_state: "applied" }, reply("job", "Compare **both** values.")] });
    expect(status()).toHaveTextContent("Companion replied: Compare both values.");
    again({ messages: [{ ...message, job_state: "applied" }, reply("job", "Compare **both** values."), { ...message, id: "m2", job_id: "j2", job_state: "applied" }, reply("j2", "x".repeat(700))] });
    expect(status()).toHaveTextContent("Companion replied. Use heading navigation to read it.");
  });
});

describe("whose turn it is", () => {
  const asking = reply("job", "9 is x + b. In y = w·x + b, what happens to x before b is added?", { context: { episodeId: "intro", asksLearner: true } });
  it("sets the closing question at 600 with 'Your turn', asks for an answer, and the answer chips send a visible turn", async () => {
    const send = vi.fn().mockResolvedValue({ ...receipt, messageId: "answer", downgradedChallengeIds: [] });
    show({ messages: [{ ...message, job_state: "applied" }, asking], onSend: send });
    const question = document.querySelector<HTMLElement>("[data-cc-question]")!;
    expect(question).toHaveTextContent("In y = w·x + b, what happens to x before b is added?");
    expect(question).toHaveStyle({ fontWeight: "600" });
    expect(screen.getByText("Your turn")).toBeVisible();
    const box = screen.getByRole("textbox", { name: "Message to your companion" });
    expect(box).toHaveAttribute("placeholder", "Your answer…");
    expect(box.getAttribute("placeholder")).not.toMatch(/\?$/);
    const chips = screen.getByRole("group", { name: "Suggested answers" });
    expect(within(chips).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["I'm not sure", "Give me a hint", "Show me an example"]);
    fireEvent.click(within(chips).getByRole("button", { name: "I'm not sure" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("I'm not sure", undefined));
    expect(within(screen.getByRole("log")).getByText("I'm not sure")).toBeVisible();
    // Any send ends the learner's turn: the tag goes.
    expect(screen.queryByText("Your turn")).toBeNull();
  });
  it("uses the same rule on an older reply stored without the flag, and offers follow-ups otherwise", () => {
    const old = reply("job", "Which one is smaller?");
    const { again } = show({ messages: [{ ...message, job_state: "applied" }, old] });
    expect(screen.getByText("Your turn")).toBeVisible();
    again({ messages: [{ ...message, job_state: "applied" }, reply("job", "The smaller one is 2.")] });
    expect(screen.queryByText("Your turn")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveAttribute("placeholder", "Reply…");
    expect(within(screen.getByRole("group", { name: "Suggested answers" })).getAllByRole("button").map((chip) => chip.textContent))
      .toEqual(["Explain it another way", "Show me an example", "Quiz me on this"]);
  });
  it("adds 'Show me how' after three question turns in a row, and hides chips once the learner types", () => {
    const turns: CompanionMessage[] = [];
    for (const n of [1, 2, 3]) turns.push({ ...message, id: `q${n}`, job_id: `a${n}`, job_state: "applied" }, reply(`a${n}`, `Step ${n}?`, { context: { episodeId: "intro", asksLearner: true } }));
    show({ messages: turns });
    expect(screen.getByRole("button", { name: "Show me how" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to your companion" }), { target: { value: "x" } });
    expect(screen.queryByRole("group", { name: "Suggested answers" })).toBeNull();
  });
});

describe("the companion's state comes from the server's availability", () => {
  it("shows nothing while it is ready or being checked, and says when it is not turned on", () => {
    const { again, container } = show({ availability: undefined });
    expect(container.querySelector(".cc-chat-notice")).toBeNull();
    again({ availability: "ready" });
    expect(container.querySelector(".cc-chat-notice")).toBeNull();
    expect(screen.queryByText(/Available|Checking whether/)).toBeNull();
    again({ availability: "unknown" });
    expect(container.querySelector(".cc-chat-notice")).toBeNull();
    again({ availability: "not_set_up" });
    expect(screen.getByText("Your companion isn't on for this course yet. You can still ask; questions are saved and answered once it's on.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toBeVisible();
  });
  it("shows an empty lesson's start: where the learner is, what to ask, the policy and starter chips that fill the box", () => {
    show({ context: { ...context, independentChallengeIds: [], blockTitle: "Part 2 of 3" } });
    expect(screen.getByText("Ask anything about this lesson")).toBeVisible();
    expect(screen.getByText(/Your companion sees this lesson and your answers here\./)).toBeVisible();
    expect(stripBidiControls(screen.getByText(/Part 2 of 3/).textContent ?? "")).toBe("Notice change · Part 2 of 3");
    const chip = screen.getByRole("button", { name: "Explain this part another way" });
    expect(chip).toHaveAccessibleDescription("Fills in the message box");
    fireEvent.click(chip);
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Explain this part another way");
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveAttribute("placeholder", "Ask about this lesson…");
  });
  it("outside a lesson shows where the conversation lives and the way into a lesson, and no composer without a draft", () => {
    show({ context: { ...context, episodeId: undefined, episodeTitle: undefined }, nextLesson: { episodeId: "intro", title: "Notice change" } });
    expect(screen.getByText("Your conversation lives here")).toBeVisible();
    expect(screen.getByText("Open a lesson to ask about it. Your conversation stays here.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Go to Notice change" })).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("keeps a draft started in a lesson outside it, with Send unavailable and said why", () => {
    show({ context: { ...context, episodeId: undefined, episodeTitle: undefined }, draft: "Half a thought" });
    const box = screen.getByRole("textbox", { name: "Message to your companion" });
    expect(box).toHaveValue("Half a thought");
    expect(box).toHaveAttribute("placeholder", "Keep drafting. Send it from a lesson.");
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "true");
  });
  it("a closed course says how many questions are left, and the exhausted block replaces the composer", () => {
    const { again } = show({ closed: { allowance: { remaining: 3, used: 7, budget: 10 }, exhausted: false } });
    expect(screen.getByText("Course closed · 3 questions left")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "More about this" }));
    expect(screen.getByText("Questions never change your results. 7 of 10 used.")).toBeVisible();
    again({ closed: { allowance: { remaining: 0 }, exhausted: true }, unavailable: true });
    expect(screen.getByText("You've used every question this closed course allows. Your conversation and the course stay here to read.")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/isn't taking questions/)).toBeNull();
  });
  it("a lesson not taking questions keeps the draft and says so", () => {
    show({ unavailable: true, draft: "Still here" });
    expect(screen.getByText("This lesson isn't taking questions right now. Your draft is safe.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message to your companion" })).toHaveValue("Still here");
    expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute("aria-disabled", "true");
  });
  it("offers both versions of a draft written twice, in the notice", () => {
    const choose = vi.fn();
    show({ draftConflict: true, onDraftChoice: choose });
    expect(screen.getByText("There are two versions of your draft.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Use the saved one" }));
    expect(choose).toHaveBeenCalledWith("other");
  });
  it("loads quietly for 400 ms, then three still bars, and a failed read says so with Try again", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { again } = show({ loaded: false });
    expect(screen.queryByRole("img", { name: "Loading conversation" })).toBeNull();
    act(() => void vi.advanceTimersByTime(400));
    expect(screen.getByRole("img", { name: "Loading conversation" })).toBeVisible();
    again({ loaded: true, error: "failed", onRefresh: retry });
    expect(screen.getByText("Couldn't refresh the conversation. Your draft is safe.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
