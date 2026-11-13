import { expect, type Locator, type Page } from "@playwright/test";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";

/* Shared steps of the companion shell's own specs (companion-panel, -sheet, -focus-view,
 * -shortcut): a learner in the synthetic "Ordering values" lesson, a lesson long enough to scroll,
 * and the companion's region and trigger. */
type Locale = "en" | "he";
const text = { en: { host: enHost, preview: enPreview }, he: { host: heHost, preview: hePreview } } as const;

/** Signs a new learner in and opens the first lesson ("Minimum"). */
export async function openLesson(page: Page, locale: Locale = "en") {
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: text[locale].host["library.open"], exact: true }).click();
  await page.getByRole("button", { name: text[locale].preview.start, exact: true }).click();
  await page.getByTestId("next-step").getByRole("button").click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
}

/** Adds paragraphs of reflowing text after the lesson's heading, as a real lesson has, so the page
 * scrolls and a width change rewraps its lines. The layout under test does not depend on the words. */
export async function lengthenLesson(page: Page, paragraphs = 24) {
  await page.evaluate((count) => {
    const main = document.querySelector(".connected-main")!;
    const box = Object.assign(document.createElement("div"), { className: "test-filler" });
    for (let i = 0; i < count; i++) {
      const p = document.createElement("p");
      p.textContent = `Paragraph ${i + 1}. To find the smaller of two values, compare them on the number line: the value further to the left is the smaller one, and the minimum of a list is no greater than any other member of it.`;
      p.style.margin = "0 0 16px";
      box.append(p);
    }
    main.append(box);
  }, paragraphs);
}

/** The companion's region (whatever its placement) and the trigger in the header. */
export const companion = (page: Page): Locator => page.locator("#connected-companion");
export const trigger = (page: Page): Locator => page.locator(".connected-header .connected-companion-trigger");

/** The companion as one drawn frame showed it, `at` ms after a press (see `pressAndWatch`). */
export type CompanionFrame = {
  at: number;
  hidden: boolean;
  inert: boolean;
  ariaHidden: string | null;
  entering: boolean;
  opacity: number;
  /** The region's own vertical translation in px (a sheet sliding). */
  shift: number;
  /** The transform of the region's body (the panel's content moving). */
  body: string;
};

/**
 * Presses `selector` and reads the companion on every frame drawn after it, in the page (no round
 * trip between), until a frame with none of its motion still running, or `limit` ms. This is what
 * the learner sees frame by frame, however late a loaded machine draws them: a motion starts on the
 * first frame drawn after it is asked for, so a read on a timer can land before that frame and see
 * the region not yet moved (WebKit on a busy CI runner can draw nothing for over 100 ms).
 */
export async function pressAndWatch(page: Page, selector: string, limit = 2000): Promise<CompanionFrame[]> {
  return page.evaluate(async ({ selector, limit }) => {
    const aside = document.querySelector<HTMLElement>("#connected-companion")!;
    const body = aside.querySelector(".cc-shell-body");
    const start = performance.now();
    const frames: CompanionFrame[] = [];
    document.querySelector<HTMLElement>(selector)!.click();
    while (performance.now() - start < limit) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const style = getComputedStyle(aside);
      frames.push({
        at: Math.round(performance.now() - start),
        hidden: aside.hidden === true,
        inert: aside.inert,
        ariaHidden: aside.getAttribute("aria-hidden"),
        entering: aside.dataset.entering === "true",
        opacity: Number(style.opacity),
        shift: style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m42,
        body: body ? getComputedStyle(body).transform : "none",
      });
      if (!aside.getAnimations({ subtree: true }).some((animation) => animation.playState === "running")) break;
    }
    return frames;
  }, { selector, limit });
}

/** Waits for the companion's own motion to end, so boxes are measured where they rest. */
export async function settled(locator: Locator) {
  await locator.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}
