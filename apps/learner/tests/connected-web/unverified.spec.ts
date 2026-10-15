import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/* Generated teaching is labelled "Unverified" where the learner reads it, and the
 * label leads to the personal change, where it can be hidden or undone. */
test("generated teaching carries an inline Unverified label that leads to its personal change", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const session = await page.request.post("/test/model-session", { data: { generated: true } });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  // The authored first part is not labelled.
  await expect(page.locator(".connected-reading-card .connected-unverified")).toHaveCount(0);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await expect(page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true })).toBeVisible();
  const label = page.locator(".connected-reading-card .connected-unverified > summary");
  await expect(label).toBeVisible();
  await expect(label).toHaveAccessibleName("Unverified: this part was written by AI and has not been reviewed by a person");
  const box = (await label.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  await label.click();
  await expect(page.getByText(/No person has reviewed it/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("unverified.png") });
  await page.getByRole("button", { name: "See this change, hide or undo it" }).click();
  const change = page.locator('[id^="personal-change-"]');
  await expect(change).toBeFocused();
  await expect(change).toContainText("Unverified.");
  await expect(change).toBeInViewport();
  expect(errors).toEqual([]);
});
