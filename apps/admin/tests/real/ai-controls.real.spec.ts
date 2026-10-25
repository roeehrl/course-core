import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceNav } from "../workspaceNav";

/**
 * AI services on the real API, in English and Hebrew, on Chromium and WebKit
 * (playwright.real.config.ts):
 * - The model selects take the field's height and, where the column is wide enough, show their
 *   whole value. WebKit drew them as its own small pop-up button (about 22px), the text clipped
 *   ("Gemini 2.5 Pro (gemini-2.5-pro) — Suggestec").
 * - "Advanced (for developers)": closed, the chevron points to the inline end like the browser's
 *   own disclosure markers (right in English, left in Hebrew); open, it points down.
 */
const TEXT = {
  en: {
    code: "One-time sign-in code",
    useCode: "Use code",
    aiServices: "AI services",
    advanced: "Advanced (for developers)",
  },
  he: {
    code: "קוד כניסה חד-פעמי",
    useCode: "שימוש בקוד",
    aiServices: "שירותי AI",
    advanced: "מתקדם (למפתחים)",
  },
} as const;

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, `admin-${test.info().project.name}-${name}.png`),
    });
  }
}

/** Where the chevron's tip points: the image of the icon's "right" under its transform. */
const pointing = (page: Page) =>
  page.locator(".ai-advanced .ai-chevron").evaluate(async (icon) => {
    await Promise.all(icon.getAnimations().map((a) => a.finished));
    const transform = getComputedStyle(icon).transform;
    const [a, b] =
      transform === "none"
        ? [1, 0]
        : transform
            .match(/-?[\d.e-]+/g)!
            .map(Number)
            .slice(0, 2);
    if (Math.abs(b!) > 0.5) return b! > 0 ? "down" : "up";
    return a! > 0 ? "right" : "left";
  });

for (const locale of ["en", "he"] as const)
  test(`${locale}: model selects keep the field height and their value, and the Advanced chevron points the reading way @webkit`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const text = TEXT[locale];
    const fixture = await (
      await page.request.post("/test/pricing-fixture", { data: {} })
    ).json();
    await page.goto(`/admin/?locale=${locale}`);
    await page.getByLabel(text.code).fill(fixture.code);
    await page.getByRole("button", { name: text.useCode, exact: true }).click();
    await (
      await workspaceNav(page)
    )
      .getByRole("button", { name: text.aiServices })
      .click();
    const models = page.locator("#ai-models");
    await expect(models.locator("select").first()).toBeVisible();
    const wide = page.viewportSize()!.width >= 700;
    for (const select of await models.locator("select:visible").all()) {
      const measured = await select.evaluate((element) => {
        const field = element as HTMLSelectElement;
        const style = getComputedStyle(field);
        const context = document.createElement("canvas").getContext("2d")!;
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const value = field.selectedOptions[0]?.textContent ?? "";
        const room =
          field.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight);
        return {
          value,
          appearance: style.appearance,
          height: field.getBoundingClientRect().height,
          // The value's line fits the field's height (nothing cut off at the top or bottom).
          tall:
            field.clientHeight -
              parseFloat(style.paddingTop) -
              parseFloat(style.paddingBottom) >=
            parseFloat(style.fontSize),
          fits: context.measureText(value).width <= room + 1,
        };
      });
      expect(measured.appearance, measured.value).toBe("none");
      expect(measured.height, measured.value).toBeGreaterThanOrEqual(40);
      expect(measured.tall, measured.value).toBe(true);
      if (wide) expect(measured.fits, measured.value).toBe(true);
    }
    await models.locator("select").first().scrollIntoViewIfNeeded();
    await shot(page, `${locale}-model-selects`);

    const advanced = page.locator(".ai-advanced > summary");
    await advanced.scrollIntoViewIfNeeded();
    expect(await pointing(page)).toBe(locale === "he" ? "left" : "right");
    await shot(page, `${locale}-advanced-closed`);
    await advanced.click();
    await expect(page.locator(".ai-advanced")).toHaveAttribute("open", "");
    expect(await pointing(page)).toBe("down");
    await advanced.click();
    await expect(page.locator(".ai-advanced")).not.toHaveAttribute("open");
    expect(await pointing(page)).toBe(locale === "he" ? "left" : "right");
  });
