import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { openProfile } from "./learner-menu.js";

const tags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
/** Requirement B06 (and B03 shown to the learner): the learner decides a new overall goal the
 * supervisor proposed, can go back to their earlier goal, and sees the teaching work started for them. */
test("the learner decides a proposed goal, can undo it, and sees the work the supervisor started", async ({ page, request }, info) => {
  const session = await request.post("/test/supervisor-requests-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await openProfile(page);
  const panel = page.getByRole("region", { name: "Decisions and work from your supervisor" });
  await expect(panel.getByText("Suggested goal: Find minima and maxima", { exact: true })).toBeVisible();
  await expect(panel.getByText("Why: You asked about maxima twice.", { exact: true })).toBeVisible();
  await expect(panel.getByText("A side-by-side example of a common mix-up")).toBeVisible();
  await expect(panel.getByText("None of this counts as an assessment result or changes your progress.")).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#supervisor-requests-title").withTags(tags).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("supervisor-requests.png") });

  await panel.getByRole("button", { name: "Use this goal", exact: true }).click();
  await expect(panel.getByText(/Your goal is updated/)).toBeVisible();
  await expect(panel.getByText(/in use/)).toBeVisible();
  await panel.getByRole("button", { name: "Go back to my earlier goal", exact: true }).click();
  await expect(panel.getByText("Your earlier goal is back.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Go back to my earlier goal", exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(tags).analyze()).violations).toEqual([]);
});
