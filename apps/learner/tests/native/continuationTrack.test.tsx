import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
// The native project resolves the app's own modules, never their `.web` variants.
import { ContinuationTrack } from "../../src/components/ContinuationTrack";
import { CourseApiError } from "../../src/client/apiClient";
import type { ContinuationView } from "../../src/client/policyClient";
import { connectedSnapshot } from "../connectedFixtures";
import { LocaleProvider } from "../../src/i18n/LocaleProvider";
import { LocaleSwitcher } from "../../src/components/LocaleSwitcher";
import { pressWhenReady } from "../pressWhenReady";

/** G15 on native: the same opt-in continuation track as the web view, on native controls. */
const view = (over: Partial<ContinuationView> = {}): ContinuationView => ({
  revision: 4,
  available: true,
  track: null,
  reviewFocus: { unprovenConceptIds: ["observe"], uncoveredObjectiveIds: [] },
  terms: { requiredWork: false, credit: false, reopensCourse: false, canStopAnytime: true },
  ...over,
});
const active = { state: "active" as const, optedInAt: "2030-03-02T10:00:00Z", stoppedAt: null };
const stopped = { state: "stopped" as const, optedInAt: "2030-03-02T10:00:00Z", stoppedAt: "2030-03-09T10:00:00Z" };
const api = (first: unknown, next: unknown = first) => ({
  request: vi.fn(async () => first),
  command: vi.fn(async () => next),
});
const disabled = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-disabled") === "true";

describe("native continuation track (G15)", () => {
  it("renders native controls, explains the fixed terms and opts in only after explicit consent", async () => {
    const a = api(view(), view({ revision: 5, track: active }));
    const onChanged = vi.fn();
    const { container } = render(<ContinuationTrack api={a as never} server={connectedSnapshot()} onChanged={onChanged} />);
    expect(await screen.findByRole("heading", { name: "Keep reviewing after the course" })).toBeTruthy();
    // Native Pressables, not a web form or input.
    expect(container.querySelector("input, form")).toBeNull();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Nothing is required/), expect.stringMatching(/You can stop at any time\./)]),
    );
    expect(screen.getByText(/do not add new credit/)).toBeTruthy();
    expect(screen.getByText(/stays closed/)).toBeTruthy();
    expect(screen.getByText(/Explain a changing pattern\./)).toBeTruthy();
    expect(disabled("Start reviewing")).toBe(true);
    await pressWhenReady(screen.getByRole("button", { name: "Start reviewing" }));
    expect(a.command).not.toHaveBeenCalled();
    const consent = screen.getByRole("checkbox");
    expect(consent).toHaveAttribute("aria-checked", "false");
    fireEvent.click(consent);
    expect(consent).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Start reviewing" }));
    await waitFor(() =>
      expect(a.command).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }), "continuation", { explicitConsent: true }),
    );
    expect(await screen.findByRole("button", { name: "Stop reviewing" })).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent(/You are reviewing after the course/);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("stops an active track and explains a refusal, then reloads the current choice", async () => {
    const a = api(view({ track: active }));
    a.command.mockRejectedValueOnce(new CourseApiError("CONTINUATION_NOT_ACTIVE", 409));
    render(<ContinuationTrack api={a as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    await pressWhenReady(await screen.findByRole("button", { name: "Stop reviewing" }));
    expect(a.command).toHaveBeenCalledWith(expect.anything(), "continuation/stop", {});
    expect(await screen.findByRole("alert")).toHaveTextContent("Reviewing after the course is already stopped.");
    await waitFor(() => expect(a.request).toHaveBeenCalledTimes(2));
  });

  it("offers to start again after a stop, and says something plain for an unknown error", async () => {
    const a = api(view({ track: stopped }));
    a.command.mockRejectedValueOnce(new CourseApiError("SOMETHING_NEW", 500));
    render(<ContinuationTrack api={a as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    expect(await screen.findByText(/You stopped reviewing on/)).toBeTruthy();
    await pressWhenReady(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Start reviewing again" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("SOMETHING_NEW");
    expect(a.request).toHaveBeenCalledTimes(1);
  });

  it("shows nothing while the course is open", async () => {
    const a = api(view({ available: false }));
    const { container } = render(<ContinuationTrack api={a as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    await waitFor(() => expect(a.request).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("reads in Hebrew, right to left, with the same consent rule", async () => {
    const a = api(view());
    render(
      <LocaleProvider>
        <LocaleSwitcher />
        <ContinuationTrack api={a as never} server={connectedSnapshot()} onChanged={vi.fn()} />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "עברית" }));
    expect(await screen.findByRole("heading", { name: "להמשיך לחזור על החומר אחרי הקורס" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "התחלת חזרה" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("radiogroup").parentElement).toHaveStyle({ direction: "rtl" });
  });
});
