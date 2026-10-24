import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";

/**
 * No horizontal scrolling: the page is never wider than the configured viewport. Compared
 * with the viewport, not innerWidth: a mobile browser widens its layout viewport to fit
 * content that overflows, so innerWidth alone would hide the overflow on phones.
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}

test("switching to Hebrew sets html lang/dir, saves the preference and lays the shell out right to left", async ({
  page,
  context,
}) => {
  const session = demoSession("administrator"),
    workspace = {
      ...demoWorkspace(session.courses[0]!, "administrator"),
      role: "admin",
    };
  const saved: { body: unknown; csrf?: string }[] = [];
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
  await page.route("**/api/me/locale", async (route) => {
    if (route.request().method() === "PUT") {
      saved.push({
        body: route.request().postDataJSON(),
        csrf: route.request().headers()["x-csrf-token"],
      });
      await route.fulfill({
        json: { preference: "he", locale: "he", source: "user" },
      });
    } else
      await route.fulfill({
        json: { preference: null, locale: "en", source: "request" },
      });
  });
  await page.route("**/api/workspaces", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/admin/courses/sorting", (route) =>
    route.fulfill({ json: workspace }),
  );
  await page.goto("/admin/");
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expectNoHorizontalOverflow(page);

  // The language is chosen in the account menu at the end of the top bar.
  await page.getByRole("button", { name: "Your account: Mock user" }).click();
  await page.getByRole("menuitemradio", { name: "עברית" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("סביבה מחוברת")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "קורס וגרסאות",
  );
  await page
    .getByRole("button", { name: /^החשבון שלך: \W*Mock user\W*$/ })
    .click();
  await expect(page.getByRole("menuitem", { name: "יציאה" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect
    .poll(() => saved)
    .toEqual([{ body: { locale: "he" }, csrf: "mock-csrf" }]);
  // The navigation sits on the right in right-to-left layout on wide screens.
  const viewport = page.viewportSize()!;
  if (viewport.width >= 1000) {
    const sidebar = await page.locator(".sidebar").boundingBox();
    expect(sidebar!.x + sidebar!.width).toBeGreaterThan(viewport.width - 4);
  }
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  // The choice survives a reload (stored on this device; the server agrees).
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("סביבה מחוברת")).toBeVisible();
});

test("the signed-out sign-in screen switches to Hebrew without horizontal overflow", async ({
  page,
}) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  await page.route("**/auth/options", (route) =>
    route.fulfill({ json: { loginCodes: true } }),
  );
  await page.goto("/admin/");
  await page.getByLabel("Language").selectOption("he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: "כניסה לאזור הניהול" }),
  ).toBeVisible();
  await expect(page.getByLabel("קוד כניסה חד-פעמי")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});

test("the en-XA pseudo-locale marks every translated string", async ({
  page,
}) => {
  await page.route("**/auth/session", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  await page.route("**/auth/options", (route) =>
    route.fulfill({ json: { loginCodes: false } }),
  );
  await page.goto("/admin/?locale=ar-XB");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar-XB");
  await page.goto("/admin/?locale=en-XA");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(/^⟦.+~⟧$/);
  await expectNoHorizontalOverflow(page);
});
