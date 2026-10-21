import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ownerApproves } from "./eval-gate";

// Real server and database. No provider is contacted: saving a configuration never calls a model.
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
  await page.getByRole("button", { name: "AI services", exact: true }).click();
}
const configuration = {
  registry: {
    revision: "eval-gate-browser",
    models: [
      {
        id: "text-companion",
        providerId: "google-main",
        remoteModel: "public-text-model",
        providerConfig: {
          transport: "generate_content",
          apiVersion: "v1beta",
          maxResponseBytes: 1048576,
        },
        enabled: true,
        capabilities: ["tutoring"],
        tools: [],
        limits: { maxInputCharacters: 30000, maxOutputTokens: 1000 },
      },
    ],
  },
  adapters: [
    { id: "google-main", kind: "google", credentialEnv: "GOOGLE_API_KEY" },
  ],
  roles: {
    companion: {
      modelId: "text-companion",
      maxInputCharacters: 12000,
      maxOutputTokens: 1000,
    },
  },
};

test("a new tutor model waits for a quality check; only the owner's audited approval turns it on", async ({
  page,
  request,
  browser,
}, info) => {
  const fixture = await (await request.post("/test/admin-fixture")).json();
  await signIn(page, fixture.code);
  const check = page.locator("#ai-check");
  await expect(check).toContainText("No model is waiting for a check.");

  // 1. A developer's JSON change goes through the same draft and gate: nothing turns on yet.
  const advanced = page.locator("#ai-advanced");
  await advanced.locator("summary").click();
  await advanced.getByLabel("Tokens per request").fill("100000");
  await advanced.getByRole("button", { name: "Save limits" }).click();
  await expect(advanced.getByText("Limits saved.")).toBeVisible();
  await advanced.getByRole("checkbox", { name: "Edit as JSON" }).check();
  await advanced
    .getByLabel("Configuration JSON")
    .fill(JSON.stringify(configuration));
  await advanced.getByRole("button", { name: "Save JSON" }).click();
  await expect(
    advanced.getByText(/Configuration saved as a draft\. It turns on after the quality check/),
  ).toBeVisible();
  await expect(check).toContainText("This model hasn't been checked yet:");
  await expect(check).toContainText("Learner tutor — public-text-model");
  // Administrators cannot approve without a check.
  await expect(
    check.getByText(
      "Only an owner can approve without checking. Ask an owner, or run the check.",
    ),
  ).toBeVisible();
  await expect(check.getByRole("button", { name: "Approve and turn on" })).toHaveCount(0);
  await expect(page.locator(".ai-status-bar")).toContainText(
    "1 model is waiting for a quality check",
  );
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("eval-gate-waiting.png"),
    fullPage: true,
  });

  // 2. The owner approves the waiting model with a reason, on the same page.
  await ownerApproves(
    browser,
    info.project.use.baseURL!,
    fixture.ownerCode,
    info.project.use.viewport,
    "Reviewed held-out transcripts for this revision by hand.",
  );

  // 3. The tutor is on, and the history shows how it was accepted.
  await page.reload();
  await page.getByRole("button", { name: "AI services", exact: true }).click();
  await expect(check).toContainText("No model is waiting for a check.");
  await expect(check).toContainText(
    "Learner tutor — public-text-model · Approved without checking",
  );
  await page.locator("#ai-advanced summary").click();
  await expect(page.locator("#ai-advanced")).toContainText(
    "Learner tutor: approved without checking on",
  );
  await expect(page.locator("#ai-advanced")).toContainText(
    "Reviewed held-out transcripts for this revision by hand.",
  );
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("eval-gate-activated.png"),
    fullPage: true,
  });
});
