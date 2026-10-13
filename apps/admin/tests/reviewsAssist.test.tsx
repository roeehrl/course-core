import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewsView } from "../src/views/ReviewsView";
import type { PendingReview, ReviewsPort } from "../src/domain/reviews";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const answer = "I keep the smallest value seen so far and compare every next element with it, so the kept value is never greater than any element.";
function item(assist: PendingReview["assist"]): PendingReview {
  return {
    attemptId: "00000000-0000-4000-8000-000000000001", enrollmentId: "00000000-0000-4000-8000-000000000002", learner: "Ada", episodeId: "min",
    assessmentId: "min-explain", prompt: "Explain the minimum.", response: answer, submittedAt: "2026-10-14T00:00:00.000Z", independentEligible: true, ownSubmission: false,
    rubric: [
      { id: "invariant", description: "States the invariant.", required: true },
      { id: "edge", description: "Mentions the empty list.", required: false },
    ],
    ...(assist ? { assist } : {}),
  };
}
function setup(pending: PendingReview) {
  const port: ReviewsPort = { pending: vi.fn(async () => ({ pending: [pending] })), review: vi.fn(async () => ({})), requestDraft: vi.fn(async () => ({})) };
  render(<ReviewsView data={{ course: { id: "catalog" } } as unknown as CourseWorkspace} client={{ reviews: port } as unknown as AdminClient} />);
  return port;
}

describe("AI drafts in the written-answer review queue", () => {
  it("labels a verified draft as not a grade, copies it into the reviewer's own findings and records which draft was open", async () => {
    const port = setup(item({ learnerConsented: true, state: "suggested", draft: { suggestionId: "00000000-0000-4000-8000-000000000003", notAGrade: true,
      summary: "The invariant is stated.", criteria: [
        { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element", note: "Clear." },
        { criterionId: "edge", met: false, quote: "", note: "Not discussed." },
      ] } }));
    expect(await screen.findByText("AI draft — not a grade")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Copy the draft into my findings" }));
    expect(screen.getByRole("button", { name: /Draft copied/ })).toBeDisabled();
    expect(screen.getByLabelText("Exact quotation from the answer")).toHaveValue("the kept value is never greater than any element");
    await userEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(port.review).toHaveBeenCalled());
    expect(vi.mocked(port.review).mock.calls[0]![1]).toMatchObject({ decision: "met", suggestionId: "00000000-0000-4000-8000-000000000003",
      criteria: [{ criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" }, { criterionId: "edge", met: false }] });
  });
  it("offers a request only when the learner opted in, and says so when they did not", async () => {
    const port = setup(item({ learnerConsented: true, state: "available", draft: null }));
    await userEvent.click(await screen.findByRole("button", { name: "Ask for an AI draft of the findings" }));
    await waitFor(() => expect(port.requestDraft).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", expect.stringMatching(/^assist-/)));
  });
  it("shows no request control without the learner's opt-in", async () => {
    setup(item({ learnerConsented: false, state: "not_consented", draft: null }));
    expect(await screen.findByText(/has not allowed AI drafts/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /AI draft/ })).toBeNull();
  });
});
