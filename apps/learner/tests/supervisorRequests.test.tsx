import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SupervisorRequests } from "../src/components/SupervisorRequests.web";
import { connectedSnapshot } from "./connectedFixtures";

const goal = { requestId: "11111111-1111-4111-8111-111111111111", jobId: "22222222-2222-4222-8222-222222222222", kind: "goal_change", approver: "learner",
  proposal: { goal: "Find minima and maxima" }, reason: "You asked about maxima twice.", state: "pending", decidedAt: null, createdAt: "2026-10-20T10:00:00.000Z", canUndo: false };
const ceiling = { ...goal, requestId: "33333333-3333-4333-8333-333333333333", kind: "paid_ceiling", approver: "staff", proposal: { limitMicroUsd: 2_000_000 } };
const actions = [
  { actionId: "44444444-4444-4444-8444-444444444444", action: "transfer_check", objectiveIds: ["observe"], origin: "supervisor", state: "delivered", endReason: null, dueAt: null,
    followUp: { objectives: [], transferItem: { assessmentId: "item-2", episodeId: null } }, createdAt: "2026-10-20T10:00:00.000Z" },
  { actionId: "55555555-5555-4555-8555-555555555555", action: "transfer_probe", objectiveIds: ["observe"], origin: "follow_up", state: "scheduled", endReason: null,
    dueAt: "2026-10-23T10:00:00.000Z", followUp: null, createdAt: "2026-10-20T10:00:00.000Z" },
  { actionId: "66666666-6666-4666-8666-666666666666", action: "follow_up", objectiveIds: ["observe"], origin: "follow_up", state: "ended", endReason: "already_demonstrated",
    dueAt: null, followUp: { objectives: [{ objectiveId: "observe", result: "demonstrated" }] }, createdAt: "2026-10-20T10:00:00.000Z" },
];
describe("decisions and work from the supervisor", () => {
  it("lets the learner decide a proposed goal, shows what waits for the course team, and lists started work in words", async () => {
    const api = { request: vi.fn(async () => ({ requests: [goal, ceiling], actions })), command: vi.fn(async () => ({ ...goal, state: "approved", canUndo: true })) };
    const onChanged = vi.fn();
    render(<SupervisorRequests api={api as never} server={connectedSnapshot()} onChanged={onChanged} />);
    expect(await screen.findByText("Suggested goal: Find minima and maxima")).toBeVisible();
    expect(screen.getByText("Why: You asked about maxima twice.")).toBeVisible();
    expect(screen.getByText("More AI help than your current limit")).toBeVisible();
    expect(screen.getByText("A new problem to try")).toBeVisible();
    expect(screen.getByText(/planned for/)).toBeVisible();
    expect(screen.getByText(/not needed: you already showed this/)).toBeVisible();
    expect(screen.getByText("None of this counts as an assessment result or changes your progress.")).toBeVisible();
    // Staff decisions are not the learner's: no buttons for the spending limit.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Use this goal" }));
    await waitFor(() => expect(api.command).toHaveBeenCalledWith(expect.anything(), `supervision/requests/${goal.requestId}/decision`, { decision: "approve" }));
    expect(await screen.findByText(/Your goal is updated/)).toBeVisible();
    expect(onChanged).toHaveBeenCalled();
  });
  it("offers undo for an approved goal and says plainly when a decision fails", async () => {
    const api = { request: vi.fn(async () => ({ requests: [{ ...goal, state: "approved", canUndo: true }], actions: [] })), command: vi.fn(async () => { throw new Error("offline"); }) };
    render(<SupervisorRequests api={api as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Go back to my earlier goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That did not go through. Refresh the page and try again.");
  });
  it("says so when there is nothing yet", async () => {
    const api = { request: vi.fn(async () => ({ requests: [], actions: [] })), command: vi.fn() };
    render(<SupervisorRequests api={api as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    const region = screen.getByRole("region", { name: "Decisions and work from your supervisor" });
    await waitFor(() => expect(region).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByText(/Nothing here yet/)).toBeVisible();
  });
});
