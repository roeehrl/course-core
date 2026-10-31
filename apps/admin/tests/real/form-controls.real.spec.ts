import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceNav } from "../workspaceNav";

const WCAG = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

/** Every visible radio button and checkbox keeps its native size: the global field rule
 * (full width, 46px tall) applies to text-like inputs only. */
async function expectCompactChoices(scope: Locator) {
  const boxes = await scope
    .locator('input[type="radio"], input[type="checkbox"]')
    .evaluateAll((inputs) =>
      inputs
        .filter((input) => (input as HTMLElement).offsetParent !== null)
        .map((input) => {
          const r = input.getBoundingClientRect();
          return {
            type: (input as HTMLInputElement).type,
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }),
    );
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.width, JSON.stringify(box)).toBeLessThanOrEqual(24);
    expect(box.height, JSON.stringify(box)).toBeLessThanOrEqual(24);
    expect(box.width, JSON.stringify(box)).toBeGreaterThanOrEqual(16);
  }
  return boxes;
}
const noHorizontalScroll = (page: Page) =>
  expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);

test("written-answer decision radios and criterion checkboxes stay compact; text fields still fill their column", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/rubric-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: "Answer reviews" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Answer reviews", level: 1 }),
  ).toBeVisible();
  const decision = page
    .locator("fieldset.segmented")
    .filter({ hasText: "Decision" });
  await expect(decision.getByRole("radio")).toHaveCount(3);
  const boxes = await expectCompactChoices(page.locator("main"));
  expect(boxes.filter((b) => b.type === "radio")).toHaveLength(3);
  // Each choice is a label at least 44px tall, so the touch target stays large.
  for (const label of await decision.locator("label").all())
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Choosing a decision by its label text works and is shown as selected.
  await decision.getByText("Ask for clarification").click();
  await expect(
    page.getByRole("radio", { name: "Ask for clarification" }),
  ).toBeChecked();
  const quote = page.getByLabel("Note (optional)").first();
  const field = (await quote.boundingBox())!,
    criterion = (await page
      .locator("fieldset.review-criterion")
      .first()
      .boundingBox())!;
  expect(field.width).toBeGreaterThan(criterion.width * 0.6);
  expect(field.height).toBeGreaterThanOrEqual(44);
  expect(
    (await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations,
  ).toEqual([]);
  await noHorizontalScroll(page);
  await decision.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath(`review-decision-${info.project.name}.png`),
    fullPage: true,
  });
});

test("the role radios in the invite dialog stay compact", async ({
  page,
}, info) => {
  const setup = await (await page.request.post("/test/admin-fixture")).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(setup.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: "People & roles" })
    .click();
  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await expect(dialog.getByRole("radio", { name: /^Learner/ })).toBeVisible();
  await expectCompactChoices(dialog);
  await dialog.getByRole("radio", { name: /^Learner/ }).check();
  expect(
    (await new AxeBuilder({ page }).include("dialog").withTags(WCAG).analyze())
      .violations,
  ).toEqual([]);
  await noHorizontalScroll(page);
  await page.screenshot({
    path: info.outputPath(`invite-roles-${info.project.name}.png`),
    fullPage: true,
  });
});
