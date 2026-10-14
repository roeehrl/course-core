import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function credentials(page: Page, data: { role?: "owner" | "learner"; mustChange?: boolean } = {}) {
  const response = await page.request.post("/test/password-session", { data });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { login: string; password: string };
}
async function noAxeViolations(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations,
  ).toEqual([]);
}
async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}

test("a learner signs in with a password, replaces a temporary one, changes it and signs in again", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const account = await credentials(page, { mustChange: true });
  await page.goto("/");
  const form = page.getByRole("form", { name: "Sign in with your username and password" });
  const username = form.getByLabel("Username", { exact: true }), password = form.getByLabel("Password", { exact: true });
  await expect(username).toHaveAttribute("autocomplete", "username");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(password).toHaveAttribute("type", "password");
  await noAxeViolations(page);
  await noHorizontalScroll(page);

  // A wrong password gives the same generic answer as an unknown user.
  await username.fill(account.login);
  await password.fill("not the right password");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("The username or password is incorrect.");

  await password.fill(account.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  const next = form.getByLabel("New password", { exact: true });
  await expect(next).toHaveAttribute("autocomplete", "new-password");
  await expect(form.getByLabel("Repeat new password")).toHaveAttribute("autocomplete", "new-password");
  await noAxeViolations(page);
  const chosen = "my own learner passphrase 1";
  await next.fill(chosen);
  await form.getByLabel("Repeat new password").fill(chosen);
  await form.getByRole("button", { name: "Set password and sign in" }).click();
  await expect(page.getByRole("heading", { name: "Your courses" })).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Change password" }).click();
  const change = page.getByRole("form", { name: "Change your password" });
  await expect(change.getByLabel("Current password")).toHaveAttribute("autocomplete", "current-password");
  await change.getByLabel("Current password").fill(chosen);
  await change.getByLabel("New password", { exact: true }).fill("a changed learner passphrase");
  await change.getByLabel("Repeat new password").fill("a changed learner passphrase");
  await noAxeViolations(page);
  await change.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Your password was changed. Your other sessions were signed out.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("learner-password.png"), fullPage: true });

  await page.getByRole("button", { name: "Sign out" }).click();
  await username.fill(account.login.toUpperCase());
  await password.fill("a changed learner passphrase");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your courses" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the one-time code field appears only when the server enables codes", async ({ page }) => {
  await page.route("**/auth/options", (route) =>
    route.fulfill({ json: { password: { minLength: 12, maxLength: 1024 }, loginCodes: false } }),
  );
  await page.goto("/");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.getByLabel("One-time sign-in code")).toHaveCount(0);
  await page.unroute("**/auth/options");
  await page.reload();
  // This disposable server enables codes for its other fixtures.
  await expect(page.getByLabel("One-time sign-in code")).toBeVisible();
});

test("an owner signs in to administration with a password", async ({ page }, info) => {
  const account = await credentials(page, { role: "owner" });
  await page.goto("/admin/");
  const form = page.getByRole("form", { name: "Sign in with your username and password" });
  await expect(form.getByLabel("Username", { exact: true })).toHaveAttribute("autocomplete", "username");
  await expect(form.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "current-password");
  await noAxeViolations(page);
  await noHorizontalScroll(page);
  await form.getByLabel("Username", { exact: true }).fill(account.login);
  await form.getByLabel("Password", { exact: true }).fill(account.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Connected to your workspace · authenticated session")).toBeVisible();
  await page.getByRole("button", { name: "Change password" }).click();
  const change = page.getByRole("form", { name: "Change your password" });
  await expect(change.getByLabel("New password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await change.getByLabel("Current password").fill(account.password);
  await change.getByLabel("New password", { exact: true }).fill("an owner's new passphrase");
  await change.getByLabel("Repeat new password").fill("an owner's new passphrase");
  await change.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Your password was changed. Your other sessions were signed out.")).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("admin-password.png"), fullPage: true });
});
