import { expect, test } from "./health";
import AxeBuilder from "@axe-core/playwright";

// Real API and PostgreSQL: the learner's notification bell (owner decision 8). A learner whose
// course was updated sees one new notification, opens it and lands on that course; the read state
// is kept by the server.
test("the learner's bell shows a course update and opens the course", async ({ page }) => {
  const token = (await (await page.request.post("/test/notification-session")).json()).token;
  await page.goto(`/#signin=${token}`);
  const bell = page.getByRole("button", { name: "Notifications, 1 new" });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByText(/Your course was updated from version .*0\.9\.0.* to version .*1\.0\.0/)).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).include(".connected-header").analyze()).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your learning path" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
});
