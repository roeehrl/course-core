import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { settled } from "./conversation-helpers";

/* Coverage uses the denominator fixed at enrollment, and a closed (capped) course
 * keeps a bounded number of read-only questions that the companion counts down. */

// A reply fading in (M1) is measured once its fade has ended.
const axe = async (page: Page) => {
  await settled(page);
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
};

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
  // A closed course offers no next step; its lessons stay open to read from the path.
  await expect(page.getByTestId("next-step")).toContainText("This course is closed");
  await page.getByRole("button", { name: /^Lesson 1: Minimum, / }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const trigger = page.locator(".connected-companion-trigger");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  // One banner above the composer, with the details behind its ⓘ.
  const notice = page.locator("#connected-companion .cc-chat-notice");
  await expect(notice).toContainText("Course closed · 1 question left");
  await notice.getByRole("button", { name: "More about this" }).click();
  await expect(notice).toContainText("Questions never change your results. 0 of 1 used.");
  expect((await axe(page)).violations).toEqual([]);
  await page.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("Why is the minimum unique?");
  await page.locator("#connected-companion .cc-chat-send").click();
  // Every question is used: a block replaces the composer, saying why (not "this lesson").
  const exhausted = page.locator("#connected-companion .cc-chat-exhausted");
  await expect(exhausted).toHaveText("You've used every question this closed course allows. Your conversation and the course stay here to read.");
  await expect(page.getByRole("textbox", { name: "Message to your companion", exact: true })).toHaveCount(0);
  await expect(page.getByText(/isn't taking questions/)).toHaveCount(0);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("closed-help.png") });
});

test("a closed course answers its read-only question, and a refused question is not counted", async ({ page }, info) => {
  const enrollmentId = await startCourse(page);
  const closed = await page.request.post("/test/closed-course", { data: { enrollmentId, budget: 1 } });
  expect(closed.ok(), await closed.text()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: /Continue learning|Resume course|Open course/ }).first().click();
  // A closed course offers no next step; its lessons stay open to read from the path.
  await expect(page.getByTestId("next-step")).toContainText("This course is closed");
  await page.getByRole("button", { name: /^Lesson 1: Minimum, / }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const trigger = page.locator(".connected-companion-trigger");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const notice = page.locator("#connected-companion .cc-chat-notice");
  const exhausted = page.locator("#connected-companion .cc-chat-exhausted");
  const message = page.getByRole("textbox", { name: "Message to your companion", exact: true });
  const sendButton = page.locator("#connected-companion .cc-chat-send");
  await message.fill("Why is the minimum unique?");
  await sendButton.click();
  await expect(exhausted).toBeVisible();
  // The access policy refuses this question at delivery: it shows as not sent and its charge returns.
  const refused = await page.request.post("/test/closed-course-answer", { data: { enrollmentId, refuse: true } });
  expect(refused.ok(), await refused.text()).toBe(true);
  expect(await refused.json()).toEqual({ answered: false, jobs: 0 });
  const question = page.locator("#connected-companion .cc-chat-turn.is-learner").filter({ hasText: "Why is the minimum unique?" });
  await expect(question.getByText("This question couldn't be sent. Edit it and try again.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("Course closed · 1 question left", { timeout: 15_000 });
  // Edit puts the question back in the box; the returned question is asked again and answered read-only.
  await question.getByRole("button", { name: "Edit" }).click();
  await expect(message).toHaveValue("Why is the minimum unique?");
  await message.fill("Which value does the minimum keep?");
  await expect(sendButton).not.toHaveAttribute("aria-disabled", "true");
  await sendButton.click();
  await expect(exhausted).toBeVisible();
  const answered = await page.request.post("/test/closed-course-answer", { data: { enrollmentId } });
  expect(answered.ok(), await answered.text()).toBe(true);
  expect(await answered.json()).toEqual({ answered: true, jobs: 1 });
  await expect(page.getByText("Scripted answer: the minimum is the one value no other value is smaller than.", { exact: true })).toBeVisible({ timeout: 15_000 });
  // The reply is the answer: no "Answered" label.
  await expect(page.getByText("Answered", { exact: true })).toHaveCount(0);
  // Answering never reopens the course or refunds an answered question.
  await expect(exhausted).toBeVisible();
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
