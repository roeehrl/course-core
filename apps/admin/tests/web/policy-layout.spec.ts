import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { mockLargePolicy } from "./policyStub";
import { openSection } from "../workspaceNav";

/**
 * Policy & extensions with a course the size of a real one (71 levels, 56 graded checks, 58 work
 * limits), at desktop, tablet and phone widths, in English and Hebrew:
 * - the page never scrolls sideways, and its long lists open short ("Show all" opens the rest);
 * - a sticky link bar reaches every section;
 * - choosing a level never leaves its detail thousands of pixels away: the level list is
 *   bounded, beside the detail on a desktop and directly above it on a tablet or phone;
 * - no label, heading or button breaks one word per line.
 * Extensions & accommodations and its group-adjustment dialog are checked the same way.
 * With WP3_SHOTS=<folder> the test also saves screenshots there.
 */
const WIDTHS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 805, height: 1000 },
  { name: "phone", width: 375, height: 812 },
] as const;
/** A message catalog, read as data (the test runner does not import JSON modules). */
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
const LOCALES = Object.fromEntries(
  (["en", "he"] as const).map((locale) => [
    locale,
    {
      app: catalog(locale, "adminApp"),
      batch: catalog(locale, "batchAdjustDialog"),
      allowances: catalog(locale, "allowancesView"),
    },
  ]),
) as Record<
  "en" | "he",
  Record<"app" | "batch" | "allowances", Record<string, string>>
>;
const shots = process.env.WP3_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page: Page, name: string, fullPage = false) => {
  if (shots)
    await page.screenshot({ path: join(shots, `${name}.png`), fullPage });
};

async function noSidewaysScroll(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}

/** Text that wraps after every word: a box with several words and as many lines as words. */
async function oneWordPerLine(page: Page, root: string) {
  return page.evaluate((root) => {
    const found: string[] = [];
    const scope = document.querySelector(root);
    if (!scope) return ["missing " + root];
    for (const el of scope.querySelectorAll<HTMLElement>(
      "h2, h3, p, small, dt, dd, label, legend, caption, th, td, .button, .badge, .section-nav a, summary",
    )) {
      if (!el.checkVisibility()) continue;
      const words = (el.innerText ?? "").trim().split(/\s+/).filter(Boolean);
      if (words.length < 3) continue;
      // Count the text's lines from the boxes of its words, not the box of the element.
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(
        [...range.getClientRects()]
          .filter((r) => r.width > 0)
          .map((r) => Math.round(r.bottom / 4)),
      ).size;
      if (lines >= words.length)
        found.push(`${el.tagName} "${words.join(" ")}"`);
    }
    return found;
  }, root);
}

