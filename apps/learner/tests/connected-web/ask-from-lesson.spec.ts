import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./health";
import { companionPanel, composerBox } from "./companion-helpers";
import enAsk from "../../src/i18n/messages/en/askCompanionButton.json";
import heAsk from "../../src/i18n/messages/he/askCompanionButton.json";
import enAnnounce from "../../src/i18n/messages/en/askFromLesson.json";
import enMedia from "../../src/i18n/messages/en/reviewedMedia.json";
import enPart from "../../src/i18n/messages/en/partMenu.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";

/*
 * Asking the companion from the lesson (final design §3.9, §5, §6, M18), on every device
 * project: nothing the learner selects is attached on its own; a stable selection offers a
 * floating "Ask companion" button 8 px below its end, on the reading side; pressing it attaches
 * the selection and opens the companion (on a touch screen without raising the keyboard). The
 * keyboard path names the shortcut once and Tab reaches the button. A video attaches the moment
 * the player is at, and an illustration's part is chosen from the app's own menu.
 */

/** The learner of /test/ask-session (or another session), in the open "Minimum" lesson. */
async function openLesson(page: Page, session = "/test/ask-session", locale?: "he") {
  const token = (await (await page.request.post(session)).json()).token;
  await page.goto(`/${locale ? `?locale=${locale}` : ""}#signin=${token}`);
  const lesson = page.locator(".connected-lesson-keeper:not([hidden]) [data-reading-heading]");
  const resume = page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .or(page.getByRole("button", { name: heHost["library.continue"], exact: true }))
    .or(page.getByTestId("next-step").getByRole("button"));
  await expect(async () => {
    if (await lesson.isVisible()) return;
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(lesson).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Selects `text` inside the first lesson paragraph that has it; returns the box of its last line. */
async function selectInLesson(page: Page, text: string) {
  return page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.querySelector(".connected-lesson")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(wanted);
      if (at < 0) continue;
      (node.parentElement as HTMLElement).scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
      const last = rects.at(-1)!;
      return { top: last.top, bottom: last.bottom, left: last.left, right: last.right };
    }
    throw new Error(`lesson text not found: ${wanted}`);
  }, text);
}

/** Moves on to the lesson's next part (text, then the video, then the illustration). */
async function nextPart(page: Page) {
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
}

const coarse = (page: Page) => page.evaluate(() => matchMedia("(pointer: coarse)").matches);

test("a selection is attached only by pressing Ask companion, which opens the companion with it", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLesson(page);
  const panel = companionPanel(page);
  const ask = page.getByRole("button", { name: enAsk.label, exact: true });
  // A plain selection (to copy, say) attaches nothing and, until it is stable, shows nothing.
  const end = await selectInLesson(page, "any other member");
  await expect(ask).toBeVisible();
  // 32 px (44 with a coarse pointer), 8 px below the selection's last line, its end at the selection's end.
  const box = (await ask.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual((await coarse(page)) ? 44 : 32);
  expect(Math.abs(box.y - (end.bottom + 8))).toBeLessThanOrEqual(1);
  const viewport = page.viewportSize()!;
  if (end.right - box.width >= 8) expect(Math.abs(box.x + box.width - end.right)).toBeLessThanOrEqual(1);
  else expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  await expect(page.getByText(/^Selected: /)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("ask-button.png") });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
  // Esc hides it; the same selection is not offered again.
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  await page.waitForTimeout(600);
  await expect(ask).toHaveCount(0);
  // A new selection is; pressing it attaches the selection and opens the companion.
  await selectInLesson(page, "no greater than");
  await ask.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Selected: “no greater than”", { exact: true })).toBeVisible();
  await expect(ask).toHaveCount(0);
  // The message box takes focus with a fine pointer; on a touch screen the keyboard stays down
  // and a sheet opens at Half.
  if (await coarse(page)) await expect(composerBox(page)).not.toBeFocused();
  else await expect(composerBox(page)).toBeFocused();
  if ((await panel.getAttribute("data-placement")) === "sheet") await expect(panel).toHaveAttribute("data-detent", "half");
  await page.screenshot({ path: info.outputPath("ask-attached.png") });
  expect(errors).toEqual([]);
});

test("a scroll of the page hides the button, and text in the companion is never offered", async ({ page }) => {
  // A short window, so the lesson scrolls.
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
  await openLesson(page);
  const ask = page.getByRole("button", { name: enAsk.label, exact: true });
  await selectInLesson(page, "any other member");
  await expect(ask).toBeVisible();
  // The learner scrolls the lesson (whichever box scrolls it on this layout).
  await page.evaluate(() => {
    for (let box = document.querySelector(".connected-lesson")!.parentElement; box; box = box.parentElement)
      if (box.scrollHeight > box.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(box).overflowY)) return box.scrollBy(0, 40);
    document.scrollingElement!.scrollBy(0, 40);
  });
  await expect(ask).toHaveCount(0);
  // Text in the companion's own panel.
  await page.evaluate(() => {
    const panel = document.querySelector("#connected-companion")!;
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim().length < 6 || !(node.parentElement as HTMLElement).getClientRects().length) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 5);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      return;
    }
  });
  await page.waitForTimeout(600);
  await expect(ask).toHaveCount(0);
});

