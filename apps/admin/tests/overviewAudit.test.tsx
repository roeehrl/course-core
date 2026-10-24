import { render, screen } from "@testing-library/react";
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
