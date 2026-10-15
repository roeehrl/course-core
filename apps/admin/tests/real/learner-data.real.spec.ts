import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("an admin exports and then irreversibly erases one learner's course data", async ({ page }, info) => {
  const setup = await page.request.post("/test/admin-fixture");
  const fixture = await setup.json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Enrollments" })
    .click();
  const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Learner data requests" }) });
  await expect(card).toBeVisible();
  await expect(card.getByText(/Your export leaves out the learner's companion conversation and their own notes/)).toBeVisible();
  const download = page.waitForEvent("download");
  await card.getByRole("button", { name: "Export learner data" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`enrollment-${fixture.enrollmentId}.json`);
  const exported = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path())!, "utf8"));
  expect(exported).toMatchObject({ format: "course-core.enrollment-export", enrollment: { id: fixture.enrollmentId } });
  // A staff copy follows the shared privacy rule: no companion conversation, no learner model.
  expect(exported).toMatchObject({ audience: "staff", companion: null, learnerModel: null });
  expect(exported.withheld.map((row: { id: string }) => row.id)).toEqual(["companion", "learner-model", "drafts", "gate-review-reason"]);
  await expect(card.getByText("Export prepared.")).toBeVisible();
  await card.getByText("Erase this learner's course data").click();
  const erase = card.getByRole("button", { name: "Erase permanently" });
  await card.getByLabel(/Reason/).fill("Learner requested erasure by email.");
  await card.getByLabel(/Type ERASE/).fill("ERASE wrong");
  await expect(erase).toBeDisabled();
  await card.getByLabel(/Type ERASE/).fill(`ERASE ${fixture.enrollmentId.slice(0, 8)}`);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
  await erase.click();
  await expect(page.getByText("This enrollment's learning data was erased.")).toBeVisible();
  await expect(page.getByText("Erased learning data").first()).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).resolves.toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("erased.png"), fullPage: true });
});
