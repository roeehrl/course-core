import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrganizationCeilingsCard } from "../src/components/OrganizationCeilingsCard";
import { PolicySettingsCard } from "../src/components/PolicySettingsCard";
import { BatchAdjustDialog } from "../src/components/BatchAdjustDialog";
import { AccommodationEditor } from "../src/components/AccommodationEditor";
import { ScopeDetails } from "../src/components/PolicyDetails";
import { AllowancesView } from "../src/views/AllowancesView";
import { createFetchAdminClient } from "../src/client/fetchClient";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import { AdminError } from "../src/domain/errors";
import type { LearningPolicy, ScopePolicy } from "../src/domain/policy";
import type {
  PolicySettings,
  PolicySettingsView,
} from "../src/domain/policyLedger";
import type {
  Allowances,
  CeilingsView,
  OrganizationCeilings,
} from "../src/domain/policyLevels";

const workspaceId = "00000000-0000-4000-8000-0000000000aa";
const courseId = "00000000-0000-4000-8000-0000000000bb";
const ceilings: OrganizationCeilings = {
  timeZone: "UTC",
  hardDeadline: null,
  maxEnrollmentDays: null,
  work: {
    additionalMinutes: null,
    additionalEpisodes: null,
    remediationCyclesPerConcept: null,
  },
  extensionsAllowed: true,
  existingMaterialAccess: "read_only",
};
const ceilingsView = (over: Partial<CeilingsView> = {}): CeilingsView => ({
  workspaceId,
  source: "default",
  revision: 0,
  changedAt: null,
  ceilings,
  defaults: ceilings,
  preview: null,
  impact: [],
  moreCourses: false,
  appliesTo: "new_enrollments",
  ...over,
});

describe("organization limits (G02, G03)", () => {
  it("checks every course before saving, explains a clipped course and saves with a reason and the revision", async () => {
    const client = {
      getPolicyCeilings: vi.fn(async () => ceilingsView()),
      previewPolicyCeilings: vi.fn(
        async (_id: string, proposed: OrganizationCeilings) =>
          ceilingsView({
            preview: { ceilings: proposed },
            impact: [
              {
                courseId,
                title: "Sorting basics",
                feasible: true,
                issues: [
                  {
                    severity: "warning",
                    code: "LOOSER_CHILD_DEADLINE",
                    scopeId: "course",
                    deadline: null,
                  },
                ],
              },
            ],
          }),
      ),
      savePolicyCeilings: vi.fn(
        async (
          _id: string,
          input: { ceilings: OrganizationCeilings; expectedRevision: number },
        ) =>
          ceilingsView({
            source: "configured",
            revision: 1,
            ceilings: input.ceilings,
            outcome: "saved",
          }),
      ),
    } as unknown as AdminClient;
    render(
      <OrganizationCeilingsCard
        client={client}
        workspaceId={workspaceId}
        canWrite
      />,
    );
    await userEvent.type(
      await screen.findByLabelText("Longest enrollment (calendar days)"),
      "10",
    );
    // Nothing can be saved before the effect on every course was checked.
    expect(
      screen.queryByRole("button", { name: "Save organization limits" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Check the effect on every course" }),
    );
    expect(
      await screen.findByText(
        "This course's own end date is later, so the organization's limit will apply to its learners.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Sorting basics")).toBeVisible();
    const save = screen.getByRole("button", {
      name: "Save organization limits",
    });
    expect(save).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Reason for this change"),
      "Terms 2026",
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(client.savePolicyCeilings).toHaveBeenCalledWith(workspaceId, {
        expectedRevision: 0,
        ceilings: { ...ceilings, maxEnrollmentDays: 10 },
        reason: "Terms 2026",
      }),
    );
    expect(
      await screen.findByText(/New enrollments in every course start/),
    ).toBeVisible();
  });

  it("changing a value after the check asks for a new check; a stale save says what to do", async () => {
    const client = {
      getPolicyCeilings: vi.fn(async () => ceilingsView()),
      previewPolicyCeilings: vi.fn(
        async (_id: string, proposed: OrganizationCeilings) =>
          ceilingsView({ preview: { ceilings: proposed } }),
      ),
      savePolicyCeilings: vi.fn(async () => {
        throw new AdminError("stale_revision");
      }),
    } as unknown as AdminClient;
    render(
      <OrganizationCeilingsCard
        client={client}
        workspaceId={workspaceId}
        canWrite
      />,
    );
    const days = await screen.findByLabelText(
      "Longest enrollment (calendar days)",
    );
    await userEvent.type(days, "30");
    await userEvent.click(
      screen.getByRole("button", { name: "Check the effect on every course" }),
    );
    await screen.findByRole("button", { name: "Save organization limits" });
    await userEvent.type(days, "0");
    expect(
      screen.queryByRole("button", { name: "Save organization limits" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Check the effect on every course" }),
    );
    await userEvent.type(
      await screen.findByLabelText("Reason for this change"),
      "x",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save organization limits" }),
    );
    expect(
      await screen.findByText(/Refresh the latest revision/),
    ).toBeVisible();
  });

  it("shows nothing to staff who cannot read workspace limits, and is read-only without policy authority", async () => {
    const hidden = {
      getPolicyCeilings: vi.fn(async () => {
        throw new AdminError("permission_denied");
      }),
    } as unknown as AdminClient;
    const { container, unmount } = render(
      <OrganizationCeilingsCard
        client={hidden}
        workspaceId={workspaceId}
        canWrite={false}
      />,
    );
    await waitFor(() => expect(hidden.getPolicyCeilings).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    unmount();
    const reader = {
      getPolicyCeilings: vi.fn(async () => ceilingsView()),
    } as unknown as AdminClient;
    render(
      <OrganizationCeilingsCard
        client={reader}
        workspaceId={workspaceId}
        canWrite={false}
      />,
    );
    expect(
      await screen.findByLabelText("Longest enrollment (calendar days)"),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", {
        name: "Check the effect on every course",
      }),
    ).toBeNull();
  });

  it("sends the organization limits to the workspace route", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(ceilingsView()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher as unknown as typeof fetch,
    });
    await client.getPolicyCeilings!(workspaceId);
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toBe(
      `/api/admin/workspaces/${workspaceId}/policy-ceilings`,
    );
  });
});

