import type { BrowserContext, Page } from "@playwright/test";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";
import { readFileSync } from "node:fs";
import { mockConnectedAdmin } from "./connectedAdmin";

/**
 * The connected owner's workspace with pages at the size a real pilot reaches: a course with 56
 * learning objectives, a course update source, installed recovery generators, a long audit log
 * with staff, system, learner and agent events, and policy changes with long lists. Fictional
 * data only. Platform, integrations and billed costs come from the demo platform port, served as
 * the JSON the server would send.
 */
const minutesAgo = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 2, 12, 0) - minutes * 60_000).toISOString();
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const objectives = Array.from(
  { length: 56 },
  (_, i) =>
    `Objective ${i + 1}: explain and apply idea number ${i + 1} to a new example, with the reasoning written out.`,
);

const AUDIT_EVENTS = [
  {
    actorKind: "staff",
    actor: "Dana Levi",
    type: "provider.quality_check.finished",
    payload: {
      roles: [{ role: "companion", passed: true }],
      state: "passed",
      reason: null,
      checkId: uuid(9001),
      chargedMicroUsd: 49_528,
    },
  },
  {
    actorKind: "staff",
    actor: "Dana Levi",
    type: "provider.quality_check.started",
    payload: {
      roles: ["companion"],
      target: "active",
      checkId: uuid(9001),
      draftId: null,
      conversations: 18,
      estimatedMicroUsd: 236_250,
      reservedMicroUsd: 3_600_000,
    },
  },
  { actorKind: "learner", actor: null, type: "session.ended", payload: null },
  {
    actorKind: "agent",
    actor: null,
    type: "supervisor.applied",
    payload: null,
  },
  {
    actorKind: "staff",
    actor: "Dana Levi",
    type: "policy.settings_changed",
    payload: {
      courseId: uuid(10),
      revision: 4,
      reason: "Pilot cohort needs more time before the final checkpoint.",
      settings: { paceDays: 10 },
    },
  },
  {
    actorKind: "system",
    actor: null,
    type: "course_update.checked",
    payload: {
      result: "up_to_date",
      version: "1.2.0",
      trigger: "automatic",
      checkedAt: minutesAgo(400),
    },
  },
  {
    actorKind: "staff",
    actor: "Dana Levi",
    type: "people.role_changed",
    payload: { userId: uuid(77), from: "member", to: "author" },
  },
  {
    actorKind: "system",
    actor: null,
    type: "provider.quality_check.finished",
    payload: {
      roles: [{ role: "companion", passed: false }],
      state: "failed",
      reason: "PROVIDER_GUIDE_MODEL_UNAVAILABLE",
      reasonDetail: { status: 404, providerCode: "NOT_FOUND" },
      checkId: uuid(9002),
      chargedMicroUsd: 12_004,
    },
  },
  {
    actorKind: "learner",
    actor: null,
    type: "assessment.submitted",
    payload: null,
  },
  {
    actorKind: "agent",
    actor: null,
    type: "companion.context.excluded",
    payload: null,
  },
  {
    actorKind: "staff",
    actor: "Dana Levi",
    type: "course.published",
    payload: { releaseId: uuid(11), version: "1.2.0" },
  },
  {
    actorKind: "staff",
    actor: "Dana Levi",
    type: "provider.billed_statement_recorded",
    payload: {
      providerLabel: "Example AI",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      billedMicroUsd: 12_500_000,
    },
  },
] as const;

function auditPage(before: string | null) {
  const offset = before ? 1000 - Number(before) : 0;
  const events = Array.from({ length: 24 }, (_, index) => {
    const n = offset + index;
    const event = AUDIT_EVENTS[n % AUDIT_EVENTS.length]!;
    const withheld =
      event.actorKind === "learner" || event.actorKind === "agent";
    return {
      sequence: String(1000 - n),
      id: uuid(5000 + n),
      at: minutesAgo(n * 17),
      actorKind: event.actorKind,
      actor: event.actor,
      type: event.type,
      enrollmentId: event.actorKind === "learner" ? uuid(42) : null,
      payload: withheld ? null : event.payload,
      payloadWithheld: withheld,
    };
  });
  return {
    events,
    nextBefore: offset < 48 ? events.at(-1)!.sequence : null,
  };
}

const assessmentIds = Array.from(
  { length: 24 },
  (_, i) =>
    `fnd-a${String(Math.floor(i / 3) + 1).padStart(2, "0")}-0${(i % 3) + 1}-transfer`,
);
const policyHistory = {
  courseId: uuid(10),
  entries: [
    {
      source: "placement_settings",
      id: uuid(301),
      at: minutesAgo(60),
      actor: "Dana Levi",
      revision: 3,
      version: null,
      reason: "Ask only the transfer questions in placement.",
      changes: [
        {
          path: "placement.assessmentIds",
          before: null,
          after: JSON.stringify(assessmentIds).slice(0, 200),
        },
        {
          path: "placement.objectiveIds",
          before: JSON.stringify(["fnd-o01", "fnd-o02"]),
          after: JSON.stringify([
            "fnd-o01",
            "fnd-o02",
            "fnd-o03",
            "fnd-o04",
            "fnd-o05",
          ]),
        },
        { path: "placement.enabled", before: "false", after: "true" },
      ],
    },
    {
      source: "release_policy",
      id: uuid(302),
      at: minutesAgo(600),
      actor: "Dana Levi",
      revision: null,
      version: "1.2.0",
      reason: null,
      changes: [
        {
          path: "policy.window.pauseRule",
          before: null,
          after: '"approved_only"',
        },
        { path: "policy.window.calendarDays", before: "21", after: "28" },
        {
          path: "policy.work.remediationCyclesPerConcept",
          before: null,
          after: "3",
        },
        {
          path: "policy.window.anchorInstant",
          before: '"2026-09-01T00:00:00Z"',
          after: '"2026-10-01T00:00:00Z"',
        },
      ],
    },
  ],
  revisions: [],
};

