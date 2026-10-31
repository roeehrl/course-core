import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mockConnectedAdmin } from "./connectedAdmin";

/**
 * Form controls look the same in every engine and stay readable (Chromium and WebKit, phone,
 * tablet and desktop: playwright.config.ts):
 * - A select takes the field's height and shows its whole value. WebKit drew it as its own small
 *   pop-up button (about 22px tall, the text clipped).
 * - A disabled button's label keeps a 4.5:1 contrast. Fading the whole button left white on pale
 *   blue at 2.8:1.
 * - The page heading's role ("Your role: Owner" / "התפקיד שלך: בעלים") is set in the UI font, not a
 *   tracked monospace face, and the data revision is its tooltip rather than text on the page.
 */
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

async function open(page: Page, locale: "en" | "he") {
  await page.goto(`/admin/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** The select's height, look, and whether its current value fits inside it. */
const measureSelect = (select: Locator) =>
  select.evaluate((element) => {
    const field = element as HTMLSelectElement;
    const style = getComputedStyle(field);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const text = field.selectedOptions[0]?.textContent ?? "";
    const room =
      field.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    return {
      height: field.getBoundingClientRect().height,
      appearance: style.appearance,
      fits: context.measureText(text).width <= room + 1,
      text,
    };
  });

/** The WCAG contrast ratio of an element's text against the first opaque background behind it. */
const textContrast = (button: Locator) =>
  button.evaluate((element) => {
    const parse = (value: string) => {
      const parts = value.match(/[\d.]+/g)!.map(Number);
      return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    let node: Element | null = element,
      background = { r: 255, g: 255, b: 255, a: 1 };
    while (node) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color.a > 0.5) {
        background = color;
        break;
      }
      node = node.parentElement;
    }
    const style = getComputedStyle(element);
    const [a, b] = [luminance(parse(style.color)), luminance(background)].sort(
      (x, y) => y - x,
    );
    return {
      ratio: (a! + 0.05) / (b! + 0.05),
      opacity: Number(style.opacity),
    };
  });

for (const locale of ["en", "he"] as const)
  test(`${locale}: selects keep the field height and their value, disabled buttons stay readable, and the revision label uses the UI font`, async ({
    page,
    context,
  }) => {
    await mockConnectedAdmin(page, context);
    await open(page, locale);

    // The course picker: in the bar or sidebar header, or in the drawer on phones.
    const toggle = page.locator(".nav-toggle");
    if (
      (await page.locator("select:visible").count()) === 0 &&
      (await toggle.isVisible())
    )
      await toggle.click();
    const selects = page.locator("select:visible");
    expect(await selects.count()).toBeGreaterThan(0);
    for (const select of await selects.all()) {
      const measured = await measureSelect(select);
      expect(measured.appearance).toBe("none");
      expect(measured.height, measured.text).toBeGreaterThanOrEqual(40);
      expect(measured.fits, measured.text).toBe(true);
    }
    if (await page.locator(".nav-drawer").isVisible())
      await page.keyboard.press("Escape");

    // Disabled buttons of every kind, on the page and in the dark app bar.
    await page.evaluate(() => {
      const make = (kind: string, label: string) => {
        const button = document.createElement("button");
        button.className = `button ${kind}`.trim();
        button.disabled = true;
        button.textContent = label;
        button.dataset.probe = kind || "secondary";
        return button;
      };
      const main = document.querySelector("#main-content")!;
      for (const kind of ["primary", "", "quiet", "danger"])
        main.prepend(make(kind, "Save prices"));
      document
        .querySelector(".app-bar-actions")
        ?.prepend(make("quiet", "Refresh"));
    });
    for (const button of await page.locator("[data-probe]").all()) {
      const { ratio, opacity } = await textContrast(button);
      expect(opacity, await button.evaluate((b) => b.className)).toBe(1);
      expect(
        ratio,
        await button.evaluate((b) => b.className),
      ).toBeGreaterThanOrEqual(4.5);
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, `${locale}-controls`);

    // The role in the page heading: words in the UI font, no tracking; the revision is its tooltip.
    const role = page.locator(".heading-role");
    await expect(role).toHaveText(
      locale === "he" ? /^התפקיד שלך: \S/ : /^Your role: [A-Z]/,
    );
    await expect(role).toHaveAttribute(
      "title",
      locale === "he" ? /^מהדורת נתונים \W*\d+\W*$/ : /^Data revision \d+$/,
    );
    const font = await role.evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, spacing: style.letterSpacing };
    });
    expect(font.family).not.toMatch(/mono/i);
    expect(["normal", "0px"]).toContain(font.spacing);
  });
