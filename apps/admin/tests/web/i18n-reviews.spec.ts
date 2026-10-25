import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createTranslator } from "@course-core/i18n";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";
import { sample as learnerViewSample } from "../learnerViewFixture";
import adminApp from "../../src/i18n/messages/en/adminApp.json" with { type: "json" };
import learnerViewCard from "../../src/i18n/messages/en/learnerViewCard.json" with { type: "json" };
import learnerDataCard from "../../src/i18n/messages/en/learnerDataCard.json" with { type: "json" };
import heAdminApp from "../../src/i18n/messages/he/adminApp.json" with { type: "json" };
import heLearnerViewCard from "../../src/i18n/messages/he/learnerViewCard.json" with { type: "json" };
import heLearnerDataCard from "../../src/i18n/messages/he/learnerDataCard.json" with { type: "json" };
import { workspaceNav } from "../workspaceNav";

const en = { adminApp, learnerViewCard, learnerDataCard };
const translators = {
  "en-XA": createTranslator({ locale: "en-XA", catalogs: { en, he: {} } }),
  he: createTranslator({
    locale: "he",
    catalogs: {
      en,
      he: {
        adminApp: heAdminApp,
        learnerViewCard: heLearnerViewCard,
        learnerDataCard: heLearnerDataCard,
      },
    },
  }),
};
type Locale = keyof typeof translators;
const nav = async (page: Page, key: "reviews" | "learners", locale: Locale) =>
  (await workspaceNav(page)).getByRole("button", {
    name: translators[locale].t(`adminApp.nav.${key}`),
    exact: true,
  });
const card = (
  page: Page,
  key: "learnerViewCard.title" | "learnerDataCard.title",
  locale: Locale,
) =>
  page.locator("section.card").filter({
    has: page.getByRole("heading", {
      name: translators[locale].t(key),
      exact: true,
    }),
  });

/** Course content and user text are isolated with dir; everything else must come from a catalog. */
const ISOLATED =
  '[dir="auto"], [dir="ltr"], bdi, code, pre, input, textarea, select, option, svg, .mono';

/** No horizontal scrolling. Compared with the set viewport width: on a mobile project
 * `innerWidth` grows with the content, so it cannot reveal overflow. */
async function expectNoHorizontalOverflow(page: Page) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
}
async function expectAccessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
/** Under en-XA every catalog string is wrapped in ⟦…⟧ and every ASCII letter is accented, so a
 * text node with plain Latin words outside an isolated (user, course or code) element is hardcoded. */
async function untranslatedText(scope: Locator, exclude = ":not(*)") {
  await expect(scope.first()).toBeVisible();
  return scope.first().evaluate(
    (root, [isolated, exclude]) => {
      const found: string[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        if (!/[A-Za-z]{2}/.test(text) || /[⟦⟧]/.test(text)) continue;
        const parent = node.parentElement!;
        const exempt = parent.closest(isolated);
        if (exempt && root.contains(exempt)) continue;
        if (parent.closest(`[hidden], [aria-hidden='true'], ${exclude}`))
          continue;
        // Dates and times come from Intl, which formats pseudo-locales as English.
        if (
          /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M UTC$/.test(
            text.trim(),
          )
        )
          continue;
        found.push(text.trim());
      }
      return found;
    },
    [ISOLATED, exclude] as const,
  );
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rubric = [
  { id: "c1", description: "Names the invariant.", required: true },
  { id: "c2", description: "Explains why it holds.", required: false },
];
const reviewFixtures = {
  pending: {
    pending: [
      {
        attemptId: uuid(1),
        enrollmentId: uuid(2),
        learner: "Avery Example",
        episodeId: "episode-1",
        assessmentId: "assessment-1",
        prompt: "Why does insertion sort keep the prefix sorted?",
        rubric,
        response: "Each step inserts into an already sorted prefix.",
        submittedAt: "2026-10-20T10:00:00.000Z",
        independentEligible: true,
        ownSubmission: false,
      },
    ],
  },
  appeals: {
    appeals: [
      {
        appealId: uuid(3),
        attemptId: uuid(4),
        enrollmentId: uuid(2),
        learner: "Avery Example",
        reason: "I named the invariant in my second sentence.",
        createdAt: "2026-10-19T10:00:00.000Z",
        prompt: "State the loop invariant.",
        rubric,
        response: "The prefix stays sorted.",
        thread: [],
        original: {
          decision: "not_met",
          findings: [{ criterionId: "c1", met: false, note: "Not stated." }],
        },
        canDecide: true,
      },
    ],
  },
  gates: {
    reviews: [
      {
        requestId: uuid(5),
        enrollmentId: uuid(2),
        gateId: "gate-sorting",
        decisionId: uuid(6),
        learner: "Avery Example",
        reason: "My evidence for the second objective was recorded late.",
        state: "open",
        requestedAt: "2026-10-18T10:00:00.000Z",
        decision: {
          decisionId: uuid(6),
          gateId: "gate-sorting",
          gateVersion: "1.0.0",
          status: "needs_evidence",
          criterionResults: [{ criterionId: "c1", met: false }],
          missingObjectiveIds: ["objective-2"],
          learnerVisibleReason: "One objective still needs evidence.",
          decidedAt: "2026-10-18T09:00:00.000Z",
        },
        canUphold: true,
        canGrantException: true,
      },
    ],
  },
  disputes: {
    disputes: [
      {
        disputeId: uuid(7),
        state: "open",
        enrollmentId: uuid(2),
        learner: "Avery Example",
        objectiveId: "objective-1",
        evidence: {
          evidenceId: uuid(8),
          attemptId: uuid(9),
          assessmentId: "assessment-1",
          passed: false,
          independent: true,
          mode: "practice",
          releaseVersion: "1.0.0",
        },
        raisedAt: "2026-10-17T10:00:00.000Z",
        ageDays: 4,
        canResolve: true,
        canUphold: true,
      },
    ],
    truncated: false,
  },
};

async function openConnected(page: Page, locale: string) {
  const session = demoSession("administrator"),
    workspace = {
      ...demoWorkspace(session.courses[0]!, "administrator"),
      role: "admin",
    };
  workspace.permissions = [...workspace.permissions, "learner.view"];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: "u1", displayName: "Mock user", locale } },
    }),
  );
  await page.route("**/api/me/locale**", (route) =>
    route.fulfill({ json: { preference: locale, locale, source: "user" } }),
  );
  await page.route("**/api/workspaces", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/admin/courses/sorting", (route) =>
    route.fulfill({ json: workspace }),
  );
  await page.route("**/rubric-reviews", (route) =>
    route.fulfill({ json: reviewFixtures.pending }),
  );
  await page.route("**/rubric-appeals", (route) =>
    route.fulfill({ json: reviewFixtures.appeals }),
  );
  await page.route("**/gate-reviews", (route) =>
    route.fulfill({ json: reviewFixtures.gates }),
  );
  await page.route("**/evidence-disputes", (route) =>
    route.fulfill({ json: reviewFixtures.disputes }),
  );
  await page.route("**/learner-view", (route) =>
    route.fulfill({ json: learnerViewSample() }),
  );
  await page.goto(`/admin/?locale=${locale}`);
}

