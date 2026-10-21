import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Real server and PostgreSQL (K13): staff preview moving learners to a newer published version,
// confirm it with a reason and an acknowledgement of lost credit, and move them back.
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

test("preview, confirm and undo a move of everyone on 1.0.0 to 1.1.0", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/version-moves-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  const card = page.locator("section.card").filter({
    has: page.getByRole("heading", {
      name: "Move learners to a newer version",
    }),
  });
  await expect(card).toContainText("Version 1.0.0 · 2 learners");
  await expect(card.getByLabel("Move them to")).toHaveValue(/.+/);

  // Test before saving: the preview changes nothing.
  await card.getByRole("button", { name: "Show what would happen" }).click();
  const preview = card.getByRole("region", {
    name: "What moving to version 1.1.0 does",
  });
  await expect(preview).toContainText("Avery Learner");
  await expect(preview).toContainText("Blake Learner");
  await expect(preview).toContainText(
    "Must pass the checkpoint again in: Minimum.",
  );
  await expect(preview).toContainText(
    "2 pieces of evidence stay recorded with version 1.0.0.",
  );
  await accessible(page);
  await preview.screenshot({
    path: info.outputPath("version-move-preview.png"),
  });

  const submit = preview.getByRole("button", { name: "Move 2 learners" });
  await expect(submit).toBeDisabled();
  await preview
    .getByLabel("Why are you moving them?")
    .fill("Version 1.1.0 fixes a question in the first checkpoint.");
  await expect(submit).toBeDisabled();
  await preview
    .getByRole("checkbox", { name: /1 learner must redo some progress/ })
    .check();
  await submit.click();
  await expect(card.getByText("2 learners moved.")).toBeVisible();
  await expect(card).toContainText("Version 1.1.0 · 2 learners");

  // Nobody has worked on 1.1.0 yet, so both can go back.
  await card
    .getByLabel("Why are you moving them back?")
    .fill("Moved too early.");
  await card.getByRole("button", { name: "Move 2 learners back" }).click();
  await expect(card.getByText("2 learners moved back.")).toBeVisible();
  await expect(card).toContainText("Version 1.0.0 · 2 learners");
  await accessible(page);
});
