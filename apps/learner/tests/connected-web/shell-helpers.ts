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

/** Waits for the companion's own motion to end, so boxes are measured where they rest. */
export async function settled(locator: Locator) {
  await locator.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
}