/** RubricFindings (the appeal's criteria) is converted separately; its legends carry no <bdi>. */
const RUBRIC_FINDINGS = "fieldset.review-criterion:not(:has(bdi))";

test("answer reviews, gate reviews and evidence disputes in Hebrew", async ({
  page,
}) => {
  await openConnected(page, "he");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await (await nav(page, "reviews", "he")).click();
  await expect(
    page.getByRole("heading", { name: "בדיקת תשובות", level: 1 }),
  ).toBeVisible();
  // The learner's question is course text, isolated inside the Hebrew card.
  await expect(
    page
      .getByRole("heading", { level: 2 })
      .locator("bdi", { hasText: "Why does insertion sort" }),
  ).toBeVisible();
  await expect(page.locator("#gate-review-heading")).toBeVisible();
  await expect(page.locator("#evidence-dispute-heading")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});

test("answer reviews show no untranslated text under the pseudo-locale", async ({
  page,
}) => {
  await openConnected(page, "en-XA");
  await (await nav(page, "reviews", "en-XA")).click();
  await expect(page.locator("#gate-review-heading")).toBeVisible();
  await expect(page.locator("#evidence-dispute-heading")).toBeVisible();
  expect(await untranslatedText(page.locator("main"), RUBRIC_FINDINGS)).toEqual(
    [],
  );
});

for (const locale of ["he", "en-XA"] as const) {
  test(`enrollment cards and the read-only learner view in ${locale}`, async ({
    page,
  }) => {
    await openConnected(page, locale);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "he" ? "rtl" : "ltr",
    );
    // The pseudo-locale's unbreakable "~~~~" padding is wider than a phone card; this test is about
    // untranslated text, so it reads the pseudo-locale at desktop width (Hebrew is checked at both).
    if (locale === "en-XA")
      await page.setViewportSize({ width: 1280, height: 900 });
    await (await nav(page, "learners", locale)).click();
    const view = card(page, "learnerViewCard.title", locale);
    const data = card(page, "learnerDataCard.title", locale);
    if (locale === "en-XA") {
      expect(await untranslatedText(view)).toEqual([]);
      expect(await untranslatedText(data)).toEqual([]);
    } else {
      await expect(data).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);
    }
    await view.getByRole("button").first().click();
    const screen = page.locator(".learner-view");
    await expect(screen).toBeVisible();
    if (locale === "en-XA") expect(await untranslatedText(screen)).toEqual([]);
    else {
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);
    }
  });
}

for (const locale of ["he", "en-XA"] as const) {
  test(`release safety and course updates in ${locale}`, async ({ page }) => {
    await openConnected(page, locale);
    // The published release (the second row) carries the safety controls.
    await page.locator(".release-row").nth(1).click();
    const panel = page.locator(".release-safety");
    await panel.getByRole("button").last().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    if (locale === "en-XA") {
      expect(await untranslatedText(panel)).toEqual([]);
      expect(await untranslatedText(dialog)).toEqual([]);
    } else {
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);
    }
  });
}
