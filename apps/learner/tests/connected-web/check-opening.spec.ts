import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";

// Split from roadmap.spec.ts: how the lesson's check opens after the reading.

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
  // One counting scheme, the parts' own ("PART 1 OF 1" on the card): the bar has a segment per
  // part and one for the questions.
  await expect(page.locator("#connected-steps-summary")).toHaveText("Part 1 of 1 · then 2 questions");
  await expect(page.locator(".connected-reading-card")).toContainText("PART 1 OF 1");
  const steps = page.getByRole("list", { name: "Your place in this lesson" });
  await expect(steps.getByRole("listitem")).toHaveCount(2);
  // Finishing waits for the reading and the questions: a disabled button that says why.
  const finish = page.getByRole("button", { name: "Finish this lesson →", exact: true });
  await expect(finish).toBeDisabled();
  await expect(finish).toHaveAttribute("aria-describedby", "connected-complete-hint");
  await expect(page.locator("#connected-complete-hint")).toHaveText("Read every part first, then answer the questions.");
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
  await expect(page.locator("#connected-steps-summary")).toHaveText("Questions · 0 of 2 answered correctly on your own");
  await expect(check).toContainText("Answer 2 questions correctly on your own to finish this lesson.");
  // Fresh: neutral, not "more evidence needed".
  await expect(page.getByTestId("gate-decision")).toHaveCount(0);
  await expect(page.getByText("Not complete yet")).toHaveCount(0);
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  // Whether the question counts, said before it. "Check" keeps its accent before an answer (final
  // design §4.1 item 3, aria-disabled); a press on it says why under the field and sends nothing.
  await expect(page.getByTestId("question-kind")).toHaveText("Counts toward this lesson. Answer on your own.");
  const checkAnswer = page.getByRole("button", { name: "Check", exact: true });
  await expect(checkAnswer).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#connected-answer-hint")).toHaveCount(0);
  // (Playwright's click waits for an enabled button, so the press is made from the keyboard.)
  await checkAnswer.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#connected-answer-hint")).toHaveText(/^(Choose an|Enter your) answer to check it\.$/);
  await expect(checkAnswer).toHaveAttribute("aria-describedby", "connected-answer-hint");
  // Help waits behind "Get help": the explanation is in the help row, which says what help costs.
  const getHelp = page.getByRole("button", { name: "Get help", exact: true });
  await expect(getHelp).toHaveAttribute("aria-expanded", "false");
  await getHelp.click();
  const help = page.getByRole("group", { name: "Help with question 1" });
  await expect(help).toContainText("Help turns this question into practice.");
  await expect(help.getByRole("button", { name: "Show explanation", exact: true })).toBeVisible();
  await getHelp.click();
  await expect(help).toHaveCount(0);
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
