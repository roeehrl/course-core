import { readFileSync } from "node:fs";
import { test, expect, type Locator } from "@playwright/test";
import { openSection } from "../workspaceNav";
import { emptyFieldsAgainstPage, fieldText } from "../fieldText";

/**
 * Free-text fields keep the UI's direction, so an empty field's placeholder and caret start at the
 * reading edge: right in Hebrew, left in English. They used to carry dir="auto", which resolves an
 * empty field to left to right, so Hebrew placeholders started at the left. Typed text still takes
 * its own direction from its first letter (unicode-bidi: plaintext): an English note typed in the
 * Hebrew interface starts at the left. The placement is measured from the painted pixels
 * (tests/fieldText.ts), because the placeholder is out of reach of layout APIs.
 */
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

const TYPED = {
  en: { same: "Two more days.", other: "עוד יומיים." },
  he: { same: "עוד יומיים.", other: "Two more days." },
};

for (const locale of ["en", "he"] as const)
  test(`placeholders and typed text start at their reading edge (${locale})`, async ({
    page,
  }, info) => {
    const nav = catalog(locale, "adminApp"),
      composer = catalog(locale, "extensionComposer"),
      people = catalog(locale, "enrollmentsView"),
      dir = locale === "he" ? "rtl" : "ltr",
      // Where text in the UI's language starts, and where text in the other script starts.
      start = locale === "he" ? "right" : "left",
      other = locale === "he" ? "left" : "right";
    const startsAt = async (field: Locator, edge: string, label: string) => {
      const text = await fieldText(field);
      expect(text.lines.length, `${label}: no text painted`).toBeGreaterThan(0);
      expect(
        { left: text.hugsLeft, right: text.hugsRight },
        `${label}: ${JSON.stringify(text)}`,
      ).toEqual({ left: edge === "left", right: edge === "right" });
    };
    await page.goto(`/admin/demo?locale=${locale}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);

    // The extension plan's two free-text fields, empty with their placeholders.
    await openSection(page, nav["nav.policy"]!);
    await page
      .getByRole("button", { name: composer["preview"]!, exact: true })
      .click();
    const impact = page.getByLabel(composer["impact"]!, { exact: true });
    const alternatives = page.getByLabel(composer["alternatives"]!, {
      exact: true,
    });
    for (const [field, key] of [
      [impact, "impact.placeholder"],
      [alternatives, "alternatives.placeholder"],
    ] as const) {
      await field.scrollIntoViewIfNeeded();
      await expect(field).toHaveAttribute("placeholder", composer[key]!);
      await expect(field).toHaveValue("");
      expect(await field.evaluate((f, d) => f.matches(`:dir(${d})`), dir)).toBe(
        true,
      );
      await startsAt(field, start, key);
    }
    expect(await emptyFieldsAgainstPage(page.locator("main"))).toEqual([]);
    await impact.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`extension-plan-placeholders-${locale}.png`),
    });

    // Typed text: the field keeps the UI's direction; the text takes its own.
    for (const [script, edge] of [
      ["same", start],
      ["other", other],
    ] as const) {
      await impact.fill(TYPED[locale][script]);
      expect(
        await impact.evaluate((f, d) => f.matches(`:dir(${d})`), dir),
      ).toBe(true);
      await startsAt(impact, edge, `typed ${script} script`);
    }
    await page.screenshot({
      path: info.outputPath(`extension-plan-typed-${locale}.png`),
    });

    // The learner search field's placeholder starts beside its icon.
    await openSection(page, nav["nav.learners"]!);
    const search = page.getByRole("searchbox", { name: people["find"] });
    await expect(search).toHaveAttribute(
      "placeholder",
      people["find.placeholder"]!,
    );
    await startsAt(search, start, "search placeholder");
  });
