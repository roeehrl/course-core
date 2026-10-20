import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The staff concept mapping editor against the real API and PostgreSQL, at desktop, phone and
// tablet sizes: pick two courses, link objectives in both directions, save, read the history.
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
async function openMappings(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Concept mappings" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Concept mappings", level: 1 }),
  ).toBeVisible();
}

test("an owner of both courses maps objectives between them, and the history records who did it", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/concept-mapping-fixture")
  ).json();
  await openMappings(page, fixture.ownerCode);
  await page
    .getByLabel("First course")
    .selectOption({ label: "Ordering values 1.0.0 · Values space" });
  await page
    .getByLabel("Second course")
    .selectOption({ label: "Ordering practice 1.0.0 · Practice space" });
  await expect(
    page.getByText("No links yet. Add the first one."),
  ).toBeVisible();
  await accessible(page);

  await page.getByRole("button", { name: "Add link" }).click();
  const first = page.getByRole("group", { name: "Link 1" });
  await first
    .getByLabel("Objective in Ordering values 1.0.0")
    .selectOption({ label: "Find a minimum." });
  await first
    .getByLabel("Objective in Ordering practice 1.0.0")
    .selectOption({ label: "Find a minimum." });
  await page.getByRole("button", { name: "Add link" }).click();
  const second = page.getByRole("group", { name: "Link 2" });
  await second
    .getByLabel("Objective in Ordering values 1.0.0")
    .selectOption({ label: "Find a maximum." });
  await second
    .getByLabel("Relation")
    .selectOption({ label: "requires (as a prerequisite)" });
  await second
    .getByLabel("Objective in Ordering practice 1.0.0")
    .selectOption({ label: "Find a minimum." });
  await page
    .getByLabel("Note for the history (optional)")
    .fill("Reviewed with both course teams");
  await accessible(page);
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText("Mapping saved as version 1.")).toBeVisible();
  await expect(page.getByText("active · version 1")).toBeVisible();
  const history = page.getByRole("region", { name: "Mapping history" });
  await expect(history.getByRole("row")).toHaveCount(2);
  await expect(history.getByText("Mapping owner")).toBeVisible();
  await expect(
    history.getByText("Reviewed with both course teams"),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("saved.png"), fullPage: true });

  // Reopened from the other side, the same links read the other way round.
  await page.reload();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Concept mappings" })
    .click();
  await page
    .getByLabel("First course")
    .selectOption({ label: "Ordering practice 1.0.0 · Practice space" });
  await page
    .getByLabel("Second course")
    .selectOption({ label: "Ordering values 1.0.0 · Values space" });
  await expect(page.getByRole("group", { name: "Link 2" })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByLabel("Relation")
        .evaluateAll((els) =>
          els.map((e) => (e as HTMLSelectElement).value).sort(),
        ),
    )
    .toEqual(["equivalent", "prerequisite_of"]);
  await page.getByRole("button", { name: "Retire mapping" }).click();
  await expect(page.getByText(/Mapping retired as version 2/)).toBeVisible();
  await expect(page.getByText("retired · version 2")).toBeVisible();
  await accessible(page);
});

test("an admin of only one of the courses has nothing to map", async ({
  page,
}) => {
  const fixture = await (
    await page.request.post("/test/concept-mapping-fixture")
  ).json();
  await openMappings(page, fixture.adminOfOneCode);
  await expect(
    page.getByText("Two published courses are needed"),
  ).toBeVisible();
  await accessible(page);
});
