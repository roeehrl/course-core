import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectModeBadge, openSection } from "../workspaceNav";
test.beforeEach(async ({ page, request }, info) => {
  const setup = await request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const data = await setup.json();
  await page.goto("/admin/");
  await expect(
    page.getByRole("heading", { name: "Sign in to administration" }),
  ).toBeVisible();
  await page.getByLabel("One-time sign-in code").fill(data.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  await expectModeBadge(page, "CONNECTED WORKSPACE");
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
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Whole file (advanced)", exact: true })
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
    page.getByRole("button", { name: "Edit draft", exact: true }),
  ).toHaveCount(0);
  const session = await (await page.request.get("/api/admin/session")).json();
  const course = session.courses[0];
  const cataloguePath = `/api/workspaces/${course.workspaceId}/courses`;
  const saved = await (
    await page.request.get(`/api/admin/courses/${course.id}`)
  ).json();
  expect(
    (await (await page.request.get(cataloguePath)).json()).map(
      (r: { version: string }) => r.version,
    ),
  ).toEqual(["1.1.0"]);
  await page.getByRole("button", { name: /Version 1.0.0/ }).click();
  await page
    .getByRole("button", { name: "Use for new learners", exact: true })
    .click();
  // Selecting an older release is a rollback: staff confirm its impact first.
  const rollback = page.getByRole("dialog", {
    name: "Roll back new learners to version 1.0.0",
  });
  await expect(rollback.getByText(/Nobody is moved/)).toBeVisible();
  await rollback.getByRole("button", { name: "Confirm rollback" }).click();
  await expect(
    page.getByText(
      "Release selected for new learners. Existing enrollments remain pinned.",
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Selected for new learners", { exact: true }),
  ).toBeVisible();
  const after = await (
    await page.request.get(`/api/admin/courses/${course.id}`)
  ).json();
  expect(after.enrollments).toEqual(saved.enrollments);
  expect(
    (await (await page.request.get(cataloguePath)).json()).map(
      (r: { version: string }) => r.version,
    ),
  ).toEqual(["1.0.0"]);
  await page.getByRole("button", { name: /^Your account:/ }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to administration" }),
  ).toBeVisible();
});
test("a draft bundle loads from a chosen manifest file and saves through the real draft API", async ({
  page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByLabel("Version", { exact: true }).fill("1.2.0");
  await page
    .getByLabel("Release notes")
    .fill("A draft loaded from a manifest file.");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(
    page.getByText(/A validated draft bundle was created/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit draft" });
  await dialog
    .getByRole("button", { name: "Whole file (advanced)", exact: true })
    .click();
  const editor = dialog.getByLabel("Course bundle JSON");
  // The synthetic fixture course's own draft, changed, stands in for a built course.manifest.json.
  const manifest = JSON.parse(await editor.inputValue());
  manifest.summary = "Loaded from a manifest file in the browser.";
  const picker = dialog.getByLabel("Load from file…");
  // A compiled bundle wrapper is refused and points at the manifest; the text is unchanged.
  await picker.setInputFiles({
    name: "course.bundle.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ formatVersion: 1, server: manifest, client: {} }),
    ),
  });
  await expect(dialog.getByRole("alert")).toContainText(
    "Choose course.manifest.json",
  );
  expect(JSON.parse(await editor.inputValue()).summary).not.toBe(
    manifest.summary,
  );
  expect(
    (
      await new AxeBuilder({ page })
        .include("dialog")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await picker.setInputFiles({
    name: "course.manifest.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await expect(
    dialog.getByText(/Loaded course\.manifest\.json .* into the bundle below/),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(JSON.parse(await editor.inputValue())).toEqual(manifest);
  // The control fits the dialog at every viewport: no horizontal overflow.
  const box = await picker.boundingBox(),
    frame = await dialog.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
  await dialog.getByRole("button", { name: "Validate and save draft" }).click();
  await expect(
    page.getByText(
      "Draft bundle validated and saved. Previous approval was cleared.",
    ),
  ).toBeVisible();
  const session = await (await page.request.get("/api/admin/session")).json();
  const course = session.courses[0];
  const releases = (
    await (await page.request.get(`/api/admin/courses/${course.id}`)).json()
  ).releases as { id: string; version: string }[];
  const draft = releases.find((r) => r.version === "1.2.0")!;
  const saved = await (
    await page.request.get(
      `/api/admin/courses/${course.id}/releases/${draft.id}/manifest`,
    )
  ).json();
  expect(saved.manifest.summary).toBe(
    "Loaded from a manifest file in the browser.",
  );
});
test("real incorrect evidence cannot be accepted; profile and rejection persist", async ({
  page,
}) => {
  await openSection(page, "Enrollments");
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
  await openSection(page, "Enrollments");
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
  await openSection(page, "Policy & extensions");
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
  await openSection(page, "Enrollments");
  await page.getByRole("button", { name: "Edit profile" }).click();
  await page
    .getByLabel("Learning goal")
    .fill("Updated after policy migration.");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(
    page.getByText("Profile saved. Evidence and mastery are unchanged."),
  ).toBeVisible();
  await openSection(page, "AI services");
  await expect(page.locator(".ai-status-bar")).toContainText(
    "AI services are off:",
  );
  await expect(
    page.getByRole("heading", { name: "Models for each job", level: 2 }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
test("subscription fallback opt-in and opt-out persist through the real server without enabling spending", async ({
  page,
}, info) => {
  await openSection(page, "AI services");
  // A connection whose key the subscription can fall back to.
  await page
    .getByLabel("API key", { exact: true })
    .fill("SYNTHETIC_FALLBACK_KEY_CANARY");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(
    page.getByText("Connection saved. Key ending NARY."),
  ).toBeVisible();
  // A subscription connection is a developer setting: added through the JSON editor.
  const advanced = page.locator("#ai-advanced");
  await advanced.locator("summary").click();
  const current = JSON.parse((await advanced.locator("pre").textContent())!);
  current.adapters.push({
    id: "subscription-one",
    kind: "subscription-fixture",
    subscriptionRef: "host-connection",
  });
  await advanced.getByRole("checkbox", { name: "Edit as JSON" }).check();
  await advanced.getByLabel("Configuration JSON").fill(JSON.stringify(current));
  await advanced.getByRole("button", { name: "Save JSON" }).click();
  await expect(
    advanced.getByText("Configuration saved and turned on."),
  ).toBeVisible();
  const choice = advanced.getByRole("checkbox", {
    name: "If the subscription subscription-one runs out, use an API key instead",
  });
  await expect(choice).not.toBeChecked();
  await choice.check();
  await advanced
    .getByLabel("API key to use")
    .selectOption({ label: "Google Gemini" });
  await advanced.getByRole("button", { name: "Save fallback" }).click();
  await expect(
    advanced.getByText("Configuration saved and turned on."),
  ).toBeVisible();
  await page.reload();
  await openSection(page, "AI services");
  await page.locator("#ai-advanced summary").click();
  await expect(choice).toBeChecked();
  await expect(page.locator(".ai-status-bar")).toContainText("spending is off");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("subscription-fallback.png"),
    fullPage: true,
  });
  await choice.uncheck();
  await page
    .locator("#ai-advanced")
    .getByRole("button", { name: "Save fallback" })
    .click();
  await expect(
    page
      .locator("#ai-advanced")
      .getByText("Configuration saved and turned on."),
  ).toBeVisible();
  await page.reload();
  await openSection(page, "AI services");
  await page.locator("#ai-advanced summary").click();
  await expect(choice).not.toBeChecked();
});
