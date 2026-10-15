import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function startCourse(page: Page) {
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
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

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();

test("the roadmap is a labelled list with SDK-driven labels and keeps the selected lesson through every window class", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await startCourse(page);
  // No host-invented chapter numbers, icons or taglines.
  await expect(page.getByText(/^Chapter \d+/)).toHaveCount(0);
  await expect(
    page.getByText("One guided path. Understanding at every step."),
  ).toHaveCount(0);
  const lessons = page.getByRole("list", { name: "Lessons in Order" });
  await expect(lessons.getByRole("listitem")).toHaveCount(2);
  await expect(lessons.getByText("Current · continue here")).toBeVisible();
  const states = page.getByRole("list", { name: "Lesson states" });
  for (const label of [
    "Current",
    "Completed",
    "Placed out",
    "Under review",
    "Optional detour",
    "Locked",
  ])
    await expect(states.getByText(new RegExp(`${label}$`))).toBeVisible();
  // Inspect the second (locked) lesson, then resize across every boundary.
  await page.getByRole("button", { name: "Inspect Maximum, Locked" }).click();
  const detail = page
    .getByRole("heading", { name: "Maximum", exact: true })
    .last();
  await expect(
    page.getByRole("button", { name: "Lesson locked" }),
  ).toBeVisible();
  if (info.project.name.endsWith("desktop"))
    for (const width of [1024, 840, 839, 600, 599]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".connected-host")).toHaveAttribute(
        "data-window-class",
        width < 600 ? "compact" : width < 840 ? "medium" : "expanded",
      );
      await expect(detail).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Lesson locked" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }
  // Compact windows stack the lessons vertically.
  if ((page.viewportSize()?.width ?? 0) < 600) {
    const [first, second] = [
      (await lessons.getByRole("listitem").nth(0).boundingBox())!,
      (await lessons.getByRole("listitem").nth(1).boundingBox())!,
    ];
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
    expect(Math.abs(second.x - first.x)).toBeLessThan(2);
  }
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("roadmap.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("a lesson names its steps in words, marks the current one and shows Now and Next", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await startCourse(page);
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  const steps = page.getByRole("list", { name: /steps complete/ });
  await expect(steps.getByRole("listitem")).toHaveCount(3);
  const current = steps.locator('[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("Part 1 · Reading");
  await expect(current).toContainText("Current");
  await expect(steps.getByRole("listitem").nth(1)).toContainText(
    "Independent check",
  );
  await expect(steps.getByRole("listitem").nth(1)).toContainText("Locked");
  // Nothing in the step list is hidden from assistive technology except the shape cue.
  await expect(
    page.locator(
      ".connected-reading-progress [aria-hidden='true']:not(.connected-step-mark)",
    ),
  ).toHaveCount(0);
  const place = page.getByRole("definition");
  await expect(place.first()).toHaveText("Part 1 · Reading");
  await expect(place.nth(1)).toHaveText("Independent check");
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await expect(steps.getByRole("listitem").nth(0)).toContainText("Completed");
  await expect(steps.locator('[aria-current="step"]')).toContainText(
    "Independent check",
  );
  await expect(place.first()).toHaveText("Independent check");
  await expect(place.nth(1)).toHaveText("Finish this lesson");
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("lesson-steps.png") });
  expect(errors).toEqual([]);
});
