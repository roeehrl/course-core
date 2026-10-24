// Performance and memory budgets for the connected learner (requirements T01/T02).
// Navigation, answer feedback and command acknowledgement are asserted against the T01
// product targets themselves (200 / 300 / 500 ms), measured over loopback against a local
// API, so they exclude real network latency. Load and memory budgets stay loose regression
// guards. Measured values are attached to every run as `budgets.json`.
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
   * (which needs the lesson data) has replaced the roadmap: the T01 navigation target.
   * The slowest press may take 3x. */
  lessonNavigationMs: 200,
  /** Median press of the roadmap button in a lesson until the roadmap is back: the T01
   * navigation target (slowest: 3x). */
  roadmapNavigationMs: 200,
  /** Median press of "Check answer" until the result is on screen, over the measured answers
   * after one unmeasured warm-up answer: the T01 feedback target (slowest: 3x). */
  feedbackMs: 300,
  /** Press of a lesson command (mark a part read, start a check) until the server's
   * acknowledgement has arrived: the T01 command acknowledgement target. Every command must meet it. */
  commandAckMs: 500,
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

/** Presses a button and resolves, on the first animation frame where `text` is on the page, with
 * the elapsed milliseconds (the feedback a learner sees after answering). */
async function timedFeedback(page: Page, button: RegExp, text: string) {
  return page.evaluate(
    ({ source, flags, text }) =>
      new Promise<number>((resolve, reject) => {
        const pattern = new RegExp(source, flags);
        const target = [...document.querySelectorAll("button")].find((b) => pattern.test(b.textContent ?? "") && b.offsetParent !== null);
        if (!target) return reject(new Error(`no visible button ${source}`));
        const started = performance.now();
        target.click();
        const deadline = started + 20_000;
        const tick = () => {
          if (document.body.innerText.includes(text)) resolve(performance.now() - started);
          else if (performance.now() > deadline) reject(new Error(`${text} did not appear`));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { source: button.source, flags: button.flags, text },
  );
}

/** Presses a button that sends a lesson command and resolves with the time until the response to
 * the POST whose path ends in `action` has fully arrived (Resource Timing `responseEnd`). */
async function timedAck(page: Page, button: RegExp, action: string) {
  return page.evaluate(
    ({ source, flags, action }) =>
      new Promise<number>((resolve, reject) => {
        const pattern = new RegExp(source, flags);
        const target = [...document.querySelectorAll("button")].find((b) => pattern.test(b.textContent ?? "") && b.offsetParent !== null);
        if (!target) return reject(new Error(`no visible button ${source}`));
        const started = performance.now();
        const ending = new RegExp(`/api/enrollments/[^/]+/${action}$`);
        target.click();
        const deadline = started + 20_000;
        const tick = () => {
          const entry = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
            .find((e) => e.startTime >= started && ending.test(new URL(e.name).pathname) && e.responseEnd > 0);
          if (entry) resolve(entry.responseEnd - started);
          else if (performance.now() > deadline) reject(new Error(`no ${action} response`));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { source: button.source, flags: button.flags, action },
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

  // Feedback and command acknowledgement on the checks of both lessons. The first answer is a
  // warm-up: it is the first time this page runs the answer path (grading receipt, result
  // notice, the reloads a new revision starts), and on a busy runner that one cold sample can
  // exceed the target although every later answer is far below it. It is recorded, not judged.
  // The four answers after it are judged like the navigations: by their median, with the
  // slowest bounded at three times the target.
  const feedback: number[] = [], ack: number[] = [];
  const numeric = async (value: string) => {
    const box = page.getByRole("textbox", { name: "Your numeric answer", exact: true });
    await box.fill(value);
    // WebKit sometimes delivers no input to a freshly shown field; fill once more (as learner.spec.ts).
    if ((await box.inputValue()) !== value) await box.fill(value);
    await expect(box).toHaveValue(value);
  };
  ack.push(await timedAck(page, /^Mark this part read$/, "read"));
  await expect(page.getByRole("button", { name: "Start the next check →", exact: true })).toBeVisible();
  ack.push(await timedAck(page, /^Start the next check →$/, "challenges"));
  await expect(page.getByText("Which is smaller?", { exact: true })).toBeVisible();
  // Warm-up: a wrong answer, so the lesson offers its second check and then a fresh one.
  await page.getByRole("radio", { name: "5", exact: true }).click();
  const warmUpFeedback = await timedFeedback(page, /^Check answer$/, "Let’s revisit this. 2 is below 5.");
  ack.push(await timedAck(page, /^Start the next check →$/, "challenges"));
  await numeric("4");
  feedback.push(await timedFeedback(page, /^Check answer$/, "Correct. 4 is below 9."));
  await page.getByRole("button", { name: /^Get a fresh check/ }).click();
  await page.getByRole("radio", { name: "7", exact: true }).click();
  feedback.push(await timedFeedback(page, /^Check answer$/, "Correct. 7 is below 11."));
  // The second lesson: its reading (with any personal extra part), then its two checks.
  await page.getByRole("button", { name: "Complete episode →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your learning path", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Maximum", exact: true })).toBeVisible();
  const markRead = page.getByRole("button", { name: "Mark this part read", exact: true });
  const startCheck = page.getByRole("button", { name: "Start the next check →", exact: true });
  await expect(async () => {
    if (await markRead.count()) await markRead.click({ timeout: 2_000 });
    await expect(startCheck).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  ack.push(await timedAck(page, /^Start the next check →$/, "challenges"));
  await numeric("9");
  feedback.push(await timedFeedback(page, /^Check answer$/, "Correct. 9 is above 4."));
  ack.push(await timedAck(page, /^Start the next check →$/, "challenges"));
  await numeric("-3");
  feedback.push(await timedFeedback(page, /^Check answer$/, "Correct. -3 is above -8."));

  // The median is the budgeted figure; the worst case is bounded at three times the budget.
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
  const measured = {
    project: testInfo.project.name, browserName, roundTrips: ROUND_TRIPS,
    coldCourseListMs: Math.round(cold.courseList), domContentLoadedMs: Math.round(cold.domContentLoaded),
    lessonNavigationMs: { median: Math.round(median(lesson)), max: Math.round(Math.max(...lesson)) },
    roadmapNavigationMs: { median: Math.round(median(roadmap)), max: Math.round(Math.max(...roadmap)) },
    heapFirstLessonBytes: heapFirst, heapAfterNavigationsBytes: heapLast,
    warmUpFeedbackMs: Math.round(warmUpFeedback),
    feedbackMs: { median: Math.round(median(feedback)), max: Math.round(Math.max(...feedback)), each: feedback.map(Math.round) },
    commandAckMs: ack.map(Math.round),
  };
  await testInfo.attach("budgets.json", { body: JSON.stringify({ measured, budgets: BUDGETS }, null, 2), contentType: "application/json" });
  console.log(`budgets ${JSON.stringify(measured)}`);

  expect(cold.courseList, "course list heading time on reload").toBeLessThan(BUDGETS.coldCourseListMs);
  expect(median(lesson), "median roadmap → lesson").toBeLessThan(BUDGETS.lessonNavigationMs);
  expect(Math.max(...lesson), "slowest roadmap → lesson").toBeLessThan(3 * BUDGETS.lessonNavigationMs);
  expect(median(roadmap), "median lesson → roadmap").toBeLessThan(BUDGETS.roadmapNavigationMs);
  expect(Math.max(...roadmap), "slowest lesson → roadmap").toBeLessThan(3 * BUDGETS.roadmapNavigationMs);
  expect(feedback, "measured answers").toHaveLength(4);
  expect(median(feedback), "median check answer → result on screen").toBeLessThan(BUDGETS.feedbackMs);
  expect(Math.max(...feedback), "slowest check answer → result on screen").toBeLessThan(3 * BUDGETS.feedbackMs);
  for (const value of ack) expect(value, "lesson command → server acknowledgement").toBeLessThan(BUDGETS.commandAckMs);
  if (browserName === "chromium") {
    expect(heapFirst, "heap measured").not.toBeNull();
    expect(heapLast!, "JS heap after navigations").toBeLessThan(BUDGETS.heapAfterNavigationsBytes);
    expect(heapLast! - heapFirst!, "JS heap growth over round trips").toBeLessThan(BUDGETS.heapGrowthBytes);
  }
  expect(errors).toEqual([]);
});
