import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { accent } from "@course-core/i18n";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";
import { openSection } from "../workspaceNav";

/** Matches the en-XA rendering of an English catalog string. */
const pseudo = (english: string) =>
  new RegExp(accent(english).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

/** Phone and desktop widths every converted view must fit without horizontal scrolling. */
const widths = [390, 1280];

/** No horizontal scrolling: compared with the configured viewport, because a mobile
 * browser widens its layout viewport (and innerWidth) to fit content that overflows. */
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
async function expectRightToLeft(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}
/** Under the en-XA pseudo-locale every catalog string is framed in ⟦ … ⟧. Text with Latin
 * letters outside a frame is hardcoded, unless it is data: user or course text and ids carry
 * dir or sit in bdi, options, inputs and code; dates and numbers format as English. Course
 * text shown through a string-only prop is listed by the caller. Overflow is checked in
 * Hebrew, not here: the pseudo padding ("~~~~⟧") is one unbreakable token wider than a phone. */
async function untranslatedText(page: Page, root: string, data: string[] = []) {
  const found = await page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return ["missing " + selector];
    const data =
      "[dir], bdi, option, select, textarea, input, code, pre, .mono";
    const date = /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M UTC$/;
    const found: string[] = [];
    // Frames can span several text nodes (a message with tags), so track the open count.
    let open = 0;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = node.textContent!;
      const framed = open > 0 || raw.includes("⟦");
      open += (raw.match(/⟦/g) ?? []).length - (raw.match(/⟧/g) ?? []).length;
      const text = raw.trim();
      const parent = node.parentElement!;
      if (framed || !/[A-Za-z]/.test(text) || date.test(text)) continue;
      const holder = parent.closest(data);
      if (holder && scope.contains(holder)) continue;
      if (!parent.closest(".sr-only") && !parent.checkVisibility()) continue;
      found.push(text);
    }
    return found;
  }, root);
  // Course text in a string-only title prop (Card) cannot carry dir; it is data too.
  return found.filter((text) => !data.includes(text));
}

