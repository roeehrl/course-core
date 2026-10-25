import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PolicyPanel, debitUnit } from "../src/components/PolicyPanel.web";
import { ContinuationTrack } from "../src/components/ContinuationTrack.web";
import {
  createContinuationClient,
  parseContinuation,
  parseEnrollmentPolicy,
  type ContinuationView,
} from "../src/client/policyClient";
import { CourseApiError } from "../src/client/apiClient";
import { connectedSnapshot } from "./connectedFixtures";
import { policyFixture } from "./policyFixtures";
import { pressWhenReady } from "./pressWhenReady";

/** G03 binding explanation, G09 minute/lesson extension offers and G15 the continuation track. */
const panelProps = (data = policyFixture()) => ({
  server: connectedSnapshot(),
  episodeId: "intro",
  data,
  loading: false,
  pending: false,
  onRefresh: vi.fn(),
  onAccept: vi.fn(),
  onDecline: vi.fn(),
});
const open = (container: HTMLElement) => {
  container.querySelector("details")!.open = true;
};

describe("which level sets a date or limit (G03)", () => {
  it("names the level that binds, never a raw scope id", () => {
    const data = policyFixture();
    data.constraints[1]!.binding = {
      deadline: { scopeId: "organization", level: "organization", kind: "window", at: "2030-02-01T10:00:00Z" },
      quotas: [{ metric: "additionalMinutes", conceptId: null, scopeId: "enrollment", level: "enrollment", limit: 60, remaining: 20 }],
    };
    const parsed = parseEnrollmentPolicy(structuredClone(data), "enrollment-1");
    const { container } = render(<PolicyPanel {...panelProps(parsed)} />);
    open(container);
    expect(screen.getByText("What sets this date: your organization's limit.")).toBeVisible();
    expect(screen.getByText("Extra learning minutes: 20 of 60 left, set by your own terms.")).toBeVisible();
    expect(container.textContent).not.toContain("organization:");
    expect(container.textContent).not.toMatch(/\benrollment\b/);
  });
  it("drops a malformed binding instead of guessing, and keeps the rest of the policy", () => {
    const data = policyFixture() as unknown as { constraints: Record<string, unknown>[] };
    data.constraints[0]!.binding = { deadline: { scopeId: "x", level: "galaxy", kind: "window", at: "2030-02-01T10:00:00Z" }, quotas: [] };
    data.constraints[1]!.binding = { deadline: null, quotas: [] };
    const parsed = parseEnrollmentPolicy(data, "enrollment-1");
    expect(parsed.constraints[0]!.binding).toBeUndefined();
    expect(parsed.constraints[1]!.binding).toEqual({ deadline: null, quotas: [] });
  });
});

describe("extension offers in named units (G09)", () => {
  it("shows extra study minutes and lessons with the exact allowance used, before and after", () => {
    const data = policyFixture(), terms = data.offers[0]!.terms;
    terms.change = { work: { additionalMinutes: 30, additionalEpisodes: 2 } };
    terms.poolDebits = [{ poolId: "admin:study-time", amount: 30 }, { poolId: "admin:lessons", amount: 2 }];
    terms.balanceBefore = [{ poolId: "admin:study-time", remaining: 120, grantsRemaining: 2 }, { poolId: "admin:lessons", remaining: 4, grantsRemaining: 2 }];
    terms.balanceAfter = [{ poolId: "admin:study-time", remaining: 90, grantsRemaining: 1 }, { poolId: "admin:lessons", remaining: 2, grantsRemaining: 1 }];
    const parsed = parseEnrollmentPolicy(structuredClone(data), "enrollment-1");
    const { container } = render(<PolicyPanel {...panelProps(parsed)} />);
    open(container);
    expect(screen.getByText("30 more planned study minutes allowed")).toBeVisible();
    expect(screen.getByText("2 more lessons allowed")).toBeVisible();
    expect(screen.getByText("Uses 30 study minutes of your allowance: 120 before, 90 after.")).toBeVisible();
    expect(screen.getByText("Uses 2 lessons of your allowance: 4 before, 2 after.")).toBeVisible();
    expect(screen.queryByText(/more calendar days? before the deadline/)).toBeNull();
  });
  it("names day debits from day pools, and an ambiguous debit only as units", () => {
    const offer = policyFixture().offers[0]!;
    offer.terms.change = { deadline: { kind: "window", calendarDays: 3 }, work: { additionalMinutes: 3 } };
    expect(debitUnit(offer, { poolId: "course:calendar", amount: 3 })).toBe("days");
    expect(debitUnit(offer, { poolId: "admin:mixed", amount: 3 })).toBe("units");
    offer.terms.change = { work: { additionalEpisodes: 1 } };
    expect(debitUnit(offer, { poolId: "admin:lessons", amount: 1 })).toBe("lessons");
  });
  it("ignores malformed change terms and debits rather than rendering them", () => {
    const data = policyFixture() as unknown as { offers: { terms: Record<string, unknown> }[] };
    data.offers[0]!.terms.change = { work: { additionalMinutes: -5 } };
    data.offers[0]!.terms.poolDebits = [{ poolId: "p", amount: 0 }];
    const parsed = parseEnrollmentPolicy(data, "enrollment-1");
    expect(parsed.offers[0]!.terms.change).toBeUndefined();
    expect(parsed.offers[0]!.terms.poolDebits).toBeUndefined();
  });
});

