import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Wide windows (from 1100px) show the workspace navigation in the sidebar. Phones and tablets
 * show a top app bar whose menu button opens it as a drawer; choosing a section there closes the
 * drawer again. The navigation lists one level's pages: the workspace's, or the open course's
 * (with a course card at the top: "All courses" and the course switcher). The helpers decide from the configured viewport, so a test that has just resized the window waits
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

/** The level's "All courses" link (the course card's way back), in the sidebar or the drawer. */
const backLink = (page: Page) =>
  page.locator(".sidebar .level-back, .nav-drawer .level-back");

/**
 * Opens a page by its navigation label, through the drawer when there is one. A workspace page
 * and a course page never share a sidebar: when the page is on the other level, this goes there
 * first (back to every course, or into the first course from the Courses home).
 */
export async function openSection(
  page: Page,
  name: string | RegExp,
  options: { exact?: boolean } = { exact: true },
) {
  let nav = await workspaceNav(page);
  let item = nav.getByRole("button", { name, ...options });
  if (!(await item.count())) {
    if (await backLink(page).count()) {
      await backLink(page).click();
      await expect(page.locator(".app-frame.level-is-workspace")).toHaveCount(
        1,
      );
    } else {
      // The workspace's first page is the Courses home.
      await nav.locator("button").first().click();
      await expect(page.locator(".nav-drawer")).toHaveCount(0);
      await openFirstCourse(page);
    }
    await expect(page.locator(".nav-drawer")).toHaveCount(0);
    nav = await workspaceNav(page);
    item = nav.getByRole("button", { name, ...options });
  }
  await item.click();
  await expect(page.locator(".nav-drawer")).toHaveCount(0);
}

/**
 * The open course's switcher: the breadcrumb's in the top bar on wide windows and tablets, the
 * course card's in the drawer on phones (the drawer is opened for it).
 */
export async function courseSwitcher(page: Page): Promise<Locator> {
  const phone = width(page) < 720;
  const button = phone
    ? page.locator(".nav-drawer .course-switcher-button")
    : page.locator(".topbar .breadcrumb .course-switcher-button");
  if (phone) await workspaceNav(page);
  await expect(button).toBeVisible();
  return button;
}

/** Switches to another course by its title, through the switcher's list. */
export async function switchCourse(page: Page, title: string) {
  await (await courseSwitcher(page)).click();
  await page
    .getByRole("listbox")
    .getByRole("option", { name: title, exact: true })
    .click();
  await expect(page.locator(".nav-drawer")).toHaveCount(0);
}

/** Opens the first course from the Courses home (where the app opens the first time). */
export async function openFirstCourse(page: Page) {
  await expect(page.locator(".courses-table")).toBeVisible();
  await page.locator(".courses-table .courses-actions button").first().click();
  await expect(page.locator(".app-frame.level-is-course")).toHaveCount(1);
}

/**
 * A connected workspace is the normal case and carries no mode badge (only the demo says what it
 * is). Waits for the page heading, then expects no "Demo workspace" label in either language.
 */
export async function expectNoModeBadge(page: Page) {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText(/^(Demo workspace|סביבת הדגמה)$/)).toHaveCount(0);
}

/**
 * Visits every page of both levels through the navigation: the open course's pages, then (after
 * "All courses") the workspace's. `visit` runs on each page after its item was clicked, with the
 * item's name. Returns every name visited, course pages first.
 */
export async function forEachPage(
  page: Page,
  visit: (name: string) => Promise<void>,
): Promise<string[]> {
  const visited: string[] = [];
  for (const level of ["course", "workspace"] as const) {
    if (level === "workspace") {
      if (compact(page)) await workspaceNav(page);
      await backLink(page).click();
      await expect(page.locator(".app-frame.level-is-workspace")).toHaveCount(
        1,
      );
      await expect(page.locator(".nav-drawer")).toHaveCount(0);
    }
    for (const name of await workspaceNavNames(page)) {
      await (
        await workspaceNav(page)
      )
        .getByRole("button", { name, exact: true })
        .click();
      await expect(page.locator(".nav-drawer")).toHaveCount(0);
      await visit(name);
      visited.push(name);
    }
  }
  return visited;
}
