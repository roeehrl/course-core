import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceNav } from "../workspaceNav";

async function signIn(page: Page) {
  const setup = await page.request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const data = await setup.json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(data.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
}

test("an admin invites, re-roles and removes a learner while owners stay protected", async ({
  page,
  browser,
}, info) => {
  await signIn(page);
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: "People & roles" })
    .click();
  await expect(
    page.getByRole("heading", { name: "People & roles", level: 1 }),
  ).toBeVisible();
  const table = page.getByRole("table");
  // The fixture admin sees themself without controls and cannot elevate anyone.
  const selfRow = table.getByRole("row").filter({ hasText: "you" });
  await expect(selfRow.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Invite person" }).click();
  const dialog = page.getByRole("dialog", { name: "Invite a person" });
  await expect(dialog.getByRole("radio", { name: /^owner/ })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: /^admin/ })).toHaveCount(0);
  await dialog.getByLabel("Display name").fill("Pilot learner");
  // Projects share one database, and usernames are unique.
  const username = `pilot.learner.${info.project.name}`;
  await dialog
    .getByLabel("Username (optional)")
    .fill(`Pilot.Learner.${info.project.name}`);
  await dialog.getByRole("radio", { name: /^learner/ }).check();
  expect(
    (
      await new AxeBuilder({ page })
        .include("dialog")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await dialog
    .getByRole("button", { name: "Invite and create temporary password" })
    .click();
  await expect(
    page.getByText("Pilot learner was invited as learner."),
  ).toBeVisible();
  // Usernames are stored normalised (NFKC, lower case).
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(
    username,
  );
  const temporary = await page
    .getByLabel("Temporary password", { exact: true })
    .inputValue();
  expect(temporary).toMatch(/^[a-z2-9]{4}(?:-[a-z2-9]{4}){4}$/);

  // The temporary password yields no session until the learner chooses their own.
  const learnerContext = await browser.newContext({
    baseURL: info.project.use.baseURL,
  });
  const learner = await learnerContext.newPage();
  const login = (data: Record<string, string>) =>
    learner.request.post("/auth/login", {
      headers: { origin: info.project.use.baseURL! },
      data,
    });
  const first = await login({
    login: username.toUpperCase(),
    password: temporary,
  });
  expect(first.status()).toBe(409);
  expect((await first.json()).error).toBe("PASSWORD_CHANGE_REQUIRED");
  expect((await learner.request.get("/api/enrollments")).status()).toBe(401);
  expect(
    (
      await login({
        login: username,
        password: temporary,
        newPassword: "a learner's own passphrase",
      })
    ).status(),
  ).toBe(200);
  expect((await learner.request.get("/api/enrollments")).status()).toBe(200);
  // The temporary password no longer works.
  expect((await login({ login: username, password: temporary })).status()).toBe(
    401,
  );

  await page
    .getByRole("button", { name: "I have shared it — hide the password" })
    .click();
  await expect(
    page.getByLabel("Temporary password", { exact: true }),
  ).toHaveCount(0);
  const row = table.getByRole("row").filter({ hasText: "Pilot learner" });
  await row.getByLabel("Role for Pilot learner").selectOption("observer");
  await row.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText("Pilot learner is now observer.")).toBeVisible();
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("people.png"),
    fullPage: true,
  });

  await row.getByRole("button", { name: "Remove" }).click();
  await page.getByLabel("Reason").fill("Pilot participation ended by request.");
  await page.getByRole("button", { name: "Remove access" }).click();
  await expect(
    page.getByText(
      "Pilot learner no longer has access. Their learning records were kept.",
    ),
  ).toBeVisible();
  await expect(
    table.getByRole("row").filter({ hasText: "Pilot learner" }),
  ).toHaveCount(0);
  // The removed person's session ends: they belong to no other workspace.
  expect((await learner.request.get("/api/enrollments")).status()).toBe(401);
  await learnerContext.close();
});
