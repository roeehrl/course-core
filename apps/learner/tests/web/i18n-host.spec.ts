import { test, expect, type Page } from "@playwright/test";
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
  expect(await trackedHebrew(page.locator("body"))).toEqual([]);

  await page.goto("/demo?locale=en-XA");
  await expect(page.getByRole("button", { name: /⟦/ }).first()).toBeVisible();
  await expect(page.getByText("Demo course · local progress")).toHaveCount(0);
  await expect(page.getByText("Made for a little more understanding.")).toHaveCount(0);
  await expect(page.getByText(/⟦Ṁåðé ƒöŕ/)).toBeVisible();
});
