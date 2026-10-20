import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { refusedRevisions } from "./eval-gate";

// Real server and database. No provider is contacted: saving a configuration never calls a model.
async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await expect(page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).resolves.toBeLessThanOrEqual(1);
}
async function signIn(page: Page, code: string) {
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Course & releases", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Providers", exact: true }).click();
}
const configuration = {
  registry: { revision: "eval-gate-browser", models: [{ id: "text-companion", providerId: "google-main", remoteModel: "public-text-model",
    providerConfig: { transport: "generate_content", apiVersion: "v1beta", maxResponseBytes: 1048576 }, enabled: true, capabilities: ["tutoring"], tools: [],
    limits: { maxInputCharacters: 30000, maxOutputTokens: 1000 } }] },
  adapters: [{ id: "google-main", kind: "google", credentialEnv: "GOOGLE_API_KEY" }],
  roles: { companion: { modelId: "text-companion", maxInputCharacters: 12000, maxOutputTokens: 1000 } },
};

test("a new companion revision waits for evaluation; only the owner's audited override lets it activate", async ({ page, request, browser }, info) => {
  const fixture = await (await request.post("/test/admin-fixture")).json();
  await signIn(page, fixture.code);
  await expect(page.getByRole("heading", { name: "Agent evaluations" })).toBeVisible();
  await expect(page.getByText("No workspace provider revision is active.")).toBeVisible();

  // 1. The administrator's save is refused and nothing is activated.
  await page.getByLabel("Provider configuration JSON").fill(JSON.stringify(configuration));
  await page.getByLabel("Per-job token allowance").fill("100000");
  await page.getByRole("button", { name: "Save settings and cancel unfinished jobs" }).click();
  const [waiting] = await refusedRevisions(page);
  expect(waiting!.role).toBe("companion");
  await expect(page.getByText(/no evaluation recorded/)).toBeVisible();
  // The override form is prefilled with the refused revision, but administrators cannot use it.
  await expect(page.getByLabel("Revision digest")).toHaveValue(waiting!.digest);
  await page.getByLabel("Reason", { exact: true }).fill("Administrators cannot accept unevaluated revisions.");
  await page.getByRole("button", { name: "Record owner override" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Only a workspace owner can record an override." })).toBeVisible();
  await accessible(page);
  await page.screenshot({ path: info.outputPath("eval-gate-refused.png"), fullPage: true });
  await page.locator("section.card", { has: page.getByRole("heading", { name: "Agent evaluations" }) })
    .screenshot({ path: info.outputPath("eval-gate-panel-refused.png") });

  // 2. The owner records an override for exactly that revision.
  const context = await browser.newContext({ baseURL: info.project.use.baseURL, ...(info.project.use.viewport ? { viewport: info.project.use.viewport } : {}) });
  const owner = await context.newPage();
  await signIn(owner, fixture.ownerCode);
  await owner.getByLabel("Role", { exact: true }).selectOption("companion");
  await owner.getByLabel("Revision digest").fill(waiting!.digest);
  await owner.getByLabel("Reason", { exact: true }).fill("Reviewed held-out transcripts for this revision by hand.");
  await owner.getByRole("button", { name: "Record owner override" }).click();
  await expect(owner.getByText(`Override recorded for the companion revision ${waiting!.digest.slice(0, 12)}.`, { exact: false })).toBeVisible();
  await expect(owner.getByRole("region", { name: "Owner overrides" })).toContainText("Reviewed held-out transcripts for this revision by hand.");
  await accessible(owner);
  await owner.screenshot({ path: info.outputPath("eval-gate-owner-override.png"), fullPage: true });
  await context.close();

  // 3. The same save now activates, and the role shows how it was accepted.
  await page.getByRole("button", { name: "Save settings and cancel unfinished jobs" }).click();
  await expect(page.getByText(/Configuration saved\./)).toBeVisible();
  await expect(page.getByText("Waiting for evaluation")).toHaveCount(0);
  const roles = page.getByRole("list", { name: "Role evaluation status" });
  await expect(roles).toContainText("companion");
  await expect(roles).toContainText("Owner override");
  await expect(roles).toContainText(waiting!.digest.slice(0, 12));
  await accessible(page);
  await page.screenshot({ path: info.outputPath("eval-gate-activated.png"), fullPage: true });
  await page.locator("section.card", { has: page.getByRole("heading", { name: "Agent evaluations" }) })
    .screenshot({ path: info.outputPath("eval-gate-panel.png") });
});