const settings: PolicySettings = {
  timeZone: "UTC",
  disambiguation: "compatible",
  hardDeadlineDisambiguation: "reject",
  extensions: {
    approval: "learner",
    offerCooldownHours: 24,
    maxOutstandingOffersPerScope: 1,
    maxOffersPerScope: null,
    ultimateDeadline: null,
  },
  extensionPools: [],
  headroom: {
    core: { additionalMinutes: 0, additionalEpisodes: 0 },
    finalAssessment: { additionalMinutes: 0, additionalEpisodes: 0 },
  },
  closedQuestionBudget: 20,
  pacing: {
    minutesPerRequiredEpisode: null,
    finalAssessmentMinutes: null,
    studyMinutesPerDay: null,
  },
  assessment: { maxGradedAttemptsPerCheck: null, retryCooldownMinutes: 0 },
};
const settingsView = (
  over: Partial<PolicySettingsView> = {},
): PolicySettingsView => ({
  courseId,
  source: "default",
  revision: 0,
  changedAt: null,
  settings,
  defaults: settings,
  releaseId: "r",
  appliesTo: "new_enrollments",
  preview: null,
  ...over,
});

describe("extra time and work allowances (G09, Q05)", () => {
  it("adds an allowance, warns when the preview finds places it can never be used, and saves it with the settings", async () => {
    const client = {
      getPolicySettings: vi.fn(async () => settingsView()),
      previewPolicySettings: vi.fn(async (_id: string, draft: PolicySettings) =>
        settingsView({
          preview: {
            settings: draft,
            feasibility: {
              feasible: true,
              issues: [],
              alternatives: [],
              masteryCriteria: "unchanged",
            },
            calendar: [],
            pools: [
              {
                poolId: "admin:allowance-1",
                unit: "calendar_day",
                total: 4,
                maxPerGrant: 2,
                maxGrants: 2,
                scopeIds: ["chapter:a", "chapter:b"],
                unusableScopeIds: ["chapter:b"],
                source: "admin",
              },
            ],
          },
        }),
      ),
      savePolicySettings: vi.fn(
        async (_id: string, input: { settings: PolicySettings }) =>
          settingsView({
            source: "configured",
            revision: 1,
            settings: input.settings,
          }),
      ),
    } as unknown as AdminClient;
    render(<PolicySettingsCard client={client} courseId={courseId} canWrite />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add an allowance" }),
    );
    expect(screen.getByText("Allowance “allowance-1”")).toBeVisible();
    expect(
      screen.getByText(
        /Up to 4 calendar days for chapters \(one shared balance\)/,
      ),
    ).toBeVisible();
    // Most per request above the total is flagged before the server refuses it.
    const perGrant = screen.getByLabelText("Most per request");
    await userEvent.clear(perGrant);
    await userEvent.type(perGrant, "9");
    expect(
      screen.getByText("Most per request cannot be more than the total."),
    ).toBeVisible();
    await userEvent.clear(perGrant);
    await userEvent.type(perGrant, "2");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Preview feasibility and daylight saving",
      }),
    );
    expect(
      await screen.findByText(
        /can never be used in 1 of its 2 places: they have no deadline to move/,
      ),
    ).toBeVisible();
    await userEvent.type(
      screen.getByLabelText("Reason for this change"),
      "Allowance review",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save settings for new enrollments" }),
    );
    await waitFor(() => expect(client.savePolicySettings).toHaveBeenCalled());
    const saved = vi.mocked(client.savePolicySettings!).mock.calls[0]![1];
    expect(saved.settings.extensionPools).toEqual([
      {
        id: "allowance-1",
        unit: "calendar_day",
        appliesTo: "every_chapter",
        sharing: "shared",
        total: 4,
        maxPerGrant: 2,
        maxGrants: 2,
      },
    ]);
  });
});

