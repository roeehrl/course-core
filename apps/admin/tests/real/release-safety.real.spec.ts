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
const version = (page: Page, v: string) =>
  page.getByRole("button", {
    name: new RegExp(`^Version ${v.replaceAll(".", "\\.")}`),
  });

test("compare, roll back with a confirmed impact, archive, and mark an item defective", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/release-safety-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();

  // Compare the older release with the live one.
  await version(page, "1.0.0").click();
  await page
    .getByRole("button", { name: "Compare with the live release" })
    .click();
  const diff = page.getByRole("region", {
    name: "Changes from version 1.1.0 to 1.0.0",
  });
  await expect(diff).toContainText("~min-b");
  // The release-safety styles apply: a bordered diff with an unbulleted, row-per-kind list.
  await expect(diff).toHaveCSS("border-top-style", "solid");
  await expect(diff).toHaveCSS("border-top-left-radius", "10px");
  await expect(diff.locator(".impact-list")).toHaveCSS(
    "list-style-type",
    "none",
  );
  await expect(diff.locator(".impact-list")).toHaveCSS("display", "grid");
  await expect(diff.locator(".impact-list li").first()).toHaveCSS(
    "display",
    "flex",
  );
  await diff.screenshot({ path: info.outputPath("release-diff.png") });

  // Selecting it for new learners is a rollback: the impact must be confirmed.
  await page.getByRole("button", { name: "Use for new learners" }).click();
  const rollback = page.getByRole("dialog", {
    name: "Roll back new learners to version 1.0.0",
  });
  await expect(rollback.getByText("Nobody is moved")).toBeVisible();
  await expect(
    rollback
      .getByRole("listitem")
      .filter({ hasText: "Learners already on 1.0.0" }),
  ).toContainText("1");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("rollback.png"),
    fullPage: true,
  });
  await rollback.getByRole("button", { name: "Confirm rollback" }).click();
  await expect(rollback).toHaveCount(0);
  await expect(version(page, "1.0.0")).toContainText(
    "Available to new learners",
  );

  // The newer release is no longer live and can be archived.
  await version(page, "1.1.0").click();
  await page.getByRole("button", { name: "Archive release" }).click();
  await expect(
    page.getByText(/Release archived\. No learners are on it\./),
  ).toBeVisible();
  await expect(
    page.getByText(/Archived: no new learner starts on it/),
  ).toBeVisible();

  // Mark min-a defective on 1.0.0: the learner's evidence on it is invalidated with the reason.
  await version(page, "1.0.0").click();
  await page.getByRole("button", { name: "Mark an item defective" }).click();
  const defect = page.getByRole("dialog", {
    name: "Mark an item defective in version 1.0.0",
  });
  await defect.getByLabel("Item ID").fill("min-a");
  await defect.getByRole("button", { name: "Preview the impact" }).click();
  const effects = defect.getByRole("list", {
    name: "What marking it defective does",
  });
  await expect(
    effects
      .getByRole("listitem")
      .filter({ hasText: "Evidence records invalidated" }),
  ).toContainText("1");
  await expect(
    effects.getByRole("listitem").filter({ hasText: "Replacement items" }),
  ).toContainText("min-b");
  await defect
    .getByLabel("Reason (learners' records keep it)")
    .fill("The correct option text was swapped with a distractor.");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("defect.png"),
    fullPage: true,
  });
  await defect
    .getByRole("button", { name: "Mark defective and invalidate evidence" })
    .click();
  await expect(defect).toHaveCount(0);
  await expect(
    page.getByText(
      /Item min-a marked defective\. 1 evidence record for 1 learner/,
    ),
  ).toBeVisible();
});
