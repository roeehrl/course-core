import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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

test("operator prices are versioned and validated, the rule for unpriced models is explicit, and spend shows charged against actual", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/pricing-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "AI services" })
    .click();
  const prices = page.locator("#ai-prices");
  const block = prices.locator("fieldset.ai-price", {
    hasText: "public-text-model",
  });
  await expect(block).toContainText("used by Learner tutor");
  await expect(block).toContainText("Current price from");
  await expect(
    block.getByLabel("Input, per 1M tokens", { exact: true }),
  ).toHaveValue("0.30");
  await expect(
    block.getByLabel("Output, per 1M tokens", { exact: true }),
  ).toHaveValue("2.50");
  await expect(block.getByLabel("Source")).toHaveValue(
    "Synthetic fixture price",
  );
  await expect(page.locator("#ai-prices .ai-section-heading")).toContainText(
    "Done",
  );

  // Charged now against actual cost, from Course Core's own ledger.
  const spending = page.locator("#ai-spending");
  await spending.getByText("Spending so far").click();
  const totals = spending.locator("dl.ai-totals");
  await expect(totals).toContainText("Charged now$0.10");
  await expect(totals).toContainText("Actual cost of priced calls$0.00096");
  await expect(totals).toContainText("Held for calls in flight$0.10");
  await expect(spending.getByRole("table", { name: "By job" })).toContainText(
    "Learner tutor",
  );
  await spending.getByLabel("Group by").selectOption("month");
  await expect(
    spending.getByRole("table", { name: "By period" }),
  ).toContainText(new Date().toISOString().slice(0, 7));
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("pricing-and-spend.png"),
    fullPage: true,
  });

  // Both token prices or neither, and amounts with at most six decimals.
  await block.getByLabel("Input, per 1M tokens", { exact: true }).fill("");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(
    prices
      .getByRole("alert")
      .filter({ hasText: "Enter the input price, or leave both prices empty" }),
  ).toBeVisible();
  await block
    .getByLabel("Input, per 1M tokens", { exact: true })
    .fill("0.1234567");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(
    prices.getByRole("alert").filter({ hasText: "Enter an amount like 0.30" }),
  ).toBeVisible();
  await block.getByLabel("Input, per 1M tokens", { exact: true }).fill("0.15");
  await block.getByText("More price types").click();
  await block.getByLabel("Cached input, per 1M tokens").fill("0.0375");
  await block.getByLabel("Output, per 1M tokens", { exact: true }).fill("0.6");
  await block.getByLabel("Source").fill("Provider pricing page, read today");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(prices.getByText("Prices saved.")).toBeVisible();

  await page.reload();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "AI services" })
    .click();
  await expect(
    block.getByLabel("Input, per 1M tokens", { exact: true }),
  ).toHaveValue("0.15");
  await expect(block.getByLabel("Cached input, per 1M tokens")).toHaveValue(
    "0.0375",
  );
  await expect(block.getByLabel("Source")).toHaveValue(
    "Provider pricing page, read today",
  );

  // Allowing unpriced work needs an explicit acknowledgement of the conservative charge.
  const advanced = page.locator("#ai-advanced");
  await advanced.locator("summary").click();
  await advanced
    .getByRole("checkbox", {
      name: "Refuse paid work for models without a price",
    })
    .uncheck();
  await expect(
    advanced.getByRole("button", { name: "Save rule" }),
  ).toBeDisabled();
  await advanced
    .getByRole("checkbox", {
      name: /without a price each call is charged at its full per-request limit/,
    })
    .check();
  await advanced.getByRole("button", { name: "Save rule" }).click();
  await expect(advanced.getByText("Rule saved.")).toBeVisible();
  await page.reload();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "AI services" })
    .click();
  await page.locator("#ai-advanced summary").click();
  await expect(
    page.getByRole("checkbox", {
      name: "Refuse paid work for models without a price",
    }),
  ).not.toBeChecked();
  await accessible(page);
});
