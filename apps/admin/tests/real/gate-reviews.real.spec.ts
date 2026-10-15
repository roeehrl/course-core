import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
async function openQueue(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "Answer reviews" }).click();
  await expect(page.getByRole("heading", { name: "Answer reviews", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gate review requests" })).toBeVisible();
}
const card = (page: Page, learner: string) => page.locator("section.card").filter({ hasText: `${learner} · min-gate` });

test("a reviewer upholds a gate decision and an instructor grants an exception, through the real API", async ({ page, browser }, info) => {
  const fixture = await (await page.request.post("/test/gate-review-fixture")).json();

  // A reviewer may uphold but is never offered an exception.
  await openQueue(page, fixture.reviewerCode);
  const avery = card(page, "Avery Learner");
  await expect(avery.getByText("I worked through the lesson but ran out of time for the transfer task.")).toBeVisible();
  await expect(avery.getByRole("region", { name: "Decision under review for Avery Learner" })).toBeVisible();
  await expect(avery.getByRole("radio", { name: /Grant an exception/ })).toHaveCount(0);
  await expect(avery.getByText("Only owners, admins and instructors can grant an exception.")).toBeVisible();
  const uphold = avery.getByRole("button", { name: "Uphold decision" });
  await avery.getByLabel("Message to the learner").fill("too short");
  await expect(uphold).toBeDisabled();
  await avery.getByLabel("Message to the learner").fill("The transfer task is still required; try the prediction item next.");
  expect((await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations).toEqual([]);
  await expect(page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).resolves.toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("gate-review-reviewer.png"), fullPage: true });
  await uphold.click();
  await expect(page.getByText("Decision upheld for Avery Learner on min-gate.")).toBeVisible();
  await expect(card(page, "Avery Learner")).toHaveCount(0);

  // The server still refuses an exception from the reviewer, whatever the page shows.
  const blake = (await (await page.request.get(`/api/admin/courses/${await catalogId(page)}/gate-reviews`)).json()).reviews[0];
  expect(blake.canGrantException).toBe(false);
  const refused = await page.request.post(`/api/admin/gate-reviews/${blake.requestId}`, {
    headers: { origin: info.project.use.baseURL!, "x-csrf-token": await csrf(page) },
    data: { outcome: "exception", note: "Trying an exception as a reviewer.", idempotencyKey: "gate-review-forbidden-1" },
  });
  expect(refused.status()).toBe(403);

  // An instructor grants an exception for the other learner.
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport: page.viewportSize()!, ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}) });
  const instructor = await context.newPage();
  await openQueue(instructor, fixture.instructorCode);
  const other = card(instructor, "Blake Learner");
  await other.getByRole("radio", { name: /Grant an exception/ }).check();
  await expect(other.getByText("An exception is not evidence")).toBeVisible();
  await other.getByLabel("Message to the learner").fill("Granted after the deadline extension request; the transfer task stays open.");
  expect((await new AxeBuilder({ page: instructor }).withTags(axeTags).analyze()).violations).toEqual([]);
  await instructor.screenshot({ path: info.outputPath("gate-review-instructor.png"), fullPage: true });
  await other.getByRole("button", { name: "Grant exception" }).click();
  await expect(instructor.getByText("Exception granted for Blake Learner on min-gate.")).toBeVisible();
  await expect(instructor.getByText("No gate reviews waiting")).toBeVisible();
  await context.close();
});

async function catalogId(page: Page) {
  const session = await (await page.request.get("/api/admin/session")).json();
  return session.courses[0].id as string;
}
async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find((c) => c.name === "course_csrf");
  return decodeURIComponent(cookie!.value);
}
