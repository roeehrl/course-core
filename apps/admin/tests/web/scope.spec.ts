import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  courseSwitcher,
  openSection,
  switchCourse,
  workspaceNav,
} from "../workspaceNav";

/**
 * The two levels of the admin: the workspace (every course) and one course. Walks from the
 * Courses home into a course and back, opens a deep link, follows the browser's back button,
 * and switches course on the same page. English and Hebrew, desktop and phone (the phone's
 * drawer mirrors the two levels).
 */
const TEXT = {
  en: {
    courses: "Courses",
    ai: "AI services",
    releases: "Course & releases",
    policy: "Policy & extensions",
    learners: "Enrollments",
    allCourses: "All courses",
    workspace: "Example school",
    crumbs: "You are here",
  },
  he: {
    courses: "קורסים",
    ai: "שירותי AI",
    releases: "קורס וגרסאות",
    policy: "מדיניות והארכות",
    learners: "הרשמות",
    allCourses: "כל הקורסים",
    workspace: "Example school",
    crumbs: "המיקום שלך",
  },
} as const;
const SORTING = "Sorting, step by step";
const GRAPHS = "A first look at graphs";

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const phone = (page: Page) => page.viewportSize()!.width < 720;
/** The name of what the page belongs to, over its heading. */
const eyebrow = (page: Page) => page.locator(".page-heading .page-course");

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}
async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

for (const locale of ["en", "he"] as const)
  test(`${locale}: workspace to course and back, a deep link, the back button and switching course`, async ({
    page,
  }) => {
    const text = TEXT[locale];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    // The first visit opens the Courses home: a workspace page, without a course switcher.
    await page.goto(`/admin/demo?locale=${locale}`);
    await expect(page).toHaveURL(/\/admin\/demo\/courses\?locale=/);
    await expect(heading(page)).toHaveText(text.courses);
    await expect(eyebrow(page)).toHaveText(text.workspace);
    await expect(page.locator(".course-switcher")).toHaveCount(0);
    if (!phone(page)) {
      const crumbs = page.getByRole("navigation", { name: text.crumbs });
      await expect(crumbs.locator("li")).toHaveCount(2);
      await expect(crumbs.locator("[aria-current=page]")).toHaveText(
        text.courses,
      );
    }
    await expectNoOverflow(page);
    await expectAccessible(page);

    // Into a course: its own pages, the course card, the course in the address.
    await page
      .locator(".courses-table .courses-actions button")
      .first()
      .click();
    await expect(heading(page)).toHaveText(text.releases);
    await expect(page).toHaveURL(/\/admin\/demo\/courses\/sorting\/releases/);
    await expect(eyebrow(page)).toHaveText(SORTING);
    const nav = await workspaceNav(page);
    await expect(nav.getByRole("button", { name: text.ai })).toHaveCount(0);
    await expect(
      page.locator(".level-course .course-switcher-button").first(),
    ).toContainText(SORTING);
    if (phone(page)) await page.keyboard.press("Escape");
    await openSection(page, text.policy);
    await expect(heading(page)).toHaveText(text.policy);
    await expect(page).toHaveURL(/\/courses\/sorting\/policy/);

    // Another course, on the same page.
    await switchCourse(page, GRAPHS);
    await expect(heading(page)).toHaveText(text.policy);
    await expect(eyebrow(page)).toHaveText(GRAPHS);
    await expect(page).toHaveURL(/\/courses\/graphs\/policy\?locale=/);
    await expectNoOverflow(page);
    await expectAccessible(page);

    // Back to every course, then a workspace page.
    if (phone(page)) await workspaceNav(page);
    await page.locator(".sidebar .level-back, .nav-drawer .level-back").click();
    await expect(heading(page)).toHaveText(text.courses);
    await openSection(page, text.ai);
    await expect(heading(page)).toHaveText(text.ai);
    await expect(page).toHaveURL(/\/admin\/demo\/ai-services/);
    await expect(eyebrow(page)).toHaveText(text.workspace);

    // The browser's back button retraces the steps.
    await page.goBack();
    await expect(heading(page)).toHaveText(text.courses);
    await page.goBack();
    await expect(heading(page)).toHaveText(text.policy);
    await expect(eyebrow(page)).toHaveText(GRAPHS);
    await page.goForward();
    await expect(heading(page)).toHaveText(text.courses);

    // A deep link opens its page; a reload stays there.
    await page.goto(`/admin/demo/courses/sorting/learners?locale=${locale}`);
    await expect(heading(page)).toHaveText(text.learners);
    await expect(eyebrow(page)).toHaveText(SORTING);
    await page.reload();
    await expect(heading(page)).toHaveText(text.learners);

    // The app's own address now opens the course used last.
    await page.goto(`/admin/demo?locale=${locale}`);
    await expect(heading(page)).toHaveText(text.releases);
    await expect(page).toHaveURL(/\/courses\/sorting\/releases/);
    expect(errors).toEqual([]);
  });

test("the course switcher is a searchable list the keyboard can use", async ({
  page,
}) => {
  await page.goto("/admin/demo/courses/sorting/overview?locale=en");
  await expect(heading(page)).toHaveText("Overview");
  const button = await courseSwitcher(page);
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const search = page.getByRole("combobox", { name: "Find a course" });
  await expect(search).toBeFocused();
  const list = page.getByRole("listbox", { name: "Courses" });
  await expect(list.getByRole("option")).toHaveCount(3);
  await expect(
    list.getByRole("option", { name: SORTING, exact: false }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.type("graph");
  await expect(list.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/courses\/graphs\/overview/);
  await expect(heading(page)).toHaveText("Overview");
  await expect(eyebrow(page)).toHaveText(GRAPHS);
});
