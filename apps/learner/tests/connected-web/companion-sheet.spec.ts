import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./health";
import { companion, lengthenLesson, openLesson, settled, trigger } from "./shell-helpers";

/*
 * The companion as a bottom sheet on phones and tablets in portrait (final design §2.3, §2.4, G6).
 * It is never modal: no scrim, nothing inert, the lesson above it stays readable, scrollable and
 * usable, and it is the complementary region at every height. Every open starts at Half; the handle
 * (a press, ↑/↓), the height toggle and a drag move it between Collapsed, Half and Full; focusing
 * the message box at Half first brings the lesson part into the strip Full leaves, then goes Full;
 * an on-screen keyboard leaves the composer above it. On the phone and tablet projects at their
 * sizes; the desktop project checks the phone's.
 */
declare global {
  interface Window {
    __keyboard(height: number | null): void;
  }
}
const axe = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
/** A sheet layout: the project's own, or the phone's on the desktop project. */
async function sheetWindow(page: Page) {
  if ((page.viewportSize()?.width ?? 0) >= 840) await page.setViewportSize({ width: 390, height: 844 });
}
const header = async (page: Page) => {
  const box = (await page.locator(".connected-header").boundingBox())!;
  return box.y + box.height;
};
const box = async (page: Page) => {
  await settled(companion(page));
  return (await companion(page).boundingBox())!;
};

