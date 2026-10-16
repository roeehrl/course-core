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
  it("shows only the reviewer's note while clarification is requested, never per-criterion findings", async () => {
    const leaky = { ...asked, criteria: [{ id: "invariant", description: "States the invariant.", required: true, met: true, quote: "the kept value never exceeds", note: "Nearly there" }] };
    render(<ReviewStatus loader={async () => [leaky]} enrollmentId="e" episodeId="min" revision={1} onReply={vi.fn()} />);
    expect(await screen.findByText("Reviewer: Why is the kept value the minimum?")).toBeVisible();
    expect(screen.getByLabelText("Your reply to the reviewer")).toBeVisible();
    expect(screen.queryByText(/States the invariant/)).toBeNull();
    expect(screen.queryByText(/Nearly there/)).toBeNull();
  });
  it("offers no reply once answered or when no clarification was asked", async () => {
    render(<ReviewStatus loader={async () => [{ ...asked, canReply: false }, { ...asked, attemptId: "a2", status: "pending_review", learnerNote: null, canReply: false, continuesAttemptId: "a1" }]} enrollmentId="e" episodeId="min" revision={1} onReply={vi.fn()} />);
    expect(await screen.findByText(/Your reply · Waiting for a reviewer/)).toBeVisible();
    expect(screen.queryByLabelText("Your reply to the reviewer")).toBeNull();
  });

  it("says when the course's fixed check, not a person, confirmed a met answer, and still offers a second opinion", async () => {
    const checked: WrittenReview = { ...asked, status: "met", learnerNote: null, canReply: false, canAppeal: true, appeal: null, confirmedBy: "automatic_check",
      criteria: [{ id: "invariant", description: "States the invariant.", required: true, met: true, quote: "the kept value never exceeds", note: null }] };
    const { unmount } = render(<ReviewStatus loader={async () => [checked]} enrollmentId="e" episodeId="min" revision={1} onAppeal={vi.fn()} />);
    expect(await screen.findByText("Checked automatically · criteria met")).toBeVisible();
    expect(screen.getByText(/fixed check confirmed each criterion from your own quoted words/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Ask for a second opinion" })).toBeVisible();
    unmount();
    render(<ReviewStatus loader={async () => [{ ...checked, confirmedBy: "reviewer" }]} enrollmentId="e" episodeId="min" revision={1} />);
    expect(await screen.findByText("Reviewed · criteria met")).toBeVisible();
    expect(screen.queryByText(/fixed check/)).toBeNull();
  });

  it("lets the learner ask once for a second opinion on a judged answer and shows its outcome", async () => {
    const judged: WrittenReview = { ...asked, status: "not_met", learnerNote: null, canReply: false, canAppeal: true, appeal: null };
    const onAppeal = vi.fn(async () => {});
    const { unmount } = render(<ReviewStatus loader={async () => [judged]} enrollmentId="e" episodeId="min" revision={1} onAppeal={onAppeal} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ask for a second opinion" }));
    const send = screen.getByRole("button", { name: "Request a second opinion" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Why should another reviewer look again?"), "My second sentence states the invariant.");
    await userEvent.click(send);
    await waitFor(() => expect(onAppeal).toHaveBeenCalledWith("a1", "My second sentence states the invariant."));
    unmount();
    render(<ReviewStatus loader={async () => [{ ...judged, status: "met", canAppeal: false, appeal: { state: "changed", note: "Invariant is stated." } }]} enrollmentId="e" episodeId="min" revision={1} onAppeal={onAppeal} />);
    expect(await screen.findByText(/Second opinion changed the decision\./)).toHaveTextContent("Reviewer: Invariant is stated.");
    expect(screen.queryByRole("button", { name: "Ask for a second opinion" })).toBeNull();
  });
});
