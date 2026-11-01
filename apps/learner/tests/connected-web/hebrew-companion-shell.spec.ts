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

// Split from hebrew-polish.spec.ts: the companion shell part (opening and closing it keeps the text being read in place).

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

  test(`${locale}: opening and closing the companion keeps the text being read in place`, async ({ page }, info) => {
    await openHebrewLesson(page, locale);
    // The paragraph being read starts a third of the way down the window, under the header.
    const paragraph = page.getByText(/בהשוואה בין שני ערכים שליליים/).first();
    const top = () => paragraph.evaluate((e) => e.getBoundingClientRect().top);
    await paragraph.evaluate((element) => {
      // Room below the lesson, so the window can scroll the paragraph up to the reading line on
      // every size (a short lesson ends before it can).
      document.querySelector(".connected-lesson")!.append(Object.assign(document.createElement("div"), { style: "height:1200px;flex-shrink:0" }));
      const header = document.querySelector(".connected-header")!.getBoundingClientRect().bottom;
      const reading = header + (window.innerHeight - header) / 3;
      window.scrollBy({ top: element.getBoundingClientRect().top - reading + 2, behavior: "instant" });
    });
    await page.waitForTimeout(300);
    const before = await top();
    const trigger = page.locator(".connected-companion-trigger");
    const close = page.getByRole("button", { name: t.dock.close, exact: true });
    // Desktop starts with the pane open: close it first, then open it again.
    const steps = (await trigger.isVisible()) ? [trigger, close] : [close, trigger];
    for (const control of steps) {
      await press(page, control);
      await page.waitForTimeout(500);
      expect(Math.abs((await top()) - before), `the paragraph stays put (${info.project.name})`).toBeLessThanOrEqual(2);
      await page.screenshot({ path: info.outputPath(`reading-place-${locale}-${steps.indexOf(control)}.png`) });
    }
  });
}
