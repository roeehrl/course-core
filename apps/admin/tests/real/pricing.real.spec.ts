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

test("operator prices are versioned and validated, the rule for unpriced models is explicit, and spend shows reserved against actual", async ({
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
    .getByRole("button", { name: "Providers" })
    .click();
  const model = page.getByRole("region", {
    name: "text-companion",
    exact: true,
  });
  await expect(model).toContainText("In force since");
  await expect(model).toContainText(
    "(version 1): input $0.300000 per 1M tokens · output $2.500000 per 1M tokens",
  );
  await expect(model.getByText("Priced", { exact: true })).toBeVisible();
  await expect(model.getByText("companion", { exact: true })).toBeVisible();

  // Reserved at admission, reconciled to actual for the priced call, held for the uncertain one.
  const totals = page.locator("dl.spend-totals");
  await expect(totals).toContainText("Reserved$0.200000");
  await expect(totals).toContainText("Charged now$0.100960");
  await expect(totals).toContainText("Actual (priced calls)$0.000960");
  await expect(totals).toContainText("Released back$0.099040");
  await expect(totals).toContainText(
    "Held for calls in flight or uncertain$0.100000",
  );
  await expect(page.getByRole("table", { name: "By role" })).toContainText(
    "companion",
  );
  await page.getByLabel("Group spend by").selectOption("month");
  await expect(page.getByRole("table", { name: "By month" })).toContainText(
    new Date().toISOString().slice(0, 7),
  );
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("pricing-and-spend.png"),
    fullPage: true,
  });

  // Client and server validation: both token prices or neither, and a source note.
  await page.getByLabel("Output price per 1M tokens (USD)").fill("2.5");
  await page
    .getByLabel("Where these prices come from")
    .fill("Provider pricing page, read today");
  await page.getByRole("button", { name: "Save price version" }).click();
  await expect(
    page.getByText(
      "Enter both the input and the output price per million tokens, or neither.",
    ),
  ).toBeVisible();
  await page
    .getByLabel("Input price per 1M tokens (USD)", { exact: true })
    .fill("0.1234567");
  await page.getByRole("button", { name: "Save price version" }).click();
  await expect(
    page.getByText("Enter USD amounts with up to six decimal places."),
  ).toBeVisible();

  await page
    .getByLabel("Input price per 1M tokens (USD)", { exact: true })
    .fill("0.15");
  await page
    .getByLabel("Cached input price per 1M tokens (USD)")
    .fill("0.0375");
  await page.getByLabel("Output price per 1M tokens (USD)").fill("0.6");
  await page.getByRole("button", { name: "Save price version" }).click();
  await expect(
    page.getByText(/Price version 2 saved for text-companion\./),
  ).toBeVisible();
  await expect(model).toContainText(
    "(version 2): input $0.150000 per 1M tokens · cached input $0.037500 per 1M tokens · output $0.600000 per 1M tokens",
  );
  await model.getByText("Version history (2)").click();
  await expect(model.getByRole("table")).toContainText(
    "Synthetic fixture price",
  );
  await expect(model.getByRole("table")).toContainText(
    "Provider pricing page, read today",
  );

  await page.reload();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: "Providers" })
    .click();
  await expect(
    page.getByRole("region", { name: "text-companion", exact: true }),
  ).toContainText("(version 2)");

  // Withdrawal leaves the model unpriced, so paid work for its role is refused by default.
  await page
    .getByLabel("Where these prices come from")
    .fill("Model retired from our plan");
  await page
    .getByRole("button", { name: "Withdraw this model’s price" })
    .click();
  await expect(
    page.getByText(/Price withdrawn for text-companion \(version 3\)/),
  ).toBeVisible();
  await expect(model.getByText("No price: paid work refused")).toBeVisible();

  // Allowing unpriced work needs an explicit acknowledgement of the conservative charge.
  await page
    .getByRole("checkbox", {
      name: "Refuse paid work for models without a price (recommended)",
    })
    .uncheck();
  await page.getByRole("button", { name: "Save pricing rule" }).click();
  await expect(
    page.getByText(
      "Confirm that unpriced calls keep the full per-job allowance as their charge.",
    ),
  ).toBeVisible();
  await page
    .getByRole("checkbox", {
      name: /I accept that each unpriced call keeps the full per-job allowance/,
    })
    .check();
  await page.getByRole("button", { name: "Save pricing rule" }).click();
  await expect(
    page.getByText(
      "Unpriced models may be used; each such call keeps the full per-job allowance as its charge.",
    ),
  ).toBeVisible();
  await expect(
    model.getByText("No price: charged the full allowance"),
  ).toBeVisible();
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("pricing-withdrawn.png"),
    fullPage: true,
  });
});
