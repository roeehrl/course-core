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

test("an owner records a wrong-answer test, checks a key change against it on a draft and runs every test, through the real API", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/answer-keys-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Answer keys" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Answer keys and test answers" }),
  ).toBeVisible();
  // The draft is chosen first; its first question is a choice whose right answer is 2.
  const question = page
    .locator("section.card")
    .filter({ hasText: "Which is smaller?" });
  await expect(question).toContainText("Right answer now:");
  await question.getByLabel("Answer", { exact: true }).selectOption("five");
  await question.getByLabel("What it tests").fill("Picks the larger value");
  await question.getByRole("button", { name: "Add test answer" }).click();
  await expect(
    page.getByText("Added. The current key already grades it as expected."),
  ).toBeVisible();
  await expect(question).toContainText("must reject");

  // A key that accepts the wrong answer is caught before it is saved.
  const save = question.getByRole("button", { name: "Save key to the draft" });
  await question
    .getByLabel("Right answer", { exact: true })
    .selectOption("five");
  await expect(save).toBeDisabled();
  await question
    .getByRole("button", { name: "Check against test answers" })
    .click();
  await expect(
    question.getByText(/1 test answer would be graded the wrong way/),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("answer-keys.png"),
    fullPage: true,
  });
  // Back to the right key, a reworded explanation saves.
  await question
    .getByLabel("Right answer", { exact: true })
    .selectOption("two");
  await question
    .getByLabel("Explanation shown after answering")
    .fill("2 is below 5, so it is the smaller value.");
  await question
    .getByRole("button", { name: "Check against test answers" })
    .click();
  await expect(
    question.getByText(/every test answer is graded as expected/),
  ).toBeVisible();
  await question.getByRole("button", { name: "Save key to the draft" }).click();
  await expect(page.getByText(/Key saved to the draft/)).toBeVisible();

  await page.getByRole("button", { name: "Run all test answers" }).click();
  await expect(
    page.getByText("Every test answer was graded as expected."),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Recent test runs" }),
  ).toContainText("1 passed · 0 failed");
  await accessible(page);
});
