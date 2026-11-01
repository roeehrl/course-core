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

// Split from hebrew-polish.spec.ts: the conversation part (a signed number in a reply, the message box reading edge).

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

  test(`${locale}: a signed number in Hebrew lesson text and a companion reply keeps its minus before the digits`, async ({ page }, info) => {
    await openHebrewLesson(page, locale, true);
    const prose = page.locator(".connected-prose").first();
    const all = await glyphs(prose);
    for (const needle of ["הוא -2.", "הוא -8.", "של -8 מאפס"]) {
      const run = find(all, needle);
      const minus = run[needle.indexOf("-")]!, digit = run[needle.indexOf("-") + 1]!;
      expect(sameLine(minus, digit)).toBe(true);
      // Left to right inside the right-to-left sentence: "-" to the left of its digit.
      expect(mid(minus), `${needle}: the minus comes before the digit`).toBeLessThan(mid(digit));
      if (needle.endsWith(".")) {
        const stop = run.at(-1)!;
        if (sameLine(stop, minus)) expect(mid(stop), `${needle}: the full stop ends the Hebrew sentence, on the left`).toBeLessThan(mid(minus));
      }
    }
    const pane = await openCompanion(page);
    const reply = find(await glyphs(pane), "הרשימה הוא -2.");
    const at = "הרשימה הוא ".length;
    expect(mid(reply[at]!)).toBeLessThan(mid(reply[at + 1]!));
    await page.screenshot({ path: info.outputPath(`signed-numbers-${locale}.png`) });
  });

  test(`${locale}: the companion's message box starts at the interface's reading edge`, async ({ page }, info) => {
    await openHebrewLesson(page, locale);
    const pane = await openCompanion(page);
    const box = pane.getByRole("textbox", { name: t.companion["draft.label"], exact: true });
    const style = await box.evaluate((e) => ({ direction: getComputedStyle(e).direction, bidi: getComputedStyle(e).unicodeBidi, align: getComputedStyle(e).textAlign }));
    expect(style).toEqual({ direction: rtl ? "rtl" : "ltr", bidi: "plaintext", align: "start" });
    await pane.screenshot({ path: info.outputPath(`companion-box-${locale}.png`) });
  });
}
