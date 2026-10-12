import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.beforeEach(async ({ page, request }, info) => {
  const setup = await request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const data = await setup.json();
  await page.goto("/admin/");
  await expect(
    page.getByRole("heading", { name: "Sign in to administration" }),
  ).toBeVisible();
  await page.getByLabel("One-time sign-in code").fill(data.code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("CONNECTED WORKSPACE")).toBeVisible();
  await expect(page.getByText("Interactive demo", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: info.outputPath("connected-admin.png"),
    fullPage: true,
  });
});
test("real cookie session, draft validation/review/publication and immutable reload", async ({
  page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByLabel("Version", { exact: true }).fill("1.1.0");
  await page
    .getByLabel("Release notes")
    .fill("A real validated release from the existing bundle.");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(
    page.getByText(
      "A validated draft bundle was created. Runtime readiness and review still govern publication.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit draft bundle", exact: true })
    .click();
  const editor = page.getByLabel("Course bundle JSON");
  const manifest = JSON.parse(await editor.inputValue());
  manifest.summary = "Updated through the real draft API.";
  await editor.fill(JSON.stringify(manifest, null, 2));
  await page.getByRole("button", { name: "Validate and save draft" }).click();
  await expect(
    page.getByText(
      "Draft bundle validated and saved. Previous approval was cleared.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve review" }).click();
  await page
    .getByRole("button", { name: "Publish release", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /I confirm publication/ }).check();
  await page.getByRole("button", { name: "Confirm publication" }).click();
  await expect(
    page.getByText(
      "Reviewed release published. Existing enrollments remain pinned.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Release 1.1.0", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit draft bundle", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to administration" }),
  ).toBeVisible();
});
test("real incorrect evidence cannot be accepted; profile and rejection persist", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Enrollments", exact: true }).click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByLabel("Display name").fill("Updated public learner");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Updated public learner" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review evidence" }).click();
  await expect(
    page.getByRole("option", {
      name: "Acknowledge valid evidence (no grade change)",
    }),
  ).toBeDisabled();
  await page
    .getByLabel("Review note")
    .fill("Invalidated after reviewing the recorded incorrect answer.");
  await page.getByRole("button", { name: "Record review" }).click();
  await expect(
    page.getByText(
      "Evidence invalidated. Progress and descendant availability are recomputed from remaining evidence.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
  await page.reload();
  await page.getByRole("button", { name: "Enrollments", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Updated public learner" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review evidence" }),
  ).toHaveCount(0);
});
test("real offer remains ungranted; concrete migration preserves the calendar clock", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Policy & extensions" }).click();
  await page
    .getByRole("button", { name: "Preview calendar extension" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Resolved extension terms" }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "enrollment.started", exact: true })
    .check();
  await page.getByRole("checkbox", { name: "Minimum", exact: true }).check();
  await page
    .getByLabel("Plan impact")
    .fill("More calendar time for existing work.");
  await page
    .getByLabel("Alternatives (one per line)")
    .fill("Keep the existing deadline.");
  await page
    .getByRole("checkbox", { name: /I reviewed these exact terms/ })
    .check();
  await page.getByRole("button", { name: "Propose offer to learner" }).click();
  await expect(
    page.getByText("Awaiting exact learner consent", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit policy scopes" }).click();
  const source = page.getByLabel("Proposed scope definitions (JSON)");
  const scopes = JSON.parse(await source.inputValue());
  scopes[0].work.additionalMinutes = 240;
  await source.fill(JSON.stringify(scopes, null, 2));
  await page
    .getByRole("button", { name: "Compute policy impact preview" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Concrete migration impact" }),
  ).toBeVisible();
  await page
    .getByLabel("Reason for migration")
    .fill(
      "Bound additional learning work while preserving the calendar anchor.",
    );
  await page
    .getByRole("checkbox", { name: /I reviewed this exact migration/ })
    .check();
  await page.getByRole("button", { name: "Apply reviewed migration" }).click();
  await expect(
    page.getByText(
      "Reviewed policy migration applied. Existing anchors, pools, grants and ledger history were preserved.",
    ),
  ).toBeVisible();
  await expect(page.getByText("superseded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Enrollments", exact: true }).click();
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page
    .getByLabel("Learning goal")
    .fill("Updated after policy migration.");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByText("Profile saved. Evidence and mastery are unchanged."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.getByText("Not verified")).toHaveCount(4);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
