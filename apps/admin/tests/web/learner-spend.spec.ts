import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** "What learners spend" on the demo's AI services page: fictional in-memory spending, the
 * spread per day and active hour, a suggested limit for each learner, and paging, in English and
 * Hebrew, on phone and desktop. */
const catalog = (locale: string, namespace: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../src/i18n/messages/${locale}/${namespace}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, string>;

async function noHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}

for (const locale of ["en", "he"] as const)
  test(`learner spending and the suggested limit in ${locale}`, async ({
    page,
  }) => {
    const nav = catalog(locale, "adminApp"),
      ai = catalog(locale, "aiServices");
    await page.goto(`/admin/demo?locale=${locale}`);
    await page
      .locator(".nav-links")
      .getByRole("button", { name: nav["nav.providers"], exact: true })
      .click();
    await page.getByText(ai["learnerSpend.title"]!, { exact: true }).click();
    const panel = page.locator(".ai-learner-spend");
    await expect(
      panel.getByRole("heading", { name: ai["learnerSpend.rec.title"] }),
    ).toBeVisible();
    await expect(panel.locator(".ai-rec-amount")).toBeVisible();
    await expect(
      panel.getByRole("table", { name: ai["learnerSpend.spreadCaption"] }),
    ).toBeVisible();
    // The demo is read-only: the suggestion cannot be applied here.
    await expect(panel.getByRole("button", { name: /\$/ })).toHaveCount(0);
    const first = panel.locator(".ai-learner-list summary").first();
    const before = await first.innerText();
    await panel
      .getByRole("button", { name: ai["learnerSpend.next"], exact: true })
      .click();
    await expect(first).not.toHaveText(before);
    await first.click();
    await expect(
      panel
        .locator(".ai-learner-list details[open]")
        .getByRole("table", { name: ai["learnerSpend.byDay"] }),
    ).toBeVisible();
    // A short period is not enough data for a suggestion.
    await panel
      .getByLabel(ai["learnerSpend.period"]!)
      .selectOption({ value: "7" });
    await expect(panel.locator(".ai-rec-amount")).toHaveCount(0);
    await expect(panel.locator(".ai-recommendation")).toContainText("15");
    await noHorizontalOverflow(page);
    expect(
      (
        await new AxeBuilder({ page })
          .include(".ai-learner-spend")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations.map((v) => `${v.id} ${v.nodes[0]?.target}`),
    ).toEqual([]);
  });
