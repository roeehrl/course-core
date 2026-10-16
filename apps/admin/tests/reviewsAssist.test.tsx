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
  it("says when the supervisor proposed the draft and why a gate's automatic check left the answer for a person", async () => {
    setup(item({ learnerConsented: true, state: "suggested", origin: "supervisor", automaticCheck: { state: "evaluator_declined", evaluatorId: "fixed-check" },
      draft: { suggestionId: "00000000-0000-4000-8000-000000000003", notAGrade: true, summary: "Drafted.", criteria: [
        { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element", note: "" },
        { criterionId: "edge", met: false, quote: "", note: "" },
      ] } }));
    expect(await screen.findByText(/The supervisor proposed these findings when the learner submitted/)).toBeVisible();
    expect(screen.getByText("Automatic check did not confirm")).toBeVisible();
    expect(screen.getByText(/did not accept every quoted finding/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save review" })).toBeVisible();
  });
  it("says the supervisor is drafting while a proposal it started is pending", async () => {
    setup(item({ learnerConsented: true, state: "requested", origin: "supervisor", draft: null }));
    expect(await screen.findByText(/The supervisor is drafting findings for this conversation/)).toBeVisible();
  });
  it("offers a request only when the learner opted in, and says so when they did not", async () => {
    const port = setup(item({ learnerConsented: true, state: "available", draft: null }));
    await userEvent.click(await screen.findByRole("button", { name: "Ask for an AI draft of the findings" }));
    await waitFor(() => expect(port.requestDraft).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", expect.stringMatching(/^assist-/)));
  });
  it("says a failed draft could not be produced and lets the reviewer ask again", async () => {
    const port = setup(item({ learnerConsented: true, state: "failed", draft: null }));
    expect(await screen.findByText(/could not be produced/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Ask again for an AI draft" }));
    await waitFor(() => expect(port.requestDraft).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", expect.stringMatching(/^assist-/)));
  });
  it("shows no request control without the learner's opt-in", async () => {
    setup(item({ learnerConsented: false, state: "not_consented", draft: null }));
    expect(await screen.findByText(/has not allowed AI drafts/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /AI draft/ })).toBeNull();
  });

  it("shows the earlier turn of a conversation, accepts quotes from it and sends a neutral probe", async () => {
    const pending = { ...item(undefined), response: "Each comparison keeps the smaller value.", thread: [
      { attemptId: "00000000-0000-4000-8000-000000000009", response: answer, submittedAt: "2026-10-13T00:00:00.000Z", reviewerNote: "Why is that the minimum?", probeOnly: true },
    ] };
    const port = setup(pending);
    expect(await screen.findByRole("region", { name: "Earlier answer 1 from Ada" })).toHaveTextContent(answer);
    expect(screen.getByText(/Reviewer asked \(neutral question\): Why is that the minimum\?/)).toBeVisible();
    await userEvent.click(screen.getAllByRole("checkbox", { name: "The answer shows this" })[0]!);
    await userEvent.type(screen.getByLabelText("Exact quotation from the answer"), "the kept value is never greater than any element");
    expect(screen.queryByText("Not found exactly in the answer.")).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "Ask for clarification" }));
    await userEvent.type(screen.getByLabelText("Message to the learner"), "Say why.");
    await userEvent.click(screen.getByRole("checkbox", { name: /neutral question with no hint/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(port.review).toHaveBeenCalled());
    expect(vi.mocked(port.review).mock.calls[0]![1]).toMatchObject({ decision: "needs_clarification", probeOnly: true, learnerNote: "Say why." });
  });
});
