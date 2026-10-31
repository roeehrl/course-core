import { test, expect, type Locator, type Page } from "./health";
import { chooseFromMenu } from "./learner-menu";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enCompanion from "../../src/i18n/messages/en/connectedCompanion.json";
import heCompanion from "../../src/i18n/messages/he/connectedCompanion.json";
import enDock from "../../src/i18n/messages/en/companionDock.json";
import heDock from "../../src/i18n/messages/he/companionDock.json";
import enData from "../../src/i18n/messages/en/yourDataPanel.json";
import heData from "../../src/i18n/messages/he/yourDataPanel.json";
import enLesson from "../../src/i18n/messages/en/connectedLesson.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";
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
  en: { host: enHost, companion: enCompanion, dock: enDock, data: enData, lesson: enLesson, preview: enPreview, roadmap: enRoadmap, input: enInput, code: enCode, connectivity: enConnectivity },
  he: { host: heHost, companion: heCompanion, dock: heDock, data: heData, lesson: heLesson, preview: hePreview, roadmap: heRoadmap, input: heInput, code: heCode, connectivity: heConnectivity },
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

  test(`${locale}: "Context used" quotes a Hebrew question with English and code in it in its own order`, async ({ page }, info) => {
    await openHebrewLesson(page, locale, true);
    const pane = await openCompanion(page);
    await pane.getByRole("button", { name: t.companion["context.show"], exact: true }).click();
    const answering = pane.getByText(/minimum value/).last();
    await answering.scrollIntoViewIfNeeded();
    const all = await glyphs(answering);
    leftToRight(find(all, "min([3, 7, -2, 5])"), "the call");
    leftToRight(find(all, "minimum"), "the term");
    const ending = find(all, "וקיבלתי -2.");
    const minus = ending[ending.length - 3]!, digit = ending[ending.length - 2]!;
    expect(mid(minus)).toBeLessThan(mid(digit));
    // The Hebrew question reads right to left: its first word is right of the call.
    const first = find(all, "מה זה")[0]!, call = find(all, "min([")[0]!;
    if (sameLine(first, call)) expect(first.left).toBeGreaterThan(call.right);
    await pane.screenshot({ path: info.outputPath(`context-used-${locale}.png`) });
  });

  test(`${locale}: the companion's message box starts at the interface's reading edge`, async ({ page }, info) => {
    await openHebrewLesson(page, locale);
    const pane = await openCompanion(page);
    const box = pane.getByRole("textbox", { name: t.companion["draft.label"], exact: true });
    const style = await box.evaluate((e) => ({ direction: getComputedStyle(e).direction, bidi: getComputedStyle(e).unicodeBidi, align: getComputedStyle(e).textAlign }));
    expect(style).toEqual({ direction: rtl ? "rtl" : "ltr", bidi: "plaintext", align: "start" });
    await pane.screenshot({ path: info.outputPath(`companion-box-${locale}.png`) });
  });

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

  test(`${locale}: a slow sandbox start shows one message with the retry; a time-limit stop is a warning`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const signed = await page.request.post("/test/code-session");
    await page.goto(`/?locale=${locale}#signin=${(await signed.json()).token}`);
    await page.getByRole("button", { name: t.host["library.open"], exact: true }).click();
    await page.getByRole("button", { name: t.preview.start, exact: true }).click();
    const resume = page.getByRole("button", { name: t.host["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
    const roadmap = page.getByRole("heading", { name: t.roadmap.path, exact: true });
    await expect(roadmap).toBeVisible();
    await expect(async () => {
      if (await resume.count()) await resume.click({ timeout: 2_000 });
      await expect(roadmap).toHaveCount(0, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole("button", { name: t.lesson.markRead, exact: true }).click();
    await page.getByRole("button", { name: t.lesson["check.start"], exact: true }).click();
    await page.getByRole("radio", { name: "2", exact: true }).click();
    await page.getByRole("button", { name: t.lesson["answer.check"], exact: true }).click();
    await page.getByRole("button", { name: t.lesson["check.start"], exact: true }).click();
    await page.getByRole("textbox", { name: t.input.numeric, exact: true }).fill("4");
    await page.getByRole("button", { name: t.lesson["answer.check"], exact: true }).click();
    await page.getByRole("button", { name: t.lesson["check.start"], exact: true }).click();
    const code = page.getByRole("textbox", { name: t.code.yourCode, exact: true });
    await code.fill("def solve(values):\n    return min(values)\n");
    // The sandbox takes too long to start: the API refuses before running anything (#236).
    const answers = /\/api\/enrollments\/[^/]+\/answers$/;
    await page.route(answers, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "CODE_SANDBOX_SETUP_SLOW" }) }));
    await page.getByRole("button", { name: t.lesson["answer.runCode"], exact: true }).click();
    // One state, where the learner pressed: the connection status says why nothing ran, with the
    // retry; no notice at the top of the lesson says it again, and no "Not recorded yet" beside it.
    const status = page.locator(".connected-connection");
    const why = rtl ? "מריץ הקוד" : "code runner";
    await expect(status).toBeVisible();
    await expect(status).toContainText(why);
    await expect(status).not.toContainText(rtl ? "עדיין לא נרשם" : "Not recorded yet");
    await expect(page.getByText(new RegExp(why))).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const retry = status.getByRole("button", { name: t.connectivity.retry, exact: true });
    await expect(retry).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`slow-sandbox-${locale}.png`) });
    // The retry sends the kept request; this time the run stops at the time limit.
    await page.unroute(answers);
    await page.route(answers, (route) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ result: { passed: false, independent: true, message: { code: "code_limit", params: { limit: "time" } }, execution: { status: "timeout" } } }) }));
    await retry.click();
    await expect(status).toHaveCount(0);
    const notice = page.locator('[data-tone="warning"]').filter({ hasText: rtl ? "מגבלת הזמן" : "time limit" });
    await expect(notice).toBeVisible();
    expect(await notice.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe("rgb(252, 243, 223)");
    await expect(page.locator('[data-tone="info"]').filter({ hasText: rtl ? "מגבלת הזמן" : "time limit" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`time-limit-${locale}.png`) });
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
