import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { workspaceNav } from "../workspaceNav";
import { fieldIconOverlaps, fieldsWithIcons } from "../fieldIcons";

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
  await (
    await workspaceNav(page)
  )
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
  await (
    await workspaceNav(page)
  )
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
  await (
    await workspaceNav(page)
  )
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

test("a price already scheduled for later: today's price still changes, and the scheduled one can be changed or removed", async ({
  page,
}, info) => {
  const fixture = await (
    await page.request.post("/test/pricing-fixture", {
      data: { scheduled: true },
    })
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  const openPrices = async () => {
    await (
      await workspaceNav(page)
    )
      .getByRole("button", { name: "AI services" })
      .click();
    await expect(
      block.getByLabel("Input, per 1M tokens", { exact: true }),
    ).toBeVisible();
  };
  const prices = page.locator("#ai-prices");
  const block = prices.locator("fieldset.ai-price", {
    hasText: "public-text-model",
  });
  const scheduled = block.locator(".ai-price-scheduled");
  await openPrices();
  await expect(scheduled).toHaveCount(1);
  await expect(scheduled).toContainText(
    /^Scheduled change from .+: \$0\.40 input and \$2\.80 output per 1M tokens\./,
  );
  await expect(block).toContainText(
    /Saving applies these prices from now until .+\. Then the scheduled change applies\./,
  );
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("scheduled-price.png"),
    fullPage: true,
  });

  // Today's price changes although a later price is scheduled; the scheduled one stays.
  await block.getByLabel("Input, per 1M tokens", { exact: true }).fill("0.35");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(prices.getByText("Prices saved.")).toBeVisible();
  await expect(scheduled).toContainText("$0.40 input and $2.80 output");

  // The scheduled price is changed in a dialog that says what saving will do.
  await block.getByRole("button", { name: "Change scheduled price" }).click();
  const dialog = page.getByRole("dialog", { name: /^Price from / });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel("Input, per 1M tokens", { exact: true });
  await expect(input).toHaveValue("0.40");
  await input.fill("0.45");
  expect(await fieldIconOverlaps(dialog)).toEqual([]);
  await expect(dialog).toContainText(
    /Until .+ the current price stays\. From .+: \$0\.45 input and \$2\.80 output per 1M tokens\./,
  );
  await accessible(page);
  await page.screenshot({ path: info.outputPath("scheduled-dialog.png") });
  await dialog.getByRole("button", { name: "Save scheduled price" }).click();
  await expect(prices.getByText("Scheduled price saved.")).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.reload();
  await openPrices();
  await expect(scheduled).toContainText("$0.45 input and $2.80 output");
  await expect(
    block.getByLabel("Input, per 1M tokens", { exact: true }),
  ).toHaveValue("0.35");

  // Removing the change keeps today's price after that date: no scheduled change is left.
  await block.getByRole("button", { name: "Keep the current price" }).click();
  const confirm = page.getByRole("dialog", {
    name: /^Remove the change scheduled for /,
  });
  await confirm.getByRole("button", { name: "Keep the current price" }).click();
  await expect(
    prices.getByText(/was removed\. The current price stays\./),
  ).toBeVisible();
  await expect(scheduled).toHaveCount(0);
  await expect(block).not.toContainText("Saving applies these prices");

  // Today's price changes again, and nothing brings the old price back later.
  await block.getByLabel("Input, per 1M tokens", { exact: true }).fill("0.38");
  await prices.getByRole("button", { name: "Save prices" }).click();
  await expect(prices.getByText("Prices saved.")).toBeVisible();
  // The version that kept the price at that date followed the new price (the server's view).
  const view = await (
    await page.request.get(
      `/api/admin/workspaces/${fixture.workspaceId}/provider-pricing`,
    )
  ).json();
  const model = view.models.find(
    (m: { modelId: string }) => m.modelId === "text-companion",
  );
  expect(model.inForce.inputMicroUsdPerMillionTokens).toBe(380000);
  expect(
    model.scheduled.map(
      (v: { inputMicroUsdPerMillionTokens: number }) =>
        v.inputMicroUsdPerMillionTokens,
    ),
  ).toEqual([380000]);
  await page.reload();
  await openPrices();
  await expect(scheduled).toHaveCount(0);
  await expect(
    block.getByLabel("Input, per 1M tokens", { exact: true }),
  ).toHaveValue("0.38");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await accessible(page);
});

test("the $ sign sits before each price and spending limit, clear of the amount, in English and Hebrew", async ({
  page,
}) => {
  const fixture = await (
    await page.request.post("/test/pricing-fixture")
  ).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  for (const locale of ["en", "he"] as const) {
    const nav = JSON.parse(
      readFileSync(
        new URL(
          `../../src/i18n/messages/${locale}/adminApp.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, string>;
    await page.goto(`/admin/?locale=${locale}`);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "he" ? "rtl" : "ltr",
    );
    await (
      await workspaceNav(page)
    )
      .getByRole("button", { name: nav["nav.providers"], exact: true })
      .click();
    await expect(page.locator("#ai-prices .ai-money").first()).toBeVisible();
    const fields = (await fieldsWithIcons(page.locator("main"))).filter(
      (field) => field.icons.some((icon) => icon.icon.includes(">$<")),
    );
    expect(fields.length, locale).toBeGreaterThanOrEqual(2);
    for (const field of fields) {
      // Amounts are written left to right in both languages, the sign first.
      expect(field.direction, field.field).toBe("ltr");
      for (const icon of field.icons) {
        expect(icon.overlapX, `${locale} ${field.field}`).toBeLessThanOrEqual(
          0,
        );
        expect(icon.box.right, `${locale} ${field.field}`).toBeLessThanOrEqual(
          field.outer.left,
        );
      }
    }
    expect(await fieldIconOverlaps(page.locator("main"), `${locale} `)).toEqual(
      [],
    );
  }
});
