import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedSnapshot } from "../connectedFixtures";
import { authorPolicy, policyFixture } from "../policyFixtures";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MessageKey } from "../../src/i18n";

/** Hebrew and pseudo-locale checks for the learner's settings panels (profile view)
 * and the companion, with fixture HTTP responses only. */
const snapshot = { ...connectedSnapshot(), course: { ...connectedSnapshot().course, policy: authorPolicy } };
const enrollment = `/api/enrollments/${snapshot.enrollmentId}`;
const at = "2026-10-14T10:00:00.000Z";

const memory = {
  enrollmentId: snapshot.enrollmentId,
  workspaceId: "workspace-1",
  episodeId: "intro",
  courseDigest: snapshot.courseDigest,
  revision: snapshot.revision,
  profileRevision: 2,
  modelRevision: 1,
  scope: { episodeId: "intro", objectiveIds: ["observe"], objectivesTruncated: false },
  understanding: [
    {
      objectiveId: "observe",
      status: "needs_evidence",
      gateId: "check",
      basis: "current_course_independent_gate_evidence",
      demonstrated: false,
      retention: "not_scheduled",
      retentionDueAt: null,
      practiceAttempts: 0,
      openDisputes: 0,
      independentFamilies: 1,
      requiredFamilies: 2,
      familiesTruncated: false,
      evidenceRefsTruncated: false,
      evidenceRefs: [{ evidenceId: "evidence-1", attemptId: "attempt-1", courseDigest: snapshot.courseDigest }],
    },
  ],
  selfReport: {
    trust: "learner_statement_not_evidence",
    preferences: { pace: "steady", explanationStyle: "worked_example", goal: "Notice patterns" },
    priorKnowledge: [{ objectiveId: "observe", statement: "I have seen these patterns before." }],
    thoughts: "Start with small examples.",
  },
  suggestions: {
    truncated: false,
    items: [
      {
        proposalId: "8a632521-8f9a-4d37-884c-b7d2502a547e",
        status: "pending",
        suggestion: { kind: "explanation_style", value: "step_by_step" },
        originalSuggestion: { kind: "explanation_style", value: "step_by_step" },
        decisionId: null,
        grantsMastery: false,
        sourceEventRefs: [
          { eventId: "source-event", cursor: "10", eventType: "companion.requested", digest: "b".repeat(64) },
        ],
      },
    ],
  },
};
const hypotheses = {
  enrollmentId: snapshot.enrollmentId,
  courseDigest: snapshot.courseDigest,
  revision: snapshot.revision,
  items: [
    {
      hypothesisId: "6a6ad0f6-0e0c-4c8e-9d1e-2d7d8b0a2f10",
      revision: 1,
      templateId: "mix-up",
      kind: "misconception",
      statement: "You may be choosing the largest value instead of the smallest.",
      learnerCorrection: null,
      status: "proposed",
      uncertainty: "high",
      source: "assessment",
      pinned: false,
      rejectedBy: null,
      objectiveIds: [snapshot.course.objectives[0]!.id],
      observations: 1,
      evidenceRefs: [{ kind: "attempt", id: "attempt-1", supports: true, at }],
      evidenceRefsTruncated: false,
      expiresAt: "2030-02-01T00:00:00Z",
      createdAt: at,
      updatedAt: at,
      probeAvailable: true,
      grantsMastery: false,
    },
  ],
  probes: [],
  requests: [],
  limits: { diagnosticRequestsPerDay: 3, openProbes: 2, probesPerDay: 3 },
  notEvidence: true,
};
const study = {
  id: "00000000-0000-4000-8000-000000000051",
  title: "Ordering study",
  purpose: "We compare three versions of this course.",
  state: "recruiting",
  consentDigest: "d".repeat(64),
  versions: ["fixed", "supervisor"],
  collected: ["study_code"],
  neverCollected: ["companion_conversations"],
};
/** Course and fixture text that is content, not UI: never translated. */
const CONTENT = [
  snapshot.course.title,
  "Public learner",
  "Learner",
  "Understand change",
  "Notice patterns",
  "I have seen these patterns before.",
  "Start with small examples.",
  "You may be choosing the largest value instead of the smallest.",
  "Desk assistant",
  "Ordering values",
  "Ordering study",
  "We compare three versions of this course.",
  "Course owner",
  ...snapshot.course.objectives.map((objective) => objective.description),
];

