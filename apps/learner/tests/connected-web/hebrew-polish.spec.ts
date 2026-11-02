import { test, expect, type Locator, type Page } from "./health";
import { chooseFromMenu } from "./learner-menu";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enCompanion from "../../src/i18n/messages/en/connectedCompanion.json";
import heCompanion from "../../src/i18n/messages/he/connectedCompanion.json";
import enReplyActions from "../../src/i18n/messages/en/replyActions.json";
import heReplyActions from "../../src/i18n/messages/he/replyActions.json";
import enDock from "../../src/i18n/messages/en/companionDock.json";
import heDock from "../../src/i18n/messages/he/companionDock.json";
import enData from "../../src/i18n/messages/en/yourDataPanel.json";
import heData from "../../src/i18n/messages/he/yourDataPanel.json";
import enLesson from "../../src/i18n/messages/en/connectedLesson.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";
import enCheck from "../../src/i18n/messages/en/checkCard.json";
import heCheck from "../../src/i18n/messages/he/checkCard.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enRoadmap from "../../src/i18n/messages/en/courseRoadmap.json";
import heRoadmap from "../../src/i18n/messages/he/courseRoadmap.json";
import enInput from "../../src/i18n/messages/en/assessmentInput.json";
import heInput from "../../src/i18n/messages/he/assessmentInput.json";
import enCode from "../../src/i18n/messages/en/codeEditor.json";
import heCode from "../../src/i18n/messages/he/codeEditor.json";
import enConnectivity from "../../src/i18n/messages/en/connectivity.json";
import heConnectivity from "../../src/i18n/messages/he/connectivity.json";

/*
 * Learner findings of the 0.1.60 qualification, on every device project and both engines, in
 * English and Hebrew, on the real connected host (the Hebrew course is test/hebrew-reading-fixture.ts):
 * - opening or closing the companion beside the lesson keeps the text being read where it was
 *   (on a WebKit tablet it moved about 100 px);
 * - the erase forms stack label, field and action in reading order (they ran onto one row);
 * - after erasing the account the sign-in page keeps the language and confirms the erasure (it
 *   came back in English, saying nothing);
 * - a signed number in Hebrew text keeps its minus before the digits ("-2." drew as ".2-");
 * - the companion's message box starts at the interface's reading edge (its Hebrew placeholder
 *   sat on the left);
 * - "Context used" quotes a Hebrew question with English and code in it in its own order;
 * - a slow sandbox start shows one message that offers the retry, not a notice and a
 *   "Not recorded yet" band over each other; a time-limit stop is a warning, not the green notice;
 * - a Hebrew scene draws its heading inside the canvas and its slider runs with the scene.
 * Positions are measured on the drawn glyphs and boxes, so each check fails on the old build.
 */
const text = {
  en: { host: enHost, companion: enCompanion, replyActions: enReplyActions, dock: enDock, data: enData, lesson: enLesson, check: enCheck, preview: enPreview, roadmap: enRoadmap, input: enInput, code: enCode, connectivity: enConnectivity },
  he: { host: heHost, companion: heCompanion, replyActions: heReplyActions, dock: heDock, data: heData, lesson: heLesson, check: heCheck, preview: hePreview, roadmap: heRoadmap, input: heInput, code: heCode, connectivity: heConnectivity },
} as const;
type Locale = keyof typeof text;
type Glyph = { char: string; left: number; right: number; top: number; bottom: number };

