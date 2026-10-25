import { readFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { accent } from "@course-core/i18n";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";
import { openSection, workspaceNav } from "../workspaceNav";

/** Hebrew catalogs, read as data so the checks follow the translations. */
const he = (namespace: string) => {
  const messages = JSON.parse(
    readFileSync(
      new URL(`../../src/i18n/messages/he/${namespace}.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, string>;
  return (key: string) => {
    const message = messages[key];
    if (message === undefined) throw new Error(`No Hebrew ${namespace}.${key}`);
    return message;
  };
};
const nav = he("adminApp");
const enNav = JSON.parse(
  readFileSync(
    new URL("../../src/i18n/messages/en/adminApp.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>;
/** A navigation button by its accessible name under en-XA (accented English), not its position. */
const pseudoNav = async (page: Page, name: string) =>
  (await workspaceNav(page)).getByRole("button", {
    name: accent(enNav[`nav.${name}`] ?? name),
  });

const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000aa";
const session = demoSession("administrator");
const base = demoWorkspace(session.courses[0]!, "administrator");
const workspace = {
  ...base,
  role: "admin",
  course: { ...base.course, workspaceId: WORKSPACE_ID },
  permissions: [...base.permissions, "audit.read"],
};
const learner = workspace.enrollments[0]!;

const overview = {
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
    pinnedLearners: [
      {
        releaseId: "00000000-0000-4000-8000-000000000011",
        version: "1.2.0",
        learners: 3,
      },
    ],
    update: {
      availableVersion: "1.3.0",
      lastResult: "available",
      lastCheckedAt: "2026-10-14T00:00:00.000Z",
      level: "minor",
    },
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
    activeReleaseChecksFailing: [
      { label: "Bundle shape", detail: "A synthetic failing check." },
    ],
    evidenceInvalidatedLast30Days: 2,
  },
  supervisorHealth: {
    jobsByState: { queued: 2, budget_wait: 1, failed: 1 },
    failedLast24h: 1,
    oldestOpenJobAgeSeconds: 600,
  },
  approvalQueue: {
    writtenAnswers: 1,
    secondOpinions: 0,
    gateReviews: 2,
    generatedMedia: 0,
    releases: 0,
    providerRequests: 0,
  },
};
const audit = {
  nextBefore: "1",
  events: [
    {
      sequence: "2",
      id: "00000000-0000-4000-8000-000000000002",
      at: "2026-10-15T00:00:00.000Z",
      actorKind: "staff",
      actor: "Owner Example",
      type: "course.published",
      enrollmentId: null,
      payload: { releaseId: "r1" },
      payloadWithheld: false,
    },
    {
      sequence: "1",
      id: "00000000-0000-4000-8000-000000000003",
      at: "2026-10-15T00:00:00.000Z",
      actorKind: "learner",
      actor: null,
      type: "assessment.submitted",
      enrollmentId: "00000000-0000-4000-8000-000000000004",
      payload: null,
      payloadWithheld: true,
    },
  ],
};
const sectionList = {
  release: { id: "r1", version: "2.0.0" },
  sections: [{ id: "glaze-lab", version: "1.0.0", title: "Glaze lab" }],
  chapters: [{ id: "ch1", title: "Firing" }],
};
const settingBase = {
  scope: "course",
  mutationPermission: "course.settings.write",
  description: null,
  discardedSavedValue: false,
  canEdit: true,
};
const section = {
  id: "glaze-lab",
  version: "1.0.0",
  title: "Glaze lab",
  description: "Kiln practice settings.",
  learnerDataAccess: "scoped_with_consent",
  learnerDataShared: false,
  renderer: {
    kind: "core_schema_form",
    declaredRendererRef: "glaze-panel",
    declaredRendererLoaded: false,
  },
  scopes: ["course", "chapter"],
  scope: "course",
  scopeRef: "",
  revision: 2,
  savedForVersion: "1.0.0",
  updatedAt: "2026-10-01T10:00:00.000Z",
  settings: [
    {
      ...settingBase,
      id: "cone",
      label: "Kiln cone",
      type: "integer",
      default: 6,
      minimum: 1,
      maximum: 10,
      value: 6,
      source: "saved",
    },
    {
      ...settingBase,
      id: "finish",
      label: "Finish",
      type: "enum",
      default: "matte",
      options: ["matte", "gloss"],
      value: "matte",
      source: "default",
    },
    {
      ...settingBase,
      id: "kiln",
      label: "Use the kiln",
      type: "boolean",
      default: true,
      value: true,
      source: "default",
      discardedSavedValue: true,
    },
  ],
};
const supervision = {
  control: {
    state: "paused",
    revision: 3,
    reasonCode: "staff_review",
    changedBy: null,
    changedAt: "2026-10-14T08:00:00.000Z",
  },
  jobs: [
    {
      id: "00000000-0000-4000-8000-000000000021",
      role: "companion",
      state: "budget_wait",
      reason: null,
      held: true,
      cancellationRequested: false,
      createdAt: "2026-10-14T07:00:00.000Z",
    },
  ],
  pendingSignals: 2,
  undeliveredEvents: [
    {
      eventId: "00000000-0000-4000-8000-000000000022",
      eventType: "assessment.submitted",
      outcome: "quarantined",
      reason: "DELIVERY_FAILED",
      at: "2026-10-14T07:30:00.000Z",
      requeued: false,
      requeueable: true,
    },
  ],
  canControl: true,
  canRequeue: true,
};

/** A connected administration session served by route mocks; no API or database. */
async function connected(page: Page, context: BrowserContext, locale: string) {
  await context.addCookies([
    {
      name: "course_csrf",
      value: "mock-csrf",
      url: test.info().project.use.baseURL!,
    },
  ]);
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: "u1", displayName: "Mock user", locale: null } },
    }),
  );
  await page.route("**/api/me/locale", (route) =>
    route.fulfill({
      json: { preference: null, locale: "en", source: "request" },
    }),
  );
  await page.route("**/api/workspaces", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/admin/courses/sorting", (route) =>
    route.fulfill({ json: workspace }),
  );
  await page.route("**/api/admin/courses/sorting/overview", (route) =>
    route.fulfill({ json: overview }),
  );
  await page.route("**/api/admin/courses/sorting/admin-sections", (route) =>
    route.fulfill({ json: sectionList }),
  );
  await page.route(
    /\/api\/admin\/courses\/sorting\/admin-sections\/glaze-lab\?/,
    (route) =>
      route.fulfill({ json: { release: sectionList.release, section } }),
  );
  await page.route(/\/api\/admin\/workspaces\/[^/]+\/audit\?/, (route) =>
    route.fulfill({ json: audit }),
  );
  await page.route(
    `**/api/admin/enrollments/${learner.id}/supervision`,
    (route) => route.fulfill({ json: supervision }),
  );
  await page.goto(`/admin/?locale=${locale}`);
}

/**
 * No horizontal scrolling. Compared with the configured viewport, not innerWidth: a mobile
 * browser widens its layout viewport to fit content that overflows.
 */
async function expectNoHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}
async function expectAccessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .include("main")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
/**
 * Under en-XA every translated message is wrapped in ⟦…⟧ and its Latin letters are accented.
 * Returns the visible text in the main region that has plain Latin letters outside any ⟦…⟧
 * frame: hardcoded text. Data is exempt where the view marks it as data (dir="ltr"/"auto",
 * bdi, code, pre, select options, the text in a field), and so are formatted dates, which pseudo-locales format as
 * English.
 */
async function untranslated(page: Page, allowed: readonly string[] = []) {
  const found = await page.evaluate(() => {
    const found: string[] = [];
    const main = document.querySelector("main")!;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const date =
      /[A-Z][a-z]{2} \d{1,2}, \d{4}(, \d{1,2}:\d{2}(:\d{2})? [AP]M)?( UTC)?/g;
    let depth = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let outside = "";
      for (const char of node.textContent ?? "") {
        if (char === "⟦") depth++;
        else if (char === "⟧") depth = Math.max(0, depth - 1);
        else if (depth === 0) outside += char;
      }
      const element = node.parentElement!;
      if (!/[A-Za-z]/.test(outside.replace(date, ""))) continue;
      // Only markers inside main count: <html> itself carries lang and dir.
      const data = element.closest(
        '[dir="ltr"], [dir="auto"], bdi, code, pre, option, textarea, [lang="en"], .sr-only',
      );
      if (data && main.contains(data)) continue;
      if (!element.checkVisibility()) continue;
      found.push(outside.trim());
    }
    return found;
  });
  return found.filter((text) => !allowed.includes(text));
}
/**
 * Nothing is allowed: course titles, and the demo's English run labels and timeline states
 * (older-server data), are marked with their own direction (Card titleDir, dir="auto").
 */
const SECTION_DATA: string[] = [];
/** Learning event types and delivery failure codes are translated (supervisionView). */
const SUPERVISION_CODES: string[] = [];
const DEMO_RUN_DATA: string[] = [];

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "desktop")
    await page.setViewportSize({ width: 1280, height: 900 });
});

test("overview, audit log and a course section render in Hebrew, right to left", async ({
  page,
  context,
}) => {
  await connected(page, context, "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");

  const ov = he("overviewView");
  await openSection(page, nav("nav.overview"), {});
  await expect(
    page.getByRole("heading", { name: ov("queue.title") }),
  ).toBeVisible();
  await expect(page.getByText("יומיים", { exact: true })).toBeVisible();
  await expect(page.getByText(ov("jobState.budget_wait"))).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  const au = he("auditView");
  await openSection(page, nav("nav.audit"), {});
  await expect(page.getByText(au("withheldLearner"))).toBeVisible();
  await expect(page.getByText("course.published")).toHaveAttribute(
    "dir",
    "ltr",
  );
  await expect(page.getByRole("button", { name: au("older") })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  const sv = he("adminSectionView");
  await openSection(page, "Glaze lab");
  await expect(page.getByText(sv("access.scoped_with_consent"))).toBeVisible();
  await expect(page.getByText("Kiln practice settings.")).toHaveAttribute(
    "dir",
    "auto",
  );
  await page.getByLabel("Kiln cone").fill("11");
  await expect(page.getByText(/בין 1 ל-10\./).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});

test("AI supervision renders in Hebrew, right to left", async ({
  page,
  context,
}) => {
  await connected(page, context, "he");
  const sv = he("supervisionView");
  await openSection(page, nav("nav.supervision"), {});
  await page
    .getByRole("combobox", { name: sv("learner") })
    .selectOption(learner.id);
  await expect(page.getByRole("table").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});

test("the run inspector renders every record view in Hebrew without overflow", async ({
  page,
}) => {
  await page.goto("/admin/demo?locale=he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const rv = he("runsView");
  await openSection(page, nav("nav.runs"), {});
  await expect(
    page.getByRole("heading", { name: nav("nav.runs"), level: 1 }),
  ).toBeVisible();
  for (const view of [
    "timeline",
    "workflow",
    "context",
    "decisions",
    "calls",
    "policies",
    "sync",
    "artifacts",
    "replay",
    "retry",
    "payload",
  ]) {
    const tab = page.getByRole("button", {
      name: rv(`view.${view}`),
      exact: true,
    });
    if (!(await tab.isVisible())) continue;
    await tab.click();
    await expectNoHorizontalOverflow(page);
  }
  await expectAccessible(page);
});

test("no hardcoded text under the en-XA pseudo-locale in the converted views", async ({
  page,
  context,
}) => {
  await connected(page, context, "en-XA");
  // Overview, Audit log and the course section (its title is course data, not accented).
  for (const name of ["overview", "audit"]) {
    await (await pseudoNav(page, name)).click();
    await expect(page.locator("main .loading")).toHaveCount(0);
    expect(await untranslated(page, SECTION_DATA)).toEqual([]);
  }
  await openSection(page, "Glaze lab", {});
  await expect(page.locator("main .loading")).toHaveCount(0);
  expect(await untranslated(page, SECTION_DATA)).toEqual([]);
  await (await pseudoNav(page, "supervision")).click();
  await page.locator("main select").first().selectOption(learner.id);
  await expect(page.getByRole("table").first()).toBeVisible();
  expect(await untranslated(page, SUPERVISION_CODES)).toEqual([]);
  // The pseudo-locale's padding wraps like words, so ~40% longer text must still fit.
  await expectNoHorizontalOverflow(page);
});

test("no hardcoded text under the en-XA pseudo-locale in the run inspector", async ({
  page,
}) => {
  await page.goto("/admin/demo?locale=en-XA");
  await (await pseudoNav(page, "runs")).click();
  const views = page.locator("main nav[aria-label] button");
  await views.first().waitFor();
  const count = await views.count();
  for (let index = 0; index < count; index++) {
    await views.nth(index).click();
    expect(await untranslated(page, DEMO_RUN_DATA)).toEqual([]);
    await expectNoHorizontalOverflow(page);
  }
});