for (const locale of ["en", "he"] as const)
  for (const size of WIDTHS)
    test(`policy at ${size.name} width (${locale}) @desktop-window`, async ({
      page,
      context,
    }) => {
      test.setTimeout(90_000);
      const text = LOCALES[locale];
      await page.setViewportSize({ width: size.width, height: size.height });
      await mockLargePolicy(page, context, { locale });
      await page.goto("/admin/courses/sorting/releases");
      await openSection(page, text.app["nav.policy"]!);
      const main = page.locator("main");
      await expect(
        main.locator(".policy-scope-picker .selector-item"),
      ).toHaveCount(71);
      await expect(main.locator(".section-nav a")).toHaveCount(8);
      await noSidewaysScroll(page);
      expect(await oneWordPerLine(page, "main")).toEqual([]);
      await shot(page, `policy-${size.name}-${locale}-top`);
      await shot(page, `policy-${size.name}-${locale}-full`, true);
      if (shots)
        console.log(
          `policy ${size.name} ${locale}: page height`,
          await page.evaluate(() => document.documentElement.scrollHeight),
        );

      // Long lists open short.
      const attempts = main.locator("#policy-attempts tbody tr");
      expect(await attempts.count()).toBeLessThanOrEqual(8);
      const limits = main.locator(
        "#policy-work tbody tr:not(.policy-group-row)",
      );
      expect(await limits.count()).toBeLessThanOrEqual(8);
      // The reasons behind the limits: one line per kind of limit, not one per concept.
      expect(
        await main.locator("#policy-deadlines .policy-why > li").count(),
      ).toBeLessThanOrEqual(6);

      // The level list is bounded, and the chosen level's detail is right beside or below it.
      const picker = main.locator(".policy-scope-picker");
      const list = picker.locator(".selector-list");
      const detail = main
        .locator("#policy-deadlines .policy-hierarchy > .card")
        .nth(1);
      const listBox = (await list.boundingBox())!;
      expect(listBox.height).toBeLessThanOrEqual(700);
      const pickerBox = (await picker.boundingBox())!;
      const detailBox = (await detail.boundingBox())!;
      if (size.name === "desktop") {
        // Side by side: the detail starts level with the list.
        expect(Math.abs(detailBox.y - pickerBox.y)).toBeLessThan(2);
        if (locale === "en")
          expect(detailBox.x).toBeGreaterThan(
            pickerBox.x + pickerBox.width - 1,
          );
        else
          expect(detailBox.x + detailBox.width).toBeLessThan(pickerBox.x + 1);
      } else {
        // Stacked: the detail follows the bounded list directly.
        expect(detailBox.y - (pickerBox.y + pickerBox.height)).toBeLessThan(60);
        expect(detailBox.y - pickerBox.y).toBeLessThan(1100);
      }

      // Searching narrows the list; choosing a level shows its detail.
      await picker.getByRole("searchbox").fill("Episode 17");
      await expect(picker.locator(".selector-item")).toHaveCount(1);
      await picker.locator(".selector-item").click();
      await expect(detail.getByRole("heading", { level: 2 })).toContainText(
        "Episode 17",
      );
      await picker.getByRole("searchbox").fill("");

      // The link bar stays in view and takes the reader to a section.
      await main.locator('.section-nav a[href="#policy-work"]').click();
      const nav = (await main.locator(".section-nav").boundingBox())!;
      expect(nav.y).toBeGreaterThanOrEqual(-1);
      expect(nav.y).toBeLessThan(80);
      const work = (await main.locator("#policy-work").boundingBox())!;
      expect(work.y).toBeGreaterThan(nav.y + nav.height - 2);
      expect(work.y).toBeLessThan(nav.y + nav.height + 60);
      await expect(
        main.locator('.section-nav a[href="#policy-work"]'),
      ).toHaveAttribute("aria-current", "true");
      await noSidewaysScroll(page);
      await shot(page, `policy-${size.name}-${locale}-work-limits`);
      await main.locator('.section-nav a[href="#policy-deadlines"]').click();
      await shot(page, `policy-${size.name}-${locale}-scopes`);
      await main.locator('.section-nav a[href="#policy-attempts"]').click();
      await shot(page, `policy-${size.name}-${locale}-attempts`);

      // "Show all" opens the full lists, still without sideways scrolling.
      await main.locator("#policy-attempts .policy-more .button").click();
      await expect(attempts).toHaveCount(56);
      await main.locator("#policy-work .policy-more .button").click();
      await expect(limits).toHaveCount(58);
      await noSidewaysScroll(page);
      expect(await oneWordPerLine(page, "main")).toEqual([]);

      // Summary-first settings: the form opens on request.
      await main.locator('.section-nav a[href="#policy-course"]').click();
      await main
        .locator("#policy-course .section-heading .button")
        .first()
        .click();
      await expect(
        main.locator("#policy-course .action-row .button.primary"),
      ).toBeDisabled();
      // Why it is off, under the button (Button reason).
      await expect(
        main.locator("#policy-course .action-row .button-reason"),
      ).toBeVisible();
      await noSidewaysScroll(page);
      await main.locator("#policy-course .action-row").scrollIntoViewIfNeeded();
      await shot(page, `policy-${size.name}-${locale}-course-settings-edit`);
      // The organization's limits are a workspace page of their own, also summary first.
      await openSection(page, text.app["nav.limits"]!);
      await main.locator(".section-heading .button").first().click();
      await expect(main.locator(".action-row .button.primary")).toBeDisabled();
      await noSidewaysScroll(page);
      await main.locator(".action-row").scrollIntoViewIfNeeded();
      await shot(page, `policy-${size.name}-${locale}-organization-edit`);
    });

for (const locale of ["en", "he"] as const)
  for (const size of WIDTHS)
    test(`extensions and accommodations at ${size.name} width (${locale}) @desktop-window`, async ({
      page,
      context,
    }) => {
      const text = LOCALES[locale];
      await page.setViewportSize({ width: size.width, height: size.height });
      await mockLargePolicy(page, context, { locale });
      await page.goto("/admin/courses/sorting/releases");
      await openSection(page, text.app["nav.allowances"]!);
      const main = page.locator("main");
      // One page heading: the view's own title is not repeated as a second heading.
      await expect(
        main.locator(".page-stack > .section-heading h2"),
      ).toHaveCount(0);
      await main
        .getByRole("button", { name: text.allowances["tab.all"]! })
        .click();
      await expect(
        main.locator(".empty, table, .allowances-list").first(),
      ).toBeVisible();
      await expect(main).not.toContainText(/\w+:calendar/);
      await noSidewaysScroll(page);
      expect(await oneWordPerLine(page, "main")).toEqual([]);
      await shot(page, `extensions-${size.name}-${locale}`, true);

      // The group adjustment: title and actions stay in view while the body scrolls.
      await main.getByRole("button", { name: text.allowances.batch! }).click();
      const dialog = page.getByRole("dialog", { name: text.batch.title! });
      await expect(dialog).toBeVisible();
      const footer = dialog.locator(".dialog-footer");
      await expect(
        footer.getByRole("button", { name: text.batch.cancel! }),
      ).toBeVisible();
      await expect(footer.locator(".button.primary")).toBeDisabled();
      await dialog.evaluate((d) => d.scrollTo({ top: d.scrollHeight }));
      const box = (await dialog.boundingBox())!;
      const heading = (await dialog.locator(".dialog-heading").boundingBox())!;
      const foot = (await footer.boundingBox())!;
      expect(heading.y).toBeGreaterThanOrEqual(box.y - 1);
      expect(heading.y).toBeLessThan(box.y + 4);
      expect(foot.y + foot.height).toBeLessThanOrEqual(box.y + box.height + 1);
      // Both choices are drawn the same way.
      expect(await dialog.locator("fieldset.segmented").count()).toBe(2);
      await noSidewaysScroll(page);
      await shot(page, `extensions-${size.name}-${locale}-adjust-dialog`);
    });
