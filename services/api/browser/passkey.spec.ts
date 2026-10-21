import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { chooseFromMenu } from "./learner-menu.js";
import { AxeBuilder } from "@axe-core/playwright";

// Passkeys run on the harness's second server: WebAuthn refuses IP-address relying
// parties, so its public origin is http://localhost:<passkey port> (see browser/start.ts
// and browser/ports.ts; the Playwright config exports the chosen port to workers).
const passkeyOrigin = `http://localhost:${process.env.COURSE_BROWSER_PASSKEY_PORT ?? "4318"}`;

// The CDP WebAuthn domain (a virtual authenticator) exists only in Chromium. WebKit
// and Firefox have no virtual authenticator in Playwright, so playwright.engines.config.ts
// excludes this file; their password journeys still run there.

async function credentials(page: Page, data: { role?: "owner" | "learner" } = {}) {
  const response = await page.request.post("/test/password-session", { data });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { login: string; password: string };
}
/** A platform authenticator with user verification and discoverable credentials,
 * as on a phone or laptop with a screen lock. */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}
async function storedCredentials(authenticator: { cdp: CDPSession; authenticatorId: string }) {
  return (await authenticator.cdp.send("WebAuthn.getCredentials", { authenticatorId: authenticator.authenticatorId })).credentials;
}
async function noAxeViolations(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
}
async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
}
async function passwordSignIn(page: Page, account: { login: string; password: string }) {
  const form = page.getByRole("form", { name: "Sign in with your username and password" });
  await form.getByLabel("Username", { exact: true }).fill(account.login);
  await form.getByLabel("Password", { exact: true }).fill(account.password);
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("a learner adds a passkey, signs in with it, removes it and still signs in with the password", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const authenticator = await virtualAuthenticator(page);
  const account = await credentials(page);
  await page.goto(`${passkeyOrigin}/`);
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
  await passwordSignIn(page, account);
  await expect(page.getByRole("heading", { name: "Your courses" })).toBeVisible();

  await chooseFromMenu(page, "Passkeys");
  const manager = page.getByRole("region", { name: "Passkeys" });
  await expect(manager.getByText("You have no passkeys yet.")).toBeVisible();
  await manager.getByLabel("Passkey name").fill("Learner test device");
  await manager.getByRole("button", { name: "Add a passkey" }).click();
  await expect(manager.getByText("Learner test device", { exact: true })).toBeVisible();
  await expect(manager.getByText(/Added “Learner test device”/)).toBeVisible();
  expect(await storedCredentials(authenticator)).toHaveLength(1);
  await noAxeViolations(page);
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("learner-passkeys.png"), fullPage: true });

  await chooseFromMenu(page, "Sign out");
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByRole("heading", { name: "Your courses" })).toBeVisible();
  const cookies = await page.context().cookies(passkeyOrigin);
  expect(cookies.find((cookie) => cookie.name === "course_session")).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  expect(cookies.find((cookie) => cookie.name === "course_csrf")).toMatchObject({ httpOnly: false, sameSite: "Strict" });
  expect((await storedCredentials(authenticator))[0]!.signCount).toBeGreaterThan(0);

  // Removing the last passkey is allowed; the password keeps working.
  await chooseFromMenu(page, "Passkeys");
  await manager.getByRole("button", { name: "Remove passkey Learner test device" }).click();
  await expect(manager.getByText("You have no passkeys yet.")).toBeVisible();
  await chooseFromMenu(page, "Sign out");
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByRole("alert")).toContainText("That passkey was not accepted.");
  await passwordSignIn(page, account);
  await expect(page.getByRole("heading", { name: "Your courses" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("an owner adds a passkey in administration and signs in with it", async ({ page }, info) => {
  const authenticator = await virtualAuthenticator(page);
  const account = await credentials(page, { role: "owner" });
  await page.goto(`${passkeyOrigin}/admin/`);
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
  await noAxeViolations(page);
  await passwordSignIn(page, account);
  await expect(page.getByText("Connected to your workspace · authenticated session")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();

  await page.getByRole("button", { name: "Passkeys" }).click();
  const card = page.locator(".passkeys");
  await expect(card.getByText("You have no passkeys yet.")).toBeVisible();
  await card.getByLabel("Passkey name").fill("Owner test device");
  await card.getByRole("button", { name: "Add a passkey" }).click();
  await expect(card.getByText("Owner test device", { exact: true })).toBeVisible();
  expect(await storedCredentials(authenticator)).toHaveLength(1);
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("admin-passkeys.png"), fullPage: true });

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page.getByText("Connected to your workspace · authenticated session")).toBeVisible();
  await noHorizontalScroll(page);

  // The same passkey works in the learner app: one account, one relying party.
  await page.goto(`${passkeyOrigin}/`);
  await expect(page.getByRole("heading", { name: "Your courses" })).toBeVisible();
});

test("passkey sign-in is not offered where the origin cannot host WebAuthn", async ({ page }) => {
  // The main harness origin is http://127.0.0.1:<port>: an IP address is never an RP ID.
  await page.goto("/");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toHaveCount(0);
  await page.goto("/admin/");
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with passkey" })).toHaveCount(0);
});
