import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { ownerOverrides, refusedRevisions } from "./eval-gate";

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

test("an Anthropic connection offers Messages API models for text roles only, never media, and its research model can price web searches", async ({
  page,
  request,
  browser,
}, info) => {
  const fixture = await (await request.post("/test/admin-fixture")).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
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
  await page.getByRole("button", { name: "Providers", exact: true }).click();

  // 1. The key is pasted once into the encrypted vault and never shown again.
  const secret = "SYNTHETIC_ANTHROPIC_BROWSER_CANARY";
  await page.getByLabel("Installed provider").selectOption("anthropic");
  await page.getByLabel("API key for new connection").fill(secret);
  await page.getByRole("button", { name: "Save new connection" }).click();
  await expect(page.getByText(/Configuration saved\./)).toBeVisible();
  await expect(page.getByLabel("API key for new connection")).toHaveValue("");
  await expect(page.getByLabel("Connection to inspect")).toContainText(
    "Anthropic ·",
  );

  // 2. Metadata only: the Models API listing, no generation.
  await page.getByRole("button", { name: "Inspect model metadata" }).click();
  await expect(page.getByText(/Inspected 2 models/)).toBeVisible();

  // 3. Text roles offer the Messages API models; media is not offered at all.
  await expect(page.getByLabel("media model")).toHaveCount(0);
  await expect(page.getByLabel("Media output kind")).toHaveCount(0);
  await expect(
    page.getByText(
      "Anthropic offers no image or video generation. The media role keeps its current connection.",
    ),
  ).toBeVisible();
  for (const role of ["companion", "supervisor", "research"])
    await expect(
      page.getByLabel(`${role} model`).locator("option"),
    ).toContainText([
      "Keep current role",
      "Disable role",
      "Claude Haiku 5.5 · claude-haiku-5-5",
      "Claude Sonnet 5.5 · claude-sonnet-5-5",
    ]);
  await page.getByLabel("companion model").selectOption("claude-haiku-5-5");
  await page.getByLabel("supervisor model").selectOption("claude-haiku-5-5");
  await page.getByLabel("research model").selectOption("claude-sonnet-5-5");
  await page
    .getByRole("checkbox", {
      name: "I declare these roles and parameters; metadata inspection is not live verification.",
    })
    .check();
  await page
    .getByRole("button", { name: "Review model configuration" })
    .click();
  await expect(
    page.getByText(/Required conservative reservation: [\d,]+/),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("anthropic-guided-roles.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Use draft and reserve / }).click();
  await page
    .getByRole("button", { name: "Save settings and cancel unfinished jobs" })
    .click();
  // The companion needs evaluation evidence; the guided supervisor (tool loop) and research
  // roles have no eval suite yet and activate as before.
  const waiting = await refusedRevisions(page);
  expect(waiting.map((r) => r.role)).toEqual(["companion"]);
  await ownerOverrides(browser, info.project.use.baseURL!, fixture.ownerCode, waiting, info.project.use.viewport);
  await page
    .getByRole("button", { name: "Save settings and cancel unfinished jobs" })
    .click();
  await expect(page.getByText(/Configuration saved\./)).toBeVisible();
  await expect(page.getByRole("list", { name: "Role evaluation status" })).toContainText("No eval suite for this role");
  await expect(
    page.getByText("Configured · live behavior unverified"),
  ).toHaveCount(3);
  // Paid work stays off: saving a model never grants spending.
  await expect(page.getByLabel("Total cost allowance (USD)")).toHaveValue(
    "0.000000",
  );

  // 4. Without operator prices, paid work for these models is refused.
  const companion = page.getByRole("region", { name: /:companion$/ });
  await expect(
    companion.getByText("No price: paid work refused"),
  ).toBeVisible();
  const research = page.getByRole("region", { name: /:research$/ });
  await expect(research.getByText("No price: paid work refused")).toBeVisible();

  // 5. A research price can include the per-search price the Messages API bills separately.
  const option = await page
    .getByLabel("Model to price")
    .locator("option", { hasText: ":research" })
    .first()
    .getAttribute("value");
  await page.getByLabel("Model to price").selectOption(option!);
  await page
    .getByLabel("Input price per 1M tokens (USD)", { exact: true })
    .fill("2");
  await page.getByLabel("Output price per 1M tokens (USD)").fill("10");
  await page.getByLabel("Price per web search (USD)").fill("0.0100000");
  await page
    .getByLabel("Where these prices come from")
    .fill("Synthetic operator price for a browser test");
  await page.getByRole("button", { name: "Save price version" }).click();
  await expect(
    page.getByText("Enter USD amounts with up to six decimal places."),
  ).toBeVisible();
  await page.getByLabel("Price per web search (USD)").fill("0.01");
  await page.getByRole("button", { name: "Save price version" }).click();
  await expect(
    page.getByText(/Price version 1 saved for .*:research\./),
  ).toBeVisible();
  await expect(research).toContainText(
    "input $2.000000 per 1M tokens · output $10.000000 per 1M tokens · $0.010000 per web search",
  );
  await expect(research.getByText("Priced", { exact: true })).toBeVisible();
  await expect(research).not.toContainText("No web search price.");
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("anthropic-prices.png"),
    fullPage: true,
  });
  expect(responses.length).toBeGreaterThan(0);
  expect(responses.every((body) => !body.includes(secret))).toBe(true);
});
