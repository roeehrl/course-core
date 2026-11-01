import { test, expect, type Page } from "./health";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enCompanion from "../../src/i18n/messages/en/connectedCompanion.json";
import heCompanion from "../../src/i18n/messages/he/connectedCompanion.json";
import enMarkdown from "../../src/i18n/messages/en/markdownContent.json";
import heMarkdown from "../../src/i18n/messages/he/markdownContent.json";

/*
 * The companion's reading on every device project and both engines, in English and Hebrew (final
 * design §3.8; the live 0.1.58 test):
 * - a question is anchored near the top of the thread and its reply grows downward: nothing
 *   scrolls while the text streams, inside the companion or on the page (the window once scrolled
 *   0 → 577 px, and the sticky header was drawn low while it did);
 * - with no unread reply, the companion opens at its latest messages and the message box, not at
 *   the oldest of a long conversation (the oldest unread reply is notify's, with its tracker);
 * - a table or display formula wider than the narrow companion scrolls sideways and says so;
 * - an English formula pasted into a Hebrew question keeps its order, and a short inline formula
 *   in Hebrew prose is never split across lines.
 * The replies are stored or streamed by the test host; no model is involved.
 */
const text = {
  en: { host: enHost, preview: enPreview, companion: enCompanion, markdown: enMarkdown },
  he: { host: heHost, preview: hePreview, companion: heCompanion, markdown: heMarkdown },
} as const;
type Locale = keyof typeof text;

async function openLesson(page: Page, locale: Locale) {
  const t = text[locale];
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: t.host["library.open"], exact: true }).click();
  await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  await page.getByTestId("next-step").getByRole("button").click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
}
async function openCompanion(page: Page) {
  const pane = page.locator("#connected-companion");
  if (!(await pane.isVisible())) await page.locator(".connected-companion-trigger").click();
  await expect(pane).toBeVisible();
  return pane;
}
async function ask(page: Page, locale: Locale, question: string) {
  const t = text[locale].companion;
  await page.getByRole("textbox", { name: t["draft.label"], exact: true }).fill(question);
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  await page.locator("#connected-companion .cc-chat-send").click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("log", { name: t.log }).getByText(question, { exact: true })).toBeVisible();
}
/** Where the lesson is: the window's scroll and the phone's learning pane's. */
const lessonPlace = (page: Page) =>
  page.evaluate(() => ({ window: Math.round(window.scrollY), pane: Math.round(document.querySelector(".connected-main")!.scrollTop) }));