const offer = {
  enrollmentId: "00000000-0000-4000-8000-000000000001",
  displayName: "Ada Learner",
  enrollmentRevision: 7,
  enrollmentStatus: "active",
  offerId: "00000000-0000-4000-8000-0000000000cc",
  scopeId: "course",
  state: "accepted_pending_admin" as const,
  change: { work: { additionalMinutes: 30 } },
  poolDebits: [{ poolId: "admin:study-time", amount: 30 }],
  requiredApprovals: ["role:admin"],
  createdAt: "2026-10-20T10:00:00.000Z",
  expiresAt: "2026-10-22T10:00:00.000Z",
  lastTransitionAt: "2026-10-20T11:00:00.000Z",
  acceptedAt: "2026-10-20T11:00:00.000Z",
};
const allowances = (over: Partial<Allowances> = {}): Allowances => ({
  courseId,
  view: "pending",
  offers: [offer],
  accommodations: [],
  pools: [],
  ...over,
});
const workspace = (permissions: string[]) =>
  ({
    course: { id: courseId, workspaceId },
    permissions,
    enrollments: [
      {
        id: offer.enrollmentId,
        status: "active",
        profile: { displayName: "Ada Learner" },
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        status: "active",
        profile: { displayName: "Ben Learner" },
      },
    ],
  }) as unknown as CourseWorkspace;
const courseScopes = [
  {
    scopeId: "course",
    label: "Sorting basics",
    kind: "course",
    parentScopeId: "organization",
    window: { resolvedDeadline: "2026-11-01T00:00:00.000Z" },
  },
  {
    scopeId: "organization",
    label: null,
    kind: "organization",
    parentScopeId: null,
  },
  {
    scopeId: "enrollment",
    label: null,
    kind: "enrollment",
    parentScopeId: "course",
  },
] as unknown as ScopePolicy[];

