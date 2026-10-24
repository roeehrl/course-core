import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { AuditView } from "../src/views/AuditView";
import { OverviewError, overviewErrorMessage } from "../src/domain/overview";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import type { CourseOverview } from "../src/domain/overview";
import { OverviewView } from "../src/views/OverviewView";
import { stripBidiControls } from "@course-core/i18n";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

const workspace = (permissions: string[]) =>
  ({
    course: { id: "c1", workspaceId: "00000000-0000-4000-8000-000000000001" },
    permissions,
  }) as unknown as CourseWorkspace;

describe("audit log", () => {
  it("builds the paged, filtered query and maps refusals", async () => {
    const urls: string[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url) => {
        urls.push(String(url));
        return urls.length === 1
          ? new Response(JSON.stringify({ events: [], nextBefore: null }), {
              status: 200,
            })
          : new Response(JSON.stringify({ error: "FORBIDDEN" }), {
              status: 403,
            });
      },
    });
    await client.audit!.list("ws-1", {
      before: "42",
      actorKind: "staff",
      limit: 20,
    });
    expect(urls[0]).toBe(
      "/api/admin/workspaces/ws-1/audit?before=42&actorKind=staff&limit=20",
    );
    const refused = await client.audit!.list("ws-1", {}).catch((e) => e);
    expect(refused).toBeInstanceOf(OverviewError);
    expect(overviewErrorMessage(refused)).toMatch(/support observer/);
  });

  it("shows staff details and withholds learner details", async () => {
    const list = vi.fn(async () => ({
      nextBefore: null,
      events: [
        {
          sequence: "2",
          id: "00000000-0000-4000-8000-000000000002",
          at: "2026-10-15T00:00:00.000Z",
          actorKind: "staff" as const,
          actor: "Owner",
          type: "course.published",
          enrollmentId: null,
          payload: { releaseId: "r1" },
          payloadWithheld: false,
        },
        {
          sequence: "1",
          id: "00000000-0000-4000-8000-000000000003",
          at: "2026-10-15T00:00:00.000Z",
          actorKind: "learner" as const,
          actor: null,
          type: "assessment.submitted",
          enrollmentId: "00000000-0000-4000-8000-000000000004",
          payload: null,
          payloadWithheld: true,
        },
      ],
    }));
    render(
      <AuditView
        data={workspace(["audit.read"])}
        client={{ audit: { list } } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText('{"releaseId":"r1"}')).toBeVisible();
    expect(screen.getByText("Details withheld · learner record")).toBeVisible();
  });

  it("explains when the role cannot read the log", () => {
    render(
      <AuditView
        data={workspace(["course.read"])}
        client={{ audit: { list: vi.fn() } } as unknown as AdminClient}
      />,
    );
    expect(screen.getByText(/cannot read the audit log/)).toBeVisible();
  });
});

const overview: CourseOverview = {
  catalogId: "00000000-0000-4000-8000-000000000010",
  generatedAt: "2026-10-15T00:00:00.000Z",
  release: {
    active: {
      id: "00000000-0000-4000-8000-000000000011",
      version: "1.2.0",
      status: "published",
      digest: "abc",
      createdAt: "2026-10-01T09:00:00.000Z",
    },
    counts: { draft: 1, published: 2, archived: 0 },
    pinnedLearners: [],
    update: null,
  },
  lifecycle: { active: 3, paused: 0, completed: 1, closed: 0, erased: 0 },
  deadlineRisks: [
    {
      enrollmentId: "00000000-0000-4000-8000-000000000012",
      learner: "Robin Example",
      deadline: "2026-10-18T00:00:00.000Z",
      daysLeft: 2,
      remainingEpisodes: 1,
    },
  ],
  contentDefects: {
    activeReleaseChecksFailing: [],
    evidenceInvalidatedLast30Days: 1,
  },
  supervisorHealth: {
    jobsByState: { budget_wait: 1 },
    failedLast24h: 0,
    oldestOpenJobAgeSeconds: 120,
    uncheckedCallsLast7Days: 2,
  },
  approvalQueue: {
    writtenAnswers: 1,
    secondOpinions: 0,
    gateReviews: 0,
    generatedMedia: 0,
    releases: 0,
    providerRequests: 0,
  },
};
const overviewClient = {
  overview: { load: vi.fn(async () => overview) },
} as unknown as AdminClient;
const text = () => stripBidiControls(document.body.textContent ?? "");

