import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const accessible = async (page: Page) => {
  expect((await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations).toEqual([]);
  await expect(page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).resolves.toBeLessThanOrEqual(1);
};
async function openSupervision(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "AI supervision" }).click();
  await expect(page.getByRole("heading", { name: "AI supervision", level: 1 })).toBeVisible();
  await page.getByLabel("Learner", { exact: true }).selectOption({ label: "Avery Learner" });
}

test("an instructor pauses, stops and resumes a learner's AI supervision; a reviewer only reads it", async ({ page, browser }, info) => {
  const fixture = await (await page.request.post("/test/supervision-fixture")).json();
  await openSupervision(page, fixture.instructorCode);
  await expect(page.getByText("AI supervision is running for this learner.")).toBeVisible();
  await page.getByLabel("Reason (optional)").selectOption("staff_review");
  await page.getByRole("button", { name: "Pause supervision" }).click();
  await expect(page.getByText("Supervision paused.")).toBeVisible();
  await expect(page.getByText(/^Paused: no new AI calls/)).toBeVisible();
  await expect(page.getByText(/staff review · revision 1/)).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("paused.png"), fullPage: true });

  await page.getByRole("button", { name: "Stop supervision" }).click();
  await expect(page.getByText("Stop cancels unfinished work")).toBeVisible();
  await accessible(page);
  await page.getByRole("button", { name: "Confirm stop" }).click();
  await expect(page.getByText(/Supervision stopped\. 0 unfinished job/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause supervision" })).toHaveCount(0);

  // A reviewer sees the same state and has no controls.
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, ...(info.project.use.viewport ? { viewport: info.project.use.viewport } : {}),
    ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}) });
  const reviewer = await context.newPage();
  await openSupervision(reviewer, fixture.reviewerCode);
  await expect(reviewer.getByText(/^Stopped: every unfinished AI job/)).toBeVisible();
  await expect(reviewer.getByText("Your role can see supervision but not change it.")).toBeVisible();
  await expect(reviewer.getByRole("button", { name: "Resume supervision" })).toHaveCount(0);
  await context.close();

  await page.getByRole("button", { name: "Resume supervision" }).click();
  await expect(page.getByText("Supervision resumed.")).toBeVisible();
  await expect(page.getByText("AI supervision is running for this learner.")).toBeVisible();
});
