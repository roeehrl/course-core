import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewStatus, type WrittenReview } from "../src/components/ReviewStatus";

const asked: WrittenReview = { attemptId: "a1", episodeId: "min", submittedAt: "2026-10-14T00:00:00.000Z", status: "needs_clarification",
  learnerNote: "Why is the kept value the minimum?", canReply: true, continuesAttemptId: null,
  criteria: [{ id: "invariant", description: "States the invariant.", required: true, met: false, quote: null, note: null }] };
describe("replying to a reviewer's clarification request", () => {
  it("lets the learner answer in their own words and sends the reply for review", async () => {
    const onReply = vi.fn(async () => {});
    render(<ReviewStatus loader={async () => [asked]} enrollmentId="e" episodeId="min" revision={1} onReply={onReply} />);
    expect(await screen.findByText("Reviewer: Why is the kept value the minimum?")).toBeVisible();
    const send = screen.getByRole("button", { name: "Send reply for review" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Your reply to the reviewer"), "Each comparison keeps the smaller value, so nothing seen is smaller.");
    await userEvent.click(send);
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("a1", "Each comparison keeps the smaller value, so nothing seen is smaller."));
  });
  it("offers no reply once answered or when no clarification was asked", async () => {
    render(<ReviewStatus loader={async () => [{ ...asked, canReply: false }, { ...asked, attemptId: "a2", status: "pending_review", learnerNote: null, canReply: false, continuesAttemptId: "a1" }]} enrollmentId="e" episodeId="min" revision={1} onReply={vi.fn()} />);
    expect(await screen.findByText(/Your reply · Waiting for a reviewer/)).toBeVisible();
    expect(screen.queryByLabelText("Your reply to the reviewer")).toBeNull();
  });
});
