import { test, expect, type Page } from "@playwright/test";

/**
 * Screen-reader-only text (.sr-only) inside a wide, horizontally scrolling table must stay inside
 * the table's scroll box. A hidden column header left at its own place in the far column used to
 * widen the whole page on phones: a mobile browser grows its layout viewport to fit it, so Hebrew
 * pages scrolled sideways. Measured against the configured viewport, not innerWidth.
 */
async function pageWidth(page: Page) {
  return page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, window.innerWidth),
  );
}

/** Adds a table wider than any phone, with a hidden caption and a hidden last header, to <main>. */
async function addWideTable(page: Page, wrapClass: string) {
  await page.evaluate((className) => {
    const wrap = document.createElement("div");
    wrap.className = className;
    wrap.dataset.test = "wide-table";
    const table = document.createElement("table");
    table.style.minWidth = "900px";
    const caption = document.createElement("caption");
    caption.className = "sr-only";
    caption.textContent = "חברי סביבת העבודה";
    const row = document.createElement("tr");
    for (const label of ["אדם", "תפקיד", "הרשמות", "כניסה אחרונה"]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      row.append(th);
    }
    const actions = document.createElement("th");
    actions.scope = "col";
    const hidden = document.createElement("span");
    hidden.className = "sr-only";
    hidden.textContent = "פעולות על השורה הזאת";
    actions.append(hidden);
    row.append(actions);
    const head = document.createElement("thead");
    head.append(row);
    table.append(caption, head);
    wrap.append(table);
    document.querySelector("main")!.append(wrap);
  }, wrapClass);
  await expect(page.locator('[data-test="wide-table"] table')).toBeAttached();
}

for (const locale of ["he", "en"] as const)
  for (const wrapClass of ["table-wrap", "ai-table-wrap"])
    test(`hidden table text stays inside a scrolling .${wrapClass} (${locale})`, async ({
      page,
    }) => {
      await page.goto(`/admin/demo?locale=${locale}`);
      await expect(page.locator("html")).toHaveAttribute(
        "dir",
        locale === "he" ? "rtl" : "ltr",
      );
      await page.locator(".nav-links button").first().waitFor();
      const width = page.viewportSize()!.width;
      await addWideTable(page, wrapClass);
      // The table itself scrolls inside its box (on a phone; a desktop window fits it).
      if (width < 900)
        expect(
          await page
            .locator(`[data-test="wide-table"]`)
            .evaluate((el) => el.scrollWidth > el.clientWidth),
        ).toBe(true);
      expect(await pageWidth(page)).toBeLessThanOrEqual(width);
      // The hidden text is still in the accessibility tree.
      await expect(
        page.getByRole("columnheader", {
          name: "פעולות על השורה הזאת",
        }),
      ).toBeAttached();
    });
