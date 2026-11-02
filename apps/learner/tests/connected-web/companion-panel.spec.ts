import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./health";
import { companion, lengthenLesson, openLesson, settled, trigger } from "./shell-helpers";

/*
 * The companion docked beside the lesson (final design §2.1, G8): a flush panel the learner widens
 * or narrows by its divider. The grip is always visible; a drag follows the pointer and pulls to
 * 400 and 560; a double click goes back to 400; the keyboard moves it as a WAI-ARIA window
 * splitter, arrows in screen direction (so ← narrows the left-hand panel in Hebrew); the width is
 * kept on this device; the line being read in the lesson stays where it was; the lesson keeps
 * 479 px at 840; and neither a drag nor opening the panel moves or redraws the lesson per frame.
 * These set their own window sizes: one desktop browser runs them (@desktop-window).
 */
const splitter = (page: Page) => page.getByRole("separator", { name: /^(Resize companion|שינוי רוחב המנחה)$/ });
const width = async (page: Page) => Math.round((await companion(page).boundingBox())!.width);

/** Where the character a third of the way down the lesson column is drawn now. */
async function readingLine(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector(".connected-main")!.getBoundingClientRect();
    const header = document.querySelector(".connected-header")!.getBoundingClientRect().bottom;
    const y = header + (innerHeight - header) / 3;
    const caret = document.caretRangeFromPoint(main.left + main.width / 2, y)!;
    (window as unknown as { __reading: Range }).__reading = caret;
    return { text: caret.startContainer.textContent?.slice(caret.startOffset, caret.startOffset + 12), top: caret.getBoundingClientRect().top };
  });
}
async function readingTop(page: Page) {
  return page.evaluate(() => {
    const caret = (window as unknown as { __reading: Range }).__reading;
    const range = document.createRange();
    range.setStart(caret.startContainer, caret.startOffset);
    range.setEnd(caret.startContainer, caret.startOffset + 1);
    return range.getClientRects()[0]!.top;
  });
}
/** Drags the divider by `dx` pixels with the mouse, in steps like a hand would. */
async function drag(page: Page, dx: number) {
  const box = (await splitter(page).boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(x + (dx * step) / 10, y);
  await page.mouse.up();
}

test("the panel's divider drags, snaps at 400 and 560, resets on a double click and is remembered", { tag: "@desktop-window" }, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLesson(page);
  await lengthenLesson(page);
  await expect(companion(page)).toHaveAttribute("data-placement", "docked");
  expect(await width(page)).toBe(400);
  // The grip is drawn without hovering: a 4 × 32 bar on the divider.
  const grip = await splitter(page).evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return { width: style.width, height: style.height, background: style.backgroundColor, content: style.content };
  });
  expect(grip).toMatchObject({ width: "4px", height: "32px", content: '""' });
  expect(grip.background).not.toBe("rgba(0, 0, 0, 0)");
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "400");
  await expect(splitter(page)).toHaveAttribute("aria-orientation", "vertical");
  await expect(splitter(page)).toHaveAttribute("aria-controls", "connected-learning");

  // The reading place, a third of the way down, a while into the lesson.
  await page.evaluate(() => window.scrollTo(0, 500));
  const before = await readingLine(page);
  // During a drag nothing in the lesson is changed; only the host's --panel-w moves.
  await page.evaluate(() => {
    const record = (window as unknown as { __mutations: number }).__mutations = 0;
    void record;
    new MutationObserver((list) => {
      (window as unknown as { __mutations: number }).__mutations += list.length;
    }).observe(document.querySelector(".connected-main")!, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  // 150 px toward the lesson makes 550: it pulls to 560.
  await drag(page, -150);
  await expect.poll(() => width(page)).toBe(560);
  expect(await page.evaluate(() => (window as unknown as { __mutations: number }).__mutations), "the lesson was not re-rendered").toBe(0);
  await expect(splitter(page)).toHaveAttribute("aria-valuenow", "560");
  expect(await page.evaluate(() => localStorage.getItem("course:learner-companion-width"))).toBe("560");
  // The lesson re-anchored its reading line on release.
  await expect.poll(async () => Math.abs((await readingTop(page)) - before.top), `"${before.text}" stays where it was`).toBeLessThanOrEqual(2);
  await page.screenshot({ path: info.outputPath("panel-560.png") });

  // Back 100 px: 460, between the snaps, kept as it is.
  await drag(page, 100);
  await expect.poll(() => width(page)).toBe(460);
  // 52 px more: 408 pulls to 400.
  await drag(page, 52);
  await expect.poll(() => width(page)).toBe(400);
  // Never under 360, never over min(720, W − 480).
  await drag(page, 300);
  await expect.poll(() => width(page)).toBe(360);
  await drag(page, -800);
  await expect.poll(() => width(page)).toBe(720);
  // A double click resets it.
  await splitter(page).dblclick();
  await expect.poll(() => width(page)).toBe(400);
  expect(await page.evaluate(() => localStorage.getItem("course:learner-companion-width"))).toBeNull();

  // Remembered on this device across a reload.
  await drag(page, -70);
  await expect.poll(() => width(page)).toBe(470);
  await page.reload();
  await expect(async () => {
    const resume = page.getByRole("button", { name: "Continue learning →", exact: true }).or(page.getByTestId("next-step").getByRole("button"));
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(page.getByRole("heading", { name: "Minimum", exact: true, level: 1 })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(companion(page)).toBeVisible();
  expect(await width(page)).toBe(470);

  // At 840 the panel is 360 and the lesson keeps 479 beside the divider.
  await page.setViewportSize({ width: 840, height: 900 });
  const scrollbar = await page.evaluate(() => innerWidth - document.documentElement.clientWidth);
  if (!scrollbar) {
    await expect.poll(() => width(page)).toBe(360);
    expect(Math.round((await page.locator(".connected-main").boundingBox())!.width)).toBeGreaterThanOrEqual(479);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("opening the panel sets the lesson's width in one step and animates only the panel (M9)", { tag: "@desktop-window" }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLesson(page);
  await expect(companion(page)).toBeVisible();
  await page.getByRole("button", { name: "Close companion", exact: true }).click();
  await expect(companion(page)).toBeHidden();
  // The lesson's width on every frame after the press: one change, at once, then still; the panel's
  // content moves, inside it, so the page never widens, and nothing fades (axe can run at any time).
  const seen = await page.evaluate(async () => {
    const main = document.querySelector(".connected-main")!;
    const aside = document.querySelector<HTMLElement>("#connected-companion")!;
    document.querySelector<HTMLButtonElement>(".connected-companion-trigger")!.click();
    const widths: number[] = [];
    let animations = "";
    for (let frame = 0; frame < 12; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      widths.push(Math.round(main.getBoundingClientRect().width));
      if (frame === 0) animations = `${getComputedStyle(aside).opacity} ${getComputedStyle(aside.querySelector(".cc-shell-body")!).animationName}`;
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth) animations += " wider";
    }
    return { widths, animations };
  });
  expect(new Set(seen.widths).size, `lesson widths per frame: ${seen.widths.join(", ")}`).toBe(1);
  expect(seen.animations).toBe("1 cc-shell-panel-in");
  await settled(companion(page));
});

test("the panel's content slides in for all of M9, and closing fades it out toward the inline end (M10)", { tag: "@desktop-window" }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLesson(page);
  await expect(companion(page)).toBeVisible();
  await page.getByRole("button", { name: "Close companion", exact: true }).click();
  await expect(companion(page)).toBeHidden();
  /** Presses `selector` and reads the panel `after` ms later, in the page (no round trip between). */
  const pressAndRead = (selector: string, after: number) =>
    page.evaluate(async ({ selector, after }) => {
      document.querySelector<HTMLElement>(selector)!.click();
      await new Promise((resolve) => setTimeout(resolve, after));
      const aside = document.querySelector<HTMLElement>("#connected-companion")!;
      return {
        hidden: aside.hidden,
        inert: aside.inert,
        ariaHidden: aside.getAttribute("aria-hidden"),
        entering: aside.dataset.entering === "true",
        opacity: Number(getComputedStyle(aside).opacity),
        shift: getComputedStyle(aside.querySelector(".cc-shell-body")!).transform,
      };
    }, { selector, after });
  // 150 ms into the 240 ms slide it still moves: a message fading in inside the panel (100 ms)
  // does not end it early.
  const opening = await pressAndRead(".connected-companion-trigger", 150);
  expect(opening.entering).toBe(true);
  expect(opening.shift).not.toBe("none");
  await settled(companion(page));
  // 60 ms into the 150 ms close it is still drawn, fading, its content moving toward the end.
  const closing = await pressAndRead('#connected-companion [aria-label="Close companion"]', 60);
  expect(closing.hidden).toBe(false);
  // Hidden from assistive technology while drawn, and out of the tab order with it (axe
  // aria-hidden-focus): nothing inside can be reached during the motion.
  expect(closing.ariaHidden).toBe("true");
  expect(closing.inert).toBe(true);
  expect(closing.opacity).toBeLessThan(1);
  expect(closing.opacity).toBeGreaterThan(0);
  expect(closing.shift).not.toBe("none");
  await expect(companion(page)).toBeHidden();
  await expect(page.locator("#connected-companion[data-leaving]")).toHaveCount(0);
  expect(await companion(page).evaluate((aside) => (aside as HTMLElement).inert)).toBe(false);
});

for (const locale of ["en", "he"] as const) {
  test(`${locale}: the splitter works from the keyboard, arrows in screen direction`, { tag: "@desktop-window" }, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openLesson(page, locale);
    await expect(companion(page)).toBeVisible();
    // RTL docks the panel on the left with the divider on its right.
    const panel = (await companion(page).boundingBox())!;
    const divider = (await splitter(page).boundingBox())!;
    if (locale === "he") expect(divider.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
    else expect(divider.x + divider.width).toBeLessThanOrEqual(panel.x + 1);
    await splitter(page).focus();
    // ← moves the divider left: a wider panel on the right, a narrower one on the left.
    await page.keyboard.press("ArrowLeft");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", locale === "he" ? "384" : "416");
    await page.keyboard.press("ArrowRight");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "400");
    await page.keyboard.press(locale === "he" ? "Shift+ArrowRight" : "Shift+ArrowLeft");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "464");
    expect(await width(page)).toBe(464);
    await page.keyboard.press("Home");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "360");
    await page.keyboard.press("End");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "720");
    await expect(splitter(page)).toHaveAttribute("aria-valuemax", "720");
    await page.keyboard.press("Enter");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "400");
    await page.keyboard.press("Enter");
    await expect(splitter(page)).toHaveAttribute("aria-valuenow", "560");
    expect(await width(page)).toBe(560);
    // The divider shows its focus.
    expect(await splitter(page).evaluate((element) => getComputedStyle(element, "::after").outlineStyle)).toBe("solid");
    // The header: title, About, Expand, Close; its hairline only once the companion is scrolled.
    const header = companion(page).locator(".cc-shell-header");
    expect(await header.evaluate((element) => getComputedStyle(element).borderBottomColor)).toBe("rgba(0, 0, 0, 0)");
    await page.screenshot({ path: info.outputPath(`panel-keyboard-${locale}.png`) });
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  });
}

test("the trigger stays in the header, pressed while the panel shows, and its About popover leads to the learner's data", { tag: "@desktop-window" }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLesson(page);
  await expect(companion(page)).toBeVisible();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  await expect(trigger(page)).toHaveAttribute("title", "Close companion");
  expect(await trigger(page).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(232, 246, 237)");
  const about = companion(page).getByRole("button", { name: "About your companion", exact: true });
  await about.click();
  const popover = page.getByRole("dialog", { name: "About your companion" });
  await expect(popover).toContainText("Your companion sees this lesson and your answers here.");
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(about).toBeFocused();
  // Esc inside the popover closed only the popover.
  await expect(companion(page)).toBeVisible();
  await about.click();
  await popover.getByRole("button", { name: "Your data and choices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Personal lesson support", exact: true })).toBeVisible();
  await trigger(page).click();
  await expect(companion(page)).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await expect(trigger(page)).toBeFocused();
});
