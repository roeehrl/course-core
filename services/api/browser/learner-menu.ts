import { expect, type Page } from "@playwright/test";

/** Chooses an item from the learner's secondary "Your course" menu (profile,
 * learning record and account settings), opening the menu first if needed. The
 * menu has to be open before an item is pressed: a single toggle press can be
 * lost while the page settles, so the toggle is pressed again only while the
 * menu is still closed (a second press on an open menu would close it). The same
 * helper as apps/learner/tests/connected-web/learner-menu.ts. */
export async function chooseFromMenu(page: Page, label: string) {
  const toggle = page.locator(".connected-menu-toggle");
  const panel = page.locator(".connected-menu-panel");
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click({ timeout: 2_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await panel.getByRole("button", { name: label, exact: true }).click();
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
