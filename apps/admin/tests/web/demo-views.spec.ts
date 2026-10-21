import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** Every view of the public demo, in English and Hebrew. The demo client stands in for the
 * answer keys, allowances, media, supervision, platform and integrations ports with fictional
 * in-memory data, so those views show their content rather than "not available here". */

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
const PORTED: Record<string, string> = {
  assessments: "assessmentsView",
  media: "mediaView",
  supervision: "supervisionView",
  platform: "platformView",
  integrations: "integrationsView",
};

async function expectNoHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}

for (const locale of ["en", "he"] as const)
  test(`every demo view renders in ${locale}, accessibly and without overflow`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const nav = catalog(locale, "adminApp");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`/admin/demo?locale=${locale}`);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "he" ? "rtl" : "ltr",
    );
    await page.locator(".nav-links button").first().waitFor();
    for (const key of ["allowances", ...Object.keys(PORTED)])
      await expect(
        page
          .locator(".nav-links")
          .getByRole("button", { name: nav[`nav.${key}`], exact: true }),
      ).toBeVisible();
    const names = (await page.locator(".nav-links button").allInnerTexts()).map(
      (name) => name.trim(),
    );
    for (const name of names) {
      await page
        .locator(".nav-links")
        .getByRole("button", { name, exact: true })
        .click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
      await expect(page.locator("main .loading")).toHaveCount(0);
      await expect(page.locator('main [role="alert"]')).toHaveCount(0);
      const ported = Object.entries(PORTED).find(
        ([key]) => nav[`nav.${key}`] === name,
      );
      if (ported) {
        await expect(page.locator("main .card").first()).toBeVisible();
        await expect(page.locator("main")).not.toContainText(
          catalog(locale, ported[1])["unavailable.title"]!,
        );
      }
      await expectNoHorizontalOverflow(page);
      expect(
        (
          await new AxeBuilder({ page })
            .include("main")
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations.map((v) => `${name}: ${v.id} ${v.nodes[0]?.target}`),
      ).toEqual([]);
    }
    expect(pageErrors).toEqual([]);
  });
