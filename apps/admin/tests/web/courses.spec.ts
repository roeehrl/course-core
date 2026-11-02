import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { expectAccessible, mockConnectedAdmin } from "./connectedAdmin";
import { courseSwitcher, workspaceNav } from "../workspaceNav";

/**
 * Adding and managing courses at the workspace level: the course switcher offers "Add a course…"
 * and "All courses", and the Courses home lists every course with one "Add a course" button.
 * English and Hebrew, desktop and phone; stubbed API (an owner who can install packages).
 *
 * Set COURSES_SHOTS to a folder to also save screenshots of the page and the dialog.
 */
const SHOTS = process.env.COURSES_SHOTS;
const catalog = (locale: string, namespace: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../src/i18n/messages/${locale}/${namespace}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, string>;

for (const locale of ["en", "he"] as const)
  test(`${locale}: add a course from the switcher, and see every course on the Courses page`, async ({
    page,
    context,
  }, info) => {
    const app = catalog(locale, "adminApp");
    const list = catalog(locale, "coursesView");
    const add = catalog(locale, "addCourse");
    await mockConnectedAdmin(page, context);
    await page.goto(`/admin/courses/sorting/releases?locale=${locale}`);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "he" ? "rtl" : "ltr",
    );
    await expect(page.locator(".card").first()).toBeVisible();

    // The switcher: the workspace entries after the courses.
    await (await courseSwitcher(page)).click();
    const options = page.getByRole("listbox");
    await expect(
      options.getByRole("option", { name: app["switcher.add"]! }),
    ).toHaveCount(1);
    await options
      .getByRole("option", { name: app["switcher.manage"]! })
      .click();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(app["nav.courses"]!);
    await expect(page).toHaveURL(/\/admin\/courses\?/);
    await expect(page.locator(".nav-drawer")).toHaveCount(0);
    await expect(heading).toBeFocused();

    // The list: one row per course, each with Open.
    const table = page.getByRole("table", { name: list["listLabel"]! });
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(
      table.getByRole("button", {
        name: new RegExp(`^${list["open"]!}`),
      }),
    ).toHaveCount(2);
    await expect(table).toContainText("1.4.0");
    await expect(table).toContainText(list["live.none"]!);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await expectAccessible(page);
    if (SHOTS)
      await page.screenshot({
        path: `${SHOTS}/courses-${locale}-${info.project.name}.png`,
        fullPage: true,
      });

    // The page's button opens the installer as "Add a course".
    await page.getByRole("button", { name: list["add"]!, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: add["title"]! });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(add["intro"]!);
    if (SHOTS)
      await page.screenshot({
        path: `${SHOTS}/add-course-${locale}-${info.project.name}.png`,
      });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // The switcher's entry opens the same dialog and leaves the open course as it is.
    await table.getByRole("button").first().click();
    await expect(page).toHaveURL(/\/admin\/courses\/sorting\/releases/);
    await (await courseSwitcher(page)).click();
    await page
      .getByRole("listbox")
      .getByRole("option", { name: app["switcher.add"]! })
      .click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/admin\/courses\/sorting\/releases/);
    await page.goto(`/admin/courses?locale=${locale}`);

    // The Courses item leads the Workspace group in the navigation.
    const nav = await workspaceNav(page);
    await expect(
      nav.locator(".nav-group").first().locator("button").first(),
    ).toHaveText(app["nav.courses"]!);
  });
