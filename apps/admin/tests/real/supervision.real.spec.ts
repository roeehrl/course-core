import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const accessible = async (page: Page) => {
  expect(
    (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
};
async function openSupervision(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "AI supervision" })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI supervision", level: 1 }),
  ).toBeVisible();
  await page
    .getByLabel("Learner", { exact: true })
    .selectOption({ label: "Avery Learner" });
}

test("an instructor pauses, stops and resumes a learner's AI supervision; a reviewer only reads it", async ({
  page,
  browser,
}, info) => {
  const fixture = await (
    await page.request.post("/test/supervision-fixture")
  ).json();
  await openSupervision(page, fixture.instructorCode);
  await expect(
    page.getByText("AI supervision is running for this learner."),
  ).toBeVisible();
  // A request refused on a permanent conflict is listed with its reason, never retried.
  const undelivered = page.getByRole("region", {
    name: "Requests that did not run",
  });
  await expect(undelivered.getByRole("row")).toHaveCount(3);
  await expect(
    undelivered.getByRole("rowheader", { name: "Companion request" }),
  ).toBeVisible();
  await expect(undelivered.getByText("refused", { exact: true })).toBeVisible();
  await expect(
    undelivered.getByText("supervisor companion context invalid"),
  ).toBeVisible();
  // A quarantined request is listed too, but only owners and admins may re-queue it.
  await expect(
    undelivered.getByText("quarantined", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Re-queue/ })).toHaveCount(0);
  await accessible(page);
  await page.getByLabel("Reason (optional)").selectOption("staff_review");
  await page.getByRole("button", { name: "Pause supervision" }).click();
  await expect(page.getByText("Supervision paused.")).toBeVisible();
  await expect(page.getByText(/^Paused: no new AI calls/)).toBeVisible();
  await expect(page.getByText(/staff review · revision 1/)).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("paused.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Stop supervision" }).click();
  await expect(page.getByText("Stop cancels unfinished work")).toBeVisible();
  await accessible(page);
  await page.getByRole("button", { name: "Confirm stop" }).click();
  // The fixture's job waiting for a staff decision is the one unfinished job.
  await expect(
    page.getByText(/Supervision stopped\. 1 unfinished job/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause supervision" }),
  ).toHaveCount(0);

  // A reviewer sees the same state and has no controls.
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    ...(info.project.use.viewport
      ? { viewport: info.project.use.viewport }
      : {}),
    ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const reviewer = await context.newPage();
  await openSupervision(reviewer, fixture.reviewerCode);
  await expect(
    reviewer.getByText(/^Stopped: every unfinished AI job/),
  ).toBeVisible();
  await expect(
    reviewer.getByText("Your role can see supervision but not change it."),
  ).toBeVisible();
  await expect(
    reviewer.getByRole("button", { name: "Resume supervision" }),
  ).toHaveCount(0);
  await context.close();

  await page.getByRole("button", { name: "Resume supervision" }).click();
  await expect(page.getByText("Supervision resumed.")).toBeVisible();
  await expect(
    page.getByText("AI supervision is running for this learner."),
  ).toBeVisible();
});

test("an owner re-queues a request quarantined after an outage once, with a reason; a refused request cannot be re-queued", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/supervision-fixture")
  ).json();
  await openSupervision(page, fixture.ownerCode);
  const undelivered = page.getByRole("region", {
    name: "Requests that did not run",
  });
  await expect(undelivered.getByRole("row")).toHaveCount(3);
  // The refused companion question has no action; the quarantined update does.
  await expect(undelivered.getByText("Not re-queueable")).toBeVisible();
  const requeue = undelivered.getByRole("button", {
    name: /^Re-queue Request \(learning\.updated\)/,
  });
  await expect(requeue).toHaveCount(1);
  await requeue.click();
  await expect(
    page.getByText("Re-queue Request (learning.updated)", { exact: true }),
  ).toBeVisible();
  const confirm = page.getByRole("button", { name: "Re-queue once" });
  // A reason is required.
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Reason for re-queueing").fill("short");
  await expect(confirm).toBeDisabled();
  await page
    .getByLabel("Reason for re-queueing")
    .fill("Provider outage resolved; delivering again.");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("requeue.png"),
    fullPage: true,
  });
  await confirm.click();
  await expect(
    page.getByText(/^Request re-queued with fresh attempts\./),
  ).toBeVisible();
  // Released for delivery: it no longer appears as quarantined, and the refused request stays.
  await expect(undelivered.getByRole("row")).toHaveCount(2);
  await expect(
    undelivered.getByText("quarantined", { exact: true }),
  ).toHaveCount(0);
  await expect(
    undelivered.getByRole("rowheader", { name: "Companion request" }),
  ).toBeVisible();
  await accessible(page);
});

test("an owner checks and saves the supervision settings, decides a spending-limit request and sets a learner's daily limits", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/supervision-fixture")
  ).json();
  await openSupervision(page, fixture.ownerCode);
  await expect(
    page.getByRole("heading", { name: "AI supervision settings" }),
  ).toBeVisible();
  // Saving needs a check of what the change does first.
  await page.getByRole("radio", { name: /^Only suggest/ }).check();
  const save = page.getByRole("button", { name: "Save settings" });
  await expect(save).toBeDisabled();
  await expect(
    page.getByText("Check what the change does before saving it."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check what this changes" }).click();
  await expect(
    page.getByText("No new teaching work starts for any learner."),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("settings-preview.png"),
    fullPage: true,
  });
  await save.click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  // A tool family switched off is previewed as tools no longer used.
  await page.getByRole("checkbox", { name: /^Visuals/ }).uncheck();
  await page.getByRole("button", { name: "Check what this changes" }).click();
  await expect(page.getByText(/will no longer be used/)).toBeVisible();

  // The spending-limit request waits for an owner.
  await expect(page.getByText("Higher AI spending limit")).toBeVisible();
  await expect(
    page.getByText("Why: Two more practice sessions this week."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.getByText(
      "Approved. The change is in force and the supervisor continues.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Nothing is waiting for a decision."),
  ).toBeVisible();

  // The learner's daily and per-lesson limits, with a plain error when they cannot work together.
  await expect(
    page.getByRole("heading", { name: "AI spending limits for this learner" }),
  ).toBeVisible();
  await page.getByLabel("Per day (US dollars)", { exact: true }).fill("0.5");
  await page.getByLabel("Per day (tokens)", { exact: true }).fill("20000");
  await page.getByLabel("Per lesson per day (US dollars)").fill("1");
  await page.getByLabel("Per lesson per day (tokens)").fill("10000");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(
    page.getByText(/The per-lesson limit is more than the daily limit/),
  ).toBeVisible();
  await page.getByLabel("Per lesson per day (US dollars)").fill("0.25");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByText("Limits saved.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove limits" }),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("learner-limits.png"),
    fullPage: true,
  });
});

test("an instructor sees no workspace settings, spending limits or decisions", async ({
  page,
}) => {
  const fixture = await (
    await page.request.post("/test/supervision-fixture")
  ).json();
  await openSupervision(page, fixture.instructorCode);
  await expect(
    page.getByText("AI supervision is running for this learner."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "AI supervision settings" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Changes waiting for your decision" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "AI spending limits for this learner" }),
  ).toHaveCount(0);
});
