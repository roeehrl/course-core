import { expect, type Page } from "@playwright/test";

/** Chooses an item from the learner's secondary "Your course" menu (profile,
 * learning record and account settings), opening the menu first if needed.
 * A single press on the toggle was once lost while the page was still settling
 * (hebrew-polish.spec.ts), and nothing checked that the menu had opened, so the
 * item press then waited on a hidden panel. The menu now has to be open before
 * an item is pressed, and the toggle is pressed again only while it is not:
 * a second press on an open menu would close it. */
export async function chooseFromMenu(page: Page, label: string) {
  await openMenu(page);
  await page
    .locator(".connected-menu-panel")
    .getByRole("button", { name: label, exact: true })
    .click();
}

async function openMenu(page: Page) {
  const toggle = page.locator(".connected-menu-toggle");
  const panel = page.locator(".connected-menu-panel");
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true")
      await toggle.click({ timeout: 2_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}
