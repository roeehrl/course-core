import { expect, test } from "./health";
import AxeBuilder from "@axe-core/playwright";

/* Generated teaching is labelled "Unverified" where the learner reads it: a small pill that opens
 * a note (final design §4.6, 18a), and the note leads to the personal change, where it can be
 * hidden or undone. */
test("generated teaching carries an inline Unverified label that leads to its personal change", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const session = await page.request.post("/test/model-session", { data: { generated: true } });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  // The authored first part is not labelled.
  await expect(page.locator(".connected-reading-card .connected-unverified")).toHaveCount(0);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await expect(page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true })).toBeVisible();
  const label = page.locator(".connected-reading-card .connected-unverified > button");
  await expect(label).toBeVisible();
  await expect(label).toHaveAccessibleName("Unverified: this part was written by AI and hasn't been reviewed by a person");
  await expect(label).toHaveText("Unverified");
  // A 24 px pill; to a coarse pointer the press target is 44 px.
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  const box = (await label.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(coarse ? 44 : 24);
  expect((await label.locator(".cc-ai-unverified-pill").boundingBox())!.height).toBe(24);
  await label.click();
  const note = page.getByRole("dialog", { name: "About this AI-written part" });
  await expect(note).toContainText("No person has reviewed it yet.");
  expect((await note.boundingBox())!.width).toBeLessThanOrEqual(320);
  // The note's fade (M16) has ended before its contrast is checked.
  await note.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("unverified.png") });
  await note.getByRole("button", { name: "See this change, hide or undo it" }).click();
  const change = page.locator('[id^="personal-change-"]');
  await expect(change).toBeFocused();
  await expect(change).toContainText("Unverified.");
  await expect(change).toBeInViewport();
  expect(errors).toEqual([]);
});
