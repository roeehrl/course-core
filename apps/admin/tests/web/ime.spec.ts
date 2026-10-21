import { test, expect } from "@playwright/test";

/* I06: an Enter that commits IME composition never submits a form. Chromium's
 * DevTools protocol drives a real composition (Input.imeSetComposition) through
 * the browser's own text-input pipeline, so the page sees compositionstart, an
 * Enter keydown with isComposing and compositionend exactly as from an OS IME.
 * Other engines have no IME automation; the guard's unit tests cover them. */
test("an Enter that commits IME composition does not submit the sign-in form", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "IME automation is Chromium-only.");
  const logins: unknown[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  await page.route("**/auth/options", (route) =>
    route.fulfill({
      json: { password: { minLength: 12, maxLength: 1024 }, loginCodes: false },
    }),
  );
  await page.route("**/auth/login", (route) => {
    logins.push(route.request().postDataJSON());
    return route.fulfill({ status: 401, json: { error: "LOGIN_FAILED" } });
  });
  await page.goto("/admin/");
  const form = page.getByRole("form", {
    name: "Sign in with your username and password",
  });
  await form.getByLabel("Password", { exact: true }).fill("not the password");
  const username = form.getByLabel("Username", { exact: true });
  await username.focus();
  const events = await page.evaluateHandle(() => {
    const seen: string[] = [];
    for (const type of ["compositionstart", "compositionend", "keydown"])
      document.addEventListener(
        type,
        (event) =>
          seen.push(
            event instanceof KeyboardEvent
              ? `keydown:${event.key}:${event.isComposing}`
              : type,
          ),
        true,
      );
    return seen;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "やまだ",
    selectionStart: 3,
    selectionEnd: 3,
  });
  // An Enter keydown that arrives while the composition is still open (as some
  // IMEs and Safari deliver the committing Enter). Without the document guard
  // (src/client/imeGuard.ts) Chromium submits the form here and this test fails.
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send("Input.insertText", { text: "山田" });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await expect(username).toHaveValue("山田");
  const seen = await events.evaluate((list) => [...list]);
  expect(seen).toContain("compositionstart");
  expect(seen).toContain("compositionend");
  await page.waitForTimeout(300);
  expect(logins).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // A plain Enter afterwards submits as usual.
  await username.press("Enter");
  await expect(
    page.getByText("The username or password is incorrect."),
  ).toBeVisible();
  expect(logins).toEqual([{ login: "山田", password: "not the password" }]);
});