describe("course overview", () => {
  it("counts with plurals in English", async () => {
    render(<OverviewView data={workspace([])} client={overviewClient} />);
    expect(await screen.findByText("Approval queue")).toBeVisible();
    expect(text()).toContain("Robin Example · 1 lesson left · due");
    expect(text()).toContain("1 evidence record invalidated in 30 days");
    expect(text()).toContain("oldest open job 2 minutes old");
    expect(screen.getByText("budget wait")).toBeVisible();
    // AI calls that ran with an unchecked setup are named, not hidden (B08).
    expect(
      screen.getByText("AI ran with a setup nobody checked"),
    ).toBeVisible();
    expect(text()).toContain(
      "2 AI calls in the last 7 days used a setup with no passing quality check",
    );
  });

  it("renders in Hebrew with Hebrew plurals and translated states", async () => {
    render(
      <I18nProvider value={createAdminTranslator("he")}>
        <OverviewView data={workspace([])} client={overviewClient} />
      </I18nProvider>,
    );
    expect(await screen.findByText("תור האישורים")).toBeVisible();
    expect(text()).toContain("Robin Example · נשאר שיעור אחד · מועד אחרון");
    expect(screen.getByText("יומיים")).toBeVisible();
    expect(screen.getByText("ממתינות לתקציב")).toBeVisible();
    expect(text()).toContain("שתי קריאות AI ב-7 הימים האחרונים");
    expect(screen.getByText("פעיל")).toBeVisible();
    expect(screen.getByText("1.2.0")).toHaveAttribute("dir", "ltr");
  });
});

