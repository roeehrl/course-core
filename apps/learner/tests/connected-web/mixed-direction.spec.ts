import { test, expect, type Page } from "./health";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enCompanion from "../../src/i18n/messages/en/connectedCompanion.json";
import heCompanion from "../../src/i18n/messages/he/connectedCompanion.json";

/*
 * Text in one direction embedded in a sentence in the other, as the learner sees it (0.1.58
 * qualification), on every device project and both engines, in English and Hebrew:
 * - a quotation in "Context used" keeps its quotation marks at its own start and end, also when
 *   it wraps (in Hebrew the marks of an English quotation landed beside the end of its first line);
 * - the due-date line reads date, time, zone in the sentence's direction, keeps the zone with the
 *   time, and names the UTC zone once ("GMT+0 · UTC" read "UTC · 8 בנוב׳ 2026, 07:41 GMT+0").
 * Positions are measured on the drawn glyphs, so the checks fail on the old rendering.
 */
const text = {
  en: { host: enHost, preview: enPreview, companion: enCompanion },
  he: { host: heHost, preview: hePreview, companion: heCompanion },
} as const;
type Locale = keyof typeof text;
type Rect = { left: number; right: number; top: number; bottom: number };

/** The drawn rectangle of each character of `pattern`'s first match in `selector`'s text (the
 * isolate controls of the string are skipped). */
async function glyphs(page: Page, selector: string, pattern: string, nth = 0) {
  return page.locator(selector).first().evaluate((root, [source, skip]) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const match = new RegExp(source as string, "u").exec(node.data);
      if (!match || seen++ < (skip as number)) continue;
      const rects: { char: string; left: number; right: number; top: number; bottom: number }[] = [];
      for (let i = match.index; i < match.index + match[0].length; i++) {
        if (/[⁦-⁩]/.test(node.data[i]!)) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        rects.push({ char: node.data[i]!, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
      return rects;
    }
    return null;
  }, [pattern, nth] as const);
}
const sameLine = (a: Rect, b: Rect) => Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 4;
/** `b` is drawn right after `a` in reading order: beside it on the same line. */
function follows(a: Rect, b: Rect, rtl: boolean) {
  expect(sameLine(a, b), "on the same line").toBe(true);
  if (rtl) expect(Math.abs(b.right - a.left)).toBeLessThanOrEqual(3);
  else expect(Math.abs(b.left - a.right)).toBeLessThanOrEqual(3);
}

async function signIn(page: Page, locale: Locale, session: string) {
  const token = (await (await page.request.post(session)).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
}

for (const locale of ["en", "he"] as const) {
  const rtl = locale === "he";
  test(`${locale}: the due date reads date, time and zone in order, with UTC named once and kept with the time`, async ({ page }, info) => {
    const t = text[locale];
    await signIn(page, locale, "/test/session");
    await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
      .getByRole("button", { name: t.host["library.open"], exact: true }).click();
    await page.getByRole("button", { name: t.preview.start, exact: true }).click();
    await page.getByRole("button", { name: t.host["library.continue"], exact: true }).click();
    await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
    const dates = page.locator(".connected-policy-dates");
    await expect(dates).toContainText("UTC");
    expect(await dates.innerText()).not.toMatch(/GMT/);
    await dates.scrollIntoViewIfNeeded();
    // The course's due date: the day, then the time, then the zone, in the sentence's direction.
    const year = await glyphs(page, ".connected-policy-dates", "\\d{4}");
    const time = await glyphs(page, ".connected-policy-dates", "\\d{1,2}:\\d{2}");
    const zone = await glyphs(page, ".connected-policy-dates", "UTC");
    expect(year && time && zone).toBeTruthy();
    const [first, last] = [year![0]!, zone![zone!.length - 1]!];
    // "UTC" stays on the time's line (it wrapped alone before).
    expect(sameLine(time![0]!, zone![0]!), "the zone is on the time's line").toBe(true);
    if (sameLine(first, last)) {
      if (rtl) expect(last.right, "UTC comes after the date, to its left").toBeLessThan(first.left);
      else expect(last.left, "UTC comes after the date, to its right").toBeGreaterThan(first.right);
    }
    const zoneStart = zone![0]!, timeEnd = time![time!.length - 1]!;
    if (rtl) expect(zoneStart.right).toBeLessThan(timeEnd.left);
    else expect(zoneStart.left).toBeGreaterThan(timeEnd.right);
    // The chapter's line, "{chapter}: {date}": the English chapter title, its colon after it in the
    // sentence's direction, then the date and the zone ("· :A map of …" and "UTC ·" before the date
    // in the live Hebrew card).
    const chapter = await glyphs(page, ".connected-policy-dates", "Order[\\u2066-\\u2069]*:");
    const chapterYear = await glyphs(page, ".connected-policy-dates", "\\d{4}", 1);
    const chapterZone = await glyphs(page, ".connected-policy-dates", "UTC", 1);
    expect(chapter && chapterYear && chapterZone).toBeTruthy();
    const [o, r, colon] = [chapter![0]!, chapter![4]!, chapter![5]!];
    if (rtl) {
      expect(colon.right, "the colon follows the title, on its left").toBeLessThanOrEqual(o.left + 1);
      if (sameLine(colon, chapterZone![0]!)) expect(chapterZone![0]!.right).toBeLessThan(chapterYear![0]!.left);
    } else {
      expect(colon.left).toBeGreaterThanOrEqual(r.right - 1);
      if (sameLine(colon, chapterZone![0]!)) expect(chapterZone![0]!.left).toBeGreaterThan(chapterYear![0]!.right);
    }
    await page.screenshot({ path: info.outputPath(`due-date-${locale}.png`) });
  });

  test(`${locale}: quotations in "Context used" keep their marks at their own start and end`, async ({ page }, info) => {
    const t = text[locale];
    await signIn(page, locale, "/test/companion-context-rich-session");
    const resume = page.getByRole("button", { name: t.host["library.continue"], exact: true });
    const lesson = page.getByRole("heading", { name: "Minimum", exact: true });
    await expect(async () => {
      if (await resume.count()) await resume.first().click({ timeout: 2_000 });
      await expect(lesson).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const pane = page.locator("#connected-companion");
    if (!(await pane.isVisible())) await page.locator(".connected-companion-trigger").click();
    await page.getByRole("button", { name: t.companion["context.show"], exact: true }).click();
    // An English reply quoted in the sentence; long enough to wrap in the pane on every size.
    const reply = page.locator("#connected-companion div[dir]").filter({ hasText: /Minimum means no greater than any other member/ }).last();
    await reply.scrollIntoViewIfNeeded();
    // Isolate controls may sit between a mark and the text; they are not drawn.
    const open = await glyphs(page, "#connected-companion", "[\"“][\\u2066-\\u2069]*Minimum means");
    const close = await glyphs(page, "#connected-companion", "every x\\.[\\u2066-\\u2069]*[\"”]");
    expect(open && close).toBeTruthy();
    // The opening mark is drawn right before "M", the closing one right after the full stop: inside
    // the English text's own (left-to-right) run, in either language.
    follows(open![0]!, open![1]!, false);
    follows(close![close!.length - 2]!, close![close!.length - 1]!, false);
    // The label comes first in the sentence's direction, then the quotation.
    const label = await glyphs(page, "#connected-companion", rtl ? "המנחה:" : "Companion:");
    if (rtl) expect(label![0]!.left, "the label is at the line's start, on the right").toBeGreaterThan(open![1]!.left);
    else expect(label![0]!.right).toBeLessThan(open![1]!.left);
    await page.screenshot({ path: info.outputPath(`context-used-${locale}.png`) });
  });
}
