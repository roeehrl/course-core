import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewAssistConsent } from "../src/components/ReviewAssistConsent.web";
import { connectedSnapshot } from "./connectedFixtures";

function snapshot(written: boolean) {
  const server = connectedSnapshot();
  server.course.assessments = [{ id: "explain", type: written ? "rubric" : "choice", objectiveIds: ["observe"] }] as never;
  return server;
}
describe("opt-in for AI drafts of written-answer reviews", () => {
  it("is off by default, says what is and is not shared, and saves the learner's choice", async () => {
    const api = { request: vi.fn(async () => ({ granted: false })), command: vi.fn(async () => ({})) };
    const onChanged = vi.fn();
    render(<ReviewAssistConsent api={api as never} server={snapshot(true)} onChanged={onChanged} />);
    const box = await screen.findByRole("checkbox", { name: "Let an AI draft notes for my reviewer" });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/not your name, profile or history/)).toBeVisible();
    await userEvent.click(box);
    await waitFor(() => expect(api.command).toHaveBeenCalledWith(expect.anything(), "review-assist", { granted: true }));
    expect(box).toBeChecked();
    expect(onChanged).toHaveBeenCalled();
  });
  it("does not appear for courses without written answers", async () => {
    const api = { request: vi.fn(async () => ({ granted: false, applies: false })), command: vi.fn() };
    const { container } = render(<ReviewAssistConsent api={api as never} server={snapshot(false)} onChanged={vi.fn()} />);
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
  it("appears when the server says a checkpoint is judged in conversation, though no written item is listed", async () => {
    const api = { request: vi.fn(async () => ({ granted: false, applies: true })), command: vi.fn() };
    render(<ReviewAssistConsent api={api as never} server={snapshot(false)} onChanged={vi.fn()} />);
    expect(await screen.findByRole("checkbox", { name: "Let an AI draft notes for my reviewer" })).not.toBeChecked();
    expect(screen.getByText(/only accepts quotes of your own words/)).toBeVisible();
  });
});