test("the sheet opens at Half every time and moves between heights by press and keys", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await sheetWindow(page);
  await openLesson(page);
  const viewport = page.viewportSize()!;
  const tablet = viewport.width >= 600;
  await trigger(page).click();
  const sheet = page.getByRole("complementary", { name: "Your companion", exact: true });
  await expect(sheet).toHaveAttribute("data-placement", "sheet");
  await expect(sheet).toHaveAttribute("data-detent", "half");
  expect(Math.abs((await box(page)).height - viewport.height / 2)).toBeLessThanOrEqual(1);
  if (tablet) expect(Math.round((await box(page)).width)).toBe(Math.min(640, viewport.width - 48));
  else expect(Math.round((await box(page)).width)).toBe(viewport.width);
  await page.screenshot({ path: info.outputPath("sheet-half.png") });
  await axe(page);
  // A press on the handle: Full, with a strip of lesson under the header (88 on a phone, 120 on a
  // tablet).
  const handle = sheet.getByRole("button", { name: "Resize companion", exact: true });
  await expect(handle).toHaveAttribute("data-companion-control", "");
  await handle.click();
  await expect(sheet).toHaveAttribute("data-detent", "full");
  expect(Math.round((await box(page)).y)).toBe(Math.round((await header(page)) + (tablet ? 120 : 88)));
  await page.screenshot({ path: info.outputPath("sheet-full.png") });
  await axe(page);
  // The toggle names the height it goes to.
  await sheet.getByRole("button", { name: "Half height", exact: true }).click();
  await expect(sheet).toHaveAttribute("data-detent", "half");
  await expect(sheet.getByRole("button", { name: "Full height", exact: true })).toBeVisible();
  // ↓ on the handle: Collapsed, a 72 px bar with the latest line.
  await handle.press("ArrowDown");
  await expect(sheet).toHaveAttribute("data-detent", "collapsed");
  expect(Math.round((await box(page)).height)).toBe(72);
  await expect(sheet.locator(".cc-shell-collapsed-text")).toHaveText("Companion");
  await page.screenshot({ path: info.outputPath("sheet-collapsed.png") });
  await axe(page);
  await sheet.getByRole("button", { name: "Show companion", exact: true }).click();
  await expect(sheet).toHaveAttribute("data-detent", "half");
  await sheet.getByRole("button", { name: "Resize companion", exact: true }).press("ArrowUp");
  await expect(sheet).toHaveAttribute("data-detent", "full");
  // Closing and opening again: Half.
  await sheet.getByRole("button", { name: "Close companion", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await expect(sheet).toHaveAttribute("data-detent", "half");
  expect(errors).toEqual([]);
});

test("the sheet slides (M12): opening, a change of height and closing are drawn moving, never in one frame", async ({ page }) => {
  await sheetWindow(page);
  await openLesson(page);
  /** Presses `selector` and reads the sheet `after` ms later, in the page (no round trip between). */
  const pressAndRead = (selector: string, after: number) =>
    page.evaluate(async ({ selector, after }) => {
      document.querySelector<HTMLElement>(selector)!.click();
      await new Promise((resolve) => setTimeout(resolve, after));
      const aside = document.querySelector<HTMLElement>("#connected-companion")!;
      const shift = /matrix\(1, 0, 0, 1, 0, (-?[\d.]+)\)/.exec(getComputedStyle(aside).transform);
      return { hidden: aside.hidden, shift: shift ? Number(shift[1]) : 0 };
    }, { selector, after });
  // Up from below the window (300 ms), still on its way 100 ms in.
  const opening = await pressAndRead(".connected-header .connected-companion-trigger", 100);
  expect(opening.shift).toBeGreaterThan(0);
  await settled(companion(page));
  // A press on the handle: Half to Full, the box sliding up into place.
  const taller = await pressAndRead("#connected-companion .cc-shell-handle", 100);
  expect(taller.shift).toBeGreaterThan(0);
  await settled(companion(page));
  await expect(companion(page)).toHaveAttribute("data-detent", "full");
  // Closing slides it down (250 ms): still drawn, part way down, 60 ms in.
  const closing = await pressAndRead('#connected-companion [aria-label="Close companion"]', 60);
  expect(closing.hidden).toBe(false);
  expect(closing.shift).toBeGreaterThan(0);
  await expect(companion(page)).toBeHidden();
});

test("the lesson stays usable beside the sheet, and focusing the message box shows the lesson part, then goes Full", async ({ page }, info) => {
  await sheetWindow(page);
  await openLesson(page);
  await lengthenLesson(page);
  await trigger(page).click();
  const sheet = companion(page);
  await expect(sheet).toHaveAttribute("data-detent", "half");
  // Nonmodal: no scrim, nothing inert, no locked page.
  expect(await page.locator("[inert], [aria-modal]").count()).toBe(0);
  expect(await page.locator(".connected-drawer-backdrop").count()).toBe(0);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  // The lesson above the sheet takes presses and scrolls.
  const top = await header(page);
  const sheetTop = (await box(page)).y;
  // Scrolled into view as focus or a link would (the lesson's scroll padding keeps it clear of the
  // sheet).
  const paragraph = page.getByText("Paragraph 3.", { exact: false });
  await paragraph.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
  const where = (await paragraph.boundingBox())!;
  expect(where.y + where.height, "scrolled into the strip above the sheet").toBeLessThanOrEqual(sheetTop + 1);
  expect(where.y).toBeGreaterThanOrEqual(top - 1);
  expect(
    await paragraph.evaluate((element) => {
      const r = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 4));
    }),
  ).toBe(true);
  // The lesson's end can be scrolled above the sheet.
  const end = page.getByText("Paragraph 24.", { exact: false });
  await end.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
  expect((await end.boundingBox())!.y + (await end.boundingBox())!.height).toBeLessThanOrEqual(sheetTop + 1);
  // A paragraph cut by the header at the top of the half view: focusing the message box brings
  // its first lines into the strip that stays above Full, then the sheet goes Full.
  const anchor = page.getByText("Paragraph 6.", { exact: false });
  await anchor.evaluate((element, headerBottom) => {
    const scroller = document.querySelector(".connected-host.is-compact .connected-main");
    const shift = element.getBoundingClientRect().top - (headerBottom - 20);
    if (scroller) scroller.scrollBy({ top: shift, behavior: "instant" });
    else window.scrollBy({ top: shift, behavior: "instant" });
  }, top);
  expect((await anchor.boundingBox())!.y).toBeLessThan(top);
  await sheet.getByRole("textbox", { name: "Message to your companion", exact: true }).focus();
  await expect(sheet).toHaveAttribute("data-detent", "full");
  const full = await box(page);
  const shown = (await anchor.boundingBox())!;
  expect(shown.y, "the paragraph starts in the strip").toBeGreaterThanOrEqual(top - 1);
  expect(shown.y).toBeLessThan(full.y);
  // Blurring does not go back to Half.
  await page.getByRole("heading", { name: "Minimum", exact: true }).click({ force: true });
  await page.waitForTimeout(400);
  await expect(sheet).toHaveAttribute("data-detent", "full");
  await expect(page.getByRole("complementary", { name: "Your companion", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("sheet-anchor-full.png") });
});

