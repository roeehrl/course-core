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

/*
 * Room for what sits at the window's edges, on every device project (Chromium desktop, phone and
 * tablet; WebKit desktop, iPhone and iPad), in English and Hebrew (0.1.58 qualification):
 * - the connection status never covers the lesson's buttons: on a phone the learning pane ends
 *   above it, beside the companion pane it is a band the page's end makes room for, and a lesson
 *   scrolled to its end keeps its next-step button in view above it;
 * - the companion pane's title and close button are never under the sticky header, at any scroll
 *   position of the page or of the pane (they slid 50-75 px under it near the end of the page);
 * - the button that shows the companion never covers lesson text: beside the lesson it is in the
 *   header, on a phone in its own row under the learning pane (on tablets it floated over the
 *   lesson mid-page).
 */
const text = {
  en: { host: enHost, preview: enPreview, lesson: enLesson, dock: enDock, connectivity: enConnectivity },
  he: { host: heHost, preview: hePreview, lesson: heLesson, dock: heDock, connectivity: heConnectivity },
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
  await page.getByRole("button", { name: t.host["library.continue"], exact: true }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  return (await page.locator(".connected-host.is-compact").count()) > 0;
}
/** Makes the lesson (and, given, the companion) longer than the window, as a real lesson and
 * conversation are; the layout rules under test do not depend on what the content is. */
async function lengthen(page: Page, { lesson = 0, companion = 0 }) {
  await page.evaluate(([lessonHeight, companionHeight]) => {
    const filler = (height: number) => Object.assign(document.createElement("div"), { className: "test-filler", style: `height:${height}px` });
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

for (const locale of ["en", "he"] as const) {
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
    await page.waitForTimeout(250);
    const room = (await status.boundingBox())!;
    const viewport = page.viewportSize()!;
    // The next step rose above the status, whole.
    const nextBox = (await next.boundingBox())!;
    expect(nextBox.y + nextBox.height, "the next-step button is above the status").toBeLessThanOrEqual(room.y);
    await expect(next).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`offline-at-the-end-${locale}.png`) });
    if (compact) {
      // A phone: the learning pane ends above the status, so at no scroll position can it cover
      // the lesson or one of its buttons.
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
    if (compact) {
      // A phone: the show button has its own row under the learning pane, never over it.
      await expect(show).toBeVisible();
      for (const y of await positions(page, true)) {
        await scrollTo(page, true, y);
        const pane = await box(page, ".connected-main"), button = (await show.boundingBox())!;
        expect(button.y, `the companion button covers the lesson at ${y}`).toBeGreaterThanOrEqual(pane.y + pane.height);
      }
      // The sheet keeps its title and close button at its top while a long conversation scrolls.
      await show.click();
      await expect(dock).toBeVisible();
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
    } else {
      const header = await box(page, ".connected-header");
      const below = header.y + header.height;
      // Beside the lesson the show button is in the header, so it can never cover lesson text.
      if (!(await dock.isVisible())) {
        await expect(page.locator(".connected-header").locator(".connected-companion-trigger")).toBeVisible();
        for (const y of await positions(page, false)) {
          await scrollTo(page, false, y);
          const button = (await show.boundingBox())!, bar = await box(page, ".connected-header");
          expect(area(button, bar), `the companion button left the header at ${y}`).toBeCloseTo(button.width * button.height, 0);
        }
        await scrollTo(page, false, 0);
        await show.click();
      }
      await expect(dock).toBeVisible();
      await lengthen(page, { companion: 2400 });
      const check = async (where: string) => {
        const pane = (await dock.boundingBox())!;
        expect(pane.y, `${where}: the pane starts under the header`).toBeGreaterThanOrEqual(below);
        expect(pane.y + pane.height, `${where}: the pane ends in the window`).toBeLessThanOrEqual(viewport.height);
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
      // The live finding was at the page's end: check it there with the pane scrolled too.
      for (const top of [0, 800, 100_000]) {
        await dock.evaluate((el, y) => { el.scrollTop = y; }, top);
        await check(`page end, pane at ${top}`);
      }
      await page.screenshot({ path: info.outputPath(`pane-at-the-end-${locale}.png`) });
      // Closing it puts the show button back in the header and focus on it.
      await close.click();
      await expect(dock).toBeHidden();
      await expect(show).toBeFocused();
      expect(await show.evaluate((el) => el.closest(".connected-header") !== null)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