describe("AI jobs that need a check, on the course overview", () => {
  const en = createAdminTranslator("en");
  const evals = {
    suite: {
      id: "core-public",
      version: "2",
      digest: "f".repeat(64),
      dialogues: 18,
      coverage: [],
    },
    providerRevision: 2,
    gatedAtActivation: true,
    roles: [
      {
        role: "supervisor",
        strategy: "core.supervisor.tool-loop",
        revisionDigest: "a".repeat(64),
        covered: true,
        status: "stale",
        grandfathered: true,
        activatedBy: "unchanged",
      },
      {
        role: "companion",
        strategy: "core.companion.tutor",
        revisionDigest: "b".repeat(64),
        covered: true,
        status: "passed",
        grandfathered: false,
        activatedBy: "passed",
      },
    ],
    results: [],
    overrides: [],
  };
  const quality = {
    target: "active",
    draftId: null,
    roles: [],
    conversations: 2,
    estimateMicroUsd: 42000,
    reserveMicroUsd: 200000,
    blocked: null,
    latest: null,
    activeRoles: [
      {
        role: "supervisor",
        remoteModel: "m",
        conversations: 2,
        priced: true,
        estimateMicroUsd: 42000,
        reserveMicroUsd: 200000,
        blocked: null,
      },
    ],
  };
  const aiClient = (aiServices: object) =>
    ({
      mode: "connected",
      overview: overviewClient.overview,
      aiServices,
    }) as unknown as AdminClient;

  it("flags each unchecked job that is on, runs the check for that job only, and links to AI services", async () => {
    const started = {
      id: "00000000-0000-4000-8000-0000000000c1",
      target: "active",
      draftId: null,
      state: "running",
      reason: null,
      roles: ["supervisor"],
      total: 2,
      completed: 0,
      estimateMicroUsd: 42000,
      reservedMicroUsd: 200000,
      chargedMicroUsd: null,
      outcome: [],
      createdAt: null,
      finishedAt: null,
      deadlineAt: null,
    };
    const port = {
      evals: vi.fn(async () => evals),
      qualityStatus: vi.fn(async () => quality),
      startQualityCheck: vi.fn(async () => started),
      qualityCheck: vi.fn(async () => started),
    };
    const open = vi.fn();
    render(
      <OverviewView
        data={workspace(["provider.configure"])}
        client={aiClient(port)}
        onOpenAiServices={open}
      />,
    );
    const card = await screen.findByTestId("overview-ai-checks");
    expect(
      within(card).getByText(en.t("overviewView.aiChecks.body", { count: 1 })),
    ).toBeVisible();
    // Only the job that needs a check is flagged; the checked one is not.
    expect(within(card).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(card).getByText(en.t("aiServices.check.flag.needsCheck")),
    ).toBeVisible();
    fireEvent.click(
      within(card).getByRole("button", {
        name: en.t("aiServices.check.flag.runFor", {
          job: en.t("aiServices.role.supervisor.name"),
        }),
      }),
    );
    expect(port.startQualityCheck).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      {
        target: "active",
        role: "supervisor",
        idempotencyKey: expect.stringMatching(/^ai-services:/),
      },
    );
    expect(await within(card).findByRole("progressbar")).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole("button", {
        name: en.t("overviewView.aiChecks.open"),
      }),
    );
    expect(open).toHaveBeenCalled();
  });

  it("shows nothing to people who can't set up AI services, when nothing needs a check, or when the status can't be read", async () => {
    const port = {
      evals: vi.fn(async () => evals),
      qualityStatus: vi.fn(async () => quality),
    };
    const { unmount } = render(
      <OverviewView data={workspace([])} client={aiClient(port)} />,
    );
    expect(await screen.findByText("Approval queue")).toBeVisible();
    expect(screen.queryByTestId("overview-ai-checks")).toBeNull();
    expect(port.evals).not.toHaveBeenCalled();
    unmount();
    const passed = {
      ...evals,
      roles: evals.roles.map((r) => ({ ...r, status: "passed" })),
    };
    const quiet = {
      evals: vi.fn(async () => passed),
      qualityStatus: vi.fn(async () => quality),
    };
    const second = render(
      <OverviewView
        data={workspace(["provider.configure"])}
        client={aiClient(quiet)}
      />,
    );
    expect(await screen.findByText("Approval queue")).toBeVisible();
    await vi.waitFor(() => expect(quiet.qualityStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("overview-ai-checks")).toBeNull();
    second.unmount();
    const refused = {
      evals: vi.fn(async () => Promise.reject(new Error("FORBIDDEN"))),
      qualityStatus: vi.fn(),
    };
    render(
      <OverviewView
        data={workspace(["provider.configure"])}
        client={aiClient(refused)}
      />,
    );
    expect(await screen.findByText("Approval queue")).toBeVisible();
    expect(screen.queryByTestId("overview-ai-checks")).toBeNull();
  });

  it("flags the job in Hebrew", async () => {
    const he = createAdminTranslator("he");
    const port = {
      evals: vi.fn(async () => evals),
      qualityStatus: vi.fn(async () => quality),
    };
    render(
      <I18nProvider value={he}>
        <OverviewView
          data={workspace(["provider.configure"])}
          client={aiClient(port)}
        />
      </I18nProvider>,
    );
    const card = await screen.findByTestId("overview-ai-checks");
    expect(
      within(card).getByText(he.t("aiServices.check.flag.needsCheck")),
    ).toBeVisible();
    expect(
      within(card).getByRole("button", {
        name: he.t("aiServices.check.flag.runFor", {
          job: he.t("aiServices.role.supervisor.name"),
        }),
      }),
    ).toBeVisible();
  });
});

describe("audit log in Hebrew", () => {
  it("translates the table, actor kinds and refusals", async () => {
    const he = createAdminTranslator("he");
    const list = vi.fn(async () => ({
      nextBefore: null,
      events: [
        {
          sequence: "1",
          id: "00000000-0000-4000-8000-000000000003",
          at: "2026-10-15T00:00:00.000Z",
          actorKind: "learner" as const,
          actor: null,
          type: "assessment.submitted",
          enrollmentId: "00000000-0000-4000-8000-000000000004",
          payload: null,
          payloadWithheld: true,
        },
      ],
    }));
    render(
      <I18nProvider value={he}>
        <AuditView
          data={workspace(["audit.read"])}
          client={{ audit: { list } } as unknown as AdminClient}
        />
      </I18nProvider>,
    );
    expect(
      await screen.findByText("הפרטים מוסתרים · תיעוד של לומד/ת"),
    ).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "מי" })).toBeVisible();
    expect(screen.getByText("assessment.submitted")).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(overviewErrorMessage(new OverviewError("FORBIDDEN"), he.t)).toMatch(
      /צופי תמיכה/,
    );
  });
});