const view = (over: Partial<ContinuationView> = {}): ContinuationView => ({
  revision: 4,
  available: true,
  track: null,
  reviewFocus: { unprovenConceptIds: ["observe"], uncoveredObjectiveIds: [] },
  terms: { requiredWork: false, credit: false, reopensCourse: false, canStopAnytime: true },
  ...over,
});
const active = { state: "active" as const, optedInAt: "2030-03-02T10:00:00Z", stoppedAt: null };
const api = (first: unknown, next: unknown = first) => ({ request: vi.fn(async () => first), command: vi.fn(async () => next) });

describe("reviewing after the course (G15)", () => {
  it("explains the terms and opts in only after explicit consent", async () => {
    const a = api(view(), view({ revision: 5, track: active }));
    const onChanged = vi.fn();
    render(<ContinuationTrack api={a as never} server={connectedSnapshot()} onChanged={onChanged} />);
    expect(await screen.findByRole("heading", { name: "Keep reviewing after the course" })).toBeVisible();
    expect(screen.getByText(/Nothing is required/)).toBeVisible();
    expect(screen.getByText(/do not add new credit/)).toBeVisible();
    expect(screen.getByText(/stays closed/)).toBeVisible();
    expect(screen.getByText("You can stop at any time.")).toBeVisible();
    expect(screen.getByText("Explain a changing pattern.")).toBeVisible();
    const start = screen.getByRole("button", { name: "Start reviewing" });
    expect(start).toBeDisabled();
    await pressWhenReady(start);
    expect(a.command).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(start);
    await waitFor(() => expect(a.command).toHaveBeenCalledWith(expect.objectContaining({ revision: 4 }), "continuation", { explicitConsent: true }));
    expect(await screen.findByRole("button", { name: "Stop reviewing" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(/You are reviewing after the course/);
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it("stops an active track, and shows a plain message for a refused request", async () => {
    const a = api(view({ track: active }));
    a.command.mockRejectedValueOnce(new CourseApiError("CONTINUATION_NOT_ACTIVE", 409));
    render(<ContinuationTrack api={a as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Stop reviewing" }));
    expect(a.command).toHaveBeenCalledWith(expect.anything(), "continuation/stop", {});
    expect(await screen.findByRole("alert")).toHaveTextContent("Reviewing after the course is already stopped.");
  });
  it("shows nothing while the course is open or if the server's terms are not the fixed ones", async () => {
    const closedOff = api(view({ available: false }));
    const { container } = render(<ContinuationTrack api={closedOff as never} server={connectedSnapshot()} onChanged={vi.fn()} />);
    await waitFor(() => expect(closedOff.request).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(() => parseContinuation({ ...view(), terms: { ...view().terms, credit: true } })).toThrow(CourseApiError);
    expect(() => parseContinuation({ ...view(), track: { state: "paused", optedInAt: "2030-01-01T00:00:00Z", stoppedAt: null } })).toThrow(CourseApiError);
  });
  it("refuses an opt-in without consent before any request", async () => {
    const a = api(view());
    const client = createContinuationClient(a as never);
    await expect(client.optIn(connectedSnapshot(), view(), false as unknown as true)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(a.command).not.toHaveBeenCalled();
  });
});
