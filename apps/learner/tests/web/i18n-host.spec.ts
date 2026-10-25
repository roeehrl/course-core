import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { trackedHebrew } from "../hebrewText";
import { connectedSnapshot } from "../connectedFixtures";

/* The connected host, lesson, passkeys and demo app in Hebrew and under the
 * en-XA pseudo-locale: direction, phone and desktop widths, axe, and no chrome
 * text that bypasses the catalogs. */

const WIDTHS = [390, 1280];
async function expectNoOverflowAtWidths(page: Page) {
  const height = page.viewportSize()?.height ?? 900;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), {
        message: `horizontal overflow at ${width}px`,
      })
      .toBeLessThanOrEqual(0);
  }
}
async function expectAccessible(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze())
      .violations,
  ).toEqual([]);
}
/**
 * Visible text under `root` that is plain Latin although the page runs in en-XA,
 * where every catalog message is accented. Course content, user text and codes
 * sit in elements with their own `dir` or `lang` and are skipped.
 */
async function untranslatedText(page: Page, root: string) {
  return page.evaluate((selector) => {
    const found: string[] = [];
    for (const scope of Array.from(document.querySelectorAll(selector))) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        if (!/[A-Za-z]{3,}/.test(text)) continue;
        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, [aria-hidden='true'], [hidden]")) continue;
        if (parent.closest("[dir], [lang]") !== document.documentElement) continue;
        if (!parent.getClientRects().length) continue;
        found.push(text.trim());
      }
    }
    return found;
  }, root);
}

async function connectedFixture(page: Page, user: Record<string, unknown> = {}) {
  const snapshot = connectedSnapshot();
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { user: { id: "public-user", displayName: "Public learner", ...user } } }),
  );
  await page.route("**/auth/passkeys", (route) =>
    route.fulfill({
      json: {
        available: true,
        passkeys: [
          { id: "pk-1", name: "Passkey on Mac", createdAt: "2026-10-01T09:00:00Z", lastUsedAt: null, backedUp: true },
        ],
      },
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/me/locale")
      return route.fulfill({
        json: user.locale ? { preference: user.locale, locale: user.locale, source: "user" } : { preference: null, locale: "en", source: "default" },
      });
    if (path === "/api/enrollments")
      return route.fulfill({
        json: [{ id: snapshot.enrollmentId, title: snapshot.course.title, version: "1.0.0", status: "active" }],
      });
    if (path === "/api/workspaces") return route.fulfill({ json: [] });
    if (path.endsWith("/companion")) return route.fulfill({ json: { messages: [] } });
    if (path === `/api/enrollments/${snapshot.enrollmentId}`) return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  return snapshot;
}
/** Where the first character of an element's text is painted: the start of a left-to-right line. */
function firstCharacterLeft(locator: Locator) {
  return locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? "").search(/[^\s\u2066-\u2069]/);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      return range.getBoundingClientRect().left;
    }
    return Number.NaN;
  });
}
/** The left edge of an element's content box. */
function contentLeft(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
  });
}
async function openLesson(page: Page, continueLabel: RegExp) {
  await page.getByRole("button", { name: continueLabel }).first().click();
  await page.getByRole("button", { name: continueLabel }).first().click();
  await expect(page.locator(".connected-lesson").first()).toBeVisible();
}

