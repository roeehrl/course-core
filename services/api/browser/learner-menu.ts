import type { Page } from "@playwright/test";

/** Chooses an item from the learner's secondary "Your course" menu (profile,
 * learning record and account settings), opening the menu first if needed. */
export async function chooseFromMenu(page: Page, label: string) {
  const toggle = page.locator(".connected-menu-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.locator(".connected-menu-panel").getByRole("button", { name: label, exact: true }).click();
}
