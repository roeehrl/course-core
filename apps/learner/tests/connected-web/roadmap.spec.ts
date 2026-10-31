import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";

/*
 * The course page and the lesson page as a learner meets them (0.1.60 owner review): the page says
 * where the learner is, what is next and how far along they are, in words that match their real
 * state, on every device project.
 */

async function signIn(page: Page, session = "/test/session") {
  const token = (await (await page.request.post(session)).json()).token;
  await page.goto(`/#signin=${token}`);
}
async function startCourse(page: Page) {
  await signIn(page);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your learning path" }),
  ).toBeVisible();
}

// A first visit: no remembered companion pane preference.
test.use({ companionPane: "default" });

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();

test("a fresh enrollment says start, the lesson's details are in the next step, and locked lessons are quiet", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await startCourse(page);
  const next = page.getByTestId("next-step");
  // Never "pick up where you left off" before anything was started.
  await expect(next).toContainText("Start here");
  await expect(next.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  await expect(next).toContainText(/^.*Lesson 1 of 2 · Order · \d+ min · 1 part/);
  await expect(next.getByRole("button", { name: "Start the course →", exact: true })).toBeVisible();
  for (const stale of ["Pick up where you left off", "Your next small step", "Continue learning", "Inside this lesson"])
    await expect(page.getByText(stale)).toHaveCount(0);
  // How far along: lessons complete, out of the whole course.
  await expect(page.getByTestId("course-progress")).toContainText("0 of 2 lessons complete");
  // No card after the path: the next step comes before it, and the path's last chapter ends the page.
  const nextBox = (await next.boundingBox())!;
  const pathBox = (await page.getByRole("heading", { name: "Your learning path" }).boundingBox())!;
  expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(pathBox.y);
  expect(
    await page.getByTestId("course-roadmap").evaluate((roadmap) => {
      const chapters = roadmap.querySelectorAll('[data-testid="roadmap-chapter"]');
      const last = chapters[chapters.length - 1]!.getBoundingClientRect();
      return Math.round(roadmap.getBoundingClientRect().bottom - last.bottom);
    }),
  ).toBe(0);
  // The current chapter is open; its locked lesson is a padlock and a title, "Locked" said to
  // assistive technology only, and no button leads into it.
  await expect(page.getByRole("button", { name: /^Order/ })).toHaveAttribute("aria-expanded", "true");
  const lessons = page.getByRole("list", { name: "Lessons in Order" });
  await expect(lessons.getByRole("listitem")).toHaveCount(2);
  await expect(lessons.getByRole("button", { name: "Lesson 1: Minimum, Current" })).toContainText("Up next");
  await expect(lessons.getByText("Maximum, Locked", { exact: true })).toBeVisible();
  await expect(lessons.getByRole("button", { name: /Maximum/ })).toHaveCount(0);
  await expect(lessons.getByText("Locked", { exact: true })).toHaveCount(0);
  // Closing the chapter hides its lessons; the summary still says how far along it is.
  await page.getByRole("button", { name: /^Order/ }).click();
  await expect(page.getByRole("list", { name: "Lessons in Order" })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Order/ })).toContainText("0 of 2 lessons done");
  await page.getByRole("button", { name: /^Order/ }).click();
  if (info.project.name.endsWith("desktop"))
    for (const width of [1024, 840, 839, 600, 599]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".connected-host")).toHaveAttribute(
        "data-window-class",
        width < 600 ? "compact" : width < 840 ? "medium" : "expanded",
      );
      await expect(next.getByRole("button", { name: "Start the course →", exact: true })).toBeVisible();
      await expect(lessons.getByRole("listitem")).toHaveCount(2);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("course-page-fresh.png"), fullPage: true });
  // Once a part is read, the next step says to continue that lesson.
  await next.getByRole("button", { name: "Start the course →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "← Course roadmap", exact: true }).click();
  await expect(next).toContainText("Continue where you stopped");
  await expect(next).toContainText("1 of 1 part read");
  await expect(next.getByRole("button", { name: "Continue lesson 1 →", exact: true })).toBeVisible();
  await expect(lessons.getByRole("button", { name: "Lesson 1: Minimum, Current" })).toContainText("In progress · 1 of 1 parts read");
  expect(errors).toEqual([]);
});