test("the connected library and lesson lay out right to left in Hebrew without overflow", async ({ page }) => {
  await connectedFixture(page, { locale: "he" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const resume = page.getByRole("button", { name: "המשך למידה ←", exact: true });
  await expect(resume).toBeVisible();
  await expectNoOverflowAtWidths(page);
  await expectAccessible(page);

  await openLesson(page, /המשך למידה|Continue learning/);
  await expect(page.getByRole("navigation", { name: "ניווט בלמידה" })).toBeVisible();
  await expect(page.getByText("עוד לא ידוע לי", { exact: true }).or(page.getByText(/חלק 1/)).first()).toBeVisible();
  // Course content keeps its own direction: the lesson heading is isolated with dir="auto".
  await expect(page.locator("h1[dir='auto'], h2[dir='auto'], [dir='auto'] h1, [dir='auto'] h2").first()).toBeAttached();
  await expectNoOverflowAtWidths(page);
  await expectAccessible(page);
});

test("an English course's lesson text starts at its own edge in the Hebrew host, not indented from the right", async ({ page }) => {
  await connectedFixture(page, { locale: "he" });
  await page.goto("/");
  await openLesson(page, /המשך למידה|Continue learning/);
  const heading = page.locator(".connected-lesson-heading");
  const title = heading.locator("h1"),
    subtitle = heading.locator("> p"),
    card = page.locator(".connected-reading-card").first(),
    prose = card.locator(".connected-prose").first(),
    sources = card.locator(".connected-sources ul");
  await expect(subtitle).toHaveText("Explain a changing pattern.");
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // The subtitle reads left to right from the same edge as the English title above it.
    await expect(subtitle).toHaveCSS("direction", "ltr");
    await expect(subtitle).toHaveCSS("text-align", "start");
    expect(Math.abs((await firstCharacterLeft(subtitle)) - (await firstCharacterLeft(title))), `subtitle at ${width}px`).toBeLessThanOrEqual(1);
    // So does the lesson prose: it starts at the card's left edge, not inside a box hung from the right.
    await expect(prose).toHaveCSS("direction", "ltr");
    expect(Math.abs((await firstCharacterLeft(prose)) - (await contentLeft(card))), `prose at ${width}px`).toBeLessThanOrEqual(1);
    // A source title's bullet stays inside the list's box, so inside the card.
    const listLeft = await sources.evaluate((list) => list.getBoundingClientRect().left);
    for (const item of await sources.locator("li").all())
      expect((await item.evaluate((li) => li.getBoundingClientRect().left)) - listLeft, `source bullet at ${width}px`).toBeGreaterThanOrEqual(12);
  }
  expect(await trackedHebrew(page.locator("body"), { tighter: true })).toEqual([]);
});

test("the demo app in Hebrew: English course text starts at its own edge, and no Hebrew heading is drawn tighter", async ({ page }) => {
  await page.goto("/demo?locale=he");
  const roadmap = page.getByTestId("course-roadmap");
  const title = roadmap.getByRole("heading", { name: "A little order." });
  const description = roadmap.getByText(/^Turn a handful of numbers/);
  const resumeTitle = roadmap.getByText("Find the order", { exact: true }).first();
  // React Native lays the page out again after a resize, so each measurement waits for it.
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // The measured description starts where its title does, not inside a box hung from the right.
    await expect.poll(async () => Math.abs((await firstCharacterLeft(description)) - (await firstCharacterLeft(title))), { message: `description at ${width}px` }).toBeLessThanOrEqual(1);
    // On a phone the next lesson's title starts at its own (left) edge of the card, not mid-card.
    // (Wider, it sits beside the button.)
    if (width < 600) {
      const card = resumeTitle.locator("xpath=../..");
      await expect.poll(async () => Math.abs((await firstCharacterLeft(resumeTitle)) - (await contentLeft(card))), { message: `next lesson title at ${width}px` }).toBeLessThanOrEqual(1);
    }
  }
  expect(await trackedHebrew(page.locator("body"), { tighter: true })).toEqual([]);
  // A Hebrew heading the demo draws in its own style (the profile) keeps normal spacing too.
  await page.getByRole("button", { name: "פרופיל" }).click();
  await expect(page.getByRole("heading").first()).toBeVisible();
  expect(await trackedHebrew(page.locator("body"), { tighter: true })).toEqual([]);
  // In a lesson, the step's label, heading and body share the heading's start edge.
  await page.goto("/demo?locale=he");
  await page.getByRole("button", { name: /המשך למידה/ }).first().click();
  const heading = page.getByRole("heading", { name: "Every number has a neighbor." });
  const label = page.getByText("First, a small observation", { exact: true });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => Math.abs((await firstCharacterLeft(label)) - (await firstCharacterLeft(heading))), { message: `lesson label at ${width}px` }).toBeLessThanOrEqual(1);
  }
  expect(await trackedHebrew(page.locator("body"), { tighter: true })).toEqual([]);
  await expectNoOverflowAtWidths(page);
  await expectAccessible(page);
});

test("passkeys are managed in Hebrew with user names isolated", async ({ page }) => {
  await connectedFixture(page, { locale: "he" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "חשבון" }).click();
  await page.getByRole("menuitem", { name: "מפתחות גישה" }).or(page.getByRole("button", { name: "מפתחות גישה" })).click();
  await expect(page.getByRole("heading", { name: "מפתחות גישה" })).toBeVisible();
  await expect(page.getByRole("list", { name: "מפתחות הגישה שלך" })).toBeVisible();
  await expect(page.getByText("Passkey on Mac", { exact: true })).toHaveAttribute("dir", "auto");
  await expect(page.getByRole("button", { name: /הסרת מפתח הגישה/ })).toBeVisible();
  await expectNoOverflowAtWidths(page);
  await expectAccessible(page);
});

test("the en-XA pseudo-locale leaves no untranslated host or lesson chrome", async ({ page }) => {
  await connectedFixture(page);
  await page.goto("/?locale=en-XA");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-XA");
  await expect(page.locator("main").first()).toBeVisible();
  expect(await untranslatedText(page, ".connected-library, .connected-header")).toEqual([]);
  await openLesson(page, /Ç[öô]ñţîñûé|Continue learning/);
  expect(
    await untranslatedText(page, ".connected-lesson-heading, .connected-steps, .connected-now-next, .connected-check, .connected-complete, .connected-gate, .connected-navigation"),
  ).toEqual([]);
  await expectNoOverflowAtWidths(page);
});

test("the demo app switches to Hebrew and passes the pseudo-locale check", async ({ page }) => {
  await page.goto("/demo?locale=he");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("button", { name: "המסלול שלי" })).toBeVisible();
  await expect(page.getByText("קורס הדגמה · התקדמות מקומית")).toBeVisible();
  await expectNoOverflowAtWidths(page);
  await expectAccessible(page);
  // Hebrew labels (the roadmap's eyebrows) are not letter-spaced or set in capitals.
  expect(await trackedHebrew(page.locator("body"), { tighter: true })).toEqual([]);

  await page.goto("/demo?locale=en-XA");
  await expect(page.getByRole("button", { name: /⟦/ }).first()).toBeVisible();
  await expect(page.getByText("Demo course · local progress")).toHaveCount(0);
  await expect(page.getByText("Made for a little more understanding.")).toHaveCount(0);
  await expect(page.getByText(/⟦Ṁåðé ƒöŕ/)).toBeVisible();
});