test.describe("demo workspace", () => {
  test("policy and enrollments render in Hebrew, right to left, at phone and desktop widths", async ({
    page,
  }) => {
    await page.goto("/admin/demo?locale=he");
    await expectRightToLeft(page);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await openSection(page, "מדיניות והארכות", {});
      await expect(
        page.getByRole("heading", { name: "שני שעונים. גבולות ברורים." }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "תחומי המדיניות" }),
      ).toBeVisible();
      await expect(
        page.getByText("מהדורת מדיניות", { exact: false }).first(),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);

      await page
        .getByRole("button", { name: "תצוגה מקדימה של ההארכה" })
        .click();
      await expect(
        page.getByRole("heading", { name: "תנאי ההארכה המחושבים" }),
      ).toBeVisible();
      await expect(
        page.getByRole("region", { name: "התנאים המדויקים לפני ואחרי" }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);

      await openSection(page, "הרשמות");
      await expect(
        page.getByRole("heading", { name: "כל לומד/ת, בהקשר המלא." }),
      ).toBeVisible();
      await expect(page.getByLabel("חיפוש לומד/ת")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);
    }
  });

  test("graded attempts: the policy is explained and an administrator allows one more attempt, in Hebrew at phone and desktop widths", async ({
    page,
  }) => {
    await page.goto("/admin/demo?locale=he");
    await expectRightToLeft(page);
    await openSection(page, "מדיניות והארכות", {});
    // The course setting, explained in plain words beside its two fields.
    await expect(page.getByLabel("מספר ניסיונות לכל נקודת בקרה")).toHaveValue(
      "3",
    );
    await expect(page.locator("#assessment-policy-summary")).toContainText(
      "לכל נקודת בקרה יש 3 ניסיונות.",
    );
    const card = page.getByRole("region", { name: "ניסיונות לפי נקודת בקרה" });
    await expect(card.getByRole("row").nth(2)).toContainText("3 מתוך 3");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);
    }
    await card.getByRole("button", { name: "מתן ניסיון נוסף" }).click();
    const confirm = page.getByRole("button", { name: "מתן הניסיון" });
    await expect(confirm).toBeDisabled();
    await page
      .getByLabel("סיבה", { exact: true })
      .fill("החיבור נותק במהלך הבדיקה");
    await expectAccessible(page);
    await confirm.click();
    await expect(
      page.getByText("ניתן ניסיון נוסף. אפשר להתחיל אותו עכשיו."),
    ).toBeVisible();
    await expect(card.getByRole("row").nth(2)).toContainText("3 מתוך 4");
    await expectNoHorizontalOverflow(page);
  });

  test("policy and enrollments have no untranslated text under the pseudo-locale", async ({
    page,
  }) => {
    await page.goto("/admin/demo?locale=en-XA");
    await openSection(page, pseudo("Policy & extensions"), {});
    await expect(
      page.getByRole("heading", { name: pseudo("Two clocks. Clear limits.") }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: pseudo("Preview calendar extension") })
      .click();
    await expect(
      page.getByRole("heading", { name: pseudo("Resolved extension terms") }),
    ).toBeVisible();
    expect(
      await untranslatedText(page, "#main-content", ["Chapter · Foundations"]),
    ).toEqual([]);
    await openSection(page, pseudo("Enrollments"), {});
    await expect(
      page.getByRole("heading", { name: pseudo("Every learner, in context.") }),
    ).toBeVisible();
    expect(
      await untranslatedText(page, "#main-content", ["Alex Example"]),
    ).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const catalogId = "77777777-7777-4777-8777-777777777777";
const owner = "22222222-2222-4222-8222-222222222222";
const scoped = "33333333-3333-4333-8333-333333333333";
const people = {
  actorRole: "owner",
  roles: ["owner", "admin", "learner", "course_scoped"],
  loginCodes: true,
  people: [
    {
      userId: owner,
      displayName: "Dana Levi",
      role: "owner",
      joinedAt: "2026-09-01T08:00:00Z",
      addedBy: null,
      enrollments: 0,
      lastSignInAt: "2026-10-20T09:30:00Z",
      self: true,
      canChangeRole: false,
      canRevoke: false,
      canIssueSignIn: false,
      loginName: "dana",
    },
    {
      userId: scoped,
      displayName: "נועה כהן",
      role: "course_scoped",
      joinedAt: "2026-10-02T10:00:00Z",
      addedBy: "Dana Levi",
      enrollments: 2,
      lastSignInAt: null,
      self: false,
      canChangeRole: true,
      canRevoke: true,
      canIssueSignIn: true,
      canSetPassword: true,
      mustChangePassword: true,
      loginName: "noa.cohen",
    },
  ],
};
const grants = {
  grants: [
    {
      grantId: "44444444-4444-4444-8444-444444444444",
      catalogId,
      userId: scoped,
      role: "observer",
      reasonCode: "support_case",
      createdAt: "2026-10-02T10:00:00Z",
      expiresAt: "2026-11-01T10:00:00Z",
      revokedAt: null,
      revokeReasonCode: null,
      state: "active",
    },
  ],
};
const placement = {
  authorLimit: 12,
  author: { enabled: true, maxItems: 12, learnerMayDecline: true },
  settings: {
    enabled: true,
    retestCooldownHours: 24,
    maxRuns: 2,
    maxItems: 8,
    minFamiliesPerEpisode: null,
    revision: 3,
    updatedAt: "2026-10-01T00:00:00Z",
  },
  effective: {
    enabled: true,
    authorEnabled: true,
    staffEnabled: true,
    maxItems: 8,
    authorMaxItems: 12,
  },
  counters: {
    runs: { finished: 4 },
    exemptions: 3,
    falseSkips: { total: 1, revokedByStaff: 1, laterFailed: 0 },
    unnecessaryRepetitions: 2,
  },
};
const learnerPlacement = {
  enrollmentId: "55555555-5555-4555-8555-555555555555",
  release: { version: "1.2.0", digest: "a".repeat(64) },
  runs: [
    {
      runNumber: 1,
      state: "accepted",
      stopReason: "item_limit",
      itemsUsed: 8,
      startedAt: "2026-10-03T10:00:00Z",
      finishedAt: "2026-10-03T10:20:00Z",
      acceptedAt: "2026-10-03T10:21:00Z",
    },
  ],
  exemptions: [
    {
      episodeId: "intro",
      title: "Introduction",
      placedAt: "2026-10-03T10:21:00Z",
      runNumber: 1,
      evidence: [
        {
          evidenceId: "66666666-6666-4666-8666-666666666666",
          objectiveId: "o1",
          assessmentId: "intro-check",
          familyId: "f1",
          independent: true,
          passed: true,
          invalidated: false,
          sameCourseVersion: true,
          placement: true,
        },
      ],
    },
  ],
  overrides: [],
};

/** A signed-in owner whose saved language is Hebrew, with people and placement served. */
async function connected(page: Page, locale: string) {
  const demo = demoSession("administrator");
  const session = {
    ...demo,
    courses: [{ ...demo.courses[0]!, id: catalogId }],
  };
  const base = demoWorkspace(session.courses[0]!, "administrator");
  const workspace = {
    ...base,
    role: "owner",
    course: { ...base.course, workspaceId },
  };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: owner, displayName: "Dana Levi", locale } },
    }),
  );
  await page.route("**/api/me/locale*", (route) =>
    route.fulfill({
      json: { preference: locale, locale, source: "user" },
    }),
  );
  await page.route("**/api/workspaces", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route(`**/api/admin/courses/${catalogId}`, (route) =>
    route.fulfill({ json: workspace }),
  );
  await page.route(`**/api/admin/workspaces/${workspaceId}/people`, (route) =>
    route.fulfill({ json: people }),
  );
  await page.route(
    `**/api/admin/workspaces/${workspaceId}/course-grants`,
    (route) => route.fulfill({ json: grants }),
  );
  await page.route(`**/api/admin/courses/${catalogId}/placement`, (route) =>
    route.fulfill({ json: placement }),
  );
  await page.route("**/api/admin/enrollments/*/placement", (route) =>
    route.fulfill({ json: learnerPlacement }),
  );
}

