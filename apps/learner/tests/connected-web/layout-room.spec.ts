import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./health";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enLesson from "../../src/i18n/messages/en/connectedLesson.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";
import enDock from "../../src/i18n/messages/en/companionDock.json";
import heDock from "../../src/i18n/messages/he/companionDock.json";
import enConnectivity from "../../src/i18n/messages/en/connectivity.json";
import heConnectivity from "../../src/i18n/messages/he/connectivity.json";
import enSplitter from "../../src/i18n/messages/en/panelSplitter.json";
import heSplitter from "../../src/i18n/messages/he/panelSplitter.json";

/*
 * Room for what sits at the window's edges, on every device project (Chromium desktop, phone and
 * tablet; WebKit desktop, iPhone and iPad), in English and Hebrew (0.1.58 qualification):
 * - the connection status never covers the lesson's buttons: on a phone the learning pane ends
 *   above it, beside the companion pane it is a band the page's end makes room for, and a lesson
 *   scrolled to its end keeps its next-step button in view above it;
 * - the companion panel's title and close button are never under the sticky header, at any scroll
 *   position of the page or of the panel (they slid 50-75 px under it near the end of the page);
 *   the panel is flush with the window's inline end (no inset), 400 px wide by default and never
 *   under 360; the sheet's title and close button stay in view while its conversation scrolls;
 * - the button that shows the companion never covers lesson text: it is in the header on every
 *   size (on tablets it once floated over the lesson mid-page, on phones it had a row of its own).
 */
const text = {
  en: { host: enHost, preview: enPreview, lesson: enLesson, dock: enDock, connectivity: enConnectivity, splitter: enSplitter },
  he: { host: heHost, preview: hePreview, lesson: heLesson, dock: heDock, connectivity: heConnectivity, splitter: heSplitter },
} as const;
type Locale = keyof typeof text;
type Box = { x: number; y: number; width: number; height: number };
const area = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

async function openLesson(page: Page, locale: Locale) {
  const t = text[locale];
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: t.host["library.open"], exact: true }).click();
  await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  await page.getByTestId("next-step").getByRole("button").click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  return (await page.locator(".connected-host.is-compact").count()) > 0;
}
/** Makes the lesson (and, given, the companion) longer than the window, as a real lesson and
 * conversation are; the layout rules under test do not depend on what the content is. */
async function lengthen(page: Page, { lesson = 0, companion = 0 }) {
  await page.evaluate(([lessonHeight, companionHeight]) => {
    const filler = (height: number) => Object.assign(document.createElement("div"), { className: "test-filler", style: `height:${height}px;flex-shrink:0` });
    if (lessonHeight) document.querySelector(".connected-main")!.prepend(filler(lessonHeight));
    if (companionHeight) document.querySelector("#connected-companion")!.append(filler(companionHeight));
  }, [lesson, companion]);
}
/** Scroll positions from the top to the end of the learning pane (phone) or the page. */
async function positions(page: Page, compact: boolean) {
  const { max, view } = await page.evaluate((pane) => {
    const scroller = pane ? document.querySelector(".connected-main")! : document.scrollingElement!;
    return { max: scroller.scrollHeight - scroller.clientHeight, view: scroller.clientHeight };
  }, compact);
  const step = Math.max(80, Math.floor(view / 3));
  const list: number[] = [];
  for (let y = 0; y < max; y += step) list.push(y);
  return [...list, max];
}
const scrollTo = (page: Page, compact: boolean, y: number) =>
  page.evaluate(([pane, top]) => {
    if (pane) document.querySelector(".connected-main")!.scrollTop = top as number;
    else window.scrollTo(0, top as number);
  }, [compact, y] as const);
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;

/** Where the lesson is: the window's scroll and the phone's learning pane's. */
const lessonPlace = (page: Page) =>
  page.evaluate(() => ({ window: Math.round(window.scrollY), pane: Math.round(document.querySelector(".connected-main")!.scrollTop) }));
