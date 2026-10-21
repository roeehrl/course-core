import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PolicySettingsCard } from "../src/components/PolicySettingsCard";
import { AssessmentAttemptsCard } from "../src/components/AssessmentPolicy";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { createDemoAdminClient } from "../src/client/demoClient";
import type { AdminClient } from "../src/domain/contracts";
import type { AssessmentAttempts } from "../src/domain/assessmentAttempts";
import { AdminError } from "../src/domain/errors";
import type {
  PolicySettings,
  PolicySettingsView,
} from "../src/domain/policyLedger";

const enrollmentId = "00000000-0000-4000-8000-000000000001";
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
const view = (over: Partial<PolicySettingsView> = {}): PolicySettingsView => ({
  courseId: "course-1",
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
const attempts = (
  over: Partial<AssessmentAttempts> = {},
): AssessmentAttempts => ({
  enrollmentId,
  revision: 7,
  policy: { maxGradedAttemptsPerCheck: 2, retryCooldownMinutes: 30 },
  checks: [
    {
      checkId: "gate:min",
      title: "Minimum",
      used: 2,
      limit: 2,
      granted: 0,
      retryAt: null,
    },
    {
      checkId: "gate:max",
      title: "Maximum",
      used: 1,
      limit: 2,
      granted: 0,
      retryAt: "2026-10-21T10:30:00Z",
    },
    {
      checkId: "gate:sum",
      title: "Sum",
      used: 0,
      limit: 2,
      granted: 0,
      retryAt: null,
    },
  ],
  ...over,
});

describe("assessment policy in course policy settings", () => {
  it("explains the limit and wait in plain words and previews the exact draft before saving", async () => {
    const client = {
      getPolicySettings: vi.fn(async () => view()),
      previewPolicySettings: vi.fn(async (_id: string, draft: PolicySettings) =>
        view({
          preview: {
            settings: draft,
            feasibility: {
              feasible: true,
              issues: [],
              alternatives: [],
              masteryCriteria: "unchanged",
            },
            calendar: [],
          },
        }),
      ),
      savePolicySettings: vi.fn(),
    } as unknown as AdminClient;
    render(<PolicySettingsCard client={client} courseId="course-1" canWrite />);
    expect(
      await screen.findByText(
        /as many graded attempts at each check as they need/,
      ),
    ).toBeVisible();
    await userEvent.type(
      screen.getByLabelText("Graded attempts per check"),
      "3",
    );
    await userEvent.clear(
      screen.getByLabelText(
        "Wait after an attempt that did not pass (minutes)",
      ),
    );
    await userEvent.type(
      screen.getByLabelText(
        "Wait after an attempt that did not pass (minutes)",
      ),
      "45",
    );
    expect(
      screen.getByText(
        /Learners get 3 graded attempts at each check\. After an attempt that does not pass, they wait 45 minutes/,
      ),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Preview feasibility and daylight saving",
      }),
    );
    expect(vi.mocked(client.previewPolicySettings!)).toHaveBeenCalledWith(
      "course-1",
      {
        ...settings,
        assessment: { maxGradedAttemptsPerCheck: 3, retryCooldownMinutes: 45 },
      },
    );
    // Emptying the limit means no limit again.
    await userEvent.clear(screen.getByLabelText("Graded attempts per check"));
    expect(
      screen.getByText(/as many graded attempts at each check as they need/),
    ).toBeVisible();
  });
});

