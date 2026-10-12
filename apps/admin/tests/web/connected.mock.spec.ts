import { test, expect } from "@playwright/test";
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