const updates = {
  revision: 3,
  source: {
    kind: "github",
    url: "https://github.com/example/sorting-course",
  },
  settings: {
    level: "check",
    intervalHours: 24,
    autoApproveRegistry: false,
    acknowledgedBy: null,
    acknowledgedAt: null,
  },
  status: {
    lastCheckedAt: minutesAgo(400),
    lastTrigger: "automatic",
    lastResult: "up_to_date",
    lastErrorCode: null,
    availableVersion: null,
    nextCheckAt: minutesAgo(-1040),
    consecutiveFailures: 0,
  },
  newestInstalled: "1.2.0",
  directories: [{ id: "a".repeat(16), name: "packages" }],
  remoteFetch: "github",
  permissions: { configure: true, install: true, publish: true },
};

const overview = {
  catalogId: uuid(10),
  generatedAt: minutesAgo(1),
  release: {
    active: {
      id: uuid(11),
      version: "1.2.0",
      status: "published",
      digest: "abc",
      createdAt: minutesAgo(600),
    },
    counts: { draft: 1, published: 2, archived: 0 },
    pinnedLearners: [
      { releaseId: uuid(11), version: "1.2.0", learners: 3 },
      { releaseId: uuid(10), version: "1.1.0", learners: 1 },
    ],
    update: null,
  },
  lifecycle: { active: 3, paused: 0, completed: 1, closed: 0, erased: 0 },
  deadlineRisks: [
    {
      enrollmentId: uuid(12),
      learner: "Robin Example",
      deadline: minutesAgo(-2 * 24 * 60),
      daysLeft: 2,
      remainingEpisodes: 1,
    },
  ],
  contentDefects: {
    activeReleaseChecksFailing: [],
    evidenceInvalidatedLast30Days: 0,
  },
  supervisorHealth: {
    jobsByState: { queued: 2, budget_wait: 1, failed: 1 },
    failedLast24h: 1,
    oldestOpenJobAgeSeconds: 600,
  },
  approvalQueue: {
    writtenAnswers: 2,
    secondOpinions: 0,
    gateReviews: 1,
    generatedMedia: 0,
    releases: 0,
    providerRequests: 0,
  },
};

/** The connected owner (mockConnectedAdmin) plus the routes the workspace pages read. */
export async function mockWorkspacePages(page: Page, context: BrowserContext) {
  const state = await mockConnectedAdmin(page, context);
  // Generated once from the demo platform port (src/client/demoPlatform.ts): fictional data.
  const platform = JSON.parse(
    readFileSync(
      new URL("./workspacePagesPlatform.json", import.meta.url),
      "utf8",
    ),
  ) as Record<
    "readiness" | "integrations" | "billing" | "versionMoves",
    unknown
  >;
  // The course workspace with the full permission set an owner has and 56 objectives.
  await page.route("**/api/admin/courses/sorting", async (route, request) => {
    if (request.method() !== "GET") return route.fallback();
    const session = demoSession("administrator");
    const workspace = demoWorkspace(session.courses[0]!, "administrator");
    await route.fulfill({
      json: {
        ...workspace,
        role: "owner",
        course: { ...workspace.course, objectives },
        permissions: [
          ...new Set([
            ...workspace.permissions,
            "audit.read",
            "audit.export",
            "policy.read",
            "provider.configure",
          ]),
        ],
      },
    });
  });
  await page.route("**/api/admin/courses/sorting/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/admin/courses/sorting/updates", (route) =>
    route.fulfill({ json: updates }),
  );
  await page.route("**/api/admin/courses/sorting/version-moves", (route) =>
    route.fulfill({ json: platform.versionMoves }),
  );
  await page.route("**/api/admin/courses/sorting/policy-history", (route) =>
    route.fulfill({ json: policyHistory }),
  );
  await page.route("**/api/admin/runtime/adaptation-adapters", (route) =>
    route.fulfill({
      json: {
        adapters: [
          {
            id: "course-numeric-creator",
            kind: "numeric",
            implementationDigest: "c".repeat(64),
            authorization: "release_registry_approval_required",
          },
          {
            id: "course-bank-creator",
            kind: "bank",
            implementationDigest: "d".repeat(64),
            authorization: "release_registry_approval_required",
          },
        ],
      },
    }),
  );
  await page.route("**/api/admin/releases/*/adaptation-registry", (route) =>
    route.fulfill({
      json: {
        registryRevision: 2,
        configured: true,
        configurationDigest: null,
      },
    }),
  );
  await page.route(/\/api\/admin\/workspaces\/[^/]+\/audit\?/, (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    return route.fulfill({ json: auditPage(before) });
  });
  await page.route(
    "**/api/admin/workspaces/*/platform-readiness",
    async (route) => route.fulfill({ json: platform.readiness }),
  );
  await page.route("**/api/admin/workspaces/*/integrations", async (route) =>
    route.fulfill({ json: platform.integrations }),
  );
  await page.route(
    "**/api/admin/workspaces/*/billing-statements",
    async (route) => route.fulfill({ json: platform.billing }),
  );
  return state;
}
