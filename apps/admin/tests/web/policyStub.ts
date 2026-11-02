import type { BrowserContext, Page } from "@playwright/test";
import { mockConnectedAdmin } from "./connectedAdmin";
import {
  DEMO_WORKSPACE_ID,
  demoSession,
  demoWorkspace,
} from "../../src/data/fixtures";
import { demoLearningPolicy } from "../../src/data/policyFixtures";
import type {
  LearningPolicy,
  Quota,
  ScopePolicy,
} from "../../src/domain/policy";
import type { AssessmentAttempts } from "../../src/domain/assessmentAttempts";
import type {
  PolicySettings,
  PolicySettingsView,
} from "../../src/domain/policyLedger";
import type {
  Allowances,
  Batches,
  CeilingsView,
  OrganizationCeilings,
} from "../../src/domain/policyLevels";

/**
 * The connected admin host with a course the size of a real one on the Policy & extensions and
 * Extensions & accommodations pages: 10 chapters and 56 episodes (71 levels with the demo levels,
 * organization and the learner's own terms), 56 core objectives, 56 graded checks and 58 work
 * limits (planned minutes, episodes and one practice-round limit per concept). Everything else
 * is the public demo data. All names are fictional.
 */
const COURSE = "sorting";
const CHAPTERS = 10;
const EPISODES = 56;
const END = "2027-01-29T14:04:00Z";

const pad = (n: number) => String(n).padStart(2, "0");
const conceptId = (i: number) =>
  `c${pad(Math.floor(i / 6) + 1)}-${pad((i % 6) + 1)}`;

function enlarge(base: LearningPolicy): LearningPolicy {
  const policy = structuredClone(base);
  const extra: ScopePolicy[] = [
    {
      scopeId: "organization",
      label: null,
      parentScopeId: null,
      policyId: "organization@1",
      kind: "organization",
      mode: "open_ended",
      work: {},
      existingMaterialAccess: "read_only",
    },
    {
      scopeId: "enrollment",
      label: null,
      parentScopeId: "course",
      policyId: "enrollment@1",
      kind: "enrollment",
      mode: "bounded",
      work: {},
      existingMaterialAccess: "read_only",
    },
  ];
  for (let c = 1; c <= CHAPTERS; c++) {
    extra.push({
      scopeId: `chapter:extra-${c}`,
      label: `Chapter ${c} · Working with vectors, matrices and tensor shapes`,
      parentScopeId: "course",
      policyId: `chapter-${c}@1`,
      kind: "chapter",
      mode: "open_ended",
      work: {},
      existingMaterialAccess: "read_only",
    });
  }
  for (let e = 0; e < EPISODES - 2; e++) {
    extra.push({
      scopeId: `episode:extra-${e + 1}`,
      label: `Episode ${e + 1} · Strides, views, broadcasting and aliasing`,
      parentScopeId: `chapter:extra-${(e % CHAPTERS) + 1}`,
      policyId: `episode-${e + 1}@1`,
      kind: "episode",
      mode: "open_ended",
      work: {},
      existingMaterialAccess: "read_only",
    });
  }
  const [course, ...rest] = policy.scopes;
  policy.scopes = [course!, extra[0]!, extra[1]!, ...rest, ...extra.slice(2)];
  const conceptQuotas: Quota[] = Array.from({ length: EPISODES }, (_, i) => ({
    scopeId: "course",
    metric: "remediationCyclesPerConcept",
    conceptId: conceptId(i),
    limit: 3,
    consumed: i === 4 ? 3 : 0,
    reserved: 0,
    remaining: i === 4 ? 0 : 3,
  }));
  const constraintFor = (scopeId: string) => {
    const own = base.constraints.find((c) => c.scopeId === scopeId);
    const quotas = [
      ...(own?.quotas.filter((q) => q.conceptId === null) ?? [
        {
          scopeId: "course",
          metric: "additionalMinutes" as const,
          conceptId: null,
          limit: 240,
          consumed: 10,
          reserved: 5,
          remaining: 225,
        },
        {
          scopeId: "course",
          metric: "additionalEpisodes" as const,
          conceptId: null,
          limit: 8,
          consumed: 0,
          reserved: 0,
          remaining: 8,
        },
      ]),
      ...conceptQuotas,
    ];
    const deadlines = own?.deadlines ?? [
      { scopeId: "course", kind: "absolute" as const, at: END },
    ];
    const effectiveDeadline = own?.effectiveDeadline ?? END;
    return {
      enrollmentId: policy.enrollmentId,
      scopeId,
      policyRevision: policy.policyRevision,
      ledgerRevision: policy.ledgerRevision,
      ancestorScopeIds: own?.ancestorScopeIds ?? ["course", scopeId],
      effectiveDeadline,
      deadlines,
      bindingDeadlines: deadlines.filter((d) => d.at === effectiveDeadline),
      quotas,
      existingMaterialAccess: "read_only" as const,
      binding: {
        deadline: {
          scopeId: "course",
          level: "course",
          kind: "absolute" as const,
          at: effectiveDeadline,
        },
        quotas: quotas.map((q) => ({
          metric: q.metric,
          conceptId: q.conceptId,
          scopeId: q.scopeId,
          level: "course",
          limit: q.limit,
          remaining: q.remaining,
        })),
      },
    };
  };
  policy.constraints = policy.scopes.map((s) => constraintFor(s.scopeId));
  policy.coverage = {
    denominator: EPISODES,
    coveredCoreObjectives: 0,
    personalExtras: {
      committed: { count: 0, additionalMinutes: 0, additionalEpisodes: 0 },
      reserved: { count: 0, additionalMinutes: 0, additionalEpisodes: 0 },
    },
    headroom: [],
  };
  policy.afterClosure = { questionBudget: 20 };
  return policy;
}

