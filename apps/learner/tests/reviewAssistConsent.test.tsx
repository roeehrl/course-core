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
    const box = await screen.findByRole("checkbox", { name: "Let AI draft notes for my reviewer" });
    expect(box).not.toBeChecked();
    expect(screen.getByText("A person reviews your written answers. You can let AI draft notes for that reviewer; it sees only the question, the rubric and your answers, never your name or history. It never grades you.")).toBeVisible();
    // What each status chip in the lesson means.
    expect(screen.getByRole("heading", { name: "What each status means" })).toBeVisible();
    expect(screen.getByText("Waiting for review")).toBeVisible();
    expect(screen.getByText("Your reviewer has a question. Reply under the answer in the lesson.")).toBeVisible();
    await userEvent.click(box);
    await waitFor(() => expect(api.command).toHaveBeenCalledWith(expect.anything(), "review-assist", { granted: true }));
    expect(box).toBeChecked();
    expect(onChanged).toHaveBeenCalled();
  });
  it("holds its space while the saved choice loads, hidden and inert, and drops it if the read fails", async () => {
    let fail!: (error: Error) => void;
    const api = { request: vi.fn(() => new Promise((_, reject) => (fail = reject))), command: vi.fn() };
    const { container } = render(<ReviewAssistConsent api={api as never} server={snapshot(true)} onChanged={vi.fn()} />);
    const section = container.querySelector("section")!;
    expect(section).toHaveAttribute("aria-hidden", "true");
    expect(section).toHaveStyle({ visibility: "hidden" });
    expect(section).toHaveAttribute("inert");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.querySelector("input")).toBeDisabled();
    fail(new Error("offline"));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api.command).not.toHaveBeenCalled();
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
    expect(await screen.findByRole("checkbox", { name: "Let AI draft notes for my reviewer" })).not.toBeChecked();
    expect(screen.getByText(/never your name or history\. It never grades you\./)).toBeVisible();
  });
  it("says plainly when the choice could not be saved, and words it all in Hebrew", async () => {
    const { I18nProvider, createLearnerTranslator } = await import("../src/i18n");
    const api = { request: vi.fn(async () => ({ granted: false })), command: vi.fn(async () => { throw new Error("offline"); }) };
    render(<I18nProvider value={createLearnerTranslator("he")}><ReviewAssistConsent api={api as never} server={snapshot(true)} onChanged={vi.fn()} /></I18nProvider>);
    expect(await screen.findByRole("heading", { name: "בדיקת התשובות הכתובות" })).toBeVisible();
    await userEvent.click(screen.getByRole("checkbox", { name: "לאפשר ל־AI לנסח טיוטת הערות לבודק" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("הבחירה לא נשמרה. שום דבר לא השתנה.");
  });
});
