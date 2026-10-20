// Performance and memory budgets for the connected learner (requirements T01/T02).
// These are regression guards on the CI runner, not proof of the product targets:
// each budget is several times the value measured locally and on CI, so a pass means
// "no gross regression", and a failure means something became markedly slower or
// started leaking. Measured values are attached to every run as `budgets.json`.
// The thresholds and the measurements behind them are documented in docs/performance-budgets.md.
// Heap figures need the Chrome DevTools Protocol, so they are asserted on Chromium only;
// the timing budgets also run on WebKit and Firefox through playwright.engines.config.ts.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const BUDGETS = {
  /** Full reload of the signed-in course list (navigation start) until the course
   * card's heading, which needs the API's course list, is in the DOM. */
  coldCourseListMs: 3_000,
  /** Median press of "Continue learning →" on the roadmap until the lesson heading
   * (which needs the lesson data) has replaced the roadmap. The slowest press may take 3x. */
  lessonNavigationMs: 500,
  /** Median press of the roadmap button in a lesson until the roadmap is back (slowest: 3x). */
  roadmapNavigationMs: 500,
  /** Chromium JS heap in use after a forced garbage collection, after all navigations. */
  heapAfterNavigationsBytes: 64 * 1024 * 1024,
  /** Growth of that heap between the first lesson and the end of the round trips. */
  heapGrowthBytes: 8 * 1024 * 1024,
};
const ROUND_TRIPS = 12;

/** Presses a button chosen by its accessible text inside the page and resolves, on the
 * first animation frame where `done` holds, with the elapsed milliseconds. Measuring in
 * the page keeps Playwright's own polling out of the number. */
async function timedPress(page: Page, button: RegExp, done: "lesson" | "roadmap") {
  return page.evaluate(
    ({ source, flags, done }) =>
      new Promise<number>((resolve, reject) => {
        const pattern = new RegExp(source, flags);
        const target = [...document.querySelectorAll("button")].find((b) => pattern.test(b.textContent ?? "") && b.offsetParent !== null);
        if (!target) return reject(new Error(`no visible button ${source}`));
        const roadmapShown = () => [...document.querySelectorAll("h1,h2,h3")].some((h) => h.textContent?.trim() === "Your learning path");
        // The fixture course's first lesson; its heading needs the lesson data, not just the shell.
        const lessonShown = () => !roadmapShown() && [...document.querySelectorAll("h1,h2,h3")].some((h) => h.textContent?.trim() === "Minimum");
        const check = done === "lesson" ? lessonShown : roadmapShown;
        const started = performance.now();
        target.click();
        const deadline = started + 20_000;
        const tick = () => {
          if (check()) resolve(performance.now() - started);
          else if (performance.now() > deadline) reject(new Error(`${done} did not appear`));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { source: button.source, flags: button.flags, done },
  );
}

test("the connected learner stays within its load, navigation and memory budgets", async ({ page, request, browserName }, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Records when the course list heading first enters the DOM on every document load.
  await page.addInitScript(() => {
    const w = window as unknown as { __courseListAt?: number };
    // The fixture course's card heading: it needs the signed-in course list from the API, not just the shell.
    const seen = () => [...document.querySelectorAll("h1,h2,h3")].some((h) => h.textContent?.trim() === "Ordering values");
    new MutationObserver((_, observer) => {
      if (w.__courseListAt === undefined && seen()) { w.__courseListAt = performance.now(); observer.disconnect(); }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await expect(page.getByRole("heading", { name: "Your courses", exact: true })).toBeVisible();

  // Cold load: a full reload of the signed-in course list (no warm JS state; HTTP cache as a returning learner has it).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your courses", exact: true })).toBeVisible();
  const cold = await page.evaluate(() => ({
    courseList: (window as unknown as { __courseListAt?: number }).__courseListAt ?? Number.NaN,
    domContentLoaded: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.domContentLoadedEventEnd ?? Number.NaN,
  }));

  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your learning path", exact: true })).toBeVisible();
  // The press below is a DOM click, so panels that load late and shift the button cannot make it miss.
  await expect(page.getByRole("button", { name: "Continue learning →", exact: true })).toBeVisible();

  const heap = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
  const heapUsed = async () => {
    if (!heap) return null;
    await heap.send("HeapProfiler.collectGarbage");
    const { metrics } = await heap.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? null;
  };
  await heap?.send("Performance.enable");

  const lesson: number[] = [], roadmap: number[] = [];
  lesson.push(await timedPress(page, /^Continue learning →$/, "lesson"));
  await expect(page.getByRole("button", { name: /Course roadmap/ })).toBeVisible();
  const heapFirst = await heapUsed();
  for (let i = 0; i < ROUND_TRIPS; i++) {
    roadmap.push(await timedPress(page, /Course roadmap/, "roadmap"));
    await expect(page.getByRole("button", { name: "Continue learning →", exact: true })).toBeVisible();
    lesson.push(await timedPress(page, /^Continue learning →$/, "lesson"));
    await expect(page.getByRole("button", { name: /Course roadmap/ })).toBeVisible();
  }
  const heapLast = await heapUsed();

  // The median is the budgeted figure; the worst case is bounded at three times the budget.
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
  const measured = {
    project: testInfo.project.name, browserName, roundTrips: ROUND_TRIPS,
    coldCourseListMs: Math.round(cold.courseList), domContentLoadedMs: Math.round(cold.domContentLoaded),
    lessonNavigationMs: { median: Math.round(median(lesson)), max: Math.round(Math.max(...lesson)) },
    roadmapNavigationMs: { median: Math.round(median(roadmap)), max: Math.round(Math.max(...roadmap)) },
    heapFirstLessonBytes: heapFirst, heapAfterNavigationsBytes: heapLast,
  };
  await testInfo.attach("budgets.json", { body: JSON.stringify({ measured, budgets: BUDGETS }, null, 2), contentType: "application/json" });
  console.log(`budgets ${JSON.stringify(measured)}`);

  expect(cold.courseList, "course list heading time on reload").toBeLessThan(BUDGETS.coldCourseListMs);
  expect(median(lesson), "median roadmap → lesson").toBeLessThan(BUDGETS.lessonNavigationMs);
  expect(Math.max(...lesson), "slowest roadmap → lesson").toBeLessThan(3 * BUDGETS.lessonNavigationMs);
  expect(median(roadmap), "median lesson → roadmap").toBeLessThan(BUDGETS.roadmapNavigationMs);
  expect(Math.max(...roadmap), "slowest lesson → roadmap").toBeLessThan(3 * BUDGETS.roadmapNavigationMs);
  if (browserName === "chromium") {
    expect(heapFirst, "heap measured").not.toBeNull();
    expect(heapLast!, "JS heap after navigations").toBeLessThan(BUDGETS.heapAfterNavigationsBytes);
    expect(heapLast! - heapFirst!, "JS heap growth over round trips").toBeLessThan(BUDGETS.heapGrowthBytes);
  }
  expect(errors).toEqual([]);
});
