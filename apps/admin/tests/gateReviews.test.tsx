import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewsView } from "../src/views/ReviewsView";
import { createFetchAdminClient } from "../src/client/fetchClient";
import {
  GateReviewError,
  gateReviewErrorMessage,
  type GateReview,
  type GateReviewsPort,
} from "../src/domain/gateReviews";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const review: GateReview = {
  requestId: "00000000-0000-4000-8000-000000000021",
  enrollmentId: "00000000-0000-4000-8000-000000000022",
  gateId: "min-gate",
  decisionId: "00000000-0000-4000-8000-000000000023",
  learner: "Ada",
  reason: "I ran out of time for the transfer task.",
  state: "open",
  requestedAt: "2026-10-14T00:00:00.000Z",
  decision: {
    decisionId: "00000000-0000-4000-8000-000000000023",
    gateId: "min-gate",
    gateVersion: "1.0.0",
    status: "needs_evidence",
    criterionResults: [
      {
        criterionId: "families",
        met: true,
        reason: "Two item families shown.",
      },
      { criterionId: "transfer", met: false, reason: "No transfer task yet." },
      {
        criterionId: "explain",
        met: "pending",
        reason: "A written answer awaits review.",
      },
    ],
    missingObjectiveIds: ["minimum"],
    learnerVisibleReason: "Show the idea on a new task.",
    decidedAt: "2026-10-13T00:00:00.000Z",
  },
  canUphold: true,
  canGrantException: true,
};
const note = "The transfer task is still required for this checkpoint.";
function setup(
  item: GateReview,
  resolve: GateReviewsPort["resolve"] = vi.fn(async () => ({
    requestId: item.requestId,
    state: "upheld" as const,
    replayed: false,
  })),
) {
  const port: GateReviewsPort = {
    queue: vi.fn(async () => ({ reviews: [item] })),
    resolve,
  };
  render(
    <ReviewsView
      data={{ course: { id: "catalog" } } as unknown as CourseWorkspace}
      client={{ gateReviews: port } as unknown as AdminClient}
    />,
  );
  return port;
}

