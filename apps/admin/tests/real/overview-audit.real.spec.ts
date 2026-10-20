import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
async function signIn(
  browser: Browser,
  baseURL: string,
  code: string,
  info: {
    project: {
      use: {
        isMobile?: boolean;
        viewport?: { width: number; height: number } | null;
      };
    };
  },
) {
  const context = await browser.newContext({
    baseURL,
    ...(info.project.use.viewport
      ? { viewport: info.project.use.viewport }
      : {}),
    ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  return page;
}
const open = async (page: Page, name: string) => {
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name })
    .click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
};
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

test("overview, course-scoped access with revocation, and a privacy-preserving audit log", async ({
  page,
  browser,
}, info) => {
  const fixture = await (
    await page.request.post("/test/people-scope-fixture")
  ).json();
  const baseURL = info.project.use.baseURL!;

  // The owner reads the course overview.
  const owner = await signIn(browser, baseURL, fixture.ownerCode, info);
  await expect(
    owner.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  await open(owner, "Overview");
  await expect(owner.getByText("Live release")).toBeVisible();
  await expect(owner.getByText("Gate review requests")).toBeVisible();
  await expect(
    owner.getByRole("list", { name: "Enrollments by state" }),
  ).toContainText("active");
  // The overview styles apply: unbulleted grid lists with one flex row per item.
  const enrollments = owner.getByRole("list", { name: "Enrollments by state" });
  await expect(enrollments).toHaveCSS("list-style-type", "none");
  await expect(enrollments).toHaveCSS("display", "grid");
  await expect(enrollments.getByRole("listitem").first()).toHaveCSS(
    "display",
    "flex",
  );
  await expect(enrollments.getByRole("listitem").first()).toHaveCSS(
    "border-bottom-style",
    "solid",
  );
  await accessible(owner);
  await owner.screenshot({
    path: info.outputPath("overview.png"),
    fullPage: true,
  });

  // A course-scoped member has no course until a grant exists.
  const tutor = await signIn(browser, baseURL, fixture.scopedCode, info);
  await expect(
    tutor.getByRole("heading", { name: "No course access" }),
  ).toBeVisible();

  // The owner grants a time-limited observer role on this course.
  await open(owner, "People & roles");
  const access = owner
    .locator("section.card")
    .filter({ hasText: "Course access: Ordering values" });
  await access.getByLabel("Person").selectOption({ label: "Visiting tutor" });
  await access.getByLabel("Role on this course").selectOption("observer");
  await access.getByLabel("Days of access").fill("14");
  await access.getByLabel("Reason code").fill("support_case");
  await accessible(owner);
  await access.getByRole("button", { name: "Grant course access" }).click();
  await expect(
    owner.getByText(
      "Visiting tutor can open Ordering values as observer for 14 days.",
    ),
  ).toBeVisible();
  await expect(
    access.getByRole("row").filter({ hasText: "Visiting tutor" }),
  ).toContainText("active");
  await owner.screenshot({
    path: info.outputPath("course-access.png"),
    fullPage: true,
  });

  await tutor.reload();
  await expect(
    tutor.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  await accessible(tutor);

  // Revocation ends access on the next request.
  await access
    .getByRole("button", { name: "Revoke access for Visiting tutor" })
    .click();
  await expect(
    owner.getByText("Course access for Visiting tutor was revoked."),
  ).toBeVisible();
  await tutor.reload();
  await expect(
    tutor.getByRole("heading", { name: "No course access" }),
  ).toBeVisible();

  // A support observer reads the audit log: staff details show, learner events do not.
  const support = await signIn(browser, baseURL, fixture.supportCode, info);
  await open(support, "Audit log");
  const table = support.getByRole("table");
  await expect(
    table.getByRole("row").filter({ hasText: "people.course_grant_revoked" }),
  ).toContainText("access_ended");
  await expect(
    table.getByRole("row").filter({ hasText: "enrollment.started" }).first(),
  ).toContainText("Details withheld");
  await accessible(support);
  await support.screenshot({
    path: info.outputPath("audit.png"),
    fullPage: true,
  });
  // A support observer has no people administration.
  await open(support, "People & roles");
  await expect(
    support.getByText("Only workspace owners and admins manage people."),
  ).toBeVisible();
  for (const p of [owner, tutor, support]) await p.context().close();
});
