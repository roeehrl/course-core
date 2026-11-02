import { expect, test, type Locator, type Page } from "@playwright/test";

/*
 * Steps the learner browser specs share (split from learner.spec.ts so each spec file can stand
 * alone): a scripted YouTube player, moving into the current or next lesson, filling an answer the
 * way a learner types it, and declining placement.
 */

/** Stands in for https://www.youtube.com/iframe_api: builds the iframe the real API
 * would build, then reports ready or the given player error. Never contacts YouTube. */
export async function fakeYouTubeApi(page: Page, errorCode?: number | "blocked") {
  const state = { loads: 0 };
  await page.route("https://www.youtube.com/iframe_api", (route) => {
    state.loads++;
    if (errorCode === "blocked") return route.abort();
    return route.fulfill({ contentType: "text/javascript", body: `
      window.YT = { Player: function (element, options) {
        var frame = document.createElement("iframe");
        frame.src = options.host + "/embed/" + options.videoId + "?enablejsapi=1&autoplay=" + options.playerVars.autoplay;
        element.replaceWith(frame);
        this.getIframe = function () { return frame; };
        this.destroy = function () { frame.remove(); };
        var self = this;
        setTimeout(function () { ${errorCode === undefined ? "options.events.onReady && options.events.onReady({ target: self });" : `options.events.onError({ target: self, data: ${errorCode} });`} }, 20);
      } };
      window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();` });
  });
  return state;
}

/** Opens the current lesson from wherever the signed-in page starts (library or roadmap). A press
 * was once lost in CI while the page was still settling after sign-in, and panels that load late
 * can shift the button mid-press, so the single "Continue learning" press each screen has is
 * retried. The loop waits for the open lesson itself, not for the roadmap in between: on a slow
 * page a retried press could pass the roadmap before it was seen, and then never find it (the same
 * race generated-content.spec.ts fixed). The lesson's heading is the mark, since not every lesson
 * view shows a reading part (a placement step, a closed course, the end-of-lesson check). */
export async function openCurrentLesson(page: Page) {
  const resume = page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ });
  const lesson = page.locator(".connected-lesson-keeper:not([hidden]) [data-reading-heading]");
  await expect(async () => {
    if (await lesson.isVisible()) return;
    if (await resume.count()) await resume.click({ timeout: 2_000 });
    await expect(lesson).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
/** From the visible roadmap, opens the next lesson. Panels that load after the
 * roadmap (placement, dates) can shift the button mid-press, so the press is
 * retried until the lesson has opened; it only navigates, never saves. */
export async function enterNextLesson(page: Page) {
  const resume = page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ });
  const roadmap = page.getByRole("heading", { name: "Your learning path", exact: true });
  await expect(roadmap).toBeVisible();
  await expect(async () => {
    if (await resume.count()) await resume.click({ timeout: 2_000 });
    await expect(roadmap).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
/** Types an answer and confirms the field kept it.
 *
 * Answers used to be lost on WebKit for an app reason: a slower, older progress
 * refresh (such as the placement panel's follow-up load) could replace a
 * just-issued check and remove the field mid-fill. Refreshes now apply in the
 * order they started ("a slower, older progress refresh..." below covers it).
 *
 * One WebKit automation artefact remains, about 1 in 100 runs of "failed code
 * recovers…" when the fill lands within milliseconds of a new code editor
 * mounting. The trace shows the same textarea, editable and never replaced; the
 * draft store gets no write for the check, so the app saw no input event; and the
 * caret sits collapsed at the end of the starter code instead of the range fill
 * selects. Adding passive capture listeners for focus/input events made it
 * disappear (0 in about 1,400 runs vs 2 in about 390 without). So retry only when
 * nothing arrived (the field still holds exactly what it held before), and only
 * once. A changed but wrong value still fails. */
export async function fillAnswer(box: Locator, value: string) {
  const before = await box.inputValue();
  await box.fill(value);
  if (before !== value && (await box.inputValue()) === before) {
    test.info().annotations.push({ type: "answer fill retried", description: "WebKit delivered no input to the field" });
    await box.fill(value);
  }
  await expect(box).toHaveValue(value);
}
/** Declines the optional placement offer and waits until the decline is
 * confirmed (the offer disappears), so the next press is not a second saved
 * request racing an unconfirmed one. */
export async function declinePlacement(page: Page) {
  await page
    .getByRole("region", { name: "Already know some of this?" })
    .getByRole("button", { name: "Start from the beginning" })
    .click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
}
// A failure in which the page itself stopped answering says so, and where it stopped.