describe("graded attempts for one learner", () => {
  it("shows use per check and allows one more attempt only with a reason", async () => {
    const granted = attempts({
      revision: 8,
      checks: attempts().checks.map((c) =>
        c.checkId === "gate:min" ? { ...c, limit: 3, granted: 1 } : c,
      ),
      receipt: { id: "e1", authority: "server", outcome: "granted" },
    });
    const client = {
      getAssessmentAttempts: vi.fn(async () => attempts()),
      grantAssessmentAttempt: vi.fn(async () => granted),
    } as unknown as AdminClient;
    const onGranted = vi.fn();
    render(
      <AssessmentAttemptsCard
        client={client}
        enrollmentId={enrollmentId}
        revision={7}
        canGrant
        onGranted={onGranted}
      />,
    );
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Minimum2 of 2No attempts left");
    expect(rows[2]).toHaveTextContent(/Maximum1 of 2Waiting until/);
    expect(rows[3]).toHaveTextContent("Sum0 of 2Available");
    // Only checks the learner cannot attempt now offer the action.
    expect(within(rows[3]!).queryByRole("button")).toBeNull();
    await userEvent.click(
      within(rows[1]!).getByRole("button", { name: "Allow one more attempt" }),
    );
    const confirm = screen.getByRole("button", { name: "Allow the attempt" });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason"), "Connection dropped");
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(onGranted).toHaveBeenCalledWith(
        "One more attempt allowed. The learner can start it now.",
      ),
    );
    expect(vi.mocked(client.grantAssessmentAttempt!)).toHaveBeenCalledWith(
      enrollmentId,
      { checkId: "gate:min", reason: "Connection dropped" },
      expect.objectContaining({ expectedRevision: 7 }),
    );
    expect(
      within(screen.getByRole("table")).getAllByRole("row")[1],
    ).toHaveTextContent("Minimum2 of 3 1 allowed by staffAvailable");
  });
  it("is read-only without the right to change policy, and says what to do on a refusal", async () => {
    const client = {
      getAssessmentAttempts: vi.fn(async () => attempts()),
      grantAssessmentAttempt: vi.fn(async () => {
        throw new AdminError("stale_revision");
      }),
    } as unknown as AdminClient;
    const { unmount } = render(
      <AssessmentAttemptsCard
        client={client}
        enrollmentId={enrollmentId}
        revision={7}
        canGrant={false}
        onGranted={vi.fn()}
      />,
    );
    await screen.findByRole("table");
    expect(
      screen.queryByRole("button", { name: "Allow one more attempt" }),
    ).toBeNull();
    unmount();
    render(
      <AssessmentAttemptsCard
        client={client}
        enrollmentId={enrollmentId}
        revision={7}
        canGrant
        onGranted={vi.fn()}
      />,
    );
    await userEvent.click(
      (
        await screen.findAllByRole("button", { name: "Allow one more attempt" })
      )[0]!,
    );
    await userEvent.type(screen.getByLabelText("Reason"), "Retry");
    await userEvent.click(
      screen.getByRole("button", { name: "Allow the attempt" }),
    );
    expect(await screen.findByRole("alert")).toBeVisible();
  });
});

describe("assessment attempt ports", () => {
  it("fetch client uses the documented admin routes", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify(attempts()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher as unknown as typeof fetch,
    });
    await client.getAssessmentAttempts!(enrollmentId);
    await client.grantAssessmentAttempt!(
      enrollmentId,
      { checkId: "gate:min", reason: "r" },
      { expectedRevision: 7, idempotencyKey: "key-12345678" },
    );
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(String(calls[0]![0])).toBe(
      `/api/admin/enrollments/${enrollmentId}/assessment-attempts`,
    );
    expect(String(calls[1]![0])).toBe(
      `/api/admin/enrollments/${enrollmentId}/assessment-attempts/grant`,
    );
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({
      checkId: "gate:min",
      reason: "r",
      expectedRevision: 7,
      idempotencyKey: "key-12345678",
    });
  });
  it("demo client keeps grants in memory, replays a repeated key and refuses a stale revision", async () => {
    const client = createDemoAdminClient({ latency: 0 });
    const session = await client.getSession();
    const course = await client.getCourse(session.courses[0]!.id);
    const id = course.enrollments[0]!.id;
    const before = await client.getAssessmentAttempts!(id);
    const apply = before.checks.find((c) => c.used === c.limit)!;
    const ctx = {
      expectedRevision: before.revision,
      idempotencyKey: "demo-key-1",
    };
    const after = await client.grantAssessmentAttempt!(
      id,
      { checkId: apply.checkId, reason: "Demo" },
      ctx,
    );
    expect(after.checks.find((c) => c.checkId === apply.checkId)).toMatchObject(
      { limit: apply.limit! + 1, granted: 1 },
    );
    expect(
      await client.grantAssessmentAttempt!(
        id,
        { checkId: apply.checkId, reason: "Demo" },
        ctx,
      ),
    ).toEqual(after);
    await expect(
      client.grantAssessmentAttempt!(
        id,
        { checkId: apply.checkId, reason: "Demo" },
        { expectedRevision: before.revision + 5, idempotencyKey: "demo-key-2" },
      ),
    ).rejects.toMatchObject({ code: "stale_revision" });
  });
});