function attemptsFor(enrollmentId: string): AssessmentAttempts {
  return {
    enrollmentId,
    revision: 1,
    policy: { maxGradedAttemptsPerCheck: 3, retryCooldownMinutes: 0 },
    checks: Array.from({ length: EPISODES }, (_, i) => ({
      checkId: `gate:extra-${i + 1}`,
      title: `Check ${i + 1} · Dot products, matrix multiplication and reductions`,
      limit: 3,
      used: i === 9 ? 3 : i % 3,
      granted: 0,
      retryAt: null,
    })),
  };
}

const settings: PolicySettings = {
  timeZone: "UTC",
  disambiguation: "compatible",
  hardDeadlineDisambiguation: "reject",
  extensions: {
    approval: "learner_and_admin",
    offerCooldownHours: 24,
    maxOutstandingOffersPerScope: 1,
    maxOffersPerScope: 9,
    ultimateDeadline: null,
  },
  extensionPools: [
    {
      id: "chapter-days",
      unit: "calendar_day",
      appliesTo: "every_chapter",
      sharing: "per_scope",
      total: 5,
      maxPerGrant: 2,
      maxGrants: 2,
    },
  ],
  headroom: {
    core: { additionalMinutes: 60, additionalEpisodes: 0 },
    finalAssessment: { additionalMinutes: 30, additionalEpisodes: 0 },
  },
  closedQuestionBudget: 20,
  pacing: {
    minutesPerRequiredEpisode: null,
    finalAssessmentMinutes: null,
    studyMinutesPerDay: null,
  },
  assessment: { maxGradedAttemptsPerCheck: 3, retryCooldownMinutes: 0 },
};
const settingsView: PolicySettingsView = {
  courseId: COURSE,
  source: "configured",
  revision: 3,
  changedAt: "2026-10-30T09:00:00Z",
  settings,
  defaults: settings,
  releaseId: null,
  appliesTo: "new_enrollments",
  preview: {
    settings,
    feasibility: {
      feasible: true,
      issues: [
        {
          severity: "warning",
          code: "TIME_FIT_UNCHECKED",
          scopeId: "course",
          message: "No study pace is declared, so only deadlines were checked.",
        },
      ],
      alternatives: [],
      masteryCriteria: "unchanged",
    },
    calendar: [],
  },
};
const ceilings: OrganizationCeilings = {
  hardDeadline: null,
  maxEnrollmentDays: null,
  timeZone: "UTC",
  work: {
    additionalMinutes: null,
    additionalEpisodes: null,
    remediationCyclesPerConcept: null,
  },
  extensionsAllowed: true,
  existingMaterialAccess: "read_only",
};
const ceilingsView: CeilingsView = {
  workspaceId: DEMO_WORKSPACE_ID,
  source: "default",
  revision: 0,
  changedAt: null,
  ceilings,
  defaults: ceilings,
  preview: null,
  impact: [],
  moreCourses: false,
  appliesTo: "new_enrollments",
};
const allowances = (view: "pending" | "all"): Allowances => ({
  courseId: COURSE,
  view,
  offers: [],
  accommodations: [],
  pools: [
    {
      poolId: "course:calendar",
      unit: "calendar_day",
      learners: 1,
      total: 30,
      used: 0,
      grants: 0,
    },
  ],
});
const batches: Batches = { courseId: COURSE, batches: [] };

export async function mockLargePolicy(
  page: Page,
  context: BrowserContext,
  options: { locale?: "en" | "he" } = {},
) {
  await mockConnectedAdmin(page, context);
  const session = demoSession("administrator");
  const workspace = demoWorkspace(session.courses[0]!, "administrator");
  const enrollment = workspace.enrollments.find((e) => e.status === "active")!;
  const policy = enlarge(demoLearningPolicy(enrollment));
  const attempts = attemptsFor(enrollment.id);
  const locale = options.locale ?? "en";
  await page.route("**/api/me/locale", (route) =>
    route.fulfill({
      json: { preference: locale, locale, source: "user" },
    }),
  );
  await page.route("**/api/admin/enrollments/*/policy", (route) =>
    route.fulfill({
      json: {
        ...policy,
        enrollmentId: decodeURIComponent(
          new URL(route.request().url()).pathname.split("/").at(-2)!,
        ),
      },
    }),
  );
  await page.route("**/api/admin/enrollments/*/assessment-attempts", (route) =>
    route.fulfill({ json: attempts }),
  );
  await page.route(`**/api/admin/courses/${COURSE}/policy-settings`, (route) =>
    route.fulfill({ json: settingsView }),
  );
  await page.route("**/api/admin/workspaces/*/policy-ceilings", (route) =>
    route.fulfill({ json: ceilingsView }),
  );
  await page.route(
    (url) => url.pathname.endsWith(`/courses/${COURSE}/allowances`),
    (route) =>
      route.fulfill({
        json: allowances(
          new URL(route.request().url()).searchParams.get("view") === "all"
            ? "all"
            : "pending",
        ),
      }),
  );
  await page.route(
    `**/api/admin/courses/${COURSE}/accommodations/batches`,
    (route) => route.fulfill({ json: batches }),
  );
  return { policy, attempts };
}
