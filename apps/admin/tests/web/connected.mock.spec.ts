import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";
test("connected host uses the API and cookie CSRF; HTTP errors do not become demo success", async ({
  page,
  context,
}) => {
  const session = demoSession("administrator"),
    workspace = {
      ...demoWorkspace(session.courses[0]!, "administrator"),
      role: "admin",
    };
  await context.addCookies([
    { name: "course_csrf", value: "mock-csrf", url: "http://127.0.0.1:4174" },
  ]);
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { user: { id: "test", displayName: "Mock user" } } }),
  );
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/admin/courses/sorting", async (route) => {
    if (route.request().method() === "PATCH") {
      expect(route.request().headers()["x-csrf-token"]).toBe("mock-csrf");
      expect(route.request().headers()["if-match"]).toBe("1");
      await route.fulfill({ status: 409, json: { error: "STALE_REVISION" } });
    } else await route.fulfill({ json: workspace });
  });
  await page.goto("/admin/");
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await expect(page.getByText("Interactive demo", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Edit course details" }).click();
  await page
    .getByRole("textbox", { name: "Course title" })
    .fill("Unsaved change");
  await page.getByRole("button", { name: "Save course details" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "changed since you opened",
  );
  await expect(page.getByRole("textbox", { name: "Course title" })).toHaveValue(
    "Unsaved change",
  );
});
test("signed-out staff see an accessible username and password form; codes appear only when enabled", async ({
  page,
}) => {
  let loginCodes = false;
  const logins: unknown[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  await page.route("**/auth/options", (route) =>
    route.fulfill({
      json: { password: { minLength: 12, maxLength: 1024 }, loginCodes },
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
  await expect(form.getByLabel("Username", { exact: true })).toHaveAttribute(
    "autocomplete",
    "username",
  );
  await expect(form.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "current-password",
  );
  await expect(page.getByLabel("One-time sign-in code")).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await form.getByLabel("Username", { exact: true }).fill("staff.member");
  await form.getByLabel("Password", { exact: true }).fill("not the password");
  await form.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByText("The username or password is incorrect."),
  ).toBeVisible();
  expect(logins).toEqual([
    { login: "staff.member", password: "not the password" },
  ]);
  loginCodes = true;
  await page.reload();
  await expect(page.getByLabel("One-time sign-in code")).toBeVisible();
});
