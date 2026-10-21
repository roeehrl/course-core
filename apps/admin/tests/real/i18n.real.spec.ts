import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

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
 * (dir="ltr"/"auto", bdi, code, pre, option, lang="en") and English-formatted dates. */
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
        '[dir="ltr"], [dir="auto"], bdi, code, pre, option, [lang="en"], .sr-only',
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
  const nav = page.locator(".nav-links");
  await nav.locator("button").first().waitFor();
  const names = (await nav.locator("button").allInnerTexts()).map((n) =>
    n.trim(),
  );
  expect(names.length).toBeGreaterThan(5);
  for (const name of names) {
    await nav.getByRole("button", { name, exact: true }).click();
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
  });
  expect(problems).toEqual([]);
});
