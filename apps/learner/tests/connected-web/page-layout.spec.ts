import { expect, test, type Page } from "./health";

/* The page frame on every engine and device project, in English and Hebrew: the page is never
 * taller than its content (a phone never scrolls the window to a blank screen, a desktop never
 * shows a white band below the app), nothing overflows sideways, the floating companion button
 * never covers the last content, and the next-step button keeps a button's shape on a phone. */

const LABELS = {
  en: { open: "Open course", start: "Start course", next: "Continue learning →", close: "Close companion", lesson: "Minimum" },
  he: { open: "פתיחת הקורס", start: "התחלת הקורס", next: "המשך למידה ←", close: "סגירת המלווה", lesson: "Minimum" },
} as const;
const PAGE_BACKGROUND = "rgb(248, 248, 242)";

async function frame(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement!, host = document.querySelector(".connected-host")!;
    const box = host.getBoundingClientRect();
    return {
      compact: host.classList.contains("is-compact"),
      viewport: innerHeight,
      documentHeight: root.scrollHeight,
      overflowsSideways: root.scrollWidth > root.clientWidth,
      hostTop: box.top + scrollY,
      hostBottom: box.bottom + scrollY,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  });
}

/** The page is exactly as tall as the app needs, and the app's background is the page's. */
async function fitsTheWindow(page: Page, where: string) {
  const before = await frame(page);
  expect.soft(before.overflowsSideways, `${where}: sideways overflow`).toBe(false);
  expect.soft(before.htmlBackground, `${where}: page background`).toBe(PAGE_BACKGROUND);
  expect.soft(before.bodyBackground, `${where}: body background`).toBe(PAGE_BACKGROUND);
  if (before.compact) {
    // A phone scrolls the learning pane, never the window: the document is the screen.
    expect.soft(before.documentHeight, `${where}: document taller than the screen`).toBeLessThanOrEqual(before.viewport);
    await page.evaluate(() => window.scrollBy(0, 900));
    expect.soft(await page.evaluate(() => scrollY), `${where}: the window scrolled`).toBe(0);
  } else {
    // The app's own box covers the whole document: no band of page below or above it.
    expect.soft(before.hostTop, `${where}: gap above the app`).toBeLessThanOrEqual(0);
    expect.soft(before.hostBottom, `${where}: page below the app`).toBeGreaterThanOrEqual(before.documentHeight - 1);
  }
}

/** A long lesson with screen-reader-only text near its end (as source links have) must not make
 * a phone's page taller than the screen: the live lesson was 2033px in an 844px window. */
async function longLessonStaysInItsPane(page: Page) {
  const heights = await page.evaluate(() => {
    const main = document.querySelector(".connected-main")!;
    const filler = document.createElement("div");
    filler.style.height = "2000px";
    const line = document.createElement("p");
    line.innerHTML = '<span class="connected-sr">opens in a new tab</span>';
    filler.append(line);
    line.style.marginTop = "1990px";
    main.append(filler);
    const result = { document: document.scrollingElement!.scrollHeight, window: innerHeight, pane: main.scrollHeight };
    filler.remove();
    return result;
  });
  expect.soft(heights.pane, "the filler is in the learning pane").toBeGreaterThan(2000);
  expect.soft(heights.document, "a long lesson made the page taller than the screen").toBeLessThanOrEqual(heights.window);
}

/** Scrolls to the end and checks the floating companion button covers none of the last content. */
async function buttonClearsContent(page: Page, where: string) {
  const trigger = page.locator(".connected-companion-trigger");
  if (!(await trigger.isVisible())) {
    // Desktop: the companion is a pane; collapse it so its floating button shows.
    await page.getByRole("button", { name: /^(Close companion|סגירת המלווה)$/ }).click();
    await expect(trigger).toBeVisible();
  }
  const overlap = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".connected-main")!;
    main.scrollTop = main.scrollHeight;
    window.scrollTo(0, document.scrollingElement!.scrollHeight);
    const button = document.querySelector(".connected-companion-trigger")!.getBoundingClientRect();
    // The last visible piece of content: the deepest last element with a size.
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[aria-hidden=true], .connected-sr");
    };
    let last: Element | null = null;
    for (const el of main.querySelectorAll("*")) if (visible(el) && !el.querySelector("*")) last = el;
    const r = last!.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.right, button.right) - Math.max(r.left, button.left));
    const y = Math.max(0, Math.min(r.bottom, button.bottom) - Math.max(r.top, button.top));
    return { area: x * y, last: (last!.textContent ?? "").slice(0, 40), lastBottom: Math.round(r.bottom), buttonTop: Math.round(button.top) };
  });
  expect(overlap.area, `${where}: the companion button covers "${overlap.last}" (${overlap.lastBottom} > ${overlap.buttonTop})`).toBe(0);
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: home, course and lesson fit the window, and the companion button never covers content`, async ({ page, request }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const labels = LABELS[locale];
    const token = (await (await request.post("/test/session")).json()).token;
    await page.goto(`/?locale=${locale}#signin=${token}`);
    const course = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) });
    await expect(course).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await fitsTheWindow(page, "home");

    await course.getByRole("button", { name: labels.open, exact: true }).click();
    await page.getByRole("button", { name: labels.start, exact: true }).click();
    const next = page.getByRole("button", { name: labels.next, exact: true });
    await expect(next).toBeVisible();
    await fitsTheWindow(page, "course page");
    if (await page.locator(".connected-host.is-compact").count()) {
      // The next step is a full-width button of ordinary height, not a tall square beside its text.
      const box = (await next.boundingBox())!;
      const card = (await page.locator(".connected-main").boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(60);
      expect(box.width, "the next-step button spans its card").toBeGreaterThan(card.width * 0.7);
    }
    await page.screenshot({ path: info.outputPath(`course-${locale}.png`) });

    await next.click();
    await expect(page.getByRole("heading", { name: labels.lesson, exact: true })).toBeVisible();
    await fitsTheWindow(page, "lesson");
    if (await page.locator(".connected-host.is-compact").count()) await longLessonStaysInItsPane(page);
    await buttonClearsContent(page, "lesson");
    await fitsTheWindow(page, "lesson after scrolling");
    await page.screenshot({ path: info.outputPath(`lesson-end-${locale}.png`) });
    expect(errors).toEqual([]);
  });
}
