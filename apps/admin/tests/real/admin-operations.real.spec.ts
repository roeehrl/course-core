import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceNav } from "../workspaceNav";

// Real API and PostgreSQL: the chapter and lesson editor with its server check and learner
// preview, the confirmed forward publish, the platform and integrations pages, the audit export
// and policy history, and stopping one run. Phone, tablet and desktop projects run each test.
const axeTags = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const accessible = async (page: Page) => {
  expect(
    (await new AxeBuilder({ page }).withTags(axeTags).analyze()).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
};
async function signIn(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
}
async function open(page: Page, view: string) {
  await (await workspaceNav(page)).getByRole("button", { name: view }).click();
  await expect(
    page.getByRole("heading", { name: view, level: 1 }),
  ).toBeVisible();
}

test("an administrator edits lessons as forms, checks and previews the draft, then publishes after confirming who it affects", async ({
  page,
}, info) => {
  const fixture = await (await page.request.post("/test/admin-fixture")).json();
  await signIn(page, fixture.code);
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByLabel("Version", { exact: true }).fill("1.1.0");
  await page.getByLabel("Release notes").fill("Clearer lesson titles.");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(
    page.getByText(/A validated draft bundle was created/),
  ).toBeVisible();

  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit draft" });
  await dialog.getByText("Minimum", { exact: true }).click();
  const title = dialog.getByLabel("Lesson title").first();
  await title.fill("Finding the smallest value");
  await dialog.getByRole("button", { name: "Check the draft" }).click();
  await expect(dialog.getByText("The draft passed every check")).toBeVisible();
  await expect(
    dialog.getByText(/1 change from the version learners start on now/),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("structured-editor.png") });

  // The unsaved draft as made-up learners meet it.
  await dialog.getByRole("button", { name: "Preview as learners" }).click();
  await dialog.getByRole("button", { name: "Show the preview" }).click();
  await expect(
    dialog.getByText("This preview shows your unsaved changes."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Finding the smallest value" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Finished the first chapter" })
    .click();
  await expect(
    dialog.getByText("This learner has finished every required lesson."),
  ).toBeVisible();
  await accessible(page);

  await dialog.getByRole("button", { name: "Chapters and lessons" }).click();
  await dialog.getByRole("button", { name: "Check and save draft" }).click();
  await expect(
    page.getByText(
      "Draft bundle validated and saved. Previous approval was cleared.",
    ),
  ).toBeVisible();
  const draft = await (
    await page.request.get(`/api/admin/courses/${fixture.catalogId}`)
  ).json();
  const saved = draft.releases.find(
    (r: { version: string }) => r.version === "1.1.0",
  );
  const manifest = await (
    await page.request.get(
      `/api/admin/courses/${fixture.catalogId}/releases/${saved.id}/manifest`,
    )
  ).json();
  expect(manifest.manifest.chapters[0].episodes[0].title).toBe(
    "Finding the smallest value",
  );

  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.getByRole("button", { name: "Approve review" }).click();
  await page
    .getByRole("button", { name: "Publish release", exact: true })
    .click();
  const publish = page.getByRole("dialog", {
    name: "Publish reviewed release",
  });
  await expect(
    publish.getByText(/1 learner stays on version 1.0.0/),
  ).toBeVisible();
  await expect(publish.getByText(/Nobody is moved/)).toBeVisible();
  await accessible(page);
  await publish
    .getByRole("checkbox", { name: /I confirm publication/ })
    .check();
  await publish.getByRole("button", { name: "Confirm publication" }).click();
  await expect(
    page.getByText(
      "Reviewed release published. Existing enrollments remain pinned.",
    ),
  ).toBeVisible();
  // The learner already enrolled stayed on the version they started.
  const after = await (
    await page.request.get(`/api/admin/courses/${fixture.catalogId}`)
  ).json();
  expect(
    after.enrollments.map((e: { releaseVersion: string }) => e.releaseVersion),
  ).toEqual(["1.0.0"]);
});

