import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LedgerActionDialog } from "../src/components/LedgerActionDialog";
import { PolicySettingsCard } from "../src/components/PolicySettingsCard";
import { CohortMigrationDialog } from "../src/components/CohortMigrationDialog";
import { createFetchAdminClient } from "../src/client/fetchClient";
import type { AdminClient } from "../src/domain/contracts";
import { AdminError } from "../src/domain/errors";
import type { LearningPolicy } from "../src/domain/policy";
import type { PolicySettings, PolicySettingsView } from "../src/domain/policyLedger";

const enrollmentId = "00000000-0000-4000-8000-000000000001";
const policy = { enrollmentId, status: "active", revision: 5,
  scopes: [{ scopeId: "course", label: "Ordering", parentScopeId: null, kind: "course", window: { resolvedDeadline: "2026-11-01T00:00:00.000Z" } }] } as unknown as LearningPolicy;
const result = { policy, receipt: { id: "receipt-1", authority: "server" as const, outcome: "revocation" }, message: "Grant revoked." };
const digest = "d".repeat(64);
const settings: PolicySettings = {
  timeZone: "UTC", disambiguation: "compatible", hardDeadlineDisambiguation: "reject",
  extensions: { approval: "learner", offerCooldownHours: 24, maxOutstandingOffersPerScope: 1, maxOffersPerScope: null },
  headroom: { core: { additionalMinutes: 0, additionalEpisodes: 0 }, finalAssessment: { additionalMinutes: 0, additionalEpisodes: 0 } },
  closedQuestionBudget: 20,
  pacing: { minutesPerRequiredEpisode: null, finalAssessmentMinutes: null, studyMinutesPerDay: null },
};
const view = (over: Partial<PolicySettingsView> = {}): PolicySettingsView => ({
  courseId: "course-1", source: "default", revision: 0, changedAt: null, settings, defaults: settings, releaseId: "r", appliesTo: "new_enrollments", preview: null, ...over,
});

