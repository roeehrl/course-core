import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.goto("/admin/demo");
  await expect(page.getByRole("button", { name: "New draft" })).toBeVisible();
});

test("course management and reviewed release publication", async ({
  page,
}, info) => {
  await page.screenshot({
    path: info.outputPath("course-workspace.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Edit course details" }).click();
  await page
    .getByRole("textbox", { name: "Course title" })
    .fill("A public sorting course");
  await page.getByRole("button", { name: "Save course details" }).click();
  await expect(page.getByText("Demo course details saved.")).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(
    page.getByRole("button", { name: "Publish after approval" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Approve review" }).click();
  await page
    .getByRole("button", { name: "Publish release", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Publish reviewed release" });
  await expect(
    dialog.getByRole("button", { name: "Confirm publication" }),
  ).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Confirm publication" }).click();
  await expect(
    page.getByText("Demo release marked published. Nothing was deployed."),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Course", exact: true })
    .selectOption("graphs");
  await expect(
    page.getByText(
      "A public example course about nodes, edges and finding a path.",
    ),
  ).toBeVisible();
});

test("enrollment profile and versioned evidence review", async ({ page }) => {
  await page.getByRole("button", { name: "Enrollments", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page
    .getByRole("textbox", { name: "Display name" })
    .fill("Taylor Example");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(
    page.getByRole("heading", { name: "Taylor Example" }),
  ).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await page
    .locator("article")
    .filter({ hasText: "Predict a small example" })
    .getByRole("button", { name: "Review evidence" })
    .click();
  await page
    .getByRole("textbox", { name: "Review note" })
    .fill("The example meets the stated rubric.");
  await page.getByRole("button", { name: "Record review" }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(
    page.getByText(/This evidence cannot be approved/),
  ).toBeVisible();
  await page.getByRole("button", { name: "New enrollment" }).click();
  await page
    .getByRole("textbox", { name: "Learner reference" })
    .fill("public-example-03");
  await page
    .getByRole("textbox", { name: "Display name" })
    .fill("Casey Example");
  await page
    .getByRole("button", { name: "Create enrollment", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Casey Example/ }),
  ).toBeVisible();
});

test("calendar policy, exact before/after terms and learner-only consent", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "Policy & extensions" }).click();
  await expect(
    page.getByText("14 calendar days from scope started"),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Inherited work caps and current usage" }),
  ).toContainText("240");
  await page
    .getByRole("button", { name: "Preview calendar extension" })
    .click();
  await expect(
    page.getByRole("button", { name: "Propose offer to learner" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: /I reviewed these exact terms/ })
    .check();
  await page
    .getByRole("spinbutton", { name: "Additional calendar days" })
    .fill("3");
  await expect(
    page.getByRole("heading", { name: "Resolved extension terms" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Preview calendar extension" })
    .click();
  await expect(
    page.getByRole("checkbox", { name: /I reviewed these exact terms/ }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: /Predict a small example/ }).check();
  await page
    .getByRole("checkbox", { name: "Notice a pattern", exact: true })
    .check();
  await page
    .getByRole("textbox", { name: "Plan impact" })
    .fill(
      "Three more calendar days for the existing plan, with no additional work.",
    );
  await page
    .getByRole("textbox", { name: "Alternatives (one per line)" })
    .fill("Continue with the current deadline.");
  await page
    .getByRole("checkbox", { name: /I reviewed these exact terms/ })
    .check();
  await page.screenshot({
    path: info.outputPath("calendar-policy.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Propose offer to learner" }).click();
  await expect(
    page.getByText("Awaiting exact learner consent", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/termsDigest: [a-f0-9]{64}/)).toBeVisible();
  await expect(
    page.getByText(/no deadline, work cap or allowance balance changed/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /Accept extension|Grant extension|Authorize reservation/,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /Episode · Apply the idea/ }).click();
  await page
    .getByRole("button", { name: "Preview calendar extension" })
    .click();
  await expect(page.getByRole("alert")).toContainText("binding ancestor");
  await page
    .getByRole("button", { name: /Chapter · Open exploration/ })
    .click();
  await expect(page.getByText("open-ended mode")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview calendar extension" }),
  ).toBeDisabled();
});

test("provider configuration remains unverified; inspector displays safe records", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByText("Not verified")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Request configuration", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Public connection label" })
    .fill("Classroom text");
  await page.getByRole("textbox", { name: "Environment name" }).fill("staging");
  await page
    .getByRole("button", { name: "Submit configuration request" })
    .click();
  await expect(
    page.getByRole("button", { name: "Configuration review pending" }),
  ).toBeDisabled();
  await expect(page.getByText("Not verified")).toHaveCount(2);
  await page.getByRole("button", { name: "Run inspector" }).click();
  await page
    .getByRole("button", { name: "Tool decisions", exact: true })
    .click();
  await expect(
    page.getByText("PROVIDER_NOT_CONFIGURED", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("0 recorded host tool calls")).toBeVisible();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await expect(
    page.getByLabel("Practice proposal plain text preview"),
  ).toContainText("No provider generated this text.");
});

test("permission, loading failure and stale-revision recovery", async ({
  page,
}) => {
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption("observer");
  await expect(
    page.getByRole("button", { name: "Edit course details" }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Scenario", exact: true })
    .selectOption("permission_denied");
  await expect(page.getByRole("alert")).toContainText("Permission denied");
  await page
    .getByRole("combobox", { name: "Scenario", exact: true })
    .selectOption("load_failure");
  await expect(page.getByRole("alert")).toContainText("service is unavailable");
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption("administrator");
  await page
    .getByRole("combobox", { name: "Scenario", exact: true })
    .selectOption("stale_revision");
  await page.getByRole("button", { name: "Edit course details" }).click();
  await page
    .getByRole("textbox", { name: "Course title" })
    .fill("A reviewed change");
  await page.getByRole("button", { name: "Save course details" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "changed since you opened",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Refresh and try again" })
    .click();
  await expect(page.getByText("revision 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit course details" }).click();
  await page
    .getByRole("textbox", { name: "Course title" })
    .fill("A reviewed change");
  await page.getByRole("button", { name: "Save course details" }).click();
  await expect(page.getByText("Demo course details saved.")).toBeVisible();
});

test("responsive layouts, focus and accessibility across admin views", async ({
  page,
}, info) => {
  await page.getByRole("button", { name: "Edit course details" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Close Edit course details" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Edit course details" }),
  ).toBeFocused();
  for (const view of [
    "Course & releases",
    "Enrollments",
    "Policy & extensions",
    "Providers",
    "Run inspector",
  ]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: view, exact: true, level: 1 }),
    ).toBeFocused();
    if (view === "Run inspector")
      await expect(page.getByText("0 recorded host tool calls")).toBeVisible();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
  for (const width of [768, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page
      .getByRole("button", { name: "Course & releases", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath(`workspace-${width}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const button of await page.getByRole("button").all()) {
      const box = await button.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});