test("an administrator sees platform readiness with the recovery targets, integrations and billed costs, and downloads the audit log", async ({
  page,
}, info) => {
  const fixture = await (await page.request.post("/test/admin-fixture")).json();
  expect((await page.request.post("/test/backup-reports")).ok()).toBe(true);
  await signIn(page, fixture.code);

  await open(page, "Platform");
  await expect(page.getByText("Is the platform ready?")).toBeVisible();
  const database = page.locator("section", {
    has: page.getByRole("heading", { name: "Database" }),
  });
  await expect(database.getByText("Working")).toBeVisible();
  await expect(
    page.getByText("The newest good copy is 20 minutes old."),
  ).toBeVisible();
  await expect(
    page.getByText(/The last restore drill took 2 minutes/),
  ).toBeVisible();
  // The host inventory an author checks a course against (K12): a real download from the API.
  await expect(
    page.getByText("Check a course against this server"),
  ).toBeVisible();
  const [inventoryDownload] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Download the server's inventory" })
      .click(),
  ]);
  expect(inventoryDownload.suggestedFilename()).toMatch(
    /^host-inventory-\d+\.\d+\.\d+\.json$/,
  );
  const inventory = JSON.parse(
    readFileSync(await inventoryDownload.path(), "utf8"),
  );
  expect(inventory).toMatchObject({
    hostInventoryFormat: 1,
    sdk: {
      supported: { min: expect.any(String), maxExclusive: expect.any(String) },
    },
  });
  await expect(page.getByText(/Downloaded\. File digest:/)).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("platform.png"),
    fullPage: true,
  });

  await open(page, "Integrations");
  await expect(page.getByText("Can each course run here?")).toBeVisible();
  await page.getByLabel("Provider").fill("Example AI");
  await page.getByLabel("Amount billed (USD)").fill("1.25");
  await page
    .getByLabel("Where the figure comes from")
    .fill("Synthetic invoice line 1");
  await page.getByRole("button", { name: "Record billed amount" }).click();
  await expect(page.getByText(/Recorded. It is listed below/)).toBeVisible();
  const table = page.getByRole("table", {
    name: "Billed amounts and estimates (days in UTC)",
  });
  await expect(
    table.getByText("Billed $1.25 more than estimated"),
  ).toBeVisible();
  await accessible(page);

  await open(page, "Audit log");
  await expect(
    page.getByRole("heading", { name: "Policy changes" }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^audit-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/,
  );
  const text = await (
    await file.createReadStream()
  )
    .toArray()
    .then((chunks) => Buffer.concat(chunks).toString("utf8"));
  expect(text.split("\r\n")[0]).toBe(
    "sequence,id,at,actorKind,actor,type,enrollmentId,payloadWithheld,payload",
  );
  expect(text).toContain("provider.billed_statement_recorded");
  await expect(page.getByText(/Downloaded \d+ events/)).toBeVisible();
  await accessible(page);
});

test("platform pages stay hidden from roles that cannot use them", async ({
  page,
}) => {
  const fixture = await (await page.request.post("/test/admin-fixture")).json();
  await signIn(page, fixture.observerCode);
  const nav = await workspaceNav(page);
  await expect(nav.getByRole("button", { name: "Audit log" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Platform" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Integrations" })).toHaveCount(
    0,
  );
  expect(
    (await page.request.get(`/api/admin/courses/${fixture.catalogId}`)).ok(),
  ).toBe(true);
});

test("an owner stops one live run with a reason and it can no longer be stopped again", async ({
  page,
}) => {
  const fixture = await (
    await page.request.post("/test/inspector-fixture")
  ).json();
  await signIn(page, fixture.ownerCode);
  await open(page, "Run inspector");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .getByLabel("Why stop it")
    .fill("Synthetic test: stopping this run.");
  await page.getByRole("button", { name: "Stop this run" }).click();
  await expect(page.getByText("Stop requested")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop this run" })).toHaveCount(
    0,
  );
  await accessible(page);
});
