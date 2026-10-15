import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/* Placement retests, when staff allow them: a "Retake placement" entry point only
 * when the server says a retest is allowed, and plain words for the limit and
 * the cooldown otherwise. */

const axe = (page: Page) =>
  new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();

async function finishPlacementRun(page: Page) {
  const run = page.locator("section.connected-placement");
  await run.getByRole("button", { name: /Stop and see my result|See my result/ }).click();
  await expect(run.getByRole("heading", { name: "Your placement result" })).toBeVisible();
  return run;
}

async function openPlacement(page: Page, settings: { maxRuns: number; cooldownHours?: number }) {
  const token = (await (await page.request.post("/test/session")).json()).token;
  // Settings are per course: set them before the course is opened.
  expect((await page.request.post("/test/placement-retests", { data: settings })).ok()).toBe(true);
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  const run = page.locator("section.connected-placement");
  await run.getByRole("button", { name: "Find my starting point" }).click();
  await expect(run.getByRole("heading", { name: /Placement question 1/ })).toBeVisible();
  return finishPlacementRun(page);
}

test("Retake placement appears only when allowed, then reports the attempt limit", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const run = await openPlacement(page, { maxRuns: 2 });
  await expect(run.getByText(/attempt 2 of 2\. It uses only questions you have not seen/)).toBeVisible();
  const retake = run.getByRole("button", { name: "Retake placement" });
  const box = (await retake.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("placement-retake.png") });
  await retake.click();
  await expect(run.getByRole("heading", { name: /Placement question/ })).toBeVisible();
  await finishPlacementRun(page);
  await expect(run.getByText("You have used all 2 placement attempts this course allows.")).toBeVisible();
  await expect(run.getByRole("button", { name: "Retake placement" })).toHaveCount(0);
  expect((await axe(page)).violations).toEqual([]);
  expect(errors).toEqual([]);
});

test("during a cooldown the learner sees when a retake becomes possible, with no button", async ({ page }) => {
  const run = await openPlacement(page, { maxRuns: 3, cooldownHours: 48 });
  await expect(run.getByText(/You can retake placement from .+ \(attempt 2 of 3\)/)).toBeVisible();
  await expect(run.getByRole("button", { name: "Retake placement" })).toHaveCount(0);
});

test("without retests the result shows no retake at all", async ({ page }) => {
  const run = await openPlacement(page, { maxRuns: 1 });
  await expect(run.locator(".connected-placement-retake")).toHaveCount(0);
});
