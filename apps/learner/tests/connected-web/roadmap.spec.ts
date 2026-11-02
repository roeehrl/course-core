import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";

/*
 * The course page and the lesson page as a learner meets them (0.1.60 owner review): the page says
 * where the learner is, what is next and how far along they are, in words that match their real
 * state, on every device project.
 */

async function signIn(page: Page, session = "/test/session") {
  const token = (await (await page.request.post(session)).json()).token;
  await page.goto(`/#signin=${token}`);
}
async function startCourse(page: Page) {
  await signIn(page);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your learning path" }),
  ).toBeVisible();
}

// A first visit: no remembered companion pane preference.
test.use({ companionPane: "default" });

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();

test("a fresh enrollment says start, the lesson's details are in the next step, and locked lessons are quiet", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await startCourse(page);
  const next = page.getByTestId("next-step");
  // Never "pick up where you left off" before anything was started.
  await expect(next).toContainText("Start here");
  await expect(next.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  await expect(next).toContainText(/^.*Lesson 1 of 2 · Order · \d+ min · 1 part/);
  await expect(next.getByRole("button", { name: "Start the course →", exact: true })).toBeVisible();
  for (const stale of ["Pick up where you left off", "Your next small step", "Continue learning", "Inside this lesson"])
    await expect(page.getByText(stale)).toHaveCount(0);
  // How far along: lessons complete, out of the whole course.
  await expect(page.getByTestId("course-progress")).toContainText("0 of 2 lessons complete");
  // No card after the path: the next step comes before it, and the path's last chapter ends the page.
  const nextBox = (await next.boundingBox())!;
  const pathBox = (await page.getByRole("heading", { name: "Your learning path" }).boundingBox())!;
  expect(nextBox.y + nextBox.height).toBeLessThanOrEqual(pathBox.y);
  expect(
    await page.getByTestId("course-roadmap").evaluate((roadmap) => {
      const chapters = roadmap.querySelectorAll('[data-testid="roadmap-chapter"]');
      const last = chapters[chapters.length - 1]!.getBoundingClientRect();
      return Math.round(roadmap.getBoundingClientRect().bottom - last.bottom);
    }),
  ).toBe(0);
  // The current chapter is open; its locked lesson is a padlock and a title, "Locked" said to
  // assistive technology only, and no button leads into it.
  await expect(page.getByRole("button", { name: /^Order/ })).toHaveAttribute("aria-expanded", "true");
  const lessons = page.getByRole("list", { name: "Lessons in Order" });
  await expect(lessons.getByRole("listitem")).toHaveCount(2);
  await expect(lessons.getByRole("button", { name: "Lesson 1: Minimum, Current" })).toContainText("Up next");
  await expect(lessons.getByText("Maximum, Locked", { exact: true })).toBeVisible();
  await expect(lessons.getByRole("button", { name: /Maximum/ })).toHaveCount(0);
  await expect(lessons.getByText("Locked", { exact: true })).toHaveCount(0);
  // Closing the chapter hides its lessons; the summary still says how far along it is.
  await page.getByRole("button", { name: /^Order/ }).click();
  await expect(page.getByRole("list", { name: "Lessons in Order" })).toBeHidden();
  await expect(page.getByRole("button", { name: /^Order/ })).toContainText("0 of 2 lessons done");
  await page.getByRole("button", { name: /^Order/ }).click();
  if (info.project.name.endsWith("desktop"))
    for (const width of [1024, 840, 839, 600, 599]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".connected-host")).toHaveAttribute(
        "data-window-class",
        width < 600 ? "compact" : width < 840 ? "medium" : "expanded",
      );
      await expect(next.getByRole("button", { name: "Start the course →", exact: true })).toBeVisible();
      await expect(lessons.getByRole("listitem")).toHaveCount(2);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("course-page-fresh.png"), fullPage: true });
  // Once a part is read, the next step says to continue that lesson.
  await next.getByRole("button", { name: "Start the course →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "← Course roadmap", exact: true }).click();
  await expect(next).toContainText("Continue where you stopped");
  await expect(next).toContainText("1 of 1 part read");
  await expect(next.getByRole("button", { name: "Continue lesson 1 →", exact: true })).toBeVisible();
  await expect(lessons.getByRole("button", { name: "Lesson 1: Minimum, Current" })).toContainText("In progress · 1 of 1 parts read");
  expect(errors).toEqual([]);
});

test("an optional lesson reads as an optional detour on the path, and its lesson says so", async ({ page }) => {
  await signIn(page, "/test/content-lesson-session");
  const next = page.getByTestId("next-step");
  await expect(async () => {
    if (await next.isVisible()) return;
    await page.getByRole("button", { name: "Continue learning →", exact: true }).click({ timeout: 2_000 });
    await expect(next).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  // The path's next step is the required lesson; the optional one is a detour beside it.
  await expect(next.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const lessons = page.getByRole("list", { name: "Lessons in Order" });
  const aside = lessons.getByRole("button", { name: "Lesson 1: A closer look, Optional detour" });
  await expect(aside).toContainText("Optional detour");
  expect((await axe(page)).violations).toEqual([]);
  await aside.click();
  await expect(page.getByTestId("detour-return")).toContainText("You're on an optional detour.");
});
