import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyActions } from "../src/connected/companion/ReplyActions.web";
import { conversationActions } from "../src/connected/companion/conversationActions";
import { lessonNavigator, resetCompanionBridge } from "../src/connected/companion/bridge";
import type { CompanionFeedback, CompanionMessage } from "../src/client/companionClient";
import { connectedSnapshot } from "./connectedFixtures";
import { context } from "./companionFixtures";

// More in a reply's action row, and the row around it (final design §3.7, §5): a keyboard menu that
// leaves a reply out of later answers (or uses it again) and reports a problem; the reuse toggle's
// failure line; Copy with its 2 s check; the time tooltip; "Try question 1" on the latest reply
// about a check.

const reply: CompanionMessage = { id: "a", role: "assistant", content: "Compare them on a number line.", context: { episodeId: "intro" },
  created_at: "2026-01-02T10:01:00Z", job_id: "job", feedback: null, excluded: false };
function renderReply(props: Partial<React.ComponentProps<typeof ReplyActions>> = {}) {
  return render(<ReplyActions message={reply} messages={[reply]} conversation={{ enrollmentId: "e", episodeTitles: {} }} latest context={context} busy="" {...props} />);
}
afterEach(() => {
  conversationActions.publish("e", null);
  resetCompanionBridge();
  vi.useRealTimers();
});

describe("a reply's More menu", () => {
  it("works from the keyboard: opens on More, ↑/↓, Home/End, runs an item, Esc returns to More", async () => {
    const user = userEvent.setup();
    const exclude = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn(async (): Promise<CompanionFeedback> => ({ vote: null, reported: true }));
    conversationActions.publish("e", { earlier: false, loading: false, failed: false, loadEarlier: async () => {}, changed: vi.fn(), vote: report });
    renderReply({ onExclude: exclude });
    const more = screen.getByRole("button", { name: "More" });
    expect(screen.getByRole("group", { name: "Message actions" })).toContainElement(more);
    more.focus();
    await user.keyboard("{Enter}");
    const menu = screen.getByRole("menu", { name: "More actions" });
    expect(within(menu).getByRole("menuitem", { name: "Don't use in later answers" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: "Report a problem" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(within(menu).getByRole("menuitem", { name: "Don't use in later answers" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
    await user.keyboard("{Enter}{End}{Enter}");
    expect(report).toHaveBeenCalledWith("a", { vote: null, report: true });
    expect(await screen.findByText("Thanks, noted.")).toBeVisible();
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Don't use in later answers" }));
    expect(exclude).toHaveBeenCalledWith("a", true);
  });

  it("offers the reply again once later answers leave it out, and says so under it", async () => {
    const user = userEvent.setup();
    render(<ReplyActions message={{ ...reply, excluded: true }} messages={[reply]} conversation={{ enrollmentId: "e", episodeTitles: {} }} latest context={context} busy=""
      onExclude={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByText("Not used in later answers")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Use in later answers again" })).toBeVisible();
  });

  it("says in place when leaving a reply out was not saved", async () => {
    const user = userEvent.setup();
    renderReply({ onExclude: vi.fn().mockRejectedValue(new Error("stale")) });
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Don't use in later answers" }));
    expect(await screen.findByText("That change wasn't saved. Refresh and try again.")).toBeVisible();
  });
});

describe("the rest of the row", () => {
  it("copies the reply, shows a check for 2 s and says “Copied”; the time is Copy's tooltip", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderReply();
    const copy = screen.getByRole("button", { name: "Copy" });
    const time = document.getElementById(copy.getAttribute("aria-describedby")!)!;
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2026-01-02T10:01:00Z");
    expect(time.textContent).toMatch(/\d{1,2}:\d{2}/);
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith("Compare them on a number line.");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    expect(copy.querySelector("svg")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("offers “Try question 1” on the latest reply about an open check, which shows its answer field", async () => {
    const user = userEvent.setup();
    const shown = vi.fn(() => true);
    lessonNavigator.register(shown);
    const question: CompanionMessage = { id: "q", role: "learner", content: "Why isn't it 9?", job_id: "job", job_state: "applied", created_at: "2026-01-02T10:00:00Z",
      context: { episodeId: "intro", attachedCheck: { challengeId: "check-1", ordinal: 1 } } };
    const snapshot = connectedSnapshot();
    const server = { ...snapshot, activeChallenges: [{ challengeId: "check-1" } as (typeof snapshot.activeChallenges)[number]] };
    const { rerender } = render(<ReplyActions message={reply} messages={[question, reply]} conversation={{ enrollmentId: "e", episodeTitles: {}, server }} latest
      context={{ ...context, episodeId: "intro" }} busy="" />);
    await user.click(screen.getByRole("button", { name: "Try question 1" }));
    await vi.waitFor(() => expect(shown).toHaveBeenCalledWith({ episodeId: "intro", challengeId: "check-1", focus: "answer" }));
    // Not on an older reply, and not once the check is answered.
    rerender(<ReplyActions message={reply} messages={[question, reply]} conversation={{ enrollmentId: "e", episodeTitles: {}, server }} latest={false}
      context={{ ...context, episodeId: "intro" }} busy="" />);
    expect(screen.queryByRole("button", { name: "Try question 1" })).toBeNull();
    rerender(<ReplyActions message={reply} messages={[question, reply]} conversation={{ enrollmentId: "e", episodeTitles: {}, server: snapshot }} latest
      context={{ ...context, episodeId: "intro" }} busy="" />);
    expect(screen.queryByRole("button", { name: "Try question 1" })).toBeNull();
  });

  it("says nothing for a deleted reply", () => {
    const { container } = render(<ReplyActions message={{ ...reply, content: "[deleted]" }} messages={[]} conversation={{ enrollmentId: "e", episodeTitles: {} }} latest
      context={context} busy="" />);
    expect(container).toBeEmptyDOMElement();
  });
});
