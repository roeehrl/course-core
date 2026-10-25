import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { accent } from "@course-core/i18n";
import { workspaceNav, workspaceNavNames } from "../workspaceNav";

/**
 * Every demo view under the en-XA pseudo-locale: each translated message is wrapped in ⟦…⟧
 * and accented, so plain Latin letters outside a frame are hardcoded text. The padding makes
 * text about 40% longer and wraps like words, so no view may overflow at phone or desktop
 * width either. (Hebrew right to left for every view: demo-views.spec.ts.)
 */
const enNav = JSON.parse(
  readFileSync(
    new URL("../../src/i18n/messages/en/adminApp.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>;

async function expectNoHorizontalOverflow(page: Page, name: string) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
    `${name} overflows`,
  ).toBeLessThanOrEqual(width);
}

/** Visible text in main with plain Latin letters outside any ⟦…⟧ frame, except data
 * (dir="ltr"/"auto", bdi, code, pre, option, a field's own text, lang="en") and English-formatted
 * dates. */
async function untranslated(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    const main = document.querySelector("main")!;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const date =
      /[A-Z][a-z]{2} \d{1,2}, \d{4}(, \d{1,2}:\d{2}(:\d{2})? [AP]M)?( UTC)?/g;
    let depth = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let outside = "";
      for (const char of node.textContent ?? "") {
        if (char === "⟦") depth++;
        else if (char === "⟧") depth = Math.max(0, depth - 1);
        else if (depth === 0) outside += char;
      }
      const element = node.parentElement!;
      if (!/[A-Za-z]/.test(outside.replace(date, ""))) continue;
      const data = element.closest(
        '[dir="ltr"], [dir="auto"], bdi, code, pre, option, textarea, [lang="en"], .sr-only',
      );
      if (data && main.contains(data)) continue;
      if (!element.checkVisibility()) continue;
      found.push(outside.trim());
    }
    return found;
  });
}

/** Fictional demo course data rendered as course content (not UI text). */
const DEMO_DATA: readonly string[] = [];

test("every demo view leaves no untranslated text under en-XA and does not overflow", async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/admin/demo?locale=en-XA");
  const names = await workspaceNavNames(page);
  expect(
    names.some((name) => name.includes(accent(enNav["nav.overview"]!))),
  ).toBe(true);
  const problems: string[] = [];
  for (const name of names) {
    await (
      await workspaceNav(page)
    )
      .getByRole("button", { name, exact: true })
      .click();
    await expect(page.locator("main .loading")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    for (const text of await untranslated(page))
      if (!DEMO_DATA.includes(text)) problems.push(`${name}: ${text}`);
    await expectNoHorizontalOverflow(page, `${name} (${info.project.name})`);
  }
  expect(problems).toEqual([]);
  expect(pageErrors).toEqual([]);
});