async function host(page: Page, locale: string) {
  await page.context().addCookies([{ name: "course_csrf", value: "mock-csrf", url: test.info().project.use.baseURL! }]);
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { user: { id: "public-user", displayName: "Public learner", locale: null } } }),
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (route.request().method() !== "GET") return route.fulfill({ status: 409, json: { error: "STALE_REVISION" } });
    if (path === "/api/me/locale") return json({ preference: null, locale: "en", source: "default" });
    if (path === "/api/enrollments")
      return json([{ id: snapshot.enrollmentId, title: snapshot.course.title, version: "1.0.0", status: "active" }]);
    if (path === "/api/workspaces") return json([]);
    if (path === enrollment) return json(snapshot);
    if (path === `${enrollment}/policy`) return json(policyFixture(snapshot.enrollmentId));
    if (path === `${enrollment}/companion`) return json({ messages: [] });
    if (path === `${enrollment}/learner-model`) return json(memory);
    if (path === `${enrollment}/learner-model/hypotheses`) return json(hypotheses);
    if (path === `${enrollment}/learner-model/history`)
      return json({ scope: memory.scope, items: [], nextCursor: null, scannedEvents: 0, maxScannedEvents: 200,
        maxSearchedTextCharacters: 4000, maxSnippetCharacters: 1000 });
    if (path === `${enrollment}/learner-model/changes`) return json({ items: [], nextCursor: null });
    if (path === `${enrollment}/supervision`)
      return json({ revision: snapshot.revision, permissionRevision: 1, adaptiveTeaching: false, authority: "learner_opt_in" });
    if (path === `${enrollment}/supervision/tools`) return json({ calls: [] });
    if (path === `${enrollment}/study`) return json({ revision: snapshot.revision, study, participation: null });
    if (path === `${enrollment}/staff-views`)
      return json({ views: [{ id: "v1", viewedAt: at, viewerName: "Course owner", viewerRole: "owner" }], exports: [] });
    if (path === `${enrollment}/agent-grants`)
      return json({
        grants: [{ id: "g1", label: "Desk assistant", scopes: ["context", "profile"], createdAt: at,
          expiresAt: "2030-10-21T10:00:00.000Z", revokedAt: null, revokedReason: null, lastUsedAt: null, state: "active" }],
        recentCalls: [],
      });
    if (path === `${enrollment}/cross-course`)
      return json({
        pairs: [{ otherEnrollmentId: "00000000-0000-4000-8000-0000000000a2",
          otherCourse: { title: "Ordering values", version: "1.0.0", status: "active" }, mapping: { links: 2 },
          consent: { granted: false, revision: 0, changedAt: null }, canGrant: true }],
        suggestions: [],
      });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.goto(`/?locale=${locale}`);
}

type Locale = "he" | "en-XA";
type T = (key: MessageKey) => string;
/** The app's own catalogs and translator (ESM, loaded once), so names follow the catalogs. */
const translators: Partial<Record<Locale, T>> = {};
test.beforeAll(async () => {
  const { createTranslator } = await import("@course-core/i18n");
  const root = path.join(__dirname, "../../src/i18n/messages");
  const catalog = (locale: string) =>
    Object.fromEntries(
      readdirSync(path.join(root, locale)).map((file) => [
        file.replace(/\.json$/, ""),
        JSON.parse(readFileSync(path.join(root, locale, file), "utf8")),
      ]),
    );
  const catalogs = { en: catalog("en"), he: catalog("he") };
  for (const locale of ["he", "en-XA"] as const)
    translators[locale] = createTranslator({ locale, catalogs } as never).t as unknown as T;
});
const tr = (locale: Locale) => translators[locale]!;
/** Headings of the panels this suite covers, in the profile view. */
const HEADINGS: MessageKey[] = [
  "supervisionPanel.settings.title",
  "learnerMemoryPanel.header.title",
  "teachingHypothesesPanel.title",
  "personalChanges.title",
  "yourDataPanel.title",
  "yourDataPanel.access.title",
  "connectedAgentsPanel.title",
  "crossCoursePanel.title",
];

/** From the course list into the course (the host's own continue button). */
async function enterCourse(page: Page, locale: Locale) {
  await page.getByRole("button", { name: tr(locale)("connectedHost.library.continue"), exact: true }).click();
}
/** From the roadmap into the next lesson. The roadmap's button is not in a catalog yet, so
 * accept its English text as well as the host's translated wording. */
async function openLesson(page: Page, locale: Locale) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [tr(locale)("connectedHost.library.continue"), "Continue learning →"].map(escape).join("|");
  await page.getByRole("button", { name: new RegExp(`^(${names})$`) }).first().click();
}

