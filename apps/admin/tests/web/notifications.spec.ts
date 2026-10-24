import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** The staff notification center in the public demo (in-memory port, fictional conditions):
 * the bell's count, the panel, going to the place to act, marking read, on phone and desktop, in
 * English and Hebrew. */

async function expectNoHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}

test("the bell counts what needs attention and opens the place to act", async ({
  page,
}) => {
  await page.goto("/admin/demo?locale=en");
  const bell = page.getByRole("button", { name: "Notifications, 4 unread" });
  await expect(bell).toBeVisible();
  await bell.click();
  const panel = page.getByRole("dialog", { name: "Needs attention" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("3 items wait for a decision")).toBeVisible();
  await expect(panel.getByText("1 AI run failed in the last day")).toBeVisible();
  await expect(panel.getByText("Learner tutor needs a quality check")).toBeVisible();
  await expect(panel.getByText("AI spending is at 84% of the limit")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const results = await new AxeBuilder({ page })
    .include(".notification-panel")
    .analyze();
  expect(results.violations).toEqual([]);
  // The panel stays inside the screen.
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await panel.getByRole("button", { name: "Go there" }).first().click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Overview",
  );
  await expect(
    page.getByRole("button", { name: "Notifications, 3 unread" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Notifications, 3 unread" }).click();
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    page.getByRole("button", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("the bell and its panel in Hebrew, right to left", async ({ page }) => {
  await page.goto("/admin/demo?locale=he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("button", { name: "התראות, 4 חדשות" }).click();
  const panel = page.getByRole("dialog", { name: "מחכה לטיפול" });
  await expect(panel.getByText("3 פריטים מחכים להחלטה")).toBeVisible();
  await expect(panel.getByText(/נדרשת בדיקת איכות/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
