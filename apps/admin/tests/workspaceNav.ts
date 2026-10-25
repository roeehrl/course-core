import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Wide windows (from 1100px) show the workspace navigation in the sidebar. Phones and tablets
 * show a top app bar whose menu button opens it as a drawer; choosing a section there closes the
 * drawer again. Below 720px the course picker moves from the bar into the drawer too. The
 * helpers decide from the configured viewport, so a test that has just resized the window waits
 * for the matching frame instead of catching the previous one.
 */
const width = (page: Page) => page.viewportSize()!.width;
const compact = (page: Page) => width(page) < 1100;

/** The navigation list, ready to use: the sidebar's, or the drawer's after opening it. */
export async function workspaceNav(page: Page): Promise<Locator> {
  if (!compact(page)) {
    const sidebar = page.locator(".sidebar .nav-links");
    await expect(sidebar).toBeVisible();
    return sidebar;
  }
  const drawer = page.locator(".nav-drawer");
  if (!(await drawer.isVisible())) await page.locator(".nav-toggle").click();
  await expect(drawer).toBeVisible();
  return drawer.locator(".nav-links");
}

/** Closes the navigation drawer when it is open (Escape, as a keyboard user would). */
export async function closeWorkspaceNav(page: Page) {
  const drawer = page.locator(".nav-drawer");
  if (!(await drawer.isVisible())) return;
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
}

/** The visible text of every navigation item, in order. Leaves the drawer closed. */
export async function workspaceNavNames(page: Page): Promise<string[]> {
  const nav = await workspaceNav(page);
  await nav.locator("button").first().waitFor();
  const names = (await nav.locator("button").allInnerTexts()).map((name) =>
    name.trim(),
  );
  await closeWorkspaceNav(page);
  return names;
}

/** Opens a workspace section by its navigation label, through the drawer when there is one. */
export async function openSection(
  page: Page,
  name: string | RegExp,
  options: { exact?: boolean } = { exact: true },
) {
  const nav = await workspaceNav(page);
  await nav.getByRole("button", { name, ...options }).click();
  await expect(page.locator(".nav-drawer")).toHaveCount(0);
}

/** The course picker: in the top bar on wide windows and tablets, in the drawer on phones. */
export async function coursePicker(page: Page): Promise<Locator> {
  const select = page.locator("#course-select");
  if (width(page) < 720) await workspaceNav(page);
  await expect(select).toBeVisible();
  return select;
}

/**
 * Expects the workspace's mode badge ("Connected workspace", "Demo workspace"). It sits in the
 * top bar on wide windows and at the foot of the navigation drawer on phones and tablets.
 */
export async function expectModeBadge(page: Page, text: string) {
  if (!compact(page)) {
    await expect(page.locator(".topbar").getByText(text)).toBeVisible();
    return;
  }
  await workspaceNav(page);
  await expect(page.locator(".nav-drawer").getByText(text)).toBeVisible();
  await closeWorkspaceNav(page);
}
