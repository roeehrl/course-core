import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SupervisorRequests } from "../src/components/SupervisorRequests.web";
import { DecisionLine } from "../src/connected/companion/DecisionLine.web";
import { companionBridge, resetCompanionBridge } from "../src/connected/companion/bridge";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";
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
describe("decisions and work from your companion", () => {
  it("lets the learner decide a proposed goal, shows what waits for the course team, and lists started work in words", async () => {
    const api = { request: vi.fn(async () => ({ requests: [goal, ceiling], actions })), command: vi.fn(async () => ({ ...goal, state: "approved", canUndo: true })) };
    const onChanged = vi.fn();
    render(<SupervisorRequests api={api as never} server={connectedSnapshot()} onChanged={onChanged} />);
    expect(await screen.findByText("Suggested goal: Find minima and maxima")).toBeVisible();
    expect(screen.getByText("Why: You asked about maxima twice.")).toBeVisible();
    expect(screen.getByText("More AI help than your current limit")).toBeVisible();
    // Each item has one status chip and at most one detail line, never a "·" chain.
    expect(screen.getByText("Sent to your course team")).toBeVisible();
    expect(screen.getByText("A new problem to try")).toBeVisible();
    expect(screen.getByText("Ready in your lesson")).toBeVisible();
    expect(screen.getByText(/^Planned for /)).toBeVisible();
    expect(screen.getByText("Not needed: you already showed this.")).toBeVisible();
    expect(document.body.textContent).not.toContain(" · ");
    // The companion's "Review" leads here.
    expect(document.getElementById("profile-decisions")).toHaveAttribute("tabindex", "-1");
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
    await screen.findByRole("button", { name: "Go back to my earlier goal" });
    expect(screen.getByText("In use")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Go back to my earlier goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That didn't go through. Refresh and try again.");
  });
  it("says so when there is nothing yet", async () => {
    const api = { request: vi.fn(async () => ({ requests: [], actions: [] })), command: vi.fn() };
    render(<SupervisorRequests api={api as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    const region = screen.getByRole("region", { name: "Decisions and work from your companion" });
    await waitFor(() => expect(region).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByText("Nothing here yet. Work your companion starts for you, and decisions it needs from you, show up here.")).toBeVisible();
  });
  it("says it in Hebrew with one name for the helper", async () => {
    const api = { request: vi.fn(async () => ({ requests: [goal, ceiling], actions })), command: vi.fn() };
    render(<I18nProvider value={createLearnerTranslator("he")}><SupervisorRequests api={api as never} server={connectedSnapshot()} onChanged={vi.fn()} /></I18nProvider>);
    expect(await screen.findByRole("heading", { name: "החלטות ועבודה מהמנחה" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "מחכה להחלטה" })).toBeVisible();
    expect(screen.getByRole("button", { name: "שימוש במטרה הזו" })).toBeVisible();
    expect(screen.getByRole("button", { name: "שמירה על המטרה הנוכחית" })).toBeVisible();
    expect(screen.getByText("שום דבר מזה לא נספר כתוצאת הערכה ולא משנה את ההתקדמות.")).toBeVisible();
  });
});

describe("the companion's line for a waiting decision", () => {
  it("says the companion suggests a new goal, lights the trigger's dot, and Review opens the decisions section", async () => {
    resetCompanionBridge();
    const profile = vi.fn();
    const unregister = companionBridge.registerNavigate({ profile, lesson: vi.fn(), course: vi.fn() });
    const api = { request: vi.fn(async () => ({ requests: [goal, ceiling], actions: [] })) };
    const server = connectedSnapshot();
    const { rerender } = render(<DecisionLine api={api as never} server={server} />);
    expect(await screen.findByText("Your companion suggests a new goal.")).toBeVisible();
    // Only a decision waiting on the learner counts: the course team's is not theirs.
    expect(companionBridge.activity().suggestions).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(profile).toHaveBeenCalledWith("decisions");
    // Once decided, the line goes and so does the dot.
    api.request.mockResolvedValue({ requests: [{ ...goal, state: "approved", canUndo: true }, ceiling], actions: [] });
    rerender(<DecisionLine api={api as never} server={{ ...server, revision: server.revision + 1 }} />);
    await waitFor(() => expect(screen.queryByText("Your companion suggests a new goal.")).toBeNull());
    expect(companionBridge.activity().suggestions).toBe(0);
    unregister();
  });
  it("shows nothing and writes no dot when the list cannot be read or there is no course", async () => {
    resetCompanionBridge();
    const api = { request: vi.fn(async () => { throw new Error("offline"); }) };
    const { container, rerender } = render(<DecisionLine api={api as never} server={connectedSnapshot()} />);
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(companionBridge.activity().suggestions).toBe(0);
    rerender(<DecisionLine />);
    expect(container).toBeEmptyDOMElement();
  });
  it("words the line in Hebrew without a gendered verb for the companion", async () => {
    resetCompanionBridge();
    const api = { request: vi.fn(async () => ({ requests: [goal], actions: [] })) };
    render(<I18nProvider value={createLearnerTranslator("he")}><DecisionLine api={api as never} server={connectedSnapshot()} /></I18nProvider>);
    expect(await screen.findByText("הצעה מהמנחה: מטרה חדשה.")).toBeVisible();
    expect(screen.getByRole("button", { name: "עיון" })).toBeVisible();
  });
});
