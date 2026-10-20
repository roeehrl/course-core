import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("a reviewer records quoted rubric findings and the queue empties", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/rubric-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Answer reviews" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Answer reviews", level: 1 }),
  ).toBeVisible();
  const answer = page.getByRole("region", {
    name: "Answer from Written learner",
  });
  await expect(answer).toContainText(
    "the kept value is never greater than any element",
  );
  const invariant = page
    .locator("fieldset.review-criterion")
    .filter({ hasText: "States the invariant" });
  const every = page
    .locator("fieldset.review-criterion")
    .filter({ hasText: "compared once" });
  await invariant.getByRole("checkbox").check();
  await invariant
    .getByLabel("Exact quotation from the answer")
    .fill("the minimum is always the first value");
  await expect(
    invariant.getByText("Not found exactly in the answer."),
  ).toBeVisible();
  await every.getByRole("checkbox").check();
  await every
    .getByLabel("Exact quotation from the answer")
    .fill("compare every next element with it");
  await expect(page.getByRole("radio", { name: "Criteria met" })).toBeChecked();
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(
    page.getByText(/Every criterion marked as met needs an exact quotation/),
  ).toBeVisible();
  await invariant
    .getByLabel("Exact quotation from the answer")
    .fill("the kept value is never greater than any element");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("review.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(
    page.getByText("Review saved for Written learner."),
  ).toBeVisible();
  await expect(page.getByText("Nothing waiting")).toBeVisible();
});

test("a reviewer sees why Core rejected an AI draft and can ask again", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/rubric-fixture?assist=rejected")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Answer reviews" })
    .click();
  await expect(
    page.getByRole("region", { name: "Answer from Written learner" }),
  ).toBeVisible();
  await expect(page.getByText("AI draft rejected")).toBeVisible();
  await expect(
    page.getByText(/quoted words that are not in the learner's answer/),
  ).toBeVisible();
  await expect(page.getByText(/An AI draft was requested/)).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "AI draft of the findings" }),
  ).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
  await page.screenshot({
    path: info.outputPath("rejected-draft.png"),
    fullPage: true,
  });
  // Asking again is a new request; this harness has no reviewer model, so the server says so.
  await page.getByRole("button", { name: "Ask again for an AI draft" }).click();
  await expect(
    page.getByRole("button", { name: "Ask again for an AI draft" }),
  ).toBeEnabled();
  await expect(
    page.getByText(
      "No reviewer-drafts model is configured for this workspace.",
    ),
  ).toBeVisible();
});
