import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyActions } from "../src/connected/companion/ReplyActions.web";
import { THANKS_MS } from "../src/connected/companion/VoteControls.web";
import { conversationActions, type ConversationActions } from "../src/connected/companion/conversationActions";
import type { CompanionFeedback, CompanionMessage } from "../src/client/companionClient";
import { context } from "./companionFixtures";
import { Announcer } from "../src/connected/ui/Announcer.web";

// Helpful / Not helpful on a companion reply (final design §3.7): pressed at once, "Thanks, noted."
// for 3 s once saved (and announced), the optional "What was wrong?" field, and a vote that was not
// saved going back with a line that says so.

const reply: CompanionMessage = { id: "a", role: "assistant", content: "Compare them on a number line.", context: { episodeId: "intro" },
  created_at: "2026-01-02T10:01:00Z", job_id: "job", feedback: null };
function publish(vote: ConversationActions["vote"]) {
  conversationActions.publish("e", { earlier: false, loading: false, failed: false, loadEarlier: async () => {}, changed: () => {}, vote });
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
function renderReply(message: CompanionMessage = reply) {
  return render(<Announcer><ReplyActions message={message} messages={[message]} conversation={{ enrollmentId: "e", episodeTitles: {} }} latest context={context} busy="" /></Announcer>);
}
const announcer = () => document.querySelector<HTMLElement>("[data-cc-announcer]")!;
const thanks = () => document.querySelector<HTMLElement>(".cc-act-thanks");

afterEach(() => {
  conversationActions.publish("e", null);
  vi.useRealTimers();
});

describe("votes on a reply", () => {
  it("presses at once, says “Thanks, noted.” in Based on's place for 3 s, and a second press takes the vote back", async () => {
    vi.useFakeTimers();
    const vote = vi.fn(async (_id: string, input: { vote: CompanionFeedback["vote"] }): Promise<CompanionFeedback> => ({ vote: input.vote, reported: false }));
    publish(vote);
    renderReply();
    const helpful = screen.getByRole("button", { name: "Helpful" }), notHelpful = screen.getByRole("button", { name: "Not helpful" });
    expect(helpful).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "true");
    expect(notHelpful).toHaveAttribute("aria-pressed", "false");
    expect(vote).toHaveBeenCalledWith("a", { vote: "helpful" });
    await flush();
    // Visible where the chip was, and said by the conversation's one status region (§6), not a
    // live region of the row.
    expect(thanks()).toHaveTextContent("Thanks, noted.");
    expect(thanks()).not.toHaveAttribute("role");
    expect(announcer()).toHaveTextContent("Thanks, noted.");
    act(() => vi.advanceTimersByTime(THANKS_MS - 1));
    expect(thanks()).toHaveTextContent("Thanks, noted.");
    act(() => vi.advanceTimersByTime(1));
    expect(thanks()).toBeNull();
    fireEvent.click(helpful);
    expect(helpful).toHaveAttribute("aria-pressed", "false");
    expect(vote).toHaveBeenLastCalledWith("a", { vote: null });
  });

  it("shows a saved vote, and Not helpful opens an optional one-line field that sends a comment or closes on Esc", async () => {
    const vote = vi.fn(async (_id: string, input: { vote: CompanionFeedback["vote"] }): Promise<CompanionFeedback> => ({ vote: input.vote, reported: false }));
    publish(vote);
    renderReply({ ...reply, feedback: { vote: "helpful", reported: false } });
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute("aria-pressed", "true");
    const notHelpful = screen.getByRole("button", { name: "Not helpful" });
    fireEvent.click(notHelpful);
    const field = screen.getByRole("textbox", { name: "What was wrong? (optional)" });
    expect(screen.getByRole("group", { name: "Note about this reply" })).toContainElement(field);
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(notHelpful).toHaveFocus();
    // Pressing it again takes the vote back; a third press opens the field again.
    await flush();
    fireEvent.click(notHelpful);
    fireEvent.click(notHelpful);
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "What was wrong? (optional)" }), { target: { value: "  It skipped a step.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(vote).toHaveBeenLastCalledWith("a", { vote: "not_helpful", comment: "It skipped a step." });
    await flush();
    expect(screen.queryByRole("textbox")).toBeNull();
    // Focus does not drop to the page when the field closes: it goes back to Not helpful.
    expect(notHelpful).toHaveFocus();
    expect(thanks()).toHaveTextContent("Thanks, noted.");
    expect(announcer()).toHaveTextContent("Thanks, noted.");
  });

  it("goes back to the saved vote and says the change was not saved when the vote fails", async () => {
    let refuse: (reason: unknown) => void = () => {};
    publish(vi.fn(() => new Promise<CompanionFeedback>((_, reject) => { refuse = reject; })));
    renderReply({ ...reply, feedback: { vote: "helpful", reported: false } });
    const notHelpful = screen.getByRole("button", { name: "Not helpful" });
    fireEvent.click(notHelpful);
    expect(notHelpful).toHaveAttribute("aria-pressed", "true");
    await act(async () => refuse(new Error("offline")));
    expect(notHelpful).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Helpful" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("That change wasn't saved. Refresh and try again.")).toBeVisible();
    expect(thanks()).toBeNull();
    expect(announcer()).not.toHaveTextContent("Thanks, noted.");
  });

  it("offers no votes where the client takes none (the demo)", () => {
    renderReply();
    expect(screen.queryByRole("button", { name: "Helpful" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
  });
});
