import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSection } from "../workspaceNav";

// Real server and database. After a Core upgrade the tutor is on without a check for the current
// quality checks: it is flagged on the course overview and on the AI services page, each with a
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
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
}
const open = (page: Page, name: string) => openSection(page, name);

test("the course overview flags a job that needs a check after an upgrade and runs the check for that job only", async ({
  page,
  request,
}, info) => {
  const fixture = await (
    await request.post("/test/upgraded-ai-fixture")
  ).json();
  await signIn(page, fixture.adminCode);
  await open(page, "Overview");
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
  const check = page.locator("#ai-check");
  await expect(check).toContainText(
    "Learner tutor — public-text-model · Checked",
  );
});

test("the AI services page flags the job with its own Run check; the route refuses a job that needs no check or does not exist", async ({
  page,
  request,
}, info) => {
  const fixture = await (
    await request.post("/test/upgraded-ai-fixture")
  ).json();
  await signIn(page, fixture.ownerCode);
  await open(page, "AI services");
  const check = page.locator("#ai-check");
  const flags = check.getByRole("list", {
    name: "Jobs that are on and need a quality check",
  });
  const job = flags.locator('[data-role="companion"]');
  await expect(job.getByText("Needs a check", { exact: true })).toBeVisible();
  await expect(job).toContainText("Checks this job only, with");
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
  await expect(check).toContainText(
    "Learner tutor — public-text-model · Checked",
  );
  // The result shows once (it used to show again under "Run the quality check").
  await expect(check.getByText(/Learner tutor: passed all \d+/)).toHaveCount(1);
  await check.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("ai-services-job-checked.png"),
    fullPage: true,
  });

  // The route refuses a job that no longer needs a check, and an unknown job.
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
  expect(again.status()).toBe(409);
  expect((await again.json()).error).toBe("PROVIDER_QUALITY_CHECK_NOT_NEEDED");
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
