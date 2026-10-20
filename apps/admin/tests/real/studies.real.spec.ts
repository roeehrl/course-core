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
async function openStudies(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Studies" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Studies", level: 1 }),
  ).toBeVisible();
}

test("an owner sets up a study, opens recruiting, sees arm balance and consent counts and exports; a reviewer only reads", async ({
  page,
  browser,
}, info) => {
  const fixture = await (await page.request.post("/test/study-fixture")).json();
  await openStudies(page, fixture.ownerCode);
  await expect(page.getByText("No studies yet")).toBeVisible();
  await page.getByRole("button", { name: "New study" }).click();
  await page.getByLabel("Title").fill("Ordering study");
  await page
    .getByLabel("Purpose shown to learners")
    .fill(
      "We compare three versions of this course to learn which helps most.",
    );
  await page.getByLabel(/^min-a /).selectOption("pre");
  await page.getByLabel(/^max-a /).selectOption("post");
  await page.getByLabel(/^min-later-1 /).selectOption("delayed");
  await page.getByLabel("Minimum cell size").fill("3");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("study-setup.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/saved as a draft/)).toBeVisible();
  // The pre-test and post-test items here also count toward gates: staff are told before opening.
  await expect(
    page.getByText(/also counts toward a gate/).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open recruiting" }).click();
  await expect(
    page.getByText(
      /is recruiting\. Learners on this release now see the consent prompt\./,
    ),
  ).toBeVisible();

  // Six learners agree in their own app (through the real learner route).
  expect(
    (
      await (
        await page.request.post("/test/study-consent", {
          data: { workspaceId: fixture.workspaceId },
        })
      ).json()
    ).consented,
  ).toBe(6);
  await page.reload();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Studies" })
    .click();
  await expect(
    page.locator(".stat").filter({ hasText: "Included in exports" }),
  ).toContainText("6");
  const balance = page.getByRole("region", {
    name: "Arm balance of Ordering study",
  });
  await expect(balance.getByRole("row")).toHaveCount(4);
  // Seeded, balanced: two learners in each arm.
  for (const arm of ["Fixed path", "Chat-only companion", "Full supervisor"])
    await expect(
      balance
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name: arm }) })
        .getByRole("cell")
        .nth(1),
    ).toContainText("2");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("study-balance.png"),
    fullPage: true,
  });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^study-[0-9a-f]{8}\.csv$/);
  await expect(page.getByText(/recorded in the audit log/)).toBeVisible();
  await page.getByRole("button", { name: "Check allocation" }).click();
  await expect(
    page.getByText(
      "All 6 assignment(s) match the seeded draw (6 made in total).",
    ),
  ).toBeVisible();
  await accessible(page);

  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    ...(info.project.use.viewport
      ? { viewport: info.project.use.viewport }
      : {}),
    ...(info.project.use.isMobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const reviewer = await context.newPage();
  await openStudies(reviewer, fixture.reviewerCode);
  await expect(
    reviewer.locator(".stat").filter({ hasText: "Included in exports" }),
  ).toContainText("6");
  for (const name of [
    "Export CSV",
    "Export JSON",
    "Close study",
    "Check allocation",
    "New study",
  ])
    await expect(reviewer.getByRole("button", { name })).toHaveCount(0);
  await accessible(reviewer);
  await context.close();
});
