import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function signIn(page: Page) {
  const setup = await page.request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const data = await setup.json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(data.code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Course & releases", level: 1 })).toBeVisible();
}

test("an admin invites, re-roles and removes a learner while owners stay protected", async ({ page, browser }, info) => {
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "People & roles" })
    .click();
  await expect(page.getByRole("heading", { name: "People & roles", level: 1 })).toBeVisible();
  const table = page.getByRole("table");
  // The fixture admin sees themself without controls and cannot elevate anyone.
  const selfRow = table.getByRole("row").filter({ hasText: "you" });
  await expect(selfRow.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await expect(dialog.getByRole("radio", { name: /^owner/ })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: /^admin/ })).toHaveCount(0);
  await dialog.getByLabel("Display name").fill("Pilot learner");
  await dialog.getByRole("radio", { name: /^learner/ }).check();
  expect(
    (await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Invite and create sign-in code" }).click();
  await expect(page.getByText("Pilot learner was invited as learner.")).toBeVisible();
  const link = await page.getByLabel("Learner sign-in link").inputValue();
  expect(link).toMatch(/#signin=[A-Za-z0-9_-]{43}$/);

  // The invited learner signs in exactly once with the shared link.
  const learnerContext = await browser.newContext({ baseURL: info.project.use.baseURL });
  const learner = await learnerContext.newPage();
  const token = link.slice(link.indexOf("#signin=") + "#signin=".length);
  const redeem = () =>
    learner.request.post("/auth/redeem", { headers: { origin: info.project.use.baseURL! }, data: { token } });
  expect((await redeem()).status()).toBe(200);
  expect((await redeem()).status()).toBe(401);
  expect((await learner.request.get("/api/enrollments")).status()).toBe(200);

  await page.getByRole("button", { name: "I have shared it — hide the code" }).click();
  await expect(page.getByLabel("Learner sign-in link")).toHaveCount(0);
  const row = table.getByRole("row").filter({ hasText: "Pilot learner" });
  await row.getByLabel("Role for Pilot learner").selectOption("observer");
  await row.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText("Pilot learner is now observer.")).toBeVisible();
  await expect(page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).resolves.toBeLessThanOrEqual(1);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("people.png"), fullPage: true });

  await row.getByRole("button", { name: "Remove" }).click();
  await page.getByLabel("Reason").fill("Pilot participation ended by request.");
  await page.getByRole("button", { name: "Remove access" }).click();
  await expect(page.getByText("Pilot learner no longer has access. Their learning records were kept.")).toBeVisible();
  await expect(table.getByRole("row").filter({ hasText: "Pilot learner" })).toHaveCount(0);
  // The removed person's session ends: they belong to no other workspace.
  expect((await learner.request.get("/api/enrollments")).status()).toBe(401);
  await learnerContext.close();
});
