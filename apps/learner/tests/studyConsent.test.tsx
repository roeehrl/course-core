import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StudyConsent } from "../src/components/StudyConsent.web";
import { connectedSnapshot } from "./connectedFixtures";

const studyId = "00000000-0000-4000-8000-000000000051";
const study = {
  id: studyId, title: "Ordering study", purpose: "We compare three versions of this course.", state: "recruiting", consentDigest: "d".repeat(64),
  versions: ["The fixed lesson path: the AI companion and personal AI supervision are off for you.", "The full course: the AI companion and personal AI supervision, as usual."],
  collected: ["your study code (not your name or email)"], neverCollected: ["your conversations with the AI companion"],
};
const joined = { consent: "consented", participantCode: "P0123456789", consentedAt: "2026-10-20T10:00:00.000Z", withdrawnAt: null,
  version: { label: "Fixed path", behaviour: "fixed", explanation: "The fixed lesson path: the AI companion and personal AI supervision are off for you." } };
const api = (view: unknown, next: unknown = view) => ({ request: vi.fn(async () => view), command: vi.fn(async () => next) });

describe("research study consent", () => {
  it("explains in plain language and joins only after an explicit agreement", async () => {
    const a = api({ revision: 3, study, participation: null }, { revision: 4, study, participation: joined });
    const onChanged = vi.fn();
    render(<StudyConsent api={a as never} server={connectedSnapshot()} mode="prompt" onChanged={onChanged} />);
    expect(await screen.findByRole("heading", { name: "Join a research study? Ordering study" })).toBeVisible();
    expect(screen.getByText(/A fair, random draw places you/)).toBeVisible();
    expect(screen.getByText("your conversations with the AI companion")).toBeVisible();
    expect(screen.getByText(/Saying no changes nothing/)).toBeVisible();
    const join = screen.getByRole("button", { name: "Join the study" });
    expect(join).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "I have read this and agree to take part" }));
    await userEvent.click(join);
    await waitFor(() => expect(a.command).toHaveBeenCalledWith(expect.anything(), "study/consent", { studyId, consentDigest: "d".repeat(64) }));
    expect(onChanged).toHaveBeenCalled();
    // The prompt is for undecided learners only.
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Join a research study/ })).toBeNull());
  });

  it("'Not now' hides the prompt without joining", async () => {
    const a = api({ revision: 3, study, participation: null });
    render(<StudyConsent api={a as never} server={connectedSnapshot()} mode="prompt" onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("heading", { name: /Join a research study/ })).toBeNull();
    expect(a.command).not.toHaveBeenCalled();
  });

  it("in My profile shows the study code and version, and leaving needs a confirmation", async () => {
    const left = { ...joined, consent: "withdrawn", withdrawnAt: "2026-10-21T10:00:00.000Z", version: null };
    const a = api({ revision: 4, study, participation: joined }, { revision: 5, study, participation: left });
    render(<StudyConsent api={a as never} server={connectedSnapshot()} mode="settings" onChanged={vi.fn()} />);
    expect(await screen.findByText("P0123456789")).toBeVisible();
    expect(screen.getByText(/Your version: The fixed lesson path/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Leave the study" }));
    const group = screen.getByRole("group", { name: "Confirm leaving the study" });
    expect(group).toHaveTextContent(/your data is left out of the study/);
    await userEvent.click(screen.getAllByRole("button", { name: "Leave the study" }).at(-1)!);
    await waitFor(() => expect(a.command).toHaveBeenCalledWith(expect.anything(), "study/withdraw", { studyId }));
    expect(await screen.findByText(/You left this study/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Join again" })).toBeDisabled();
  });

  it("shows nothing without a study, and reports a failed save without changing anything", async () => {
    const none = api({ revision: 1, study: null, participation: null });
    const { container } = render(<StudyConsent api={none as never} server={connectedSnapshot()} mode="settings" onChanged={vi.fn()} />);
    await waitFor(() => expect(none.request).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    const failing = { request: vi.fn(async () => ({ revision: 3, study, participation: null })), command: vi.fn(async () => { throw new Error("offline"); }) };
    render(<StudyConsent api={failing as never} server={connectedSnapshot()} mode="settings" onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "I have read this and agree to take part" }));
    await userEvent.click(screen.getByRole("button", { name: "Join the study" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your choice could not be saved. You have not joined.");
  });
});