describe("gate review queue", () => {
  it("shows the request with the decision under review and upholds it with a note", async () => {
    const port = setup(review);
    expect(await screen.findByText(review.reason)).toBeVisible();
    expect(screen.getByText("No transfer task yet.")).toBeVisible();
    expect(screen.getByText("pending")).toBeVisible();
    const submit = screen.getByRole("button", { name: "Uphold decision" });
    // The note must be at least ten characters before anything is sent.
    await userEvent.type(
      screen.getByLabelText("Message to the learner"),
      "too short",
    );
    expect(submit).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Message to the learner"),
      " — the transfer task is still required.",
    );
    await userEvent.click(submit);
    await waitFor(() => expect(port.resolve).toHaveBeenCalledTimes(1));
    const [requestId, input, key] = vi.mocked(port.resolve).mock.calls[0]!;
    expect(requestId).toBe(review.requestId);
    expect(input).toEqual({
      outcome: "upheld",
      note: "too short — the transfer task is still required.",
    });
    expect(key).toMatch(/^gate-review-[0-9a-f-]{36}$/);
    expect(
      await screen.findByText("Decision upheld for Ada on min-gate."),
    ).toBeVisible();
    expect(port.queue).toHaveBeenCalledTimes(2);
  });

  it("grants an exception only when allowed, and explains that it is not evidence", async () => {
    const resolve = vi.fn<GateReviewsPort["resolve"]>(async () => ({
      requestId: review.requestId,
      state: "exception_granted" as const,
      replayed: false,
    }));
    setup(review, resolve);
    await userEvent.click(
      await screen.findByRole("radio", { name: /Grant an exception/ }),
    );
    expect(screen.getByText("An exception is not evidence")).toBeVisible();
    await userEvent.type(screen.getByLabelText("Message to the learner"), note);
    await userEvent.click(
      screen.getByRole("button", { name: "Grant exception" }),
    );
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(vi.mocked(resolve).mock.calls[0]![1]).toEqual({
      outcome: "exception",
      note,
    });
    expect(
      await screen.findByText("Exception granted for Ada on min-gate."),
    ).toBeVisible();
  });

  it("a reviewer without enrollment rights can uphold but sees no exception control", async () => {
    setup({ ...review, canGrantException: false });
    expect(
      await screen.findByRole("radio", { name: /Uphold the decision/ }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("radio", { name: /Grant an exception/ }),
    ).toBeNull();
    expect(
      screen.getByText(
        "Only owners, admins and instructors can grant an exception.",
      ),
    ).toBeVisible();
  });

  it("nobody decides their own request", async () => {
    setup({ ...review, canUphold: false, canGrantException: false });
    expect(await screen.findByText(/This is your own request/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Uphold decision" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Message to the learner")).toBeDisabled();
  });

  it("shows the server's refusal, keeps the key for a retry of the same decision and uses a new one for a changed decision", async () => {
    const resolve = vi.fn<GateReviewsPort["resolve"]>(async () => {
      throw new GateReviewError("GATE_ALREADY_READY");
    });
    setup(review, resolve);
    await userEvent.click(
      await screen.findByRole("radio", { name: /Grant an exception/ }),
    );
    await userEvent.type(screen.getByLabelText("Message to the learner"), note);
    await userEvent.click(
      screen.getByRole("button", { name: "Grant exception" }),
    );
    expect(
      await screen.findByText(/The learner now meets the gate/),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Grant exception" }),
    );
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    await userEvent.click(
      screen.getByRole("radio", { name: /Uphold the decision/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Uphold decision" }),
    );
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
    const keys = vi.mocked(resolve).mock.calls.map((c) => (c as unknown[])[2]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("shows an empty state", async () => {
    const port: GateReviewsPort = {
      queue: vi.fn(async () => ({ reviews: [] })),
      resolve: vi.fn(),
    };
    render(
      <ReviewsView
        data={{ course: { id: "catalog" } } as unknown as CourseWorkspace}
        client={{ gateReviews: port } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText("No gate reviews waiting")).toBeVisible();
  });
});

describe("gate review fetch adapter", () => {
  it("calls the course queue and the resolution route, and maps only enumerated error codes", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const responses = [
      new Response(JSON.stringify({ reviews: [review] }), { status: 200 }),
      new Response(
        JSON.stringify({
          requestId: review.requestId,
          state: "upheld",
          replayed: false,
          reviewerNote: note,
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ error: "SELF_REVIEW_FORBIDDEN" }), {
        status: 403,
      }),
      new Response(JSON.stringify({ error: "<script>" }), { status: 500 }),
    ];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return responses.shift()!;
      },
    });
    expect(
      (await client.gateReviews!.queue("cat-1")).reviews[0]!.requestId,
    ).toBe(review.requestId);
    expect(calls[0]!.url).toBe("/api/admin/courses/cat-1/gate-reviews");
    expect(
      await client.gateReviews!.resolve(
        review.requestId,
        { outcome: "upheld", note },
        "gate-review-key-1",
      ),
    ).toMatchObject({ state: "upheld" });
    expect(calls[1]!.url).toBe(`/api/admin/gate-reviews/${review.requestId}`);
    expect(calls[1]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({
      outcome: "upheld",
      note,
      idempotencyKey: "gate-review-key-1",
    });
    const refused = await client
      .gateReviews!.resolve(
        review.requestId,
        { outcome: "upheld", note },
        "k2-abcdefgh",
      )
      .catch((e) => e);
    expect(gateReviewErrorMessage(refused)).toMatch(/your own request/);
    const garbled = await client
      .gateReviews!.resolve(
        review.requestId,
        { outcome: "upheld", note },
        "k3-abcdefgh",
      )
      .catch((e) => e);
    expect(garbled).toBeInstanceOf(GateReviewError);
    expect(garbled.code).toBe("UNAVAILABLE");
  });
});
