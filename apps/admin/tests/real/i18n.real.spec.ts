import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { accent } from "@course-core/i18n";
import { openSection, workspaceNav, workspaceNavNames } from "../workspaceNav";
import { fieldIconOverlaps } from "../fieldIcons";
import { trackedHebrew } from "../hebrewText";
import { emptyFieldsAgainstPage } from "../fieldText";

/**
 * Every admin view against the real API, in Hebrew (right to left, axe, no overflow) and under
 * the en-XA pseudo-locale (no untranslated text, no overflow): server states, codes and receipts
 * reach these views as codes, so anything English here is hardcoded or server prose.
 */
async function signIn(page: Page) {
  const setup = await page.request.post("/test/admin-fixture");
  expect(setup.ok()).toBeTruthy();
  const data = await setup.json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(data.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
}

async function overflow(page: Page) {
  const width = page.viewportSize()!.width;
  return (
    (await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    )) - width
  );
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

async function eachView(
  page: Page,
  visit: (name: string) => Promise<void>,
): Promise<void> {
  const names = await workspaceNavNames(page);
  expect(names.length).toBeGreaterThan(5);
  for (const name of names) {
    await openSection(page, name);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.locator("main .loading")).toHaveCount(0);
    await visit(name);
  }
}

test("every admin view on the real API renders in Hebrew, right to left, accessibly and without overflow", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto("/admin/?locale=he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  const problems: string[] = [];
  await eachView(page, async (name) => {
    const wide = await overflow(page);
    if (wide > 0)
      problems.push(`${name}: ${wide}px overflow (${info.project.name})`);
    problems.push(
      ...(await fieldIconOverlaps(page.locator("main"), `${name}: `)),
      ...(await trackedHebrew(page.locator("body"))).map(
        (line) => `${name}: ${line}`,
      ),
      // Empty free-text fields start at the right: no dir="auto" left-to-right fields.
      ...(await emptyFieldsAgainstPage(page.locator("main"))).map(
        (field) => `${name}: ${field}`,
      ),
    );
    const violations = (
      await new AxeBuilder({ page })
        .include("main")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations;
    for (const v of violations)
      problems.push(`${name}: ${v.id} ${v.nodes[0]?.target}`);
  });
  expect(problems).toEqual([]);
});

test("every admin view on the real API leaves no untranslated text under en-XA", async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto("/admin/?locale=en-XA");
  const problems: string[] = [];
  await eachView(page, async (name) => {
    for (const text of await untranslated(page))
      problems.push(`${name}: ${text}`);
    const wide = await overflow(page);
    if (wide > 0)
      problems.push(`${name}: ${wide}px overflow (${info.project.name})`);
    problems.push(
      ...(await fieldIconOverlaps(page.locator("main"), `${name}: `)),
    );
  });
  expect(problems).toEqual([]);
});

test("the AI supervision settings wrap their long labels under en-XA instead of widening the page", async ({
  page,
}, info) => {
  // The 0.1.54 qualification measured 261 px of overflow here at a 1280 px desktop, from one
  // unbroken pseudo-locale run in the help text; the desktop run checks that narrower width too.
  if (info.project.name === "desktop")
    await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/admin/?locale=en-XA");
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: accent("AI supervision") })
    .click();
  const settings = page.locator(".supervision-settings").first();
  await expect(
    settings.getByRole("heading", { name: accent("AI supervision settings") }),
  ).toBeVisible();
  await expect(page.locator("main .loading")).toHaveCount(0);
  expect(
    await overflow(page),
    `${info.project.name} overflows`,
  ).toBeLessThanOrEqual(0);
  // A word longer than the column (a long translation, or an unbroken run like the one above)
  // wraps inside the card's help text, legends and choices instead of widening the page.
  await settings.evaluate((card) => {
    const long = "W".repeat(400);
    for (const target of card.querySelectorAll("p, legend, label span"))
      target.append(` ${long}`);
  });
  expect(
    await overflow(page),
    `${info.project.name} overflows with a long word`,
  ).toBeLessThanOrEqual(0);
  // The card itself stays inside the content column.
  const box = (await settings.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
