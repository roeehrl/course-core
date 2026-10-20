import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const accessible = async (page: Page) => {
  expect(
    (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
};
async function openSection(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Lab notebook" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Lab notebook", level: 1 }),
  ).toBeVisible();
}

test("a course-declared admin section renders from its schema, saves within bounds at each level, and is read-only without the right", async ({
  page,
  browser,
}, info) => {
  const fixture = await (
    await page.request.post("/test/admin-section-fixture")
  ).json();
  await openSection(page, fixture.code);
  await expect(
    page.getByText("How the practice notebook prompts learners."),
  ).toBeVisible();
  await expect(
    page.getByText("Rendered by Core from the course's settings schema"),
  ).toBeVisible();

  const save = page.getByRole("button", { name: "Save Lab notebook" });
  const hours = page.getByLabel("Hours between prompts");
  await expect(hours).toHaveValue("24");
  await expect(save).toBeDisabled();
  await hours.fill("90");
  await expect(page.getByText("Between 1 and 72.")).toBeVisible();
  await expect(save).toBeDisabled();
  await hours.fill("12");
  await page.getByLabel("Measurement units").selectOption("imperial");
  await save.click();
  await expect(
    page.getByText("Lab notebook saved (revision 1)."),
  ).toBeVisible();
  await expect(hours).toHaveValue("12");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("course-level.png"),
    fullPage: true,
  });

  // Chapter and learner levels.
  await page.getByRole("button", { name: "One chapter" }).click();
  await page
    .getByLabel("Chapter", { exact: true })
    .selectOption({ label: "Order" });
  const hints = page.getByLabel("Show worked hints first");
  await expect(hints).toBeChecked();
  await hints.uncheck();
  await save.click();
  await expect(
    page.getByText("Lab notebook saved (revision 1)."),
  ).toBeVisible();
  await expect(hints).not.toBeChecked();
  await page.getByRole("button", { name: "One learner" }).click();
  await page
    .getByLabel("Learner", { exact: true })
    .selectOption({ label: "Avery Learner" });
  await page.getByLabel("Notebook label").fill("Window-sill trials");
  await save.click();
  await expect(
    page.getByText("Lab notebook saved (revision 1)."),
  ).toBeVisible();
  await expect(page.getByLabel("Notebook label")).toHaveValue(
    "Window-sill trials",
  );
  await accessible(page);

  // Each change is in the audit log.
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Audit log" })
    .click();
  await expect(
    page.getByText("admin_section.settings_changed").first(),
  ).toBeVisible();

  // An instructor reads the same values and cannot change them.
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    ...(info.project.use.viewport
      ? { viewport: info.project.use.viewport }
      : {}),
    ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const instructor = await context.newPage();
  await openSection(instructor, fixture.instructorCode);
  await expect(
    instructor.getByText("Read only: your role cannot change these settings."),
  ).toBeVisible();
  await expect(instructor.getByLabel("Hours between prompts")).toHaveValue(
    "12",
  );
  await expect(instructor.getByLabel("Hours between prompts")).toBeDisabled();
  await expect(
    instructor.getByRole("button", { name: "Save Lab notebook" }),
  ).toHaveCount(0);
  await accessible(instructor);
  await context.close();
});
