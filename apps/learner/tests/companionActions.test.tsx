import React from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Split from companion.test.tsx: actions on companion messages (what a reply was based on, deleting a question).

afterEach(() => vi.useRealTimers());
/** A window that docks the companion beside the lesson, or one that shows it as a sheet. */
const dockLayout = (wide: boolean) => (wide ? companionLayout(1440, 960) : companionLayout(390, 844));
describe("persisted companion integration", () => {
  it("shows what an answer was based on, in sections, and lets the learner stop reusing a message", async () => {
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
        constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: true, policyRevision: 1, digest: "d" },
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
    // The thread names the lesson the question was asked in once, in a divider (conversation §3.4).
    expect(screen.getByText("Notice change")).toBeVisible();
    expect(screen.queryByText(/Earlier lesson/)).not.toBeInTheDocument();
    // One start-aligned chip instead of a full-width "Show context used" button.
    expect(screen.queryByRole("button", { name: "Show context used" })).toBeNull();
    const chip = screen.getByRole("button", { name: /^Based on/ });
    expect(chip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    const block = screen.getByRole("region", { name: "What this reply was based on" });
    expect(chip).toHaveAttribute("aria-controls", block.id);
    const text = stripBidiControls(block.textContent ?? "");
    // Sections with plain labels, in this order.
    const order = ["Your question", "You pointed at", "Video", "Earlier messages used", "Rules for this reply", "Your answers used:"].map((label) => text.indexOf(label));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(text).toContain("“Why does it change?”");
    expect(text).toContain("Formula or code example: “a <= b”");
    expect(text).toContain("Course video at 1:23");
    expect(text).toContain("A counted check was open, so it gave hints, not answers.");
    expect(text).toContain("Only practice from this lesson.");
    expect(text).toContain("2 recent answers");
    // The jargon is gone.
    expect(text).not.toMatch(/Context version|Evidence it could see|named briefly|Rules it followed/);
    // Each earlier message, the learner's own and those named in the summary, can be left out or used again.
    // The quotation is its own isolate (`<bdi>`) after the label.
    expect(within(block).getByText((_, node) => node?.className === "cc-act-based-text" && node.textContent === "You: “An earlier question”")).toBeVisible();
    expect(within(block).getByText("“An earlier question”", { selector: "bdi" })).toBeVisible();
    fireEvent.click(within(block).getByRole("button", { name: "Don't use “An earlier question” again" }));
    await waitFor(() => expect(exclude).toHaveBeenCalledWith("old", true));
    await pressWhenReady(within(block).getByRole("button", { name: "Use “The first question” again" }));
    await waitFor(() => expect(exclude).toHaveBeenCalledWith("older", false));
    // A focus chosen in this lesson is shown and removable.
    act(() => companionFocus.setSelection({ kind: "code", excerpt: "return x", lineStart: 3, lineEnd: 4, codeSnapshotHash: "a".repeat(64) }));
    expect(screen.getByText("Your code, lines 3–4")).toBeVisible();
    await pressWhenReady(screen.getByRole("button", { name: "Remove code lines" }));
    expect(companionFocus.get().selection).toBeUndefined();
  });

  it("deletes a question only after a danger confirm that starts on Cancel, and offers nothing for a deleted one", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    const answered = { ...message, job_state: "applied" };
    const { rerender } = render(
      <ConnectedCompanion context={context} messages={[answered]} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={() => {}}
        onSend={vi.fn()} onDeleteMessage={remove} pending={false} loaded />,
    );
    // No full-width "Delete this question" button: the question's own menu holds Delete.
    expect(screen.queryByRole("button", { name: "Delete this question" })).toBeNull();
    const more = screen.getByRole("button", { name: "Message options" });
    await user.click(more);
    const del = screen.getByRole("menuitem", { name: "Delete question" });
    expect(del).toHaveClass("is-danger");
    await user.click(del);
    expect(remove).not.toHaveBeenCalled();
    const confirm = screen.getByRole("dialog", { name: /Delete this question and its answer\? Suggestions based on it are removed too\. This can't be undone\./ });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(within(confirm).getByRole("button", { name: "Delete" })).toHaveClass("cc-act-delete");
    // Esc cancels and returns to the menu button.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(more).toHaveFocus();
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Delete question" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("m"));
    rerender(
      <ConnectedCompanion context={context} messages={[{ ...answered, content: "[deleted]" }]} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={() => {}}
        onSend={vi.fn()} onDeleteMessage={remove} pending={false} loaded />,
    );
    expect(screen.queryByRole("button", { name: "Message options" })).toBeNull();
  });

  it("never offers Delete while a question waits for its reply, and says so when a delete fails", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    const panel = (messages: CompanionMessage[]) => (
      <ConnectedCompanion context={context} messages={messages} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={() => {}}
        onSend={vi.fn()} onDeleteMessage={remove} pending={false} loaded />
    );
    const { rerender } = render(panel([message]));
    await user.click(screen.getByRole("button", { name: "Message options" }));
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Delete question" })).toBeNull();
    await user.keyboard("{Escape}");
    rerender(panel([{ ...message, job_state: "applied" }]));
    await user.click(screen.getByRole("button", { name: "Message options" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete question" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("dialog");
    expect(await within(confirm).findByText("Couldn't delete the question. Refresh and try again.")).toBeVisible();
    // Said once, in the confirm: the thread has no notice of its own for it.
    expect(screen.getAllByText(/Couldn't delete the question/)).toHaveLength(1);
  });

  it("says under the reply, once, that a change to what later answers use was not saved", async () => {
    const exclude = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    const reply: CompanionMessage = { id: "a", role: "assistant", content: "Because the minimum may equal another member.", context: {}, created_at: "2026-01-02", job_id: "job" };
    render(
      <ConnectedCompanion context={context} messages={[{ ...message, job_state: "applied" }, reply]} episodeTitles={{ intro: "Notice change" }} draft="" onDraftChange={() => {}}
        onSend={vi.fn()} onExcludeContext={exclude} pending={false} loaded />,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Don't use in later answers" }));
    await waitFor(() => expect(exclude).toHaveBeenCalledWith("a", true));
    const reason = await screen.findByText("That change wasn't saved. Refresh and try again.");
    expect(reason.closest(".cc-act-reply")).not.toBeNull();
    expect(screen.getAllByText(/That change wasn't saved/)).toHaveLength(1);
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
  it("shows what a reply was based on as plain words, not Markdown or TeX", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /^Based on/ }));
    expect(screen.getByText((_, node) => node?.className === "cc-act-based-text" && node.textContent === "Companion: “Fine-tuning updates weights by w - η g”")).toBeVisible();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });
});