async function openProfile(page: Page, locale: Locale) {
  const t = tr(locale);
  await enterCourse(page, locale);
  await page.getByRole("button", { name: t("connectedHost.menu.yourCourse") }).click();
  await page.getByRole("button", { name: t("connectedHost.menu.profile") }).click();
  for (const key of HEADINGS)
    await expect(page.getByRole("heading", { name: t(key), exact: true })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
async function expectAccessible(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
}
/** Under en-XA every UI string is wrapped in ⟦…⟧; text without the marks is hardcoded. */
async function untranslated(scope: Locator) {
  return scope.evaluateAll((roots, content) => roots.flatMap((root) => {
    const found: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    // Text inside a marked string, content, numbers, codes and punctuation is fine.
    const marked = (node: Node) => {
      let text = "";
      for (let el = node.parentElement; el && el !== root.parentElement; el = el.parentElement) {
        text = el.textContent ?? "";
        if (text.includes("⟦")) return true;
      }
      return false;
    };
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").replace(/[⁦-⁩‎‏‪-‮]/g, "").trim();
      if (!/[A-Za-z]{2}/.test(text)) continue;
      if (content.some((value) => text === value)) continue;
      if (/^[a-z0-9_.:-]+$/i.test(text) && !/\s/.test(text) && /[\d_.:-]/.test(text)) continue;
      if (!text.includes("⟦") && !marked(node)) found.push(text);
    }
    return found;
  }), CONTENT);
}

for (const width of [390, 1280]) {
  test(`Hebrew settings panels at ${width}px: rtl, translated, no overflow, axe clean`, async ({ page }) => {
    const t = tr("he");
    await page.setViewportSize({ width, height: 900 });
    await host(page, "he");
    await expect(page.locator("html")).toHaveAttribute("lang", "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await openProfile(page, "he");
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);

  });
}

for (const width of [390, 1280]) {
  test(`Hebrew companion at ${width}px: rtl, translated, no overflow, axe clean`, async ({ page }) => {
    const t = tr("he");
    await page.setViewportSize({ width, height: 900 });
    await host(page, "he");
    await enterCourse(page, "he");
    await openLesson(page, "he");
    if (width < 600) await page.getByRole("button", { name: t("companionDock.open"), exact: true }).click();
    const companion = page.getByRole(width < 600 ? "dialog" : "complementary", { name: t("companionDock.label") });
    await expect(companion).toBeVisible();
    await expect(companion.getByRole("textbox", { name: t("connectedCompanion.draft.label") })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
  });
}

for (const width of [390, 1280]) {
  test(`Hebrew study dates and extension offer at ${width}px: rtl, translated, no overflow, axe clean`, async ({ page }) => {
    const t = tr("he");
    await page.setViewportSize({ width, height: 900 });
    await host(page, "he");
    await enterCourse(page, "he");
    await page.getByText(t("policyPanel.caption"), { exact: true }).click();
    const offer = page.locator(".connected-policy-panel article").first();
    await expect(offer.getByRole("button", { name: t("policyPanel.offer.accept") })).toBeVisible();
    await expect(offer.getByRole("region", { name: t("policyPanel.offer.beforeLabel") })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
  });
}

test("the settings panels, study dates and companion have no untranslated text under the en-XA pseudo-locale", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await host(page, "en-XA");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-XA");
  await openProfile(page, "en-XA");
  const profile = page.locator("section.connected-reading-card").filter({ has: page.locator("select") });
  // The locale switcher and the profile editor above the panels belong to other views.
  const panels = profile.locator(":scope > *:not(:nth-child(-n+2))");
  for (const key of HEADINGS)
    await expect(panels.getByRole("heading", { name: tr("en-XA")(key), exact: true })).toBeVisible();
  expect(await untranslated(panels)).toEqual([]);

  await page.goto("/?locale=en-XA");
  await enterCourse(page, "en-XA");
  await page.getByText(tr("en-XA")("policyPanel.caption"), { exact: true }).click();
  const policy = page.locator(".connected-policy-panel");
  await expect(policy.locator("article").first()).toBeVisible();
  expect(await untranslated(policy)).toEqual([]);
  await openLesson(page, "en-XA");
  const companion = page.getByRole("complementary", { name: tr("en-XA")("companionDock.label") });
  await expect(companion.getByRole("textbox", { name: tr("en-XA")("connectedCompanion.draft.label") })).toBeVisible();
  expect(await untranslated(companion)).toEqual([]);
});
