import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewsView } from "../src/views/ReviewsView";
import { createFetchAdminClient } from "../src/client/fetchClient";
import {
  EvidenceDisputeError,
  evidenceDisputeErrorMessage,
  type EvidenceDispute,
  type EvidenceDisputesPort,
} from "../src/domain/evidenceDisputes";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const dispute: EvidenceDispute = {
  disputeId: "00000000-0000-4000-8000-000000000031",
  state: "open",
  enrollmentId: "00000000-0000-4000-8000-000000000032",
  learner: "Ada",
  objectiveId: "minimum",
  evidence: {
    evidenceId: "00000000-0000-4000-8000-000000000033",
    attemptId: "00000000-0000-4000-8000-000000000034",
    assessmentId: "min-a",
    passed: true,
    independent: true,
    mode: "independent",
    releaseVersion: "1.0.0",
  },
  raisedAt: "2026-10-14T00:00:00.000Z",
  ageDays: 2,
  canResolve: true,
  canUphold: true,
};
const note = "Checked against the answer key.";
const receipt = (invalidated = false) => ({ disputeId: dispute.disputeId, state: "resolved" as const, decision: invalidated ? ("reject" as const) : ("accept" as const), invalidated, replayed: false });
function setup(item: EvidenceDispute, resolve: EvidenceDisputesPort["resolve"] = vi.fn(async () => receipt())) {
  const port: EvidenceDisputesPort = { queue: vi.fn(async () => ({ disputes: [item], truncated: false })), resolve };
  render(<ReviewsView data={{ course: { id: "catalog" } } as unknown as CourseWorkspace} client={{ evidenceDisputes: port } as unknown as AdminClient} />);
  return port;
}

describe("evidence dispute queue", () => {
  it("shows the disputed evidence and its age, and upholds it with a note", async () => {
    const port = setup(dispute);
    expect(await screen.findByText("Ada · minimum · open 2 days")).toBeVisible();
    expect(screen.getByText("min-a")).toBeVisible();
    expect(screen.getByText(/passed, independent/)).toBeVisible();
    expect(screen.getByText(/You see which result is disputed, not the learner's explanation/)).toBeVisible();
    const submit = screen.getByRole("button", { name: "Uphold result" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Review note"), note);
    await userEvent.click(submit);
    await waitFor(() => expect(port.resolve).toHaveBeenCalledTimes(1));
    const [catalogId, disputeId, input, key] = vi.mocked(port.resolve).mock.calls[0]!;
    expect([catalogId, disputeId, input]).toEqual(["catalog", dispute.disputeId, { decision: "accept", note }]);
    expect(key).toMatch(/^evidence-dispute-[0-9a-f-]{36}$/);
    expect(await screen.findByText("Result upheld for Ada on minimum. The dispute is closed.")).toBeVisible();
    expect(port.queue).toHaveBeenCalledTimes(2);
  });

  it("offers only invalidation when the result cannot be upheld", async () => {
    const resolve = vi.fn<EvidenceDisputesPort["resolve"]>(async () => receipt(true));
    setup({ ...dispute, ageDays: 0, canUphold: false, evidence: { ...dispute.evidence, passed: false } }, resolve);
    expect(await screen.findByText("Ada · minimum · opened today")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Uphold the result/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Invalidate this evidence/ })).toBeChecked();
    expect(screen.getByText(/Only an independent, unassisted, passing answer/)).toBeVisible();
    await userEvent.type(screen.getByLabelText("Review note"), "Recorded against the wrong item.");
    await userEvent.click(screen.getByRole("button", { name: "Invalidate evidence" }));
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(vi.mocked(resolve).mock.calls[0]![2]).toEqual({ decision: "reject", note: "Recorded against the wrong item." });
    expect(await screen.findByText("Evidence invalidated for Ada on minimum. The dispute is closed.")).toBeVisible();
  });

  it("nobody resolves their own dispute", async () => {
    setup({ ...dispute, canResolve: false, canUphold: false });
    expect(await screen.findByText(/This is your own dispute/)).toBeVisible();
    expect(screen.getByLabelText("Review note")).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    expect(screen.getByRole("button", { name: /Invalidate evidence|Uphold result/ })).toBeDisabled();
  });

  it("shows the server's refusal and keeps the key for a retry of the same decision only", async () => {
    const resolve = vi.fn<EvidenceDisputesPort["resolve"]>(async () => {
      throw new EvidenceDisputeError("REVIEW_CANNOT_GRANT_MASTERY");
    });
    setup(dispute, resolve);
    await userEvent.type(await screen.findByLabelText("Review note"), note);
    await userEvent.click(screen.getByRole("button", { name: "Uphold result" }));
    expect(await screen.findByText(/cannot be upheld as valid/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Uphold result" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("radio", { name: /Invalidate this evidence/ }));
    await userEvent.click(screen.getByRole("button", { name: "Invalidate evidence" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
    const keys = vi.mocked(resolve).mock.calls.map((c) => (c as unknown[])[3]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("shows an empty state", async () => {
    const port: EvidenceDisputesPort = { queue: vi.fn(async () => ({ disputes: [], truncated: false })), resolve: vi.fn() };
    render(<ReviewsView data={{ course: { id: "catalog" } } as unknown as CourseWorkspace} client={{ evidenceDisputes: port } as unknown as AdminClient} />);
    expect(await screen.findByText("No disputed evidence")).toBeVisible();
  });
});

describe("evidence dispute fetch adapter", () => {
  it("calls the course routes, refuses a row that carries a reason, and maps only enumerated error codes", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const responses = [
      new Response(JSON.stringify({ disputes: [dispute], truncated: false }), { status: 200 }),
      new Response(JSON.stringify({ disputes: [{ ...dispute, reason: "The learner's words" }], truncated: false }), { status: 200 }),
      new Response(JSON.stringify({ ...receipt(), evidenceId: dispute.evidence.evidenceId, message: "saved" }), { status: 200 }),
      new Response(JSON.stringify({ error: "EVIDENCE_DISPUTE_CLOSED" }), { status: 409 }),
      new Response(JSON.stringify({ error: "<script>" }), { status: 500 }),
    ];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({ url: String(url), ...(init ? { init } : {}) });
        return responses.shift()!;
      },
    });
    const ports = client.evidenceDisputes!;
    expect((await ports.queue("cat-1")).disputes[0]!.disputeId).toBe(dispute.disputeId);
    expect(calls[0]!.url).toBe("/api/admin/courses/cat-1/evidence-disputes");
    // A response that ever carried the learner's reason is rejected, not shown.
    expect((await ports.queue("cat-1").catch((e) => e)).code).toBe("INVALID_RESPONSE");
    expect(await ports.resolve("cat-1", dispute.disputeId, { decision: "accept", note }, "evidence-dispute-key-1")).toMatchObject({ state: "resolved", invalidated: false });
    expect(calls[2]!.url).toBe(`/api/admin/courses/cat-1/evidence-disputes/${dispute.disputeId}/resolve`);
    expect(calls[2]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ decision: "accept", note, idempotencyKey: "evidence-dispute-key-1" });
    const closed = await ports.resolve("cat-1", dispute.disputeId, { decision: "accept", note }, "k2-abcdefgh").catch((e) => e);
    expect(evidenceDisputeErrorMessage(closed)).toMatch(/already resolved or withdrawn/);
    const garbled = await ports.resolve("cat-1", dispute.disputeId, { decision: "accept", note }, "k3-abcdefgh").catch((e) => e);
    expect(garbled).toBeInstanceOf(EvidenceDisputeError);
    expect(garbled.code).toBe("UNAVAILABLE");
  });
});
