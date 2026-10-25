import { expect, test, type Page } from "./health";
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

test("a closed course answers its read-only question, and a refused question is not counted", async ({ page }, info) => {
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
  const message = page.getByRole("textbox", { name: "Message to your companion", exact: true });
  const sendButton = page.getByRole("button", { name: "Send message", exact: true });
  await message.fill("Why is the minimum unique?");
  await sendButton.click();
  await expect(budget).toHaveText(/every question it allows after closing has been used/);
  // The access policy refuses this question at delivery: it shows as unanswered and its charge returns.
  const refused = await page.request.post("/test/closed-course-answer", { data: { enrollmentId, refuse: true } });
  expect(refused.ok(), await refused.text()).toBe(true);
  expect(await refused.json()).toEqual({ answered: false, jobs: 0 });
  await expect(page.getByText("Not sent · this question could not be passed on to the AI service · nothing was used · you can ask it again", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(budget).toHaveText(/You can still ask 1 more question about its material \(0 of 1 used\)/, { timeout: 15_000 });
  // The returned question is asked again and answered read-only.
  await message.fill("Which value does the minimum keep?");
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(budget).toHaveText(/every question it allows after closing has been used/);
  const answered = await page.request.post("/test/closed-course-answer", { data: { enrollmentId } });
  expect(answered.ok(), await answered.text()).toBe(true);
  expect(await answered.json()).toEqual({ answered: true, jobs: 1 });
  await expect(page.getByText("Scripted answer: the minimum is the one value no other value is smaller than.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Answered", { exact: true })).toBeVisible();
  // Answering never reopens the course or refunds an answered question.
  await expect(budget).toHaveText(/every question it allows after closing has been used/);
  const enrollment = await (await page.request.get(`/api/enrollments/${enrollmentId}`)).json();
  expect(enrollment.status).toBe("closed");
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("closed-answered.png") });
});

test("after closing, the learner can opt into review explicitly and stop it, without reopening the course", async ({ page }, info) => {
  const enrollmentId = await startCourse(page);
  const closed = await page.request.post("/test/closed-course", { data: { enrollmentId, budget: 1 } });
  expect(closed.ok(), await closed.text()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /Continue learning|Resume course|Open course/ }).first().click();
  const track = page.locator(".connected-continuation");
  await expect(track.getByRole("heading", { name: "Keep reviewing after the course" })).toBeVisible();
  await expect(track).toContainText("Nothing is required");
  await expect(track).toContainText("The course stays closed");
  const start = track.getByRole("button", { name: "Start reviewing", exact: true });
  await expect(start).toBeDisabled();
  expect((await axe(page)).violations).toEqual([]);
  await track.getByRole("checkbox").check();
  await start.click();
  await expect(track.getByRole("status")).toContainText("You are reviewing after the course");
  const view = await (await page.request.get(`/api/enrollments/${enrollmentId}/continuation`)).json();
  expect(view.track.state).toBe("active");
  expect((await (await page.request.get(`/api/enrollments/${enrollmentId}`)).json()).status).toBe("closed");
  await page.screenshot({ path: info.outputPath("continuation.png") });
  await track.getByRole("button", { name: "Stop reviewing", exact: true }).click();
  await expect(track).toContainText("You stopped reviewing on");
  await expect(track.getByRole("button", { name: "Start reviewing again", exact: true })).toBeDisabled();
});
