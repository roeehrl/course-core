import { expect, test, type Page } from "./health";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enRoadmap from "../../src/i18n/messages/en/courseRoadmap.json";
import heRoadmap from "../../src/i18n/messages/he/courseRoadmap.json";
import enLesson from "../../src/i18n/messages/en/connectedLesson.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";

// The result of "Check answer" shows in the check, beside the answer just given, and is in the
// window afterwards at every size (on a phone the notice above the lesson was out of sight); it is
// announced through a live region that was already on the page. The sticky answer bar is opaque,
// so lesson text scrolling under it never shows through.
const text = {
  en: { host: enHost, preview: enPreview, roadmap: enRoadmap, lesson: enLesson },
  he: { host: heHost, preview: hePreview, roadmap: heRoadmap, lesson: heLesson },
} as const;
type Locale = keyof typeof text;

async function openCheck(page: Page, locale: Locale) {
  const t = text[locale];
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: t.host["library.open"], exact: true })
    .click();
  await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  await page.getByRole("button", { name: t.roadmap.continue, exact: true }).click();
  await page.getByRole("button", { name: t.lesson.markRead, exact: true }).click();
  await page.getByRole("button", { name: t.lesson["check.start"], exact: true }).click();
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeVisible();
}

for (const locale of ["en", "he"] as const) {
  test(`the result of Check answer is in the window beside the check and announced (${locale})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openCheck(page, locale);
    // The live region is on the page, empty, before the answer is sent.
    const region = page.locator(".connected-check .connected-answer-feedback");
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).toHaveText("");
    await page.getByRole("radio", { name: "2", exact: true }).click();
    const check = page.getByRole("button", { name: text[locale].lesson["answer.check"], exact: true });
    // The learner is at the answer actions, as after reading the question to its end.
    await check.scrollIntoViewIfNeeded();
    await check.click();
    await expect(region).toContainText("2 is below 5.");
    await expect(region).toBeInViewport({ ratio: 1 });
    // It is not also shown above the lesson.
    await expect(page.getByText(/2 is below 5\./)).toHaveCount(1);
    // The check's heading, right above it, is in view too and has focus.
    await expect(page.locator("#connected-check-title")).toBeFocused();
    await expect(page.locator("#connected-check-title")).toBeInViewport();
    // Starting the next check clears it, and the next result fills the same region.
    await page.getByRole("button", { name: text[locale].lesson["check.start"], exact: true }).click();
    await expect(region).toHaveText("");
    expect(errors).toEqual([]);
  });
}

test("the sticky answer bar is opaque: lesson text under it never shows through", async ({ page }) => {
  await openCheck(page, "en");
  const bar = page.locator(".connected-answer-actions");
  await expect(bar).toBeVisible();
  const style = await bar.evaluate((el) => {
    const s = getComputedStyle(el);
    return { position: s.position, background: s.backgroundColor, opacity: s.opacity };
  });
  expect(style.position).toBe("sticky");
  expect(style.opacity).toBe("1");
  // rgb(...) is opaque; rgba(..., a) and color(... / a) carry an alpha below 1.
  expect(style.background).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  // Scroll the question's prompt under the stuck bar: the bar, not the prompt, is on top there.
  const prompt = page.getByText("Which is smaller?", { exact: true });
  const covered = await prompt.evaluate(async (el) => {
    const bar = document.querySelector<HTMLElement>(".connected-answer-actions")!;
    const main = document.querySelector<HTMLElement>(".connected-main");
    const scroller = main && main.scrollHeight > main.clientHeight + 1 && getComputedStyle(main).overflowY !== "visible" ? main : null;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let i = 0; i < 3; i++) {
      const bottom = scroller ? Math.min(scroller.getBoundingClientRect().bottom, innerHeight) : innerHeight;
      const barTop = bar.getBoundingClientRect().top;
      const delta = el.getBoundingClientRect().top - (barTop < bottom ? barTop + 8 : bottom - 60);
      if (scroller) scroller.scrollBy(0, delta);
      else window.scrollBy(0, delta);
      await frame();
    }
    const a = el.getBoundingClientRect(), b = bar.getBoundingClientRect();
    const y = Math.max(a.top, b.top) + 2, x = a.left + Math.min(a.width, 40) / 2;
    const hit = document.elementFromPoint(x, y);
    return { overlap: a.bottom > b.top && a.top < b.bottom, onBar: Boolean(hit && bar.contains(hit)) };
  });
  expect(covered).toEqual({ overlap: true, onBar: true });
});
