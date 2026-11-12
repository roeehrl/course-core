import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSection } from "../workspaceNav";

// Real server and database. After a Core upgrade the tutor is on without a check for the current
// quality checks: it is flagged on the Courses home and on the AI services page, each with a
// "Run check" for that job only, and it keeps working. The check runs against the synthetic
// Gemini model of scripts/real-server.ts; no provider is contacted.
async function accessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
}
async function signIn(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  // A first visit opens on the Courses home.
  await expect(
    page.getByRole("heading", { name: "Courses", level: 1 }),
  ).toBeVisible();
}
const open = (page: Page, name: string) => openSection(page, name);
/** The tutor is on and checked, with its model (its id is under the row's technical details). */
async function expectChecked(check: Locator) {
  const tutor = check
    .getByRole("list", { name: "Jobs that are on" })
    .locator('[data-role="companion"]');
  await expect(tutor).toContainText("Learner tutor");
  await expect(tutor.getByText("Checked", { exact: true })).toBeVisible();
  await expect(tutor).toContainText("public-text-model");
}

test("the Courses home flags a job that needs a check after an upgrade and runs the check for that job only", async ({
  page,
  request,
}, info) => {
  const fixture = await (
    await request.post("/test/upgraded-ai-fixture")
  ).json();
  await signIn(page, fixture.adminCode);
  const card = page.getByTestId("overview-ai-checks");
  await expect(card).toContainText(
    "1 AI job is on but hasn't passed the current quality checks",
  );
  await expect(card).toContainText("They keep working for learners.");
  const job = card.locator('[data-role="companion"]');
  await expect(job).toContainText("Learner tutor");
  await expect(job.getByText("Needs a check", { exact: true })).toBeVisible();
  await expect(job).toContainText("Needs a new check");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("overview-flagged.png"),
    fullPage: true,
  });
  await job
    .getByRole("button", { name: "Run check for Learner tutor" })
    .click();
  await expect(card).toContainText(/Learner tutor: passed all \d+/, {
    timeout: 30000,
  });
  await expect(card).toContainText(
    "Every AI job that is on has passed the current quality checks",
  );
  await expect(card.locator('[data-role="companion"]')).toHaveCount(0);
  // The AI services page agrees: the tutor is checked, and was never turned off.
  await card.getByRole("button", { name: "Open AI services" }).click();
  await expectChecked(page.locator("#ai-check"));
});

test("the AI services page flags the job with its own Run check; the route checks a job that is on again and refuses one that does not exist", async ({
  page,
  request,
}, info) => {
  const fixture = await (
    await request.post("/test/upgraded-ai-fixture")
  ).json();
  await signIn(page, fixture.ownerCode);
  await open(page, "AI services");
  const check = page.locator("#ai-check");
  const flags = check.getByRole("list", { name: "Jobs that are on" });
  const job = flags.locator('[data-role="companion"]');
  await expect(job.getByText("Needs a check", { exact: true })).toBeVisible();
  // Its own check: how many practice conversations, and about what it costs.
  await expect(job).toContainText(/\d+ practice conversations · about \$/);
  await expect(check).toContainText("They keep working as they are.");
  // With one job to check there is no second "check everything" button.
  await expect(
    check.getByRole("button", { name: "Run quality check" }),
  ).toHaveCount(0);
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("ai-services-flagged.png"),
    fullPage: true,
  });
  await job
    .getByRole("button", { name: "Run check for Learner tutor" })
    .click();
  await expect(check).toContainText(/Learner tutor: passed all \d+/, {
    timeout: 30000,
  });
  await expectChecked(check);
  // The result shows once, as the latest check under the list of jobs.
  await expect(check.getByText(/Learner tutor: passed all \d+/)).toHaveCount(1);
  await check.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("ai-services-job-checked.png"),
    fullPage: true,
  });

  // The route checks a job that is on again, and refuses an unknown job.
  const workspaces = await (
    await page.request.get("/api/admin/session")
  ).json();
  const workspaceId = workspaces.workspaces[0].id as string;
  const csrf = (await page.context().cookies()).find(
    (c) => c.name === "course_csrf",
  )!.value;
  const post = (data: object) =>
    page.request.post(
      `/api/admin/workspaces/${workspaceId}/provider-setup/quality-check`,
      {
        data,
        headers: { "x-csrf-token": csrf, origin: new URL(page.url()).origin },
      },
    );
  const again = await post({
    idempotencyKey: "browser:again:0001",
    target: "active",
    role: "companion",
  });
  // A job that is on can be checked again (its row keeps a Run check, 76ecc361).
  expect(again.status(), await again.text()).toBe(200);
  expect(
    (
      await post({
        idempotencyKey: "browser:unknown:0001",
        target: "active",
        role: "wizard",
      })
    ).status(),
  ).toBe(400);
});