/** A tap where the control is on screen (Playwright's click first scrolls it "into view"). */
async function tap(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: opening and closing the companion never moves the lesson`, async ({ page }, info) => {
    const compact = await openLesson(page, locale);
    await lengthen(page, { lesson: 1600 });
    const middle = Math.round((await positions(page, compact)).at(-1)! / 2);
    await scrollTo(page, compact, middle);
    const dock = page.locator("#connected-companion");
    for (let round = 0; round < 2; round++) {
      const before = await lessonPlace(page);
      if (!(await dock.isVisible())) await tap(page, ".connected-companion-trigger");
      await expect(dock).toBeVisible();
      const sheet = (await dock.getAttribute("data-placement")) === "sheet";
      if (sheet) expect(await lessonPlace(page), "opening the sheet").toEqual(before);
      await page.waitForTimeout(150);
      if (sheet) await page.keyboard.press("Escape");
      else await tap(page, `#connected-companion [aria-label="${text[locale].dock.close}"]`);
      await expect(dock).toBeHidden();
      await page.waitForTimeout(150);
      expect(await lessonPlace(page), `round ${round}: closing the companion`).toEqual(before);
    }
    await page.screenshot({ path: info.outputPath(`companion-closed-${locale}.png`) });
  });

  test(`${locale}: the connection status never covers the lesson's buttons`, async ({ page, context }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const t = text[locale];
    const compact = await openLesson(page, locale);
    await lengthen(page, { lesson: 900 });
    // The live finding: scrolled to the lesson's end, then the connection drops.
    const end = (await positions(page, compact)).at(-1)!;
    await scrollTo(page, compact, end);
    const next = page.getByRole("button", { name: t.lesson["complete.episode"], exact: true });
    await expect(next).toBeInViewport();
    await context.setOffline(true);
    const status = page.getByRole("status").filter({ hasText: t.connectivity.offline });
    await expect(status).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--connected-status-offset"))).not.toBe("");
    // Measured where it rests, after its short slide in.
    await status.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    await page.waitForTimeout(100);
    const room = (await status.boundingBox())!;
    const viewport = page.viewportSize()!;
    // The next step rose above the status, whole.
    const nextBox = (await next.boundingBox())!;
    expect(nextBox.y + nextBox.height, "the next-step button is above the status").toBeLessThanOrEqual(room.y);
    await expect(next).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`offline-at-the-end-${locale}.png`) });
    if (compact) {
      // A phone: the learning pane ends above the status, so at no scroll position can it cover
      // the lesson or one of its buttons. The companion opened as a sheet takes the bottom and the
      // status moves above it.
      for (const y of await positions(page, true)) {
        await scrollTo(page, true, y);
        const pane = await box(page, ".connected-main");
        expect(pane.y + pane.height, `the pane runs under the status at ${y}`).toBeLessThanOrEqual(room.y);
        const covered = await page.evaluate(([s, p]) => Array.from(document.querySelectorAll<HTMLElement>(".connected-main button")).flatMap((button) => {
          const r = button.getBoundingClientRect();
          // The part of the button the pane shows.
          const top = Math.max(r.top, p.y), bottom = Math.min(r.bottom, p.y + p.height);
          const shown = bottom > top && r.width > 0;
          return shown && bottom > s.y && top < s.y + s.height && r.right > s.x && r.left < s.x + s.width ? [button.textContent ?? ""] : [];
        }), [room, pane] as const);
        expect(covered, `buttons under the status at ${y}`).toEqual([]);
      }
      await tap(page, ".connected-companion-trigger");
      const sheet = page.locator("#connected-companion");
      await expect(sheet).toBeVisible();
      await sheet.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
      const above = (await status.boundingBox())!, top = (await sheet.boundingBox())!;
      expect(above.y + above.height, "the status sits above the sheet").toBeLessThanOrEqual(top.y + 1);
      const pane = await box(page, ".connected-main");
      expect(pane.y + pane.height, "the pane ends above the status and the sheet").toBeLessThanOrEqual(above.y);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    } else {
      // Beside the companion pane: a band across the window's end, opaque like the header; the
      // page's end makes room for it, and the companion pane ends above it.
      expect(room.x).toBeLessThanOrEqual(0.5);
      expect(room.width).toBeGreaterThanOrEqual(viewport.width - 1);
      expect(room.y + room.height).toBeGreaterThanOrEqual(viewport.height - 1);
      expect(await status.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
      const dock = page.locator("#connected-companion");
      if (await dock.isVisible()) {
        for (const y of await positions(page, false)) {
          await scrollTo(page, false, y);
          const pane = (await dock.boundingBox())!;
          expect(pane.y + pane.height, `the companion pane runs under the status at ${y}`).toBeLessThanOrEqual(room.y);
        }
      }
      // Keyboard focus that lands under the band is scrolled above it.
      const read = page.getByRole("button", { name: t.lesson.markRead, exact: true });
      await read.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight + 20));
      await read.focus();
      const focused = (await read.boundingBox())!;
      expect(focused.y + focused.height, "a focused button stops above the status").toBeLessThanOrEqual(room.y + 1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
    await context.setOffline(false);
    await expect(page.locator(".connected-connection")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--connected-status-offset"))).toBe("");
    expect(errors).toEqual([]);
  });

  test(`${locale}: the companion's title, close and show buttons stay clear of the header and the lesson at every scroll position`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const t = text[locale];
    const compact = await openLesson(page, locale);
    const show = page.locator(".connected-companion-trigger");
    const dock = page.locator("#connected-companion");
    const title = dock.locator(".connected-dock-title h2");
    const close = dock.getByRole("button", { name: t.dock.close, exact: true });
    await lengthen(page, { lesson: 900 });
    const viewport = page.viewportSize()!;
    // The show button is in the header on every size, so it can never cover lesson text.
    await expect(page.locator(".connected-header").locator(".connected-companion-trigger")).toBeVisible();
    if ((await show.getAttribute("aria-expanded")) !== "true") {
      for (const y of await positions(page, compact)) {
        await scrollTo(page, compact, y);
        const button = (await show.boundingBox())!, bar = await box(page, ".connected-header");
        expect(area(button, bar), `the companion button left the header at ${y}`).toBeCloseTo(button.width * button.height, 0);
      }
      await scrollTo(page, compact, 0);
      await show.click();
    }
    await expect(dock).toBeVisible();
    await expect(show).toHaveAttribute("aria-expanded", "true");
    // Measured where it rests, after it slid or faded in.
    await dock.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    if ((await dock.getAttribute("data-placement")) === "sheet") {
      // The sheet keeps its title and close button at its top while a long conversation scrolls.
      await lengthen(page, { companion: 2400 });
      for (const top of [0, 600, 1200, 100_000]) {
        await dock.evaluate((el, y) => { el.scrollTop = y; }, top);
        for (const part of [title, close]) {
          const b = (await part.boundingBox())!;
          expect(b.y, `sheet scrolled to ${top}`).toBeGreaterThanOrEqual(0);
          expect(b.y + b.height).toBeLessThanOrEqual(viewport.height);
        }
      }
      await page.screenshot({ path: info.outputPath(`sheet-${locale}.png`) });
      await close.click();
      await expect(dock).toBeHidden();
      await expect(show).toBeFocused();
    } else {
      const header = await box(page, ".connected-header");
      const below = header.y + header.height;
      // Flush with the window's inline end (no inset), 400 px wide by default, never under 360.
      const pane = (await dock.boundingBox())!;
      expect(Math.round(pane.width)).toBe(400);
      const edge = locale === "he" ? pane.x : viewport.width - (pane.x + pane.width);
      const scrollbar = await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth);
      expect(edge, "the panel is flush with the window's end").toBeLessThanOrEqual(scrollbar + 0.5);
      const splitter = page.getByRole("separator", { name: t.splitter.label });
      await splitter.focus();
      await page.keyboard.press("Home");
      await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(360);
      await page.keyboard.press("Enter");
      await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(400);
      await lengthen(page, { companion: 2400 });
      const check = async (where: string) => {
        const pane = (await dock.boundingBox())!;
        expect(pane.y, `${where}: the panel starts under the header`).toBeGreaterThanOrEqual(below - 1);
        expect(pane.y + pane.height, `${where}: the panel ends in the window`).toBeLessThanOrEqual(viewport.height);
        for (const part of [title, close]) {
          const b = (await part.boundingBox())!;
          expect(b.y, `${where}: the companion title or close button is under the header`).toBeGreaterThanOrEqual(below);
          expect(b.y + b.height, where).toBeLessThanOrEqual(viewport.height);
        }
      };
      for (const y of await positions(page, false)) {
        await scrollTo(page, false, y);
        await check(`page at ${y}`);
      }
      // The live finding was at the page's end: check it there with the panel scrolled too.
      for (const top of [0, 800, 100_000]) {
        await dock.evaluate((el, y) => { el.scrollTop = y; }, top);
        await check(`page end, panel at ${top}`);
      }
      await page.screenshot({ path: info.outputPath(`pane-at-the-end-${locale}.png`) });
      // Closing it leaves the show button in the header, with focus on it.
      await close.click();
      await expect(dock).toBeHidden();
      await expect(show).toBeFocused();
      expect(await show.evaluate((el) => el.closest(".connected-header") !== null)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