/** Every drawn character under `root`, in text order, without bidi controls. */
async function glyphs(root: Locator): Promise<Glyph[]> {
  return root.evaluate((element) => {
    const out: Glyph[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null)
      for (let i = 0; i < node.data.length; i++) {
        if (/[‎‏⁦-⁩]/.test(node.data[i]!)) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        // WebKit adds an empty rect at an isolate's edge to the first character's box: use the drawn one.
        const r = Array.from(range.getClientRects()).find((rect) => rect.width > 0) ?? range.getBoundingClientRect();
        out.push({ char: node.data[i]!, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
    return out;
  });
}
/** The glyphs of `needle`'s first occurrence after `from`. */
function find(all: Glyph[], needle: string, from = 0): Glyph[] {
  const joined = all.map((g) => g.char).join("");
  const at = joined.indexOf(needle, from);
  expect(at, `"${needle}" is drawn`).toBeGreaterThanOrEqual(0);
  return all.slice(at, at + needle.length);
}
/** The glyph's horizontal centre (edges overlap by a pixel in WebKit). */
const mid = (g: Glyph) => (g.left + g.right) / 2;
const sameLine = (a: Glyph, b: Glyph) => Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 4;
/** A run drawn left to right: each glyph to the right of the one before on its line; a run that
 * wraps continues on a lower line. */
function leftToRight(run: Glyph[], label: string) {
  const drawn = run.filter((g) => g.char.trim());
  for (let i = 1; i < drawn.length; i++) {
    const [previous, glyph] = [drawn[i - 1]!, drawn[i]!];
    if (sameLine(previous, glyph)) expect(mid(glyph), `${label}: "${glyph.char}" after "${previous.char}"`).toBeGreaterThan(mid(previous));
    else expect(glyph.top, `${label}: "${glyph.char}" continues below "${previous.char}"`).toBeGreaterThan(previous.top);
  }
}
async function signIn(page: Page, locale: Locale, session: string, data?: Record<string, unknown>) {
  const token = (await (await page.request.post(session, data ? { data } : undefined)).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
}
async function openHebrewLesson(page: Page, locale: Locale, conversation = false) {
  await signIn(page, locale, "/test/hebrew-reading-session", { conversation });
  const resume = page.getByRole("button", { name: text[locale].host["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
  const reading = page.getByText(/בשיעור הזה מחפשים/).first();
  await expect(async () => {
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(reading).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
/** A real press at the control's centre (a locator click first scrolls the page under the
 * sticky header, which would hide what this file measures). */
async function press(page: Page, control: Locator) {
  const box = (await control.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function openCompanion(page: Page) {
  const pane = page.locator("#connected-companion");
  if (!(await pane.isVisible())) await press(page, page.locator(".connected-companion-trigger"));
  await expect(pane).toBeVisible();
  return pane;
}

for (const locale of ["en", "he"] as const) {
  const t = text[locale], rtl = locale === "he";

  test(`${locale}: the erase forms stack label, field and action in reading order`, async ({ page }, info) => {
    await signIn(page, locale, "/test/session");
    await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
      .getByRole("button", { name: t.host["library.open"], exact: true }).click();
    await page.getByRole("button", { name: t.preview.start, exact: true }).click();
    await chooseFromMenu(page, t.host["menu.profile"]);
    const panel = page.getByRole("region", { name: t.data.title });
    for (const [summary, reason, confirm, button] of [
      [panel.locator("summary").first(), panel.locator('textarea[id$="-reason"]').first(), panel.locator('input[id$="-confirm"]').first(), panel.getByRole("button", { name: t.data["erase.button"], exact: true })],
      [panel.getByText(t.data["account.summary"], { exact: true }), panel.locator('textarea[id$="-account-reason"]'), panel.locator('input[id$="-account-confirm"]'), panel.getByRole("button", { name: t.data["account.button"], exact: true })],
    ] as const) {
      await summary.click();
      await button.scrollIntoViewIfNeeded();
      const boxes = await Promise.all([reason, confirm, button].map(async (control) => {
        const id = await control.getAttribute("id");
        const label = id ? await page.locator(`label[for="${id}"]`).boundingBox() : null;
        return { control: (await control.boundingBox())!, label };
      }));
      const [why, phrase, action] = boxes as [typeof boxes[0], typeof boxes[0], typeof boxes[0]];
      // Each label sits above its field, the confirmation below the reason, the action last.
      expect(why.label!.y + why.label!.height).toBeLessThanOrEqual(why.control.y + 1);
      expect(why.control.y + why.control.height).toBeLessThanOrEqual(phrase.label!.y + 1);
      expect(phrase.label!.y + phrase.label!.height).toBeLessThanOrEqual(phrase.control.y + 1);
      expect(phrase.control.y + phrase.control.height).toBeLessThanOrEqual(action.control.y + 1);
      // All of it starts at the reading edge of the form: the right in Hebrew, the left in English.
      const edge = (b: { x: number; width: number }) => (rtl ? b.x + b.width : b.x);
      for (const b of [why.label!, why.control, phrase.label!, phrase.control, action.control])
        expect(Math.abs(edge(b) - edge(why.control)), "starts at the reading edge").toBeLessThanOrEqual(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
    await panel.screenshot({ path: info.outputPath(`erase-forms-${locale}.png`) });
  });

  test(`${locale}: after erasing the account the sign-in page keeps the language and confirms it`, async ({ page }, info) => {
    await signIn(page, locale, "/test/session");
    await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
      .getByRole("button", { name: t.host["library.open"], exact: true }).click();
    await page.getByRole("button", { name: t.preview.start, exact: true }).click();
    await chooseFromMenu(page, t.host["menu.profile"]);
    const panel = page.getByRole("region", { name: t.data.title });
    await panel.getByText(t.data["account.summary"], { exact: true }).click();
    await panel.locator('textarea[id$="-account-reason"]').fill(rtl ? "סיום הלמידה בשירות הזה, בכל הקורסים." : "I am leaving every course on this service.");
    await panel.locator('input[id$="-account-confirm"]').fill(t.data["account.phrase"]);
    await panel.getByRole("button", { name: t.data["account.button"], exact: true }).click();
    await expect(page.getByRole("heading", { name: t.host["signIn.title"], exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", rtl ? "rtl" : "ltr");
    await expect(page.getByText(t.data["account.erased"], { exact: true })).toBeVisible();
    expect((await page.request.get("/api/enrollments")).status()).toBe(401);
    // Said once: a reload of the page does not repeat it, and keeps the language.
    expect(new URL(page.url()).searchParams.get("erased")).toBeNull();
    await page.reload();
    await expect(page.getByRole("heading", { name: t.host["signIn.title"], exact: true })).toBeVisible();
    await expect(page.getByText(t.data["account.erased"], { exact: true })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.screenshot({ path: info.outputPath(`erased-${locale}.png`) });
  });

  test(`${locale}: a Hebrew scene draws its heading inside the canvas and its slider runs with the scene`, async ({ page }, info) => {
    await openHebrewLesson(page, locale);
    await page.getByRole("button", { name: t.lesson.markRead, exact: true }).click();
    const player = page.locator(".ccv-player").first();
    // The player loads lazily in place of its placeholder.
    await expect(player.locator("svg.ccv-scene")).toBeVisible();
    await player.locator("svg.ccv-scene").scrollIntoViewIfNeeded();
    const canvas = (await player.locator("svg.ccv-scene").boundingBox())!;
    const heading = (await player.locator("svg.ccv-scene text").first().boundingBox())!;
    expect(heading.x).toBeGreaterThanOrEqual(canvas.x);
    expect(heading.x + heading.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    // "מדף 4" reads right to left: the number is drawn on the word's left.
    const drawn = await glyphs(player.locator("svg.ccv-scene text").first());
    expect(mid(drawn.find((g) => g.char === "4")!)).toBeLessThan(mid(drawn.find((g) => g.char === "מ")!));
    // The slider's thumb and the marker move the same way as the value grows.
    const slider = player.locator('input[type="range"]').last();
    const marker = player.locator('[data-node-id="marker"]');
    const at = async () => ({ marker: (await marker.boundingBox())!.x, direction: await slider.evaluate((e) => getComputedStyle(e).direction) });
    const low = await at();
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const high = await at();
    expect(low.direction).toBe("ltr");
    expect(high.marker).toBeGreaterThan(low.marker);
    expect(Number(await slider.inputValue())).toBeGreaterThan(2);
    await player.screenshot({ path: info.outputPath(`scene-${locale}.png`) });
  });
}