describe("revocation, refund and exceptional grant dialogs", () => {
  it("previews a revocation, discloses shortened time and applies with a reason and a stable key", async () => {
    const client = {
      previewLedgerAction: vi.fn(async () => ({ previewKind: "revocation", previewId: "p1", previewDigest: digest, revision: 5, expiresAt: "2026-10-15T23:00:00.000Z",
        grantId: "g1", kind: "extension", scopeId: "course", shortensDeadline: true,
        impacts: [{ scopeId: "course", effectiveDeadlineBefore: "2026-11-03T00:00:00.000Z", effectiveDeadlineAfter: "2026-11-01T00:00:00.000Z", shortened: true }] })),
      applyLedgerAction: vi.fn(async () => result),
    } as unknown as AdminClient;
    const onUpdated = vi.fn();
    render(<LedgerActionDialog client={client} policy={policy} initial={{ kind: "revocation", grantId: "g1" }} onClose={vi.fn()} onUpdated={onUpdated} />);
    expect(screen.getByText(/does not refund allowance/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Preview the effect" }));
    expect(await screen.findByText("This shortens promised time for the learner.")).toBeVisible();
    expect(screen.getByText(/Ordering: Nov 3, 2026.*→ Nov 1, 2026.*\(earlier\)/)).toBeVisible();
    const apply = screen.getByRole("button", { name: "Apply: revoke grant" });
    expect(apply).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "Ticket 42");
    await userEvent.click(apply);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(result));
    expect(vi.mocked(client.applyLedgerAction!).mock.calls[0]).toEqual([enrollmentId, { kind: "revocation", grantId: "g1" },
      { previewId: "p1", previewDigest: digest, reason: "Ticket 42" }, { expectedRevision: 5, idempotencyKey: expect.any(String) }]);
  });
  it("changing the refund amount discards the reviewed preview; a refused refund shows the server's reason", async () => {
    const client = {
      previewLedgerAction: vi.fn(async (_id: string, action: { amount: number }) => {
        if (action.amount > 2) throw new AdminError("ledger_refused");
        return { previewKind: "refund", previewId: "p2", previewDigest: digest, revision: 5, expiresAt: "2026-10-15T23:00:00.000Z", grantId: "g1", poolId: "course:calendar", amount: 2,
          balanceBefore: { poolId: "course:calendar", remaining: 0, grantsRemaining: 0 }, balanceAfter: { poolId: "course:calendar", remaining: 2, grantsRemaining: 0 } };
      }),
      applyLedgerAction: vi.fn(),
    } as unknown as AdminClient;
    render(<LedgerActionDialog client={client} policy={policy} initial={{ kind: "refund", grantId: "g1", poolId: "course:calendar", amount: 2 }} onClose={vi.fn()} onUpdated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Preview the effect" }));
    expect(await screen.findByText("Balance 0 → 2 (course:calendar)")).toBeVisible();
    await userEvent.clear(screen.getByLabelText("Units to refund"));
    await userEvent.type(screen.getByLabelText("Units to refund"), "3");
    expect(screen.queryByText("Balance 0 → 2 (course:calendar)")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview the effect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The ledger refused this operation");
    expect(client.applyLedgerAction).not.toHaveBeenCalled();
  });
});

describe("course policy settings", () => {
  it("requires a server preview of the exact draft, shows DST effects and saves with the revision", async () => {
    const reviewed = { ...settings, timeZone: "America/New_York", disambiguation: "reject" as const };
    const client = {
      getPolicySettings: vi.fn(async () => view()),
      previewPolicySettings: vi.fn(async () => view({ preview: { settings: reviewed, feasibility: { feasible: true, issues: [], alternatives: [], masteryCriteria: "unchanged" },
        calendar: [{ scopeId: "course", rule: "window", timeZone: "America/New_York", disambiguation: "reject", calendarDays: 30, rejectsSomeStarts: true, rejectedExtensionDays: [],
          transitions: [{ transitionAt: "2027-03-14T07:00:00Z", kind: "gap", offsetBefore: "-05:00", offsetAfter: "-04:00", localDate: "2027-03-14", localStart: "02:00:00",
            localEnd: "03:00:00", affectedAnchorDate: "2027-02-12", example: null, resolution: "rejected" }] }] } })),
      savePolicySettings: vi.fn(async () => view({ source: "configured", revision: 1, settings: reviewed, message: "Policy settings saved." })),
    } as unknown as AdminClient;
    render(<PolicySettingsCard client={client} courseId="course-1" canWrite />);
    expect(await screen.findByText("Documented defaults")).toBeVisible();
    await userEvent.clear(screen.getByLabelText("Deadline time zone (IANA)"));
    await userEvent.type(screen.getByLabelText("Deadline time zone (IANA)"), "America/New_York");
    await userEvent.selectOptions(screen.getByLabelText("Window daylight-saving resolution"), "reject");
    expect(screen.getByLabelText("Hard-deadline daylight-saving resolution")).toHaveValue("reject");
    expect(screen.queryByRole("button", { name: "Save settings for new enrollments" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Preview feasibility and daylight saving" }));
    expect(vi.mocked(client.previewPolicySettings!)).toHaveBeenCalledWith("course-1", reviewed);
    const table = await screen.findByRole("table", { name: "Daylight-saving effects" });
    expect(table).toHaveTextContent("skipped 02:00–03:00");
    expect(table).toHaveTextContent("Refused");
    expect(screen.getByText(/would be refused at these times/)).toBeVisible();
    await userEvent.type(screen.getByLabelText("Reason for this change"), "Course moved to New York");
    await userEvent.click(screen.getByRole("button", { name: "Save settings for new enrollments" }));
    expect(await screen.findByText("Policy settings saved.")).toBeVisible();
    expect(vi.mocked(client.savePolicySettings!)).toHaveBeenCalledWith("course-1", { expectedRevision: 0, settings: reviewed, reason: "Course moved to New York" });
  });
  it("is read-only without the policy write permission", async () => {
    const client = { getPolicySettings: vi.fn(async () => view()), previewPolicySettings: vi.fn(), savePolicySettings: vi.fn() } as unknown as AdminClient;
    render(<PolicySettingsCard client={client} courseId="course-1" canWrite={false} />);
    expect(await screen.findByLabelText("Deadline time zone (IANA)")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Preview feasibility and daylight saving" })).toBeNull();
  });
});

describe("cohort migration", () => {
  it("cannot apply until every shortened grant is acknowledged", async () => {
    const client = {
      previewCohortMigration: vi.fn(async () => ({ migrationId: "m1", previewDigest: digest, expiresAt: "2026-10-15T23:00:00.000Z", shortenedGrantIds: ["g1"], refused: [],
        enrollments: [{ enrollmentId, displayName: "Public learner", impacts: [{ scopeId: "course", effectiveDeadlineBefore: "2026-11-03T00:00:00.000Z", effectiveDeadlineAfter: "2026-10-30T00:00:00.000Z" }],
          shortenedGrants: [{ entryId: "g1", kind: "extension", scopeId: "course", effectiveDeadlineBefore: "2026-11-03T00:00:00.000Z", effectiveDeadlineAfter: "2026-10-30T00:00:00.000Z" }] }] })),
      applyCohortMigration: vi.fn(async () => ({ migrationId: "m1", applied: 1, replayed: false, message: "Applied." })),
    } as unknown as AdminClient;
    const onApplied = vi.fn();
    render(<CohortMigrationDialog client={client} courseId="course-1" policy={policy} onClose={vi.fn()} onApplied={onApplied} />);
    await userEvent.type(screen.getByLabelText("New absolute deadline (UTC)"), "2026-10-30T00:00");
    await userEvent.click(screen.getByRole("button", { name: "Preview every enrollment" }));
    expect(vi.mocked(client.previewCohortMigration!)).toHaveBeenCalledWith("course-1", { scopeId: "course", hardDeadline: "2026-10-30T00:00:00.000Z" });
    await userEvent.type(await screen.findByLabelText("Reason for this change"), "Program ends early");
    const apply = screen.getByRole("button", { name: "Apply to all previewed learners" });
    expect(apply).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /Public learner's extension ends/ }));
    await userEvent.click(apply);
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(vi.mocked(client.applyCohortMigration!)).toHaveBeenCalledWith("course-1", { migrationId: "m1", previewDigest: digest, reason: "Program ends early", acknowledgedShortenedGrantIds: ["g1"] });
  });
});

describe("fetch client policy routes", () => {
  it("uses the documented admin routes and maps infeasibility and unacknowledged shortening", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith("/policy/cohort/apply")) return new Response(JSON.stringify({ error: "SHORTENED_GRANT_UNACKNOWLEDGED" }), { status: 409 });
      return new Response(JSON.stringify({ error: "PUBLISH_INFEASIBLE" }), { status: 409 });
    });
    const client = createFetchAdminClient({ baseUrl: "/api/admin", fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.previewPolicySettings!("c 1", settings)).rejects.toMatchObject({ code: "policy_infeasible" });
    await expect(client.applyCohortMigration!("c1", { migrationId: "m", previewDigest: digest, reason: "r", acknowledgedShortenedGrantIds: [] })).rejects.toMatchObject({ code: "shortened_grant" });
    await client.previewLedgerAction!(enrollmentId, { kind: "exception", scopeId: "course", days: 2, deadlineKind: "window" }).catch(() => undefined);
    await client.applyLedgerAction!(enrollmentId, { kind: "refund", grantId: "g/1", poolId: "p", amount: 1 }, { previewId: "p", previewDigest: digest, reason: "r" },
      { expectedRevision: 3, idempotencyKey: "k" }).catch(() => undefined);
    await client.approveExtension!(enrollmentId, "o1", { expectedRevision: 3, idempotencyKey: "k2" }).catch(() => undefined);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/admin/courses/c%201/policy-settings/preview",
      "POST /api/admin/courses/c1/policy/cohort/apply",
      `POST /api/admin/enrollments/${enrollmentId}/exceptions/preview`,
      `POST /api/admin/enrollments/${enrollmentId}/grants/g%2F1/refund`,
      `POST /api/admin/enrollments/${enrollmentId}/extensions/o1/grant`,
    ]);
    expect(calls[2]!.body).toEqual({ scopeId: "course", change: { deadline: { kind: "window", calendarDays: 2 } } });
    expect(calls[3]!.body).toEqual({ previewId: "p", previewDigest: digest, reason: "r", expectedRevision: 3, idempotencyKey: "k" });
  });
});