test("a lesson shows one progress indicator, and its check opens neutral after the reading", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await startCourse(page);
  await page.getByRole("button", { name: "Start the course →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  // Where the lesson is, and one indicator of the learner's place in it.
  await expect(page.locator(".connected-lesson-where")).toHaveText("Lesson 1 of 2 · Order");
  await expect(page.locator("#connected-steps-summary")).toContainText("Step 1 of 3 · Part 1 · Reading");
  await expect(page.locator("#connected-steps-summary")).toContainText("0 of 3 done");
  const steps = page.getByRole("list", { name: "Your place in this lesson" });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  await expect(steps.locator('[aria-current="step"]')).toHaveText("Part 1 · Reading: Current");
  await expect(steps.getByRole("listitem").nth(1)).toHaveText("Check your understanding: Locked");
  for (const gone of ["Read · explore · check", "YOUR LEARNING PATH", "Study dates & optional extensions"])
    await expect(page.getByText(gone)).toHaveCount(0);
  // The objective once, whole.
  const objective = await page.locator(".connected-lesson-heading > p").innerText();
  expect(objective.endsWith("…")).toBe(false);
  expect(await page.getByText(objective, { exact: true }).count()).toBe(1);
  // Before the reading is done the check only says what follows: no decision, no suggestions.
  const check = page.locator(".connected-check");
  await expect(check).toHaveAttribute("data-state", "after-reading");
  await expect(check).toContainText("2 questions to answer on your own. The check opens after part 1.");
  await expect(page.getByTestId("gate-decision")).toHaveCount(0);
  await expect(page.locator(".connected-reading-card")).toContainText("Next: check your understanding · 2 questions");
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await expect(check).toHaveAttribute("data-state", "open");
  await expect(check).toContainText("Answer 2 questions correctly on your own to finish this lesson.");
  // Fresh: neutral, not "more evidence needed".
  await expect(page.getByTestId("gate-decision")).toHaveCount(0);
  await expect(page.getByText("Not complete yet")).toHaveCount(0);
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  // Whether the question counts, said before it; why "Check answer" waits, said beside it.
  await expect(page.getByTestId("question-kind")).toHaveText("Counts toward this lesson. Answer on your own, without help.");
  const checkAnswer = page.getByRole("button", { name: "Check answer", exact: true });
  await expect(checkAnswer).toBeDisabled();
  await expect(page.locator("#connected-answer-hint")).toHaveText(/^(Choose an|Enter your) answer to check it\.$/);
  await expect(checkAnswer).toHaveAttribute("aria-describedby", "connected-answer-hint");
  await expect(page.getByRole("button", { name: "Show the explanation (the question then becomes practice and won't count)" })).toBeVisible();
  // After an answer the decision and its suggestions are relevant, in plain words.
  const option = page.locator(".connected-check").getByRole("radio").first();
  if (await option.count()) await option.click();
  else await page.locator(".connected-check input").first().fill("999");
  await expect(page.locator("#connected-answer-hint")).toHaveCount(0);
  await checkAnswer.click();
  const decision = page.getByTestId("gate-decision");
  await expect(decision).toBeVisible();
  await expect(decision).not.toContainText(/item famil|independent success/i);
  await expect(decision.getByRole("button", { name: /^Try a new question/ })).toHaveCount(0);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("lesson-check.png"), fullPage: true });
  expect(errors).toEqual([]);
});

for (const [session, status] of [
  ["/test/session", "Available"],
  ["/test/companion-off-session", "Not turned on for this course yet · a question you send is saved and answered once it is"],
] as const)
  test(`the companion is closed on the course page and says the server's state: ${status.split(" ·")[0]}`, async ({ page }, info) => {
    if (session === "/test/session") await startCourse(page);
    else {
      await signIn(page, session);
      await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
    }
    await expect(page.getByTestId("next-step")).toBeVisible();
    const pane = page.locator("#connected-companion");
    await expect(pane).toBeHidden();
    await expect(page.locator(".connected-layout")).not.toHaveClass(/with-companion/);
    await page.locator(".connected-companion-trigger:visible").click();
    await expect(pane).toBeVisible();
    await expect(pane.getByRole("status")).toHaveText(`Companion: ${status}`);
    // Outside a lesson: no empty "saved conversation", no place labels, no disabled send.
    for (const gone of ["Your saved conversation", "Following your place", "Course roadmap", "Open a lesson before sending"])
      await expect(pane.getByText(gone)).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "Send message" })).toHaveCount(0);
    await expect(pane).toContainText("Ask from inside a lesson");
    // In a lesson it asks about that lesson, and it stays as the learner left it.
    await page.getByRole("button", { name: "Close companion" }).click();
    await page.getByTestId("next-step").locator('[data-usability="next"]').click();
    await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
    await expect(pane).toBeHidden();
    await page.locator(".connected-companion-trigger:visible").click();
    await expect(pane.getByRole("status")).toHaveText(`Companion: ${status}`);
    await expect(pane.getByTestId("companion-place")).toContainText("Asking about");
    await expect(pane.getByRole("button", { name: "Send message" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("companion.png") });
  });
