import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Real server and database; the Anthropic Models API page is scripted by the test server.
// No live Anthropic call is made and no generation endpoint is reachable from this suite.
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

test("an Anthropic connection offers Messages API models for text jobs only, never media, and its research model can price web searches", async ({
  page,
  request,
}, info) => {
  const fixture = await (await request.post("/test/admin-fixture")).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.ownerCode);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  const responses: string[] = [];
  page.on("response", (r) => {
    if (
      r.url().includes("/api/admin/") &&
      r.headers()["content-type"]?.includes("application/json")
    )
      void r
        .text()
        .then((body) => responses.push(body))
        .catch(() => {});
  });
  await page.getByRole("button", { name: "AI services", exact: true }).click();

  // 1. The key is tested with the Models API listing (metadata only), saved once and never shown.
  const secret = "SYNTHETIC_ANTHROPIC_BROWSER_CANARY";
  await page.getByRole("radio", { name: "Anthropic Claude" }).check();
  await expect(page.getByRole("link", { name: /Create a key in the Anthropic Console/ })).toBeVisible();
  await page.getByLabel("API key", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByText("Connection saved. Key ending NARY.")).toBeVisible();
  await expect(page.locator(".ai-connection")).toContainText("Anthropic Claude");

  // 2. Text jobs offer the Messages API models; Images and video is not offered at all.
  const models = page.locator("#ai-models");
  await expect(
    models.getByLabel("Model for Learner tutor").locator("option:checked"),
  ).toContainText("claude-sonnet-5-5");
  await models.getByText(/Optional jobs \(3\)/).click();
  await expect(models.getByText("Anthropic doesn't offer this job.")).toBeVisible();
  await expect(models.getByLabel("Model for Images and video")).toHaveCount(0);
  await expect(
    models.getByLabel("Model for Source finder").locator("option"),
  ).toContainText([
    "Off",
    "Claude Haiku 5.5 (claude-haiku-5-5) — Suggested",
    "Claude Sonnet 5.5 (claude-sonnet-5-5)",
  ]);
  await models
    .getByLabel("Model for Source finder")
    .selectOption({ label: "Claude Haiku 5.5 (claude-haiku-5-5) — Suggested" });
  await models.getByRole("button", { name: "Save models" }).click();
  await expect(models.getByText(/Models saved\. 1 model needs a quality check/)).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("anthropic-models.png"),
    fullPage: true,
  });

  // 3. Prices per model before anything turns on; research can price web searches.
  const prices = page.locator("#ai-prices");
  await expect(prices).toContainText("Course Core doesn't include Anthropic's prices");
  const haiku = prices.locator("fieldset.ai-price", { hasText: "claude-haiku-5-5" });
  await expect(haiku).toContainText("used by Source finder");
  await haiku.getByLabel("Input, per 1M tokens", { exact: true }).fill("2");
  await haiku.getByLabel("Output, per 1M tokens", { exact: true }).fill("10");
  await haiku.getByText("More price types").click();
  await haiku.getByLabel("Per web search").fill("0.0100000");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(prices.getByRole("alert").filter({ hasText: "Enter an amount like 0.30" })).toBeVisible();
  await haiku.getByLabel("Per web search").fill("0.01");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(prices.getByText("Prices saved.")).toBeVisible();

  // 4. The owner approves the tutor; the planner and source finder have no check yet.
  const check = page.locator("#ai-check");
  await check
    .getByLabel("Why are you skipping the check?")
    .fill("Synthetic browser fixture: this model is never contacted.");
  await check.getByRole("button", { name: "Approve and turn on" }).click();
  await expect(check.getByText("Approved and turned on.")).toBeVisible();
  await expect(check).toContainText("Source finder — claude-haiku-5-5 · No check for this job yet — ready");
  // Saving models never grants spending: spending stays off until the button is pressed.
  await expect(page.locator(".ai-status-bar")).toContainText("spending is off");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("anthropic-prices.png"),
    fullPage: true,
  });
  expect(responses.length).toBeGreaterThan(0);
  expect(responses.every((body) => !body.includes(secret))).toBe(true);
});