/** Shift+→ extends the selection by one character. Safari's engine does that on lesson text;
 * Chromium needs caret browsing for it, so there the selection is extended as caret browsing would. */
async function extendByOne(page: Page) {
  const before = await page.evaluate(() => document.getSelection()!.toString().length);
  await page.keyboard.press("Shift+ArrowRight");
  await page.evaluate((length) => {
    const selection = document.getSelection()!;
    if (selection.toString().length === length) selection.modify("extend", "forward", "character");
  }, before);
}

test("keyboard: the shortcut is named once, Tab reaches the button and Enter attaches", async ({ page }) => {
  await openLesson(page);
  const ask = page.getByRole("button", { name: enAsk.label, exact: true });
  // A selection extended with the keyboard: Shift+→ from a caret in the lesson text, one
  // character at a time, as caret browsing does it.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector(".connected-lesson")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf("any other member");
      if (at < 0) continue;
      document.getSelection()!.collapse(node, at);
      return;
    }
  });
  for (let i = 0; i < "any other".length; i++) await extendByOne(page);
  await expect(ask).toBeVisible();
  const status = page.locator(".cc-ask-status");
  await expect(status).toHaveText(enAnnounce.available);
  await expect(status).toHaveAttribute("role", "status");
  await page.keyboard.press("Tab");
  await expect(ask).toBeFocused();
  // Esc hides it and gives focus back to where it came from, not to the top of the page.
  await page.keyboard.press("Escape");
  await expect(ask).toHaveCount(0);
  expect(await page.evaluate(() => !!document.activeElement?.closest(".connected-lesson"))).toBe(true);
  for (let i = 0; i < 2; i++) await extendByOne(page);
  await expect(ask).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(ask).toBeFocused();
  await page.keyboard.press("Enter");
  const panel = companionPanel(page);
  await expect(panel.getByText("Selected: “any other m”", { exact: true })).toBeVisible();
  await expect(composerBox(page)).toBeFocused();
});

test("a video attaches the moment the player is at", async ({ page }) => {
  await page.route("https://www.youtube-nocookie.com/**", (route) => route.abort());
  // Stands in for the official IFrame Player API: the player says it is at 2:14.
  await page.route("https://www.youtube.com/iframe_api", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.YT = { Player: function (element, options) {
        var frame = document.createElement("iframe");
        frame.src = options.host + "/embed/" + options.videoId + "?enablejsapi=1";
        element.replaceWith(frame);
        this.getIframe = function () { return frame; };
        this.getCurrentTime = function () { return 134; };
        this.destroy = function () { frame.remove(); };
        var self = this;
        setTimeout(function () {
          options.events.onReady && options.events.onReady({ target: self });
          window.__playerReady = true;
        }, 20);
      } };
      window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();`,
    }),
  );
  await openLesson(page);
  await nextPart(page);
  const moment = page.getByRole("button", { name: enMedia.askMoment, exact: true });
  await expect(moment).toHaveCount(0);
  await page.getByRole("button", { name: enMedia.load, exact: true }).click();
  await expect(moment).toBeVisible();
  // The player tells its position once it is ready; a press before that attaches the video alone.
  await page.waitForFunction(() => (window as Window & { __playerReady?: boolean }).__playerReady === true);
  await moment.click();
  const panel = companionPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/Course video.*2:14/)).toBeVisible();
});

test("an illustration's part is chosen from the app's menu by keyboard", async ({ page }) => {
  await openLesson(page);
  await nextPart(page);
  await nextPart(page);
  const button = page.getByRole("button", { name: enPart.button, exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: enPart.title });
  await expect(menu).toBeVisible();
  const first = menu.getByRole("menuitemradio").first();
  await expect(first).toBeFocused();
  const rows = await menu.getByRole("menuitemradio").count();
  expect(rows).toBeGreaterThan(1);
  // 44 px rows (measured without the opening scale, M16).
  for (const row of await menu.getByRole("menuitemradio").all()) expect(await row.evaluate((element) => (element as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
  const axe = await new AxeBuilder({ page }).include(".cc-ask-part").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
  await page.keyboard.press("ArrowDown");
  const chosen = (await menu.getByRole("menuitemradio").nth(1).textContent())!;
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  const panel = companionPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByText(`Part of the illustration: ${chosen}`, { exact: true })).toBeVisible();
});

test("Hebrew: the button reads שאלה למנחה and sits on the reading side of the selection", async ({ page }, info) => {
  await openLesson(page, "/test/hebrew-reading-session", "he");
  const ask = page.getByRole("button", { name: heAsk.label, exact: true });
  const text = "בשיעור הזה מחפשים";
  const end = await selectInLesson(page, text);
  await expect(ask).toBeVisible();
  const box = (await ask.boundingBox())!;
  // Right to left, the selection ends at its left edge, where the button starts.
  if (end.left + box.width <= page.viewportSize()!.width - 8) expect(Math.abs(box.x - end.left)).toBeLessThanOrEqual(1);
  // Its own width, not stretched to the window's edge.
  expect(box.width).toBeLessThan(240);
  expect(Math.abs(box.y - (end.bottom + 8))).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("ask-button-he.png") });
  await ask.click();
  await expect(companionPanel(page).getByText(text, { exact: false }).first()).toBeVisible();
});
