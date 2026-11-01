import { test, expect } from "./health";
import { companion, openLesson, trigger } from "./shell-helpers";

/*
 * The companion's shortcut (final design §3.1, §5, Q8): Ctrl+Shift+. (⌘⇧. on a Mac) on the physical
 * period key, never with Alt and never while typing in a field. It opens and closes the companion;
 * with lesson text selected it opens it with the selection to attach. It is shown in the trigger's
 * tooltip and `aria-keyshortcuts`. The Hebrew layout and the modifier rules are unit tested
 * (tests/shortcut.test.ts); the collision check is in docs/accessibility.md.
 */
test("Ctrl+Shift+. toggles the companion, not while typing, and the trigger says so", async ({ page }) => {
  await openLesson(page);
  const region = companion(page);
  if ((await trigger(page).getAttribute("aria-expanded")) === "true") {
    await region.getByRole("button", { name: "Close companion", exact: true }).click();
    await expect(region).toBeHidden();
  }
  await expect(trigger(page)).toHaveAttribute("aria-keyshortcuts", /^(Control|Meta)\+Shift\+\.$/);
  await expect(trigger(page)).toHaveAttribute("title", /^Companion \((Ctrl\+Shift\+\.|⌘⇧\.)\)$/);
  await page.getByRole("heading", { name: "Minimum", exact: true }).click();
  await page.keyboard.press("Control+Shift+Period");
  await expect(region).toBeVisible();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  // Focus moves into the companion, as with the trigger.
  await expect(region).toBeFocused();
  // In the message box the keys are the field's.
  const draft = region.getByRole("textbox", { name: "Message to your companion", exact: true });
  await draft.focus();
  await page.keyboard.press("Control+Shift+Period");
  await expect(region).toBeVisible();
  // Alt is never part of it.
  await page.getByRole("heading", { name: "Minimum", exact: true }).click({ force: true });
  await page.keyboard.press("Control+Alt+Shift+Period");
  await expect(region).toBeVisible();
  await page.keyboard.press("Control+Shift+Period");
  await expect(region).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  // Closed with focus inside it, focus goes back to the trigger.
  await page.keyboard.press("Control+Shift+Period");
  await expect(region).toBeFocused();
  await page.keyboard.press("Control+Shift+Period");
  await expect(region).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

test("with lesson text selected the shortcut opens the companion and keeps the selection", async ({ page }) => {
  await openLesson(page);
  const region = companion(page);
  if ((await trigger(page).getAttribute("aria-expanded")) === "true") {
    await region.getByRole("button", { name: "Close companion", exact: true }).click();
    await expect(region).toBeHidden();
  }
  const sentence = page.getByText("The minimum is no greater than any other member.", { exact: true });
  await sentence.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await page.keyboard.press("Control+Shift+Period");
  await expect(region).toBeVisible();
  expect(await page.evaluate(() => document.getSelection()!.toString())).toContain("The minimum is no greater");
});
