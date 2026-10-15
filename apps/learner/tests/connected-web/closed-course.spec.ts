import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/* Coverage uses the denominator fixed at enrollment, and a closed (capped) course
 * keeps a bounded number of read-only questions that the companion counts down. */

const axe = (page: Page) =>
  new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();

async function startCourse(page: Page) {
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your learning path" })).toBeVisible();
  const enrollments = (await (await page.request.get("/api/enrollments")).json()) as { id: string; title: string }[];
  return enrollments.find((e) => e.title === "Ordering values")!.id;
}

test("coverage counts core objectives against a fixed denominator", async ({ page }, info) => {
  await startCourse(page);
  const coverage = page.getByTestId("course-coverage");
  await expect(coverage).toContainText(/^0 of \d+ core objectives? covered/);
  await expect(page.getByText(/personal extra/)).toHaveCount(0);
  await page.locator(".connected-menu-toggle").click();
  await expect(page.locator(".connected-menu-description")).toContainText(/core objectives? covered/);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("coverage.png") });
});

test("a closed course counts down its read-only questions and says when none remain", async ({ page }, info) => {
  const enrollmentId = await startCourse(page);
  const closed = await page.request.post("/test/closed-course", { data: { enrollmentId, budget: 1 } });
  expect(closed.ok(), await closed.text()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /Continue learning|Resume course|Open course/ }).first().click();
  await page.getByRole("button", { name: "Inspect Minimum, Current" }).or(page.getByRole("button", { name: /Inspect Minimum/ })).first().click();
  await page.getByRole("button", { name: /Open lesson|Revisit lesson|Continue learning/ }).first().click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const trigger = page.locator(".connected-companion-trigger");
  if (await trigger.isVisible()) await trigger.click();
  const budget = page.locator(".connected-closed-help");
  await expect(budget).toHaveText(/You can still ask 1 more question about its material \(0 of 1 used\)/);
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("Why is the minimum unique?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(budget).toHaveText(/every question it allows after closing has been used/);
  await expect(budget).toHaveClass(/is-exhausted/);
  await page.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("One more?");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("closed-help.png") });
});
