import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedSnapshot } from "../connectedFixtures";

/** No horizontal scrolling: the page is never wider than the viewport. */
async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}
async function expectAccessible(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze())
      .violations,
  ).toEqual([]);
}

test("the signed-out learner switches sign-in to Hebrew: html lang/dir, right-to-left, no overflow", async ({
  page,
}) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  await page.route("**/auth/options", (route) => route.fulfill({ json: { loginCodes: true } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pick up where you left off." })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByLabel("Language").selectOption("he");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { name: "ממשיכים מאיפה שעצרת." })).toBeVisible();
  await expect(page.getByRole("button", { name: "כניסה", exact: true })).toBeVisible();
  // The form's start edge is the right edge in right-to-left layout.
  const field = await page.getByRole("textbox", { name: "שם משתמש" }).boundingBox();
  const label = await page.getByText("שם משתמש", { exact: true }).boundingBox();
  expect(label!.x + label!.width).toBeGreaterThan(field!.x + field!.width - 4);
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});

test("a signed-in learner's saved Hebrew preference lays out the course shell right to left, and the profile switches back", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "course_csrf", value: "mock-csrf", url: "http://127.0.0.1:4173" }]);
  const snapshot = connectedSnapshot();
  const saved: unknown[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { user: { id: "public-user", displayName: "Public learner", locale: "he" } } }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/me/locale" && request.method() === "PUT") {
      saved.push({ body: request.postDataJSON(), csrf: request.headers()["x-csrf-token"] });
      return route.fulfill({ json: { preference: "en", locale: "en", source: "user" } });
    }
    if (path === "/api/me/locale")
      return route.fulfill({ json: { preference: "he", locale: "he", source: "user" } });
    if (path === "/api/enrollments")
      return route.fulfill({
        json: [{ id: snapshot.enrollmentId, title: snapshot.course.title, version: "1.0.0", status: "active" }],
      });
    if (path === "/api/workspaces") return route.fulfill({ json: [] });
    if (path === `/api/enrollments/${snapshot.enrollmentId}`) return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expectNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "ניווט בלמידה" })).toBeVisible();
  const back = page.locator("nav.connected-navigation button");
  await expect(back).toHaveText("← כל הקורסים");
  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "הקורס שלך" }).click();
  await page.getByRole("button", { name: "הפרופיל שלי" }).click();
  await expect(back).toHaveText("← חזרה ללמידה");
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  await page.getByLabel("שפה").selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(back).toHaveText("← Back to learning");
  await expect.poll(() => saved).toEqual([{ body: { locale: "en" }, csrf: "mock-csrf" }]);
});