describe("extensions and accommodations across learners (Q05, G05)", () => {
  it("approves an accepted offer from the queue with the learner's revision", async () => {
    const client = {
      getAllowances: vi
        .fn()
        .mockResolvedValueOnce(allowances())
        .mockResolvedValue(allowances({ offers: [] })),
      getPolicy: vi.fn(async () => ({ scopes: courseScopes })),
      approveExtension: vi.fn(async () => ({})),
      rejectExtension: vi.fn(async () => ({})),
    } as unknown as AdminClient;
    render(
      <AllowancesView
        data={workspace(["policy.read", "policy.write"])}
        client={client}
      />,
    );
    expect(await screen.findByText("Ada Learner")).toBeVisible();
    expect(
      screen.getByText(/30 extra planned minutes for Sorting basics/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(client.approveExtension).toHaveBeenCalledWith(
        offer.enrollmentId,
        offer.offerId,
        { expectedRevision: 7, idempotencyKey: expect.any(String) },
      ),
    );
    expect(await screen.findByText(/Approved for Ada Learner/)).toBeVisible();
    expect(await screen.findByText("Nothing is waiting")).toBeVisible();
  });

  it("needs a reason to reject, and shows a refused approval's message without losing the queue", async () => {
    const client = {
      getAllowances: vi.fn(async () => allowances()),
      getPolicy: vi.fn(async () => ({ scopes: courseScopes })),
      approveExtension: vi.fn(async () => {
        throw new AdminError("stale_revision");
      }),
      rejectExtension: vi.fn(async () => ({})),
    } as unknown as AdminClient;
    render(
      <AllowancesView
        data={workspace(["policy.read", "policy.write"])}
        client={client}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    expect(
      await screen.findByText(/Refresh the latest revision/),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    const confirm = screen.getByRole("button", { name: "Reject this offer" });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Why you are rejecting it"),
      "Not needed",
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(client.rejectExtension).toHaveBeenCalledWith(
        offer.enrollmentId,
        offer.offerId,
        "Not needed",
        { expectedRevision: 7, idempotencyKey: expect.any(String) },
      ),
    );
  });

  it("reader roles see the queue without approval buttons; the full view lists accommodations and pool use", async () => {
    const client = {
      getAllowances: vi.fn(async (_id: string, view: string) =>
        view === "all"
          ? allowances({
              view: "all",
              offers: [{ ...offer, state: "granted" }],
              accommodations: [
                {
                  enrollmentId: offer.enrollmentId,
                  displayName: "Ada Learner",
                  accommodationId: "a1",
                  kind: "outage",
                  scopeId: "course",
                  adjustment: {},
                  batchId: "00000000-0000-4000-8000-0000000000dd",
                  authorizedAt: "2026-10-20T12:00:00.000Z",
                },
              ],
              pools: [
                {
                  poolId: "admin:study-time",
                  unit: "planned_minute",
                  learners: 2,
                  total: 240,
                  used: 30,
                  grants: 1,
                },
              ],
            })
          : allowances(),
      ),
      getPolicy: vi.fn(async () => ({ scopes: courseScopes })),
    } as unknown as AdminClient;
    render(
      <AllowancesView data={workspace(["policy.read"])} client={client} />,
    );
    expect(await screen.findByText("Ada Learner")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Adjust for several learners" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Everything" }));
    expect(await screen.findByText("Granted")).toBeVisible();
    expect(screen.getByText("(part of a group adjustment)")).toBeVisible();
    expect(
      screen.getByText(
        /30 of 240 planned minutes used across 2 learners \(1 grant\)/,
      ),
    ).toBeVisible();
  });

  it("previews a group outage for every active learner, lists refusals in plain words and applies with a reference", async () => {
    const client = {
      previewAccommodationBatch: vi.fn(async () => ({
        batchId: "00000000-0000-4000-8000-0000000000ee",
        previewDigest: "e".repeat(64),
        expiresAt: "2026-10-21T12:00:00.000Z",
        courseId,
        kind: "outage",
        scopeId: "course",
        change: { deadline: { kind: "window", calendarDays: 2 } },
        enrollments: [
          {
            enrollmentId: offer.enrollmentId,
            displayName: "Ada Learner",
            effectiveDeadlineBefore: "2026-11-01T00:00:00.000Z",
            effectiveDeadlineAfter: "2026-11-03T00:00:00.000Z",
            bindingAfter: { scopeId: "course", level: "course" },
          },
        ],
        refused: [
          {
            enrollmentId: "00000000-0000-4000-8000-000000000002",
            displayName: "Ben Learner",
            code: "PARENT_CAP_CONFLICT",
          },
        ],
      })),
      applyAccommodationBatch: vi.fn(async () => ({
        batchId: "00000000-0000-4000-8000-0000000000ee",
        applied: 1,
        replayed: false,
        outcome: "applied",
      })),
    } as unknown as AdminClient;
    const onApplied = vi.fn();
    render(
      <BatchAdjustDialog
        client={client}
        courseId={courseId}
        enrollments={workspace([]).enrollments}
        scopes={courseScopes}
        onClose={vi.fn()}
        onApplied={onApplied}
      />,
    );
    // Only course, chapter and episode levels are offered.
    expect(
      within(screen.getByLabelText("Where"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Sorting basics"]);
    const days = screen.getByLabelText("Extra calendar days");
    await userEvent.clear(days);
    await userEvent.type(days, "2");
    await userEvent.click(
      screen.getByRole("button", { name: "Show the effect on each learner" }),
    );
    expect(await screen.findByText("1 learner would change")).toBeVisible();
    expect(
      screen.getByText(/a stricter limit above this level would still apply/),
    ).toBeVisible();
    expect(
      vi.mocked(client.previewAccommodationBatch!).mock.calls[0]![1],
    ).toEqual({
      scopeId: "course",
      kind: "outage",
      change: { deadline: { kind: "window", calendarDays: 2 } },
    });
    const apply = screen.getByRole("button", { name: "Apply to 1 learner" });
    expect(apply).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Reference for this decision"),
      "Incident 42",
    );
    await userEvent.click(apply);
    await waitFor(() =>
      expect(client.applyAccommodationBatch).toHaveBeenCalledWith(courseId, {
        batchId: "00000000-0000-4000-8000-0000000000ee",
        previewDigest: "e".repeat(64),
        reason: "Incident 42",
      }),
    );
    expect(onApplied).toHaveBeenCalled();
  });

  it("chooses specific learners and cannot preview with none chosen", async () => {
    const client = {
      previewAccommodationBatch: vi.fn(),
    } as unknown as AdminClient;
    render(
      <BatchAdjustDialog
        client={client}
        courseId={courseId}
        enrollments={workspace([]).enrollments}
        scopes={courseScopes}
        onClose={vi.fn()}
        onApplied={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByLabelText("Only the learners I choose"));
    const preview = screen.getByRole("button", {
      name: "Show the effect on each learner",
    });
    expect(preview).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Ben Learner"));
    expect(preview).toBeEnabled();
  });
});

describe("per-learner policy (G03, G05)", () => {
  const policy = {
    enrollmentId: offer.enrollmentId,
    status: "active",
    revision: 3,
    scopes: courseScopes,
  } as unknown as LearningPolicy;
  it("names the level that sets a date, including levels without a title", () => {
    render(
      <ScopeDetails
        scope={
          {
            ...courseScopes[0]!,
            window: undefined,
            mode: "bounded",
            policyId: "course@1",
            work: {},
          } as ScopePolicy
        }
        policy={policy}
        constraint={{
          enrollmentId: offer.enrollmentId,
          scopeId: "course",
          policyRevision: 1,
          ledgerRevision: 0,
          ancestorScopeIds: ["organization", "course"],
          effectiveDeadline: "2026-10-30T00:00:00.000Z",
          deadlines: [
            {
              scopeId: "organization",
              kind: "window",
              at: "2026-10-30T00:00:00.000Z",
            },
          ],
          bindingDeadlines: [
            {
              scopeId: "organization",
              kind: "window",
              at: "2026-10-30T00:00:00.000Z",
            },
          ],
          quotas: [],
          existingMaterialAccess: "read_only",
          binding: {
            deadline: {
              scopeId: "organization",
              level: "organization",
              kind: "window",
              at: "2026-10-30T00:00:00.000Z",
            },
            quotas: [
              {
                metric: "additionalMinutes",
                conceptId: null,
                scopeId: "enrollment",
                level: "enrollment",
                limit: 60,
                remaining: 20,
              },
            ],
          },
        }}
      />,
    );
    expect(
      screen.getByText(/What sets this date: Organization \(Organization\)/),
    ).toBeVisible();
    expect(
      screen.getByText(
        /Additional planned minutes: limited by This learner's own terms .* 20 of 60 left/,
      ),
    ).toBeVisible();
  });
  it("offers an outage adjustment that moves a deadline only", async () => {
    render(
      <AccommodationEditor
        client={{} as AdminClient}
        policy={policy}
        scopeId="course"
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Extra planned minutes/)).toBeVisible();
    await userEvent.click(screen.getByLabelText(/Outage adjustment/));
    expect(screen.queryByLabelText(/Extra planned minutes/)).toBeNull();
    expect(screen.getByLabelText("Extra calendar days")).toBeVisible();
  });
});
