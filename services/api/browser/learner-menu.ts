import { expect, type Page } from "@playwright/test";

/** Chooses an item from the learner's secondary "Your course" menu (profile,
 * learning record and account settings), opening the menu first if needed. */
export async function chooseFromMenu(page: Page, label: string) {
  const toggle = page.locator(".connected-menu-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.locator(".connected-menu-panel").getByRole("button", { name: label, exact: true }).click();
}

/** Opens "My profile" and waits until its stacked panels have loaded. The
 * supervisor settings, learning memory and teaching-ideas panels mount with a
 * spinner and grow when their reads resolve, moving everything below them. A
 * click issued while one of them settles can press a control and release over
 * whatever moved under the pointer, so the control never activates. */
export async function openProfile(page: Page) {
  await chooseFromMenu(page, "My profile");
  // The panels mount together with the profile view, each starting in its
  // loading state, so once this heading is visible their spinners are present
  // until the reads finish.
  await expect(page.getByRole("heading", { name: "Personal lesson support", exact: true })).toBeVisible();
  for (const label of ["Loading supervisor information", "Loading learning memory", "Loading teaching ideas"])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
}
