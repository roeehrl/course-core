import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { openSection } from "../workspaceNav";
import { fieldIconOverlaps, fieldsWithIcons } from "../fieldIcons";

/**
 * The search icon inside "Find a learner" (Enrollments) never covers the placeholder, a typed
 * name or the browser's clear button, in English and Hebrew, on phone and desktop. A name in the
 * other script must not move the room kept for the icon: dir="auto" used to flip the field, and
 * its padding, to the far side while the icon stayed put. The icon sits inside the field, at the
 * start of the UI's reading direction, and is centred on the field's height.
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
  latin: "Dana Levi-Cohen",
  hebrew: "דנה לוי-כהן",
  digits: "2048",
  long: "Dana Levi-Cohen, autumn cohort, evening group, second attempt",
  longHebrew: "דנה לוי-כהן, מחזור הסתיו, קבוצת ערב, ניסיון שני",
};

for (const locale of ["en", "he"] as const)
  test(`the search icon stays clear of the placeholder and of typed names (${locale})`, async ({
    page,
  }) => {
    const nav = catalog(locale, "adminApp"),
      view = catalog(locale, "enrollmentsView"),
      dir = locale === "he" ? "rtl" : "ltr";
    await page.goto(`/admin/demo?locale=${locale}`);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await openSection(page, nav["nav.learners"]!);
    const search = page.getByRole("searchbox", { name: view["find"] });
    await expect(search).toHaveAttribute(
      "placeholder",
      view["find.placeholder"]!,
    );
    for (const [state, value] of [
      ["placeholder", ""],
      ...Object.entries(TYPED),
    ] as const) {
      await search.fill(value);
      // Focused, so the browser shows its clear button for a typed value.
      await search.focus();
      const fields = await fieldsWithIcons(page.locator(".search-field"));
      expect(fields, state).toHaveLength(1);
      const field = fields[0]!,
        icon = field.icons[0]!;
      expect(field.icons, state).toHaveLength(1);
      // The field keeps the UI's direction whatever is typed, so its start padding stays on
      // the icon's side; the typed text takes its own direction from its content.
      expect(field.direction, state).toBe(dir);
      expect(
        await search.evaluate((el) => getComputedStyle(el).unicodeBidi),
      ).toBe("plaintext");
      // No overlap with the text box, and a visible gap of at least 6px.
      expect(
        icon.overlapX,
        `${state}: ${JSON.stringify(field)}`,
      ).toBeLessThanOrEqual(-6);
      // At the start of the reading direction, inside the field's border.
      if (dir === "ltr") {
        expect(icon.box.left, state).toBeGreaterThan(field.outer.left);
        expect(icon.box.right, state).toBeLessThan(field.text.left);
      } else {
        expect(icon.box.right, state).toBeLessThan(field.outer.right);
        expect(icon.box.left, state).toBeGreaterThan(field.text.right);
      }
      const middle = (b: { top: number; bottom: number }) =>
        (b.top + b.bottom) / 2;
      expect(
        Math.abs(middle(icon.box) - middle(field.outer)),
        state,
      ).toBeLessThanOrEqual(1.5);
      // The text box keeps most of the field: the icon's room is not the whole field.
      expect(field.text.right - field.text.left, state).toBeGreaterThan(
        (field.outer.right - field.outer.left) / 2,
      );
    }
    // The search still filters by a typed name.
    await search.fill("Alex");
    await expect(page.locator(".selector-item")).toHaveCount(1);
    await expect(page.locator(".selector-item")).toContainText("Alex Example");
    await search.fill("does-not-exist");
    await expect(
      page.getByRole("heading", { name: view["noMatch.title"] }),
    ).toBeVisible();
    // Nothing else on the page draws an icon over a field's text.
    expect(await fieldIconOverlaps(page.locator("main"))).toEqual([]);
  });