test("a drag on the handle moves the sheet between heights and down past Collapsed closes it", async ({ page }) => {
  await sheetWindow(page);
  await openLesson(page);
  await trigger(page).click();
  const sheet = companion(page);
  await expect(sheet).toHaveAttribute("data-detent", "half");
  const handle = sheet.getByRole("button", { name: "Resize companion", exact: true });
  const dragBy = async (dy: number, steps = 12) => {
    await settled(sheet);
    const h = (await handle.boundingBox())!;
    const x = h.x + h.width / 2,
      y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= steps; step++) {
      await page.mouse.move(x, y + (dy * step) / steps);
      // A hand's pace: about a frame between moves, so the release is not a flick.
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  };
  // Up, slowly, near Full: it settles at Full.
  const viewport = page.viewportSize()!;
  await dragBy(-viewport.height * 0.35, 30);
  await expect(sheet).toHaveAttribute("data-detent", "full");
  // Down a little, slowly: back to Full.
  await dragBy(40, 30);
  await expect(sheet).toHaveAttribute("data-detent", "full");
  // Down to the window's bottom: past a quarter below Collapsed, so it closes. Measured once the
  // sheet has slid back to Full (it is lower while it does).
  await settled(sheet);
  const handleTop = (await handle.boundingBox())!.y;
  await dragBy(viewport.height - handleTop - 30, 30);
  await expect(sheet).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
});

test("an on-screen keyboard leaves the composer above it and the strip at 48 px", async ({ page }) => {
  await page.addInitScript(() => {
    const real = window.visualViewport;
    if (!real) return;
    let height: number | null = null;
    const fake = new EventTarget();
    for (const key of ["width", "offsetLeft", "offsetTop", "pageLeft", "pageTop", "scale"] as const)
      Object.defineProperty(fake, key, { get: () => real[key] });
    Object.defineProperty(fake, "height", { get: () => height ?? real.height });
    for (const type of ["resize", "scroll"]) real.addEventListener(type, () => fake.dispatchEvent(new Event(type)));
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    window.__keyboard = (next) => {
      height = next;
      fake.dispatchEvent(new Event("resize"));
    };
  });
  await sheetWindow(page);
  await openLesson(page);
  await trigger(page).click();
  const sheet = companion(page);
  const draft = sheet.getByRole("textbox", { name: "Message to your companion", exact: true });
  await draft.focus();
  await expect(sheet).toHaveAttribute("data-detent", "full");
  const viewport = page.viewportSize()!;
  const tablet = viewport.width >= 600;
  const keyboard = Math.round(viewport.height * 0.4);
  await page.evaluate((h) => window.__keyboard(h), viewport.height - keyboard);
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>(".connected-host")!.style.getPropertyValue("--kb"))).toBe(`${keyboard}px`);
  await expect.poll(async () => Math.round((await box(page)).y)).toBe(Math.round((await header(page)) + 48));
  const field = (await draft.boundingBox())!;
  expect(field.y + field.height, "the message box is above the keyboard").toBeLessThanOrEqual(viewport.height - keyboard + 1);
  await expect(draft).toBeFocused();
  await page.evaluate(() => window.__keyboard(null));
  await expect.poll(async () => Math.round((await box(page)).y)).toBe(Math.round((await header(page)) + (tablet ? 120 : 88)));
});

test("he: the sheet mirrors, and every height stays accessible", async ({ page }, info) => {
  await sheetWindow(page);
  await openLesson(page, "he");
  await trigger(page).click();
  const sheet = page.getByRole("complementary", { name: "המנחה", exact: true });
  await expect(sheet).toHaveAttribute("data-detent", "half");
  const frame = await box(page);
  const title = (await sheet.locator(".connected-dock-title h2").boundingBox())!;
  const close = (await sheet.getByRole("button", { name: "סגירת המנחה", exact: true }).boundingBox())!;
  const handle = (await sheet.getByRole("button", { name: "שינוי גובה המנחה", exact: true }).boundingBox())!;
  // The title at the right, the controls at the left, the handle in the middle.
  expect(title.x).toBeGreaterThan(frame.x + frame.width / 2);
  expect(close.x + close.width).toBeLessThan(frame.x + frame.width / 2);
  expect(Math.abs(handle.x + handle.width / 2 - (frame.x + frame.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.round(handle.width)).toBe(96);
  expect(Math.round(handle.height)).toBe(44);
  await page.screenshot({ path: info.outputPath("sheet-half-he.png") });
  await axe(page);
  await sheet.getByRole("button", { name: "גובה מלא", exact: true }).click();
  await expect(sheet).toHaveAttribute("data-detent", "full");
  await axe(page);
  await sheet.getByRole("button", { name: "שינוי גובה המנחה", exact: true }).press("ArrowDown");
  await sheet.getByRole("button", { name: "שינוי גובה המנחה", exact: true }).press("ArrowDown");
  await expect(sheet).toHaveAttribute("data-detent", "collapsed");
  await expect(sheet.getByRole("button", { name: "הצגת המנחה", exact: true })).toBeVisible();
  await axe(page);
});