for (const locale of ["en", "he"] as const) {
  test(`${locale}: a streaming reply grows under its anchored question; neither the thread nor the lesson moves`, async ({ page }, info) => {
    const t = text[locale];
    await openLesson(page, locale);
    const pane = await openCompanion(page);
    const log = pane.getByRole("log", { name: t.companion.log });
    const question = `${locale === "he" ? "שאלה ארוכה" : "Long question"} ${Date.now()}`;
    await ask(page, locale, question);
    const before = await lessonPlace(page);
    const header = page.locator(".connected-header");
    const headerTop = (await header.boundingBox())!.y;
    // The anchor's scroll (M3, 240 ms) has settled.
    await page.waitForTimeout(400);
    const anchored = await log.evaluate((el) => Math.round(el.scrollTop));
    const pieces = Array.from({ length: 16 }, (_, i) => `Step ${i + 1}: compare the two values on the number line and keep the smaller one. `);
    expect((await (await page.request.post("/test/companion-draft", { data: { question, pieces, gapMs: 120, end: "complete" } })).json()).opened).toBe(true);
    const draft = log.locator('[data-reply-state="streaming"]');
    await expect(draft).toBeVisible();
    // While it streams: the lesson stays where the learner left it, the header where it is, and
    // the thread where the anchor put it.
    for (let sample = 0; sample < 12; sample++) {
      expect(await lessonPlace(page), `sample ${sample}`).toEqual(before);
      expect((await header.boundingBox())!.y, `header at sample ${sample}`).toBe(headerTop);
      expect(await log.evaluate((el) => Math.round(el.scrollTop)), `thread at sample ${sample}`).toBe(anchored);
      await page.waitForTimeout(150);
    }
    // The question sits near the thread's top, its reply under it.
    const logBox = (await log.boundingBox())!, bubble = (await log.locator(".cc-chat-bubble").filter({ hasText: question }).boundingBox())!;
    expect(bubble.y - logBox.y).toBeLessThan(40);
    expect((await draft.boundingBox())!.y).toBeGreaterThan(bubble.y);
    expect(await lessonPlace(page)).toEqual(before);
    await page.screenshot({ path: info.outputPath(`streamed-${locale}.png`) });
  });

  test(`${locale}: the companion opens at its latest messages`, async ({ page }) => {
    const t = text[locale];
    await openLesson(page, locale);
    await openCompanion(page);
    for (let i = 1; i <= 5; i++) {
      const question = `${locale === "he" ? "שאלה" : "Question"} ${i} ${Date.now()}`;
      await ask(page, locale, question);
      expect((await (await page.request.post("/test/companion-job", { data: { question, state: "applied", answer: `${"A longer stored answer. ".repeat(6)}${i}` } })).json()).updated).toBe(true);
      await expect(page.getByRole("log", { name: t.companion.log }).getByText(new RegExp(` ${i}$`))).toBeVisible({ timeout: 15_000 });
    }
    // A new visit: the conversation is long, and the companion opens at its end.
    await page.reload();
    await expect(async () => {
      const resume = page.getByRole("button", { name: t.host["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
      if (await resume.count()) await resume.first().click({ timeout: 2_000 });
      await expect(page.getByRole("heading", { name: "Minimum", exact: true, level: 1 })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const pane = await openCompanion(page);
    const log = pane.getByRole("log", { name: t.companion.log });
    await expect(log.getByText(/ 5$/)).toBeVisible();
    await expect.poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
    expect(await log.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
    await expect(log).toHaveAttribute("data-scrolled", "true");
    await expect(page.getByRole("textbox", { name: t.companion["draft.label"], exact: true })).toBeInViewport();
  });

  test(`${locale}: wide tables and formulas scroll sideways and say so; mixed text keeps its order`, async ({ page }, info) => {
    const t = text[locale];
    await openLesson(page, locale);
    const pane = await openCompanion(page);
    const pasted = "For prediction=w*x, use w=3, x=2, target=4 and L=(prediction-target)^2/2. What is the current value of w?";
    const question = locale === "he" ? `השאלה היא: ${pasted} תענה רק במספר.` : `The question is: ${pasted} Answer with a number.`;
    await ask(page, locale, question);
    const answer = [
      locale === "he" ? "נניח מודל של שתי שכבות: $h = w_1 \\cdot x$ ולאחר מכן $\\text{prediction} = w_2 \\cdot h$." : "Take two layers: $h = w_1 \\cdot x$ and then $\\text{prediction} = w_2 \\cdot h$.",
      "",
      "$$w_{\\text{new}} = w - \\eta \\frac{\\partial L}{\\partial w} = 2 - 0.1 \\cdot (-6) = 2 + 0.6 = 2.6 \\quad \\text{and the next forward gives } 7.8 \\quad \\text{so the loss falls from } 2 \\text{ to } 0.02$$",
      "",
      "| Stage | w | Prediction (w·x) | Loss | Gradient dL/dw | Learning rate η | Momentum β | Weight decay λ | Epoch |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| After forward | 2 | 6 | 2 | not yet computed | 0.1 (fixed for the run) | 0.9 | 0.0001 | 1 of 10 |",
      "| After update | 2.6 | 7.8 (on next forward) | 0.02 | not yet computed | 0.1 (fixed for the run) | 0.9 | 0.0001 | 1 of 10 |",
    ].join("\n");
    expect((await (await page.request.post("/test/companion-job", { data: { question, state: "applied", answer } })).json()).updated).toBe(true);
    const table = pane.locator(".markdown-table");
    await expect(table).toBeVisible({ timeout: 15_000 });
    // The learner's own question: the pasted English is one left-to-right run, in its own order.
    const card = pane.getByRole("log").locator("[dir=ltr]").filter({ hasText: "For prediction=w*x" });
    if (locale === "he") await expect(card.first()).toHaveText(pasted);
    // A short inline formula is one piece, never split across lines.
    const inline = pane.getByRole("math").first();
    expect(await inline.evaluate((el) => el.querySelectorAll("math").length)).toBe(1);
    // The table and the display formula are wider than the companion (the tablet sheet's 640 px
    // included): they scroll sideways, and a line under each says so.
    for (const frame of [table, pane.locator(".math-formula.is-display")]) {
      await frame.scrollIntoViewIfNeeded();
      expect(await frame.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await expect(frame).toHaveClass(/is-overflowing/);
      const hint = frame.locator("xpath=following-sibling::*[contains(@class, 'markdown-scroll-hint')]");
      await expect(hint).toHaveText(t.markdown.scrollHint);
      await expect(hint).toBeVisible();
    }
    // Scrolled to its end, the last column shows in full inside the frame.
    await table.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    const last = table.getByRole("columnheader").last(), frameBox = (await table.boundingBox())!, lastBox = (await last.boundingBox())!;
    expect(lastBox.x).toBeGreaterThanOrEqual(frameBox.x - 1);
    expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(frameBox.x + frameBox.width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`wide-${locale}.png`) });
  });
}
