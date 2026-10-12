import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EnrollmentPreview } from "../src/components/EnrollmentPreview";
import { ClosureSummary } from "../src/components/ClosureSummary";
import { PolicyPanel } from "../src/components/PolicyPanel.web";
import {
  createPolicyClient,
  parseEnrollmentPolicy,
  type CatalogCourse,
} from "../src/client/policyClient";
import { createCourseApi } from "../src/client/apiClient";
import {
  policyDate,
  previewPolicyAvailable,
} from "../src/connected/policyPresentation";
import { connectedSnapshot } from "./connectedFixtures";
import { authorPolicy, policyFixture } from "./policyFixtures";
const course: CatalogCourse = {
  id: "release",
  title: "Everyday patterns",
  version: "1",
  status: "published",
  summary: "Notice what changes.",
  policy: authorPolicy,
};
describe("enrollment clocks and explicit policy decisions", () => {
  it("shows defaults before a new enrollment, and only its explicit Start calls the handler", () => {
    const start = vi.fn(),
      back = vi.fn();
    render(
      <EnrollmentPreview
        course={course}
        pending={false}
        onStart={start}
        onBack={back}
      />,
    );
    expect(start).not.toHaveBeenCalled();
    expect(
      screen.getByText("90 calendar days from starting this course."),
    ).toBeVisible();
    expect(screen.getByText(/Times shown in Asia\/Jerusalem/)).toBeVisible();
    expect(
      screen.getByText(/7 calendar days total, across up to 2 extensions/),
    ).toBeVisible();
    expect(screen.getByText("Extra learning minutes: 30.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "← Back to courses" }));
    expect(back).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start course" }));
    expect(start).toHaveBeenCalledOnce();
  });
  it("fails closed if new-enrollment policy metadata is missing or malformed", () => {
    const start = vi.fn();
    render(
      <EnrollmentPreview
        course={{ ...course, policy: undefined }}
        pending={false}
        onStart={start}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Start course" })).toBeDisabled();
    expect(
      previewPolicyAvailable({
        ...authorPolicy,
        window: { ...authorPolicy.window!, calendarDays: NaN },
      }),
    ).toBe(false);
    expect(
      previewPolicyAvailable({
        ...authorPolicy,
        window: { ...authorPolicy.window!, timeZone: "not-a-zone" },
      }),
    ).toBe(false);
  });
  it("uses supplied effective dates and balances, with explicit consent reset for changed terms", () => {
    const server = connectedSnapshot(),
      data = policyFixture(),
      accept = vi.fn(),
      decline = vi.fn();
    const props = {
      server,
      episodeId: "intro",
      data,
      loading: false,
      pending: false,
      onRefresh: vi.fn(),
      onAccept: accept,
      onDecline: decline,
    };
    const { container, rerender } = render(<PolicyPanel {...props} />);
    container.querySelector("details")!.open = true;
    expect(
      screen.getAllByText(/7 calendar days, 2 extensions remaining/, {
        selector: "li",
      }),
    ).toHaveLength(2);
    const button = screen.getByRole("button", {
      name: "Accept this extension",
    });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(button);
    expect(accept).toHaveBeenCalledWith(data.offers[0]);
    expect(data.constraints[0]!.effectiveDeadline).toBe("2030-03-01T10:00:00Z");
    const changed = structuredClone(data);
    changed.offers[0]!.termsDigest = "b".repeat(64);
    rerender(<PolicyPanel {...props} data={changed} />);
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Accept this extension" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Decline offer" }));
    expect(decline).toHaveBeenCalledWith(changed.offers[0]);
  });
  it("does not offer acceptance for expired or stale policy terms, or claim a pending approval extended dates", () => {
    const data = policyFixture(),
      server = connectedSnapshot();
    data.offers[0]!.terms.expiresAt = "2020-01-01T00:00:00Z";
    const props = {
      server,
      data,
      loading: false,
      pending: false,
      onRefresh: vi.fn(),
      onAccept: vi.fn(),
      onDecline: vi.fn(),
    };
    const { container, rerender } = render(<PolicyPanel {...props} />);
    container.querySelector("details")!.open = true;
    expect(
      screen.getByRole("button", { name: "Accept this extension" }),
    ).toBeDisabled();
    data.offers[0]!.terms.expiresAt = "2030-01-01T00:00:00Z";
    data.policyRevision = 2;
    rerender(<PolicyPanel {...props} data={{ ...data }} />);
    expect(screen.getByText(/Your plan changed/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Accept this extension" }),
    ).toBeDisabled();
    data.offers[0]!.state = "accepted_pending_admin";
    rerender(<PolicyPanel {...props} data={{ ...data }} />);
    expect(screen.getByText("Accepted · waiting for approval")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Accept this extension" }),
    ).not.toBeInTheDocument();
  });
  it("sends only the offered digest plus explicit consent with the server policy revision", async () => {
    const snapshot = connectedSnapshot(),
      data = policyFixture();
    data.revision = 9;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ revision: 10, offer: data.offers[0] })),
      );
    const client = createPolicyClient(
      createCourseApi({ fetch: fetcher, csrf: () => "csrf" }),
    );
    expect(() =>
      client.accept(snapshot, data, data.offers[0]!, false as true),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await client.accept(snapshot, data, data.offers[0]!, true);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject(
      {
        offerId: data.offers[0]!.terms.offerId,
        termsDigest: "a".repeat(64),
        explicitConsent: true,
        expectedRevision: 9,
      },
    );
    await client.decline(snapshot, data, data.offers[0]!);
    expect(
      JSON.parse(fetcher.mock.calls[1]![1]!.body as string),
    ).not.toHaveProperty("explicitConsent");
  });
  it("rejects cross-enrollment or malformed policy snapshots without inventing zero balances", () => {
    expect(
      parseEnrollmentPolicy(policyFixture(), "enrollment-1").balances[0]!
        .remaining,
    ).toBe(7);
    expect(() =>
      parseEnrollmentPolicy(policyFixture("other"), "enrollment-1"),
    ).toThrow();
    const invalid = policyFixture();
    invalid.balances[0]!.remaining = NaN;
    expect(() => parseEnrollmentPolicy(invalid, "enrollment-1")).toThrow();
  });
  it("distinguishes complete coverage from mastery gaps and never presents certification", () => {
    const server = connectedSnapshot();
    server.complete = true;
    server.closureReport = {
      closedAt: "2026-10-12T00:00:00Z",
      reason: "completed",
      coverage: "complete",
      mastery: "gaps",
      uncoveredObjectiveIds: [],
      unprovenConceptIds: ["observe"],
      requiredExpansion: "stopped",
      continuation: "explicit_opt_in_separate_track",
    };
    render(<ClosureSummary server={server} />);
    expect(screen.getByText("Material coverage: Complete.")).toBeVisible();
    expect(
      screen.getByText(/Further independent checks are needed/),
    ).toBeVisible();
    expect(screen.getByText("Explain a changing pattern.")).toBeVisible();
    expect(
      screen.getByText(/not professional certification or qualification/),
    ).toBeVisible();
  });
  it("formats repeated DST clock times with their real offsets and keeps the server instant unchanged", () => {
    const before = "2026-11-01T05:30:00Z",
      after = "2026-11-01T06:30:00Z";
    expect(policyDate(before, "America/New_York")).toContain("GMT-4");
    expect(policyDate(after, "America/New_York")).toContain("GMT-5");
    expect(policyDate(null)).toBe("No calendar deadline specified");
  });
});
