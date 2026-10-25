import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedSnapshot } from "../connectedFixtures";

/**
 * The connection status (offline, a saved request not yet recorded, a slow server) used to be
 * inserted at the top of the learning column, pushing the course down while the learner read.
 * It now floats at the bottom of the window as a snackbar: nothing on the page moves when it
 * appears or goes. The "Your course" menu marks the view on screen without English words, so it
 * reads the same in Hebrew.
 */
const TEXT = {
  en: {
    resume: "Continue learning →",
    offline: "You’re offline.",
    slow: "The server is slow to answer.",
    read: "Mark this part read",
    path: "Learning path",
  },
  he: {
    resume: "המשך למידה ←",
    offline: "אין חיבור.",
    slow: "השרת עונה לאט.",
    read: "סימון החלק כנקרא",
    path: "מסלול הלמידה",
  },
} as const;
type Locale = keyof typeof TEXT;

/** The connected host on fixtures: one course, opened at its roadmap. `/read` can be held. */
async function openCourse(page: Page, locale: Locale) {
  const snapshot = connectedSnapshot();
  const held: { release?: () => void } = {};
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: {
        user: { id: "public-user", displayName: "Public learner", locale },
      },
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/me/locale")
      return route.fulfill({
        json: { preference: locale, locale, source: "user" },
      });
    if (path === "/api/enrollments")
      return route.fulfill({
        json: [
          {
            id: snapshot.enrollmentId,
            title: snapshot.course.title,
            version: "1.0.0",
            status: "active",
          },
        ],
      });
    if (path === "/api/workspaces") return route.fulfill({ json: [] });
    if (path === "/api/me/notifications")
      return route.fulfill({
        json: { items: [], unread: 0, nextCursor: null },
      });
    if (path.endsWith("/companion"))
      return route.fulfill({ json: { messages: [] } });
    if (path.endsWith("/read")) {
      await new Promise<void>((resolve) => (held.release = resolve));
      const input = request.postDataJSON();
      snapshot.lessons[0]!.completedBlockIds.push(input.blockId);
      snapshot.revision++;
      return route.fulfill({ json: { revision: snapshot.revision } });
    }
    if (path === `/api/enrollments/${snapshot.enrollmentId}`)
      return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.goto(`/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await page
    .getByRole("button", { name: TEXT[locale].resume, exact: true })
    .first()
    .click();
  await expect(page.locator(".connected-main h1").first()).toBeVisible();
  return held;
}

/** Where the header, the column and everything in it are, in page coordinates. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".connected-main")!;
    const scrollTop = window.scrollY + main.scrollTop;
    return [
      document.querySelector(".connected-header")!,
      main,
      ...Array.from(main.querySelectorAll("h1, h2, button, summary")).slice(
        0,
        12,
      ),
    ].map((element) => {
      const box = element.getBoundingClientRect();
      return [
        Math.round(box.x),
        Math.round(box.y + scrollTop),
        Math.round(box.width),
      ].join(",");
    });
  });
}
/** The layout once the page has finished drawing (the same twice in a row). */
async function settledLayout(page: Page) {
  let last = await layout(page);
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(150);
    const next = await layout(page);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  throw new Error("the page kept moving");
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
/** The status floats inside the window, below the header, and does not widen the page. */
async function expectFloating(page: Page) {
  const status = page.locator(".connected-connection");
  const box = (await status.boundingBox())!;
  const header = (await page.locator(".connected-header").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(
    await status.evaluate((element) => getComputedStyle(element).position),
  ).toBe("fixed");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThan(header.y + header.height);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(viewport.width);
  // The sticky answer actions and the column's end make room for it.
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue(
        "--connected-status-offset",
      ),
    ),
  ).toBe(`${Math.ceil(box.height) + 16}px`);
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: going offline shows the status over the page without moving it`, async ({
    page,
    context,
  }) => {
    const text = TEXT[locale];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openCourse(page, locale);
    await expect(page.locator(".connected-connection")).toHaveCount(0);
    const before = await settledLayout(page);

    await context.setOffline(true);
    const status = page.getByRole("status").filter({ hasText: text.offline });
    await expect(status).toBeVisible();
    expect(await settledLayout(page)).toEqual(before);
    await expectFloating(page);
    await expectAccessible(page);

    await context.setOffline(false);
    await expect(page.locator(".connected-connection")).toHaveCount(0);
    expect(await settledLayout(page)).toEqual(before);
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue(
          "--connected-status-offset",
        ),
      ),
    ).toBe("");
    expect(errors).toEqual([]);
  });

  test(`${locale}: the current view in the course menu is marked without English words`, async ({
    page,
  }) => {
    const text = TEXT[locale];
    await openCourse(page, locale);
    await page.locator(".connected-menu-toggle").click();
    const current = page
      .locator(".connected-menu-panel")
      .locator('button[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAccessibleName(text.path);
    // The marker is drawn, not written: no generated text in any language.
    const generated = await current.evaluate((element) =>
      ["::before", "::after"].map(
        (pseudo) => getComputedStyle(element, pseudo).content,
      ),
    );
    for (const content of generated)
      expect(content === "none" || content === '""').toBe(true);
    const marker = await current.evaluate((element) => {
      const style = getComputedStyle(element, "::before");
      return { width: style.width, background: style.backgroundColor };
    });
    expect(marker.width).toBe("4px");
    expect(marker.background).not.toBe("rgba(0, 0, 0, 0)");
    if (locale === "he")
      expect(
        await page
          .locator(".connected-menu-panel")
          .evaluate((panel) => (panel as HTMLElement).innerText),
      ).not.toMatch(/\bshown\b/i);
    await expectAccessible(page);
  });
}

test("a slow answer from the server is reported over the page without moving it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const held = await openCourse(page, "en");
  await page
    .getByRole("button", { name: TEXT.en.resume, exact: true })
    .first()
    .click();
  const read = page.getByRole("button", { name: TEXT.en.read, exact: true });
  await expect(read).toBeVisible();
  await read.click();
  await expect.poll(() => Boolean(held.release)).toBe(true);
  const before = await settledLayout(page);
  // The status appears after the request has run for six seconds.
  const status = page.getByRole("status").filter({ hasText: TEXT.en.slow });
  await expect(status).toBeVisible({ timeout: 15_000 });
  expect(await layout(page)).toEqual(before);
  await expectFloating(page);
  held.release!();
  await expect(page.locator(".connected-connection")).toHaveCount(0);
});
