import { expect, test } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { openCompanion } from "./companion-helpers";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enLesson from "../../src/i18n/messages/en/connectedLesson.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";

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

/* With the companion docked beside the lesson, the note stays in the lesson's column under its
 * pill (18a): it ends where the pill ends instead of running over the panel, mirrored in Hebrew. */
for (const locale of ["en", "he"] as const) {
  test(`${locale}: the Unverified note stays in the lesson column beside the docked companion`, { tag: "@desktop-window" }, async ({ page }) => {
    const host = locale === "en" ? enHost : heHost;
    const lesson = locale === "en" ? enLesson : heLesson;
    await page.setViewportSize({ width: 1100, height: 900 });
    const session = await page.request.post("/test/model-session", { data: { generated: true } });
    expect(session.ok()).toBe(true);
    await page.goto(`/?locale=${locale}#signin=${(await session.json()).token}`);
    const resume = page.getByRole("button", { name: host["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
    const markRead = page.getByRole("button", { name: lesson.markRead, exact: true });
    await expect(async () => {
      if (await resume.count()) await resume.first().click({ timeout: 2_000 });
      await expect(markRead).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await markRead.click();
    const label = page.locator(".connected-reading-card .connected-unverified > button");
    await expect(label).toBeVisible();
    const panel = await openCompanion(page);
    await expect(panel).toHaveAttribute("data-placement", "docked");
    await label.scrollIntoViewIfNeeded();
    await label.click();
    const note = page.locator(".cc-ai-unverified-note");
    await expect(note).toBeVisible();
    await note.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    const box = (await note.boundingBox())!, aside = (await panel.boundingBox())!;
    const main = (await page.locator("#connected-learning").boundingBox())!, pill = (await label.boundingBox())!;
    expect(box.width).toBeGreaterThan(300);
    // Under its pill, inside the lesson's column, clear of the panel.
    expect(box.y).toBeGreaterThan(pill.y);
    expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
    if (locale === "en") expect(box.x + box.width).toBeLessThanOrEqual(aside.x);
    else expect(box.x).toBeGreaterThanOrEqual(aside.x + aside.width);
  });
}
