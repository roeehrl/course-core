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

test("placement settings tighten only, and a learner's exemption shows its evidence and can be revoked", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/placement-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Placement" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Placement", level: 1 }),
  ).toBeVisible();
  await expect(
    page.locator(".stat").filter({ hasText: "Exemptions" }),
  ).toContainText("1");

  // The question limit can only be lowered below the author's 4.
  const save = page.getByRole("button", { name: "Save placement settings" });
  await page.getByLabel("Question limit").fill("5");
  await expect(save).toBeDisabled();
  await page.getByLabel("Question limit").fill("3");
  await page.getByLabel("Runs per learner").fill("2");
  await save.click();
  await expect(page.getByText("Placement settings saved.")).toBeVisible();

  // Keep a lesson on the path: the effect is checked before it can be saved (Q06).
  await page
    .getByRole("group", { name: "Always keep on the path" })
    .getByLabel("Maximum")
    .check();
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Check the effect" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Maximum" }),
  ).toContainText("Always kept (your setting)");
  await save.click();
  await expect(page.getByText("Placement settings saved.")).toBeVisible();

  // A learner's exemption with the evidence behind it.
  await page
    .getByLabel("Learner", { exact: true })
    .selectOption({ label: "Avery Learner" });
  const exemption = page.getByRole("region", { name: "Exemption: Minimum" });
  await expect(exemption).toContainText("placed out in run 1");
  await expect(
    exemption.getByRole("listitem").filter({ hasText: "min-a" }),
  ).toContainText("independent");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("placement.png"),
    fullPage: true,
  });
  await exemption
    .getByLabel("Reason to put it back on the path")
    .fill("Their later answers show a gap in the invariant.");
  await exemption.getByRole("button", { name: "Revoke exemption" }).click();
  await expect(page.getByText("Exemption revoked: Minimum")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Exemption: Minimum" }),
  ).toHaveCount(0);
  await accessible(page);
});
