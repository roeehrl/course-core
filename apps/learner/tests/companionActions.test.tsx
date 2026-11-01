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

// Split from companion.test.tsx: actions on companion messages (context used, deleting a question).

afterEach(() => vi.useRealTimers());
/** A window that docks the companion beside the lesson, or one that shows it as a sheet. */
const dockLayout = (wide: boolean) => (wide ? companionLayout(1440, 960) : companionLayout(390, 844));
describe("persisted companion integration", () => {
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
    // The thread names the lesson the question was asked in once, in a divider (conversation §3.4).
    expect(screen.getByText("Notice change")).toBeVisible();
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
    await pressWhenReady(screen.getByRole("button", { name: "Remove code lines" }));
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