test.describe("connected workspace", () => {
  test("people, course access and placement render in Hebrew, right to left, at phone and desktop widths", async ({
    page,
  }) => {
    await connected(page, "he");
    await page.goto("/admin/");
    await expectRightToLeft(page);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await openSection(page, "אנשים ותפקידים", {});
      await expect(
        page.getByRole("heading", { name: "חברי סביבת העבודה" }),
      ).toBeVisible();
      await expect(page.getByText("שני אנשים")).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: /התפקיד של .*נועה כהן/ }),
      ).toHaveValue("course_scoped");
      await expect(
        page
          .getByRole("option", { name: "גישה לפי קורס", exact: true })
          .first(),
      ).toBeAttached();
      await expect(
        page.getByRole("heading", { name: /^גישה לקורס:/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /ביטול הגישה של .*נועה כהן/ }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);

      await page.getByRole("button", { name: "הזמנת אדם" }).click();
      await expect(
        page.getByRole("dialog", { name: "הזמנת אדם" }),
      ).toBeVisible();
      await expect(page.getByText("גישה לפי קורס").last()).toBeVisible();
      await expectAccessible(page);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "ביטול", exact: true })
        .click();

      await openSection(page, "שיבוץ");
      await expect(page.getByText("הופעל על ידי הצוות")).toBeVisible();
      await page.getByLabel("לומד/ת", { exact: true }).selectOption({
        index: 1,
      });
      await expect(page.getByText("הגעה למגבלת השאלות")).toBeVisible();
      await expect(
        page.getByRole("region", { name: /פטור: .*Introduction/ }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);
    }
  });

  test("people and placement have no untranslated text under the pseudo-locale", async ({
    page,
  }) => {
    await connected(page, "en-XA");
    await page.goto("/admin/?locale=en-XA");
    await openSection(page, pseudo("People & roles"), {});
    await expect(
      page.getByRole("heading", { name: pseudo("Workspace members") }),
    ).toBeVisible();
    expect(await untranslatedText(page, "#main-content")).toEqual([]);
    await openSection(page, pseudo("Placement"), {});
    await page.getByRole("combobox", { name: pseudo("Learner") }).selectOption({
      index: 1,
    });
    await expect(
      page.getByRole("region", { name: /Introduction/ }),
    ).toBeVisible();
    expect(await untranslatedText(page, "#main-content")).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
});
