import { expect, test } from "@playwright/test";
import { chooseFromMenu } from "./learner-menu.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";

/** Opens the course from the course list, then its current lesson. A press was
 * once lost in CI while the page was still settling after sign-in,
 * so each press is retried until the page has changed. */
/** Stands in for https://www.youtube.com/iframe_api: builds the iframe the real API
 * would build, then reports ready or the given player error. Never contacts YouTube. */
async function fakeYouTubeApi(page: Page, errorCode?: number | "blocked") {
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

async function openCurrentLesson(page: Page) {
  const resume = page.getByRole("button", { name: "Continue learning →", exact: true });
  const roadmap = page.getByRole("heading", { name: "Your learning path", exact: true });
  await expect(async () => {
    if (!(await roadmap.count())) await resume.click({ timeout: 2_000 });
    await expect(roadmap).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await enterNextLesson(page);
}
/** From the visible roadmap, opens the next lesson. Panels that load after the
 * roadmap (placement, dates) can shift the button mid-press, so the press is
 * retried until the lesson has opened; it only navigates, never saves. */
async function enterNextLesson(page: Page) {
  const resume = page.getByRole("button", { name: "Continue learning →", exact: true });
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
async function fillAnswer(box: Locator, value: string) {
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
async function declinePlacement(page: Page) {
  await page
    .getByRole("region", { name: "Already know some of this?" })
    .getByRole("button", { name: "Start from the beginning" })
    .click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
}
test("compact companion reserves space without covering reading or activity, including short landscape windows", async ({
  page,
  request,
}, info) => {
  const session = await request.post("/test/model-session", {
    data: { generated: true, repair: true },
  });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  const checkGeometry = async () => {
    const pane = await page
      .getByRole("main", { name: "Learning content" })
      .boundingBox();
    const companion = await page
      .getByRole("button", { name: "Companion", exact: true })
      .boundingBox();
    expect(pane).not.toBeNull();
    expect(companion).not.toBeNull();
    expect(pane!.y + pane!.height).toBeLessThanOrEqual(companion!.y);
    expect(companion!.y + companion!.height).toBeLessThanOrEqual(
      await page.evaluate(() => innerHeight),
    );
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  };
  // Force a compact window on the desktop project too, then test a short wide
  // landscape window where width-only CSS would otherwise leave the old overlay.
  await page.setViewportSize({ width: 390, height: 844 });
  // Layout settles after a resize; wait for it rather than sampling one frame.
  await expect(checkGeometry).toPass({ timeout: 10_000 });
  const read = page.getByRole("button", {
    name: "Mark this part read",
    exact: true,
  });
  await read.scrollIntoViewIfNeeded();
  expect(
    await read.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await read.click();
  await chooseFromMenu(page, "Learning record");
  const rejected = page.getByText(
    "Draft rejected by reference checks · revision needed",
    { exact: true },
  );
  await rejected.scrollIntoViewIfNeeded();
  // Layout settles after a resize; wait for it rather than sampling one frame.
  await expect(checkGeometry).toPass({ timeout: 10_000 });
  expect(
    await rejected.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 500 });
  // Layout settles after a resize; wait for it rather than sampling one frame.
  await expect(checkGeometry).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Your companion" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(
    page.getByRole("button", { name: "Companion", exact: true }),
  ).toBeFocused();
  // 599 px is the widest compact window (see windowClass); 600 and up keep the
  // companion beside the lesson instead.
  await page.setViewportSize({ width: 599, height: 1112 });
  // Layout settles after a resize; wait for it rather than sampling one frame.
  await expect(checkGeometry).toPass({ timeout: 10_000 });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  if (info.project.use.viewport)
    await page.setViewportSize(info.project.use.viewport);
  await rejected.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("reserved-companion-layout.png"),
    fullPage: true,
  });
});
test("independently verified new teaching is visible on the linear lesson and survives reload without granting mastery", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request.post("/test/model-session", {
    data: { generated: true },
  });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await expect(
    page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await openCurrentLesson(page);
  await expect(
    page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("verified-generated-teaching.png"),
    fullPage: true,
  });
  // A required personal change is explained but cannot be hidden, in the UI or the API.
  await chooseFromMenu(page, "My profile");
  const changes = page.getByRole("region", { name: "Your personal changes" });
  await expect(changes.getByText("Required for your path. Ask your companion or course team if you disagree.")).toBeVisible();
  await expect(changes.getByRole("button", { name: /this addition/ })).toHaveCount(0);
  const id = (await (await page.request.get("/api/enrollments")).json())[0].id;
  const listed = (await (await page.request.get(`/api/enrollments/${id}/personal-changes`)).json()).changes[0];
  const snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  const csrf = (await page.context().cookies()).find((c) => c.name === "course_csrf")!.value;
  const refused = await page.request.post(`/api/enrollments/${id}/personal-changes/visibility`, {
    headers: { origin: new URL(page.url()).origin, "x-csrf-token": csrf },
    data: { expectedRevision: snapshot.revision, idempotencyKey: "hide-required-" + id, episodeId: listed.episodeId, blockId: listed.blockId, hidden: true },
  });
  expect((await refused.json()).error).toBe("CHANGE_NOT_HIDEABLE");
});
test("rejected teaching is repaired and its optional activity record distinguishes feedback from delivery", async ({
  page,
  request,
}, info) => {
  const session = await request.post("/test/model-session", {
    data: { generated: true, repair: true },
  });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await expect(
    page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Minimum of [31, -14, 9] is 9.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await chooseFromMenu(page, "Learning record");
  await expect(
    page.getByText("Draft rejected by reference checks · revision needed", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Another option was selected for your lesson", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Added to your lesson · plan 1", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Minimum of [31, -14, 9] is 9.", { exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("bounded-teaching-repair.png"),
    fullPage: true,
  });
});

test("supervisor preference proposal is corrected and disputed by its learner through the real UI without credit", async ({
  page,
  request,
}, info) => {
  const session = await request.post("/test/model-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await chooseFromMenu(page, "My profile");
  await expect(
    page.getByText("Awaiting your review", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Suggested explanation: Step by step", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Correct suggestion", exact: true })
    .click();
  await page
    .getByRole("radiogroup", { name: "Corrected suggestion", exact: true })
    .getByRole("radio", { name: "Worked examples", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(
    page.getByText("Corrected by you", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await chooseFromMenu(page, "My profile");
  await expect(
    page.getByText("Suggested explanation: Worked examples", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Dispute suggestion", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm dispute", exact: true })
    .click();
  await expect(
    page.getByText("Disputed · excluded from AI context", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Suggested explanation: Worked examples", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("supervisor-model-review.png"),
    fullPage: true,
  });
});

test("failed code recovers with a reviewed contract, real isolated grading and unchanged mastery", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signed = await request.post("/test/code-session");
  expect(signed.ok()).toBe(true);
  await page.goto(`/#signin=${(await signed.json()).token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await enterNextLesson(page);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your numeric answer", exact: true }),
    "4",
  );
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your code", exact: true }),
    "def solve(values):\n    return max(values)\n",
  );
  await page
    .getByRole("button", { name: "Run code & check", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Get a fresh check · 2 min →",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Get a fresh check · 2 min →", exact: true })
    .click();
  await expect(
    page.getByText(
      "Implement solve(values), returning the zero-based index of the first minimum in a nonempty list. Ties select the first position.",
      { exact: true },
    ),
  ).toBeVisible();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your code", exact: true }),
    "def solve(values):\n    return values.index(min(values))\n",
  );
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("fresh-code.png"),
    fullPage: true,
  });
  await page.reload();
  await openCurrentLesson(page);
  await expect(
    page.getByRole("textbox", { name: "Your code", exact: true }),
  ).toHaveValue("def solve(values):\n    return values.index(min(values))\n");
  await page
    .getByRole("button", { name: "Run code & check", exact: true })
    .click();
  await expect(
    page.getByText("Your independent checks are complete.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Complete episode →", exact: true })
    .click();
  await expect(
    page.getByText("1 completed / 2", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("wrong first answer recovers through a fresh qualified family check without lowering mastery standards", async ({
  page,
  request,
}) => {
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await enterNextLesson(page);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page.getByRole("radio", { name: "5", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your numeric answer", exact: true }),
    "4",
  );
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Get a fresh check · 2 min →", exact: true })
    .click();
  await expect(
    page.getByText("Which value is smaller: 7 or 11?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await page.getByRole("radio", { name: "7", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByText("Your independent checks are complete.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Complete episode →", exact: true })
    .click();
  await expect(
    page.getByText("1 completed / 2", { exact: true }),
  ).toBeVisible();
});

test("signed-in lesson, independent evidence, reload, server gate and account isolation", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await expect(
    page.getByRole("heading", { name: "Your courses", exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain("signin=");
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ordering values", exact: true }),
  ).toBeVisible();
  await enterNextLesson(page);
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  // Exercise the actual connected memory screen, including persistence and the
  // distinction between self-report and independently demonstrated knowledge.
  await chooseFromMenu(page, "My profile");
  await expect(
    page.getByRole("heading", {
      name: "A profile you can shape.",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "My learning goal", exact: true })
    .fill("Understand ordering without guessing.");
  await page
    .getByRole("textbox", { name: "My thoughts about learning", exact: true })
    .fill("Worked examples help me identify mistakes.");
  await page
    .getByRole("button", { name: "Save my profile", exact: true })
    .click();
  await expect(
    page.getByText("Saved self-report", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.reload();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await chooseFromMenu(page, "My profile");
  await expect(
    page.getByRole("textbox", { name: "My learning goal", exact: true }),
  ).toHaveValue("Understand ordering without guessing.");
  await expect(
    page.getByRole("textbox", {
      name: "My thoughts about learning",
      exact: true,
    }),
  ).toHaveValue("Worked examples help me identify mistakes.");
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "← Back to learning", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("connected-lesson.png"),
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await expect(
    page.getByText("Which is smaller?", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openCurrentLesson(page);
  await expect(
    page.getByText("Which is smaller?", { exact: true }),
  ).toBeVisible();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByText("Correct. 2 is below 5.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your numeric answer", exact: true }),
    "4",
  );
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByText("Your independent checks are complete.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Complete episode →", exact: true })
    .click();
  await expect(
    page.getByText("1 completed / 2", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Maximum", exact: true }),
  ).toBeVisible();
  await expect(page.locator("svg").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("connected-visual.png"),
    fullPage: true,
  });
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  await page
    .getByRole("textbox", { name: "Message to your companion", exact: true })
    .fill("Explain the current illustration settings.");
  const sent = page.waitForRequest(
    (r) =>
      r.method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"),
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const capsule = (await sent).postDataJSON();
  expect(capsule.interactiveContext).toMatchObject({
    schemaVersion: 1,
    episodeId: "max",
    blockId: "max-visual",
    timeMs: 0,
  });
  expect(capsule.interactiveContext).not.toHaveProperty("nodes");
  await expect(
    page.getByText("Explain the current illustration settings.", {
      exact: true,
    }),
  ).toBeVisible();
  // Docked on wide desktop layouts; an overlay that must be closed elsewhere.
  if (!testInfo.project.name.endsWith("desktop"))
    await page
      .getByRole("button", { name: "Close companion", exact: true })
      .click();
  await chooseFromMenu(page, "Sign out");
  await expect(
    page.getByRole("heading", {
      name: "Pick up where you left off.",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => (await fetch("/api/enrollments")).status),
  ).toBe(401);
  expect(errors).toEqual([]);
});

test("reviewed research resources are optional in-lesson help that never records progress", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Never contact YouTube from the test; the player request is asserted, then aborted.
  const players: string[] = [];
  await page.route("https://www.youtube-nocookie.com/**", (route) => {
    players.push(route.request().url());
    return route.abort();
  });
  const api = await fakeYouTubeApi(page);
  const signIn = await request.post("/test/research-session");
  expect(signIn.ok()).toBeTruthy();
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await enterNextLesson(page);
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  const progressText = page.getByText(/of \d+ parts read/);
  const before = await progressText.textContent();
  const help = page.getByText("2 reviewed resources for this episode");
  await expect(help).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await help.click();
  await expect(page.getByText(/does not count toward progress/)).toBeVisible();
  await expect(
    page.getByText(
      "The walkthrough keeps the smaller value after each comparison and then checks it against every element.",
    ),
  ).toBeVisible();
  expect(players).toEqual([]);
  expect(api.loads).toBe(0);
  await page.getByRole("button", { name: /Load video player/ }).click();
  // The official IFrame Player API builds the privacy-enhanced embed.
  await expect(page.locator("iframe")).toHaveAttribute("src", /^https:\/\/www\.youtube-nocookie\.com\/embed\/aqz-KE-bpKQ\?/);
  await expect(page.locator("iframe")).toHaveAttribute("title", "Minimum walkthrough");
  expect(api.loads).toBe(1);
  await expect
    .poll(() => players.length)
    .toBeGreaterThan(0);
  expect(players.every((url) => url.startsWith("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"))).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .exclude("iframe")
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("research-resources.png"), fullPage: true });
  // Opening and loading help changed nothing on the authoritative path.
  await page.reload();
  await openCurrentLesson(page);
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  await expect(progressText).toHaveText(before!);
  await expect(page.getByText("2 reviewed resources for this episode")).toBeVisible();
  expect(errors).toEqual([]);
});

test("an unavailable or blocked YouTube video becomes a written route without leaving the step (F08)", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://www.youtube-nocookie.com/**", (route) => route.abort());
  for (const [failure, message] of [[150, /does not allow it to play on other sites/], ["blocked", /player could not load/]] as const) {
    await page.unroute("https://www.youtube.com/iframe_api");
    await fakeYouTubeApi(page, failure);
    const signIn = await request.post("/test/research-session");
    await page.goto(`/#signin=${(await signIn.json()).token}`);
    await page.getByRole("button", { name: "Open course", exact: true }).click();
    await page.getByRole("button", { name: "Start course", exact: true }).click();
    await enterNextLesson(page);
    await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
    const progressText = page.getByText(/of \d+ parts read/);
    const before = await progressText.textContent();
    await page.getByText("2 reviewed resources for this episode").click();
    await page.getByRole("button", { name: /Load video player/ }).click();
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByText("This video can’t play here.")).toBeVisible();
    await expect(page.getByRole("link", { name: /open the video on YouTube/ })).toHaveAttribute("href", "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    await expect(page.getByText("The walkthrough keeps the smaller value after each comparison and then checks it against every element.")).toBeVisible();
    // The pending step is unchanged and still actionable.
    await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
    await expect(progressText).toHaveText(before!);
    await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.context().clearCookies();
    await page.goto("about:blank");
  }
  expect(errors).toEqual([]);
});

test("approved course-made video is optional help with captions and a transcript; unreviewed clips never appear", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = await request.post("/test/media-session");
  expect(signIn.ok()).toBeTruthy();
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  // The fixture enrolled through the API; the learner resumes into the current lesson.
  await openCurrentLesson(page);
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const progressText = page.getByText(/of \d+ parts read/);
  const before = await progressText.textContent();
  const help = page.getByText("1 reviewed resource for this episode");
  await expect(help).toBeVisible();
  await help.click();
  await expect(page.getByRole("heading", { name: "Running minimum in motion" })).toBeVisible();
  await expect(page.getByText("Unreviewed draft clip")).toHaveCount(0);
  await expect(page.getByText(/Course-made video/)).toBeVisible();
  await expect(page.getByText("The running minimum keeps the smaller value after each comparison in the list.")).toBeVisible();
  await expect(page.getByText(/highlight moves left to right/)).toBeVisible();
  const video = page.locator("video");
  await expect(video).toHaveAttribute("preload", "none");
  await expect(video.locator("track[kind=captions]")).toHaveAttribute("src", /\/media\/[0-9a-f-]+\/captions\.vtt$/);
  const captions = await page.request.get((await video.locator("track").getAttribute("src"))!);
  expect(captions.headers()["content-type"]).toContain("text/vtt");
  expect(await captions.text()).toContain("WEBVTT");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("generated-media.png"), fullPage: true });
  await page.reload();
  await openCurrentLesson(page);
  await expect(progressText).toHaveText(before!);
  expect(errors).toEqual([]);
});

test("a learner downloads their data and then erases this course's learning data", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await enterNextLesson(page);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  // The read is committed (the next part is offered) before the profile opens, so
  // its revision refresh cannot reload the profile panels underneath the click.
  await expect(page.getByRole("button", { name: "Start the next check →", exact: true })).toBeVisible();
  await chooseFromMenu(page, "My profile");
  const panel = page.getByRole("region", { name: "Your data" });
  await expect(panel).toBeVisible();
  // The supervision, learning-memory and personal-changes panels above "Your data"
  // load after it mounts and grow by hundreds of pixels. A click while they settle
  // can press the button and release over whatever moved under the pointer, so no
  // click (and no download) happens. Wait until the panels above have rendered.
  await expect(page.getByLabel("Loading supervisor information")).toHaveCount(0);
  await expect(page.getByLabel("Loading learning memory")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your personal changes" })).toBeVisible();
  // Staff access to the record is listed for the learner (none in this journey).
  await expect(panel.getByText("No one on the course staff has viewed or downloaded your record.")).toBeVisible();
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download my data (JSON)" }).click();
  await expect(panel.getByText("Your data file was prepared. Check your downloads.")).toBeVisible();
  const file = await download;
  const exported = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path())!, "utf8"));
  expect(exported.format).toBe("course-core.enrollment-export");
  expect(exported.events.items.map((e: { event_type: string }) => e.event_type)).toContain("block.read");
  await panel.getByText(/Erase my learning data for/).click();
  const enrollmentId = exported.enrollment.id as string;
  await panel.getByLabel(/Why are you erasing it/).fill("I want to start fresh elsewhere.");
  await panel.getByLabel(/to confirm/).fill(`ERASE ${enrollmentId.slice(0, 8)}`);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
  await panel.getByRole("button", { name: "Erase permanently" }).click();
  await expect(page.getByText("Your learning data for this course was erased.")).toBeVisible();
  const erasedCard = page
    .getByRole("article")
    .filter({ has: page.getByText(/learning data erased/) });
  await expect(erasedCard).toBeVisible();
  await expect(erasedCard.getByRole("button", { name: "Continue learning →" })).toHaveCount(0);
  expect((await page.request.get(`/api/enrollments/${enrollmentId}`)).status()).toBe(410);
  await expect(page.getByText(/You erased your learning data for this version/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume course" })).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("learner-data.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a learner sees each staff view and staff download of their record, and their notes stay private", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A learner and the course owner of the same workspace (the owner acts through the real API).
  const fixture = await (await request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await declinePlacement(page);
  const id = (await (await page.request.get("/api/enrollments")).json())[0].id as string;
  // The owner can read the evidence projection of the learner model, not the learner's notes or history.
  const model = await request.get(`/api/enrollments/${id}/learner-model`, { headers: fixture.reviewer });
  expect(model.status()).toBe(200);
  expect(await model.json()).toMatchObject({ access: "staff", withheld: ["selfReport", "suggestions", "changes", "history"] });
  expect((await request.get(`/api/enrollments/${id}/learner-model/history`, { headers: fixture.reviewer })).status()).toBe(403);
  // The learner writes private notes about themselves.
  const marker = "PRIVATE_NOTE_" + Date.now();
  const saved = await page.request.post(`/api/enrollments/${id}/learner-model/profile`, {
    headers: { origin: new URL(page.url()).origin, "x-csrf-token": (await page.context().cookies()).find((c) => c.name === "course_csrf")!.value },
    data: { expectedRevision: (await (await page.request.get(`/api/enrollments/${id}`)).json()).revision, idempotencyKey: crypto.randomUUID(),
      profile: { preferences: {}, priorKnowledge: [], thoughts: marker } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  // One read-only view and one data download by the owner; neither contains the notes.
  const viewed = await request.get(`/api/admin/enrollments/${id}/learner-view`, { headers: fixture.reviewer });
  expect(viewed.status()).toBe(200);
  expect(await viewed.text()).not.toContain(marker);
  const staffCopy = await request.get(`/api/admin/enrollments/${id}/export`, { headers: fixture.reviewer });
  expect(staffCopy.status()).toBe(200);
  expect(await staffCopy.text()).not.toContain(marker);
  expect(await staffCopy.json()).toMatchObject({ audience: "staff", learnerModel: null, companion: null });
  await chooseFromMenu(page, "My profile");
  const panel = page.getByRole("region", { name: "Your data" });
  const access = panel.getByRole("region", { name: "Staff access to your record" });
  await expect(access.getByRole("listitem")).toHaveCount(2);
  await expect(access.getByRole("listitem").nth(0)).toContainText("Rubric reviewer (owner) viewed your record");
  await expect(access.getByRole("listitem").nth(1)).toContainText("Rubric reviewer (owner) downloaded a copy of your data");
  await expect(access.getByText(/neither the view nor their copy includes your companion conversation or your own notes/)).toBeVisible();
  await access.scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({ page }).include(".connected-staff-views").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box = (await access.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await access.screenshot({ path: testInfo.outputPath("staff-access.png") });
  // The same records are in the learner's own data file.
  const exported = await (await page.request.get(`/api/enrollments/${id}/export`)).json();
  expect(exported.staffViews).toHaveLength(1);
  expect(exported.staffExports).toMatchObject([{ exporterName: "Rubric reviewer", exporterRole: "owner" }]);
  expect(exported.learnerModel.profile.profile.thoughts).toBe(marker);
  expect(errors).toEqual([]);
});

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];
test("optional placement: bounded questions, a reviewed result and an explicit start point", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  const panel = page.getByRole("region", { name: "Already know some of this?" });
  await expect(panel).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: "Find my starting point" }).click();
  const run = page.locator("section.connected-placement");
  for (let step = 0; step < 4; step++) {
    await expect(run.getByRole("heading", { name: `Placement question ${step + 1} of at most 4` })).toBeVisible();
    await expect(run.getByRole("button", { name: "Save answer" })).toBeVisible();
    const text = await run.textContent();
    const match = placementAnswers.find(([prompt]) => prompt.test(text ?? ""));
    expect(match, text ?? "").toBeTruthy();
    const [, value, choice] = match!;
    if (choice) await run.getByRole("radio", { name: value, exact: true }).click();
    else await run.getByRole("textbox", { name: "Your numeric answer" }).fill(value);
    await run.getByRole("button", { name: "Save answer" }).click();
    if (step < 3) await expect(run.getByRole("heading", { name: `Placement question ${step + 2} of at most 4` })).toBeVisible();
    if (step === 0) {
      // Interrupt mid-run: reload resumes the run rather than restarting or skipping.
      // Wait for the next item to be issued first, so the reload interrupts a
      // shown item rather than one being issued.
      await expect(run.getByRole("button", { name: "Save answer" })).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
      await run.getByRole("button", { name: /Next question|Resume my question/ }).click();
    }
  }
  await run.getByRole("button", { name: /See my result/ }).click();
  await expect(run.getByRole("heading", { name: "Your placement result" })).toBeVisible();
  await expect(run.getByText("Minimum", { exact: true })).toBeVisible();
  await expect(run.getByText("Maximum", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("placement-result.png"), fullPage: true });
  await run.getByRole("button", { name: "Place out of everything shown" }).click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  const enrollments = await (await page.request.get("/api/enrollments")).json();
  const snapshot = await (await page.request.get(`/api/enrollments/${enrollments[0].id}`)).json();
  expect(snapshot.lessons.filter((l: { id: string }) => ["min", "max"].includes(l.id)).map((l: { status: string; completedBlockIds: string[] }) => [l.status, l.completedBlockIds.length])).toEqual([["placed", 0], ["placed", 0]]);
  expect(errors).toEqual([]);
});

test("declining placement starts the normal path and the offer does not return", async ({ page, request }) => {
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  // While the offer is open, the roadmap card points to it.
  const offer = page.getByRole("region", { name: "Already know some of this?" });
  await expect(page.getByText("Already know this material?")).toBeVisible();
  await page.getByRole("button", { name: "Explore placement ↗" }).click();
  await expect(offer).toBeInViewport();
  await expect(offer).toBeFocused();
  await declinePlacement(page);
  // Declined: the card is gone with the panel it pointed to, and stays gone.
  await expect(page.getByText("Already know this material?")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explore placement ↗" })).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Continue learning →", exact: true })).toBeVisible();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await expect(page.getByText("Already know this material?")).toHaveCount(0);
});

test("a written explanation waits for an independent reviewer before the gate can pass", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await declinePlacement(page);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByText("A REVIEWER WILL LOOK FOR")).toBeVisible();
  await expect(page.getByText("States the invariant: the kept value is never greater than any element seen.")).toBeVisible();
  await fillAnswer(page.getByRole("textbox", { name: "Your explanation" }), "To find the minimum I keep the smallest value seen so far and compare every next element with it. Because each comparison keeps the smaller value, the kept value is never greater than any element.");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByText(/Submitted for review\./)).toBeVisible();
  await expect(page.getByText("Waiting for a reviewer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete episode →", exact: true })).toBeDisabled();
  // A separate reviewer (the course owner) records quoted findings through the real API.
  const course = (await (await page.request.get("/api/enrollments")).json())[0];
  const catalog = (await (await request.get("/api/admin/session", { headers: fixture.reviewer })).json()).courses[0].id;
  const pending = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending;
  expect(pending).toHaveLength(1);
  const saved = await request.post(`/api/admin/rubric-reviews/${pending[0].attemptId}`, {
    headers: fixture.reviewer,
    data: {
      decision: "met",
      criteria: [
        { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
        { criterionId: "every-element", met: true, quote: "compare every next element with it" },
        { criterionId: "edge", met: false, note: "Empty list not discussed." },
      ],
      idempotencyKey: "browser-review-" + course.id,
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.reload();
  await openCurrentLesson(page);
  await expect(page.getByText("Reviewed · criteria met")).toBeVisible();
  await expect(page.getByText("Empty list not discussed.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete episode →", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("written-review.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a slower, older progress refresh never removes the check a learner is answering", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/rubric-session")).json();
  // Hold back the refresh the placement panel starts after a confirmed decline:
  // the server answers it with the state at that moment, and the browser gets
  // it only after the learner has read, started a check and typed an answer.
  let declined = false, held = false, releaseHeld: (() => void) | undefined;
  const heldBack = new Promise<void>((resolve) => (releaseHeld = resolve));
  let deliveredLate: Promise<void> | undefined, heldRequest: Request | undefined;
  await page.route(/\/api\/enrollments\/[0-9a-f-]{36}(\/placement(\/decline)?)?$/, async (route) => {
    const url = route.request().url(), method = route.request().method();
    if (method === "POST" && url.endsWith("/placement/decline")) declined = true;
    else if (method === "GET" && url.endsWith("/placement") && declined) held = true;
    else if (method === "GET" && held && !deliveredLate) {
      heldRequest = route.request();
      const response = await route.fetch();
      deliveredLate = heldBack.then(() => route.fulfill({ response }));
      return deliveredLate;
    }
    return route.continue();
  });
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await declinePlacement(page);
  await expect.poll(() => Boolean(deliveredLate)).toBe(true);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  const answer = page.getByRole("textbox", { name: "Your explanation" });
  await fillAnswer(answer, "I keep the smallest value seen so far");
  const arrived = page.waitForEvent("requestfinished", (finished) => finished === heldRequest);
  releaseHeld!();
  await arrived;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100))));
  // The older snapshot neither removes the check nor rolls back the reading.
  await expect(answer).toHaveValue("I keep the smallest value seen so far");
  await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toHaveCount(0);
  await answer.press("End");
  await answer.pressSequentially(" and compare it with every next element.");
  await expect(answer).toHaveValue("I keep the smallest value seen so far and compare it with every next element.");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByText("Waiting for a reviewer")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a reviewer's neutral question continues the written answer as a conversation the learner replies to", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await declinePlacement(page);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await fillAnswer(page.getByRole("textbox", { name: "Your explanation" }), "I keep the smallest value seen so far and compare every next element with it.");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByText("Waiting for a reviewer")).toBeVisible();
  const catalog = (await (await request.get("/api/admin/session", { headers: fixture.reviewer })).json()).courses[0].id;
  const opening = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending[0];
  const question = await request.post(`/api/admin/rubric-reviews/${opening.attemptId}`, { headers: fixture.reviewer, data: {
    decision: "needs_clarification", probeOnly: true, learnerNote: "Why does the kept value end up being the minimum?", idempotencyKey: "browser-probe-" + opening.attemptId,
    criteria: [
      { criterionId: "invariant", met: false },
      { criterionId: "every-element", met: true, quote: "compare every next element with it" },
      { criterionId: "edge", met: false },
    ] } });
  expect(question.ok(), await question.text()).toBeTruthy();
  await page.reload();
  await openCurrentLesson(page);
  await expect(page.getByText("Reviewer: Why does the kept value end up being the minimum?")).toBeVisible();
  await page.getByRole("textbox", { name: "Your reply to the reviewer" }).fill("Each comparison keeps the smaller value, so the kept value is never greater than any element seen.");
  await page.getByRole("button", { name: "Send reply for review", exact: true }).click();
  await expect(page.getByText(/Your reply · Waiting for a reviewer/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your reply to the reviewer" })).toHaveCount(0);
  const reply = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending[0];
  expect(reply.thread).toHaveLength(1);
  expect(reply.independentEligible).toBe(true);
  await expect(page.getByRole("button", { name: "Complete episode →", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("placement: the learner replies to a reviewer's question about a written answer for a still-locked episode", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/placement-written-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Find my starting point" }).click();
  const run = page.locator("section.connected-placement");
  await expect(run.getByRole("heading", { name: "Placement question 1 of at most 4" })).toBeVisible();
  await run.getByRole("radio", { name: "2", exact: true }).click();
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 2 of at most 4" })).toBeVisible();
  await fillAnswer(run.getByRole("textbox", { name: "Your numeric answer" }), "4");
  await run.getByRole("button", { name: "Save answer" }).click();
  // The third question is a written explanation for the second, still-locked episode.
  await expect(run.getByRole("heading", { name: "Placement question 3 of at most 4" })).toBeVisible();
  await expect(run.getByText("A REVIEWER WILL LOOK FOR")).toBeVisible();
  await fillAnswer(run.getByRole("textbox", { name: "Your explanation" }), "To find the maximum I keep the largest value seen so far and compare every next element with it, keeping the larger value each time.");
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 4 of at most 4" })).toBeVisible();
  await expect(run.getByText("Waiting for a reviewer")).toBeVisible();

  const catalog = (await (await request.get("/api/admin/session", { headers: fixture.reviewer })).json()).courses[0].id;
  const opening = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending
    .find((p: { assessmentId: string }) => p.assessmentId === "max-explain");
  expect(opening.episodeId).toBe("max");
  const asked = await request.post(`/api/admin/rubric-reviews/${opening.attemptId}`, { headers: fixture.reviewer, data: {
    decision: "needs_clarification", probeOnly: true, learnerNote: "Why is the kept value the maximum at the end?", idempotencyKey: "browser-placement-probe-" + opening.attemptId,
    criteria: [{ criterionId: "invariant", met: false }, { criterionId: "every-element", met: true, quote: "compare every next element with it" }] } });
  expect(asked.ok(), await asked.text()).toBeTruthy();

  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  const answers = run.getByRole("region", { name: "Your written answers" });
  await expect(answers.getByText("Reviewer: Why is the kept value the maximum at the end?")).toBeVisible();
  expect((await (await page.request.get(`/api/enrollments/${(await (await page.request.get("/api/enrollments")).json())[0].id}`)).json()).lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await fillAnswer(answers.getByRole("textbox", { name: "Your reply to the reviewer" }), "The kept value is never less than any element seen, because each comparison keeps the larger of the two values.");
  await answers.getByRole("button", { name: "Send reply for review", exact: true }).click();
  await expect(answers.getByText(/Your reply · Waiting for a reviewer/)).toBeVisible();
  await expect(answers.getByRole("textbox", { name: "Your reply to the reviewer" })).toHaveCount(0);
  // The reply used no placement question: the fourth one is still available.
  await expect(run.getByRole("heading", { name: "Placement question 4 of at most 4" })).toBeVisible();
  const reply = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending[0];
  expect(reply.thread).toHaveLength(1);
  expect(reply.independentEligible).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("placement-reply.png"), fullPage: true });
  await run.getByRole("button", { name: /Next question|Resume my question/ }).click();
  await fillAnswer(run.getByRole("textbox", { name: "Your numeric answer" }), "9");
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByText(/still waiting to be evaluated/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("placement: a judged written placement answer can be appealed from the placement panel", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/placement-written-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Find my starting point" }).click();
  const run = page.locator("section.connected-placement");
  await expect(run.getByRole("heading", { name: "Placement question 1 of at most 4" })).toBeVisible();
  await run.getByRole("radio", { name: "2", exact: true }).click();
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 2 of at most 4" })).toBeVisible();
  await fillAnswer(run.getByRole("textbox", { name: "Your numeric answer" }), "4");
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 3 of at most 4" })).toBeVisible();
  await fillAnswer(run.getByRole("textbox", { name: "Your explanation" }), "To find the maximum I keep the largest value seen so far and compare every next element with it, keeping the larger value each time.");
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 4 of at most 4" })).toBeVisible();
  await expect(run.getByText("Waiting for a reviewer")).toBeVisible();

  const catalog = (await (await request.get("/api/admin/session", { headers: fixture.reviewer })).json()).courses[0].id;
  const opening = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending
    .find((p: { assessmentId: string }) => p.assessmentId === "max-explain");
  const judged = await request.post(`/api/admin/rubric-reviews/${opening.attemptId}`, { headers: fixture.reviewer, data: {
    decision: "not_met", idempotencyKey: "browser-placement-judged-" + opening.attemptId,
    criteria: [{ criterionId: "invariant", met: false, note: "Not stated." }, { criterionId: "every-element", met: true, quote: "compare every next element with it" }] } });
  expect(judged.ok(), await judged.text()).toBeTruthy();

  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  const answers = run.getByRole("region", { name: "Your written answers" });
  await expect(answers.getByText("Reviewed · not yet")).toBeVisible();
  // The episode is still locked; the appeal is made right here.
  const enrollment = (await (await page.request.get("/api/enrollments")).json())[0].id;
  expect((await (await page.request.get(`/api/enrollments/${enrollment}`)).json()).lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
  await answers.getByRole("button", { name: "Ask for a second opinion" }).click();
  await fillAnswer(answers.getByRole("textbox", { name: "Why should another reviewer look again?" }), "My answer says the kept value is the largest seen so far at every step.");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await answers.getByRole("button", { name: "Request a second opinion" }).click();
  await expect(answers.getByText(/Second opinion requested/)).toBeVisible();
  await expect(answers.getByRole("button", { name: "Ask for a second opinion" })).toHaveCount(0);
  const queued = (await (await request.get(`/api/admin/courses/${catalog}/rubric-appeals`, { headers: fixture.reviewer })).json()).appeals;
  expect(queued.map((a: { attemptId: string }) => a.attemptId)).toEqual([opening.attemptId]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("placement-appeal.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("placement: after accepting a start point, an open reviewer question about a locked episode can still be answered", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/placement-written-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Find my starting point" }).click();
  const run = page.locator("section.connected-placement");
  await expect(run.getByRole("heading", { name: "Placement question 1 of at most 4" })).toBeVisible();
  await run.getByRole("radio", { name: "2", exact: true }).click();
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 2 of at most 4" })).toBeVisible();
  await fillAnswer(run.getByRole("textbox", { name: "Your numeric answer" }), "4");
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 3 of at most 4" })).toBeVisible();
  await fillAnswer(run.getByRole("textbox", { name: "Your explanation" }), "To find the maximum I keep the largest value seen so far and compare every next element with it, keeping the larger value each time.");
  await run.getByRole("button", { name: "Save answer" }).click();
  await expect(run.getByRole("heading", { name: "Placement question 4 of at most 4" })).toBeVisible();
  await run.getByRole("button", { name: /Stop and see my result/ }).click();
  await expect(run.getByRole("heading", { name: "Your placement result" })).toBeVisible();
  // Starting from the beginning places nothing: the questioned episode stays locked.
  await run.getByRole("button", { name: "Start from the beginning" }).click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);

  const catalog = (await (await request.get("/api/admin/session", { headers: fixture.reviewer })).json()).courses[0].id;
  const opening = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending
    .find((p: { assessmentId: string }) => p.assessmentId === "max-explain");
  const asked = await request.post(`/api/admin/rubric-reviews/${opening.attemptId}`, { headers: fixture.reviewer, data: {
    decision: "needs_clarification", probeOnly: true, learnerNote: "Why is the kept value the maximum at the end?", idempotencyKey: "browser-accepted-probe-" + opening.attemptId,
    criteria: [{ criterionId: "invariant", met: false }, { criterionId: "every-element", met: true, quote: "compare every next element with it" }] } });
  expect(asked.ok(), await asked.text()).toBeTruthy();

  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Your learning path", exact: true })).toBeVisible();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  const open = page.getByRole("region", { name: "Placement answers a reviewer asked about" });
  await expect(open.getByText("Reviewer: Why is the kept value the maximum at the end?")).toBeVisible();
  const enrollment = (await (await page.request.get("/api/enrollments")).json())[0].id;
  expect((await (await page.request.get(`/api/enrollments/${enrollment}`)).json()).lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("placement-accepted-question.png"), fullPage: true });
  await fillAnswer(open.getByRole("textbox", { name: "Your reply to the reviewer" }), "The kept value is never less than any element seen, because each comparison keeps the larger of the two values.");
  await open.getByRole("button", { name: "Send reply for review", exact: true }).click();
  // The reply stays visible, waiting for review, until the reviewer closes the conversation.
  await expect(open.getByText(/Your reply · Waiting for a reviewer/)).toBeVisible();
  await expect(open.getByRole("textbox", { name: "Your reply to the reviewer" })).toHaveCount(0);
  const reply = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending[0];
  expect(reply.thread).toHaveLength(1);
  expect(reply.independentEligible).toBe(true);
  const judged = await request.post(`/api/admin/rubric-reviews/${reply.attemptId}`, { headers: fixture.reviewer, data: {
    decision: "met", idempotencyKey: "browser-accepted-judged-" + reply.attemptId,
    criteria: [{ criterionId: "invariant", met: true, quote: "never less than any element seen" }, { criterionId: "every-element", met: true, quote: "compare every next element with it" }] } });
  expect(judged.ok(), await judged.text()).toBeTruthy();
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Your learning path", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Placement answers a reviewer asked about" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a due delayed check is optional, fresh and records retention without changing progress", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/retention-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  const panel = page.getByRole("region", { name: "Delayed checks" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Shown once")).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: "Take the delayed check" }).click();
  await expect(page.getByText("Minimum of 12 and 7?")).toBeVisible();
  await fillAnswer(page.getByRole("textbox", { name: "Your numeric answer", exact: true }), "7");
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(page.getByText(/Correct\./)).toBeVisible();
  await page.getByRole("button", { name: /Course roadmap/ }).click();
  await expect(page.getByRole("region", { name: "Delayed checks" }).getByText("Retained")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("retention.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a learner sees why their course changed and can hide and restore an optional addition", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request.post("/test/model-session", { data: { generated: true, optional: true } });
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  const teaching = page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true });
  await expect(teaching).toBeVisible();
  await chooseFromMenu(page, "My profile");
  const panel = page.getByRole("region", { name: "Your personal changes" });
  await expect(panel.getByText("Added explanation or example")).toBeVisible();
  await expect(panel.getByText(/· optional ·/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: /^Hide this addition/ }).click();
  await expect(panel.getByRole("button", { name: /^Restore this addition/ })).toBeVisible();
  const enrollments = await (await page.request.get("/api/enrollments")).json();
  const id = enrollments[0].id;
  let snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  expect(JSON.stringify(snapshot.course)).not.toContain("Minimum of [31, -14, 9] is -14.");
  const evidenceBefore = snapshot.lessons[0].gate;
  await page.screenshot({ path: testInfo.outputPath("personal-changes.png"), fullPage: true });
  await panel.getByRole("button", { name: /^Restore this addition/ }).click();
  await expect(panel.getByRole("button", { name: /^Hide this addition/ })).toBeVisible();
  snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  expect(JSON.stringify(snapshot.course)).toContain("Minimum of [31, -14, 9] is -14.");
  expect(snapshot.lessons[0].gate).toEqual(evidenceBefore);
  // Generated text is labelled unverified, and the learner can undo it for good after confirming.
  await expect(panel.getByText("Unverified.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /^Undo: Added explanation or example/ }).click();
  await panel.getByRole("button", { name: "Keep it", exact: true }).click();
  await panel.getByRole("button", { name: /^Undo: Added explanation or example/ }).click();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: "Yes, undo", exact: true }).click();
  await expect(panel.getByText(/^Undone/)).toBeVisible();
  await expect(panel.getByRole("button", { name: /^(Undo|Hide|Restore)/ })).toHaveCount(0);
  snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  expect(JSON.stringify(snapshot.course)).not.toContain("Minimum of [31, -14, 9] is -14.");
  expect(snapshot.lessons[0].gate).toEqual(evidenceBefore);
  await page.screenshot({ path: testInfo.outputPath("personal-change-undone.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("a learner sees teaching ideas in plain language, checks one, then pins, corrects and rejects it without credit", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await chooseFromMenu(page, "My profile");
  const statement = "You may be choosing the largest value when the question asks for the smallest.";
  await expect(page.getByText(statement, { exact: true })).toBeVisible();
  await expect(page.getByText("Possible mix-up", { exact: true })).toBeVisible();
  await expect(page.getByText("An idea to check", { exact: true })).toBeVisible();
  await expect(page.getByText(/Noticed from a check answer · Tentative · based on 1 observation/)).toBeVisible();

  // A quick check: answered, and stated never to count toward progress.
  await page.getByRole("button", { name: "Ask for a quick check of this idea", exact: true }).click();
  await expect(page.getByText("Which is the smallest of 4, 9 and 2?", { exact: true })).toBeVisible();
  await expect(page.getByText("Quick check · does not count toward progress", { exact: true })).toBeVisible();
  await page.getByRole("radiogroup", { name: "Quick check answer", exact: true }).getByRole("radio", { name: "9", exact: true }).click();
  await page.getByRole("button", { name: "Submit check", exact: true }).click();
  await expect(page.getByText(/it does not count toward your progress/)).toBeVisible();
  await expect(page.getByText("Supported by your answers", { exact: true })).toBeVisible();
  await page.getByText(statement, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("teaching-hypothesis-checked.png") });

  await page.getByRole("button", { name: "Pin idea", exact: true }).click();
  await expect(page.getByText("Pinned by you", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Correct this idea", exact: true }).click();
  await page.getByRole("textbox", { name: "Say it in your own words", exact: true }).fill("I read “smallest” as “largest”.");
  await page.getByRole("button", { name: "Save correction", exact: true }).click();
  await expect(page.getByText("I read “smallest” as “largest”.", { exact: true })).toBeVisible();
  // The correction persists across reload.
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await chooseFromMenu(page, "My profile");
  await expect(page.getByText("I read “smallest” as “largest”.", { exact: true })).toBeVisible();
  await expect(page.getByText("Pinned by you", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject this idea", exact: true }).click();
  await page.getByRole("button", { name: "Confirm reject", exact: true }).click();
  await expect(page.getByText("No open ideas.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show earlier ideas", exact: true }).click();
  await expect(page.getByText("You rejected this", { exact: true })).toBeVisible();
  // Nothing here grants credit.
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("teaching-hypotheses.png"), fullPage: true });
});

test("an idea the learner writes is kept for a limited time and can be kept longer", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session");
  expect(session.ok()).toBe(true);
  const decisions: Record<string, unknown>[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/decision$/.test(new URL(r.url()).pathname)) decisions.push(r.postDataJSON()); });
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await chooseFromMenu(page, "My profile");
  await page.getByRole("button", { name: "Show ask for a quick check", exact: true }).click();
  await expect(page.getByText(/What you write here becomes one of your ideas/)).toBeVisible();
  const note = "I compare only the first two numbers.";
  await page.getByRole("textbox", { name: "What do you think is confusing you? (optional)", exact: true }).fill(note);
  await page.getByRole("button", { name: "Ask for a check", exact: true }).click();
  const card = page.locator(`[aria-label="Teaching idea: ${note}"]`);
  await expect(card.getByText(/^From your request/)).toBeVisible();
  // The same bounded lifetime as an automatic idea, visible to the learner.
  await expect(card.getByText(/^Kept until /)).toBeVisible();
  await expect(page.getByText(/kept for 30 days, then lapses and frees its place/)).toBeVisible();
  await card.getByRole("button", { name: "Keep this idea for another 30 days", exact: true }).click();
  await expect(page.getByText("Kept for another 30 days.", { exact: true })).toBeVisible();
  expect(decisions.at(-1)).toMatchObject({ action: "renew" });
  await card.scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("teaching-idea-lifetime.png") });
});

test("an optional confidence rating with a declared item reaches the teaching ideas but never the result", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session?check=1");
  expect(session.ok()).toBe(true);
  const sent: Record<string, unknown>[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/answers$/.test(new URL(r.url()).pathname)) sent.push(r.postDataJSON()); });
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await enterNextLesson(page);
  await expect(page.getByText("Which is the smallest of 7, 3 and 9?", { exact: true })).toBeVisible();
  const confidence = page.getByRole("radiogroup", { name: "Confidence", exact: true });
  await expect(confidence).toHaveAccessibleDescription(/never changes your result/);
  // Optional: nothing is chosen until the learner picks a level.
  for (const radio of await confidence.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  await confidence.getByRole("radio", { name: "5", exact: true }).click();
  await expect(confidence.getByRole("radio", { name: "5", exact: true })).toBeChecked();
  await page.getByRole("radiogroup", { name: "Your answer", exact: true }).getByRole("radio", { name: "9", exact: true }).click();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("answer-confidence.png") });
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ answer: "nine", confidence: 5 });
  // The confident wrong answer is observed against the open idea; no credit appears.
  await chooseFromMenu(page, "My profile");
  await expect(page.getByText(/based on 2 observations/)).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
});

test("a learner disputes a result and keeps it out of AI context, without any change to credit", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await chooseFromMenu(page, "My profile");
  await page.getByRole("button", { name: "Search history", exact: true }).click();
  await page.getByRole("button", { name: /^Show history references / }).first().click();
  await expect(page.getByText("Your companion and supervisor may use this result.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Dispute result / }).click();
  const send = page.getByRole("button", { name: "Send dispute", exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole("textbox", { name: /^Why should evidence .+ be reviewed\?$/ }).fill("I meant the smallest value; please look at it again.");
  await send.click();
  await expect(page.getByText("Change saved. Assessment evidence is unchanged.", { exact: true })).toBeVisible();
  await expect(page.getByText("Disputed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Exclude .+ from AI context$/ }).click();
  await expect(page.getByText("Disputed · a review is open. Not used by your companion or supervisor.", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("evidence-controls.png"), fullPage: true });
  // Both controls persist across reload; nothing was demonstrated by them.
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await chooseFromMenu(page, "My profile");
  await expect(page.getByText("Disputed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Search history", exact: true }).click();
  await page.getByRole("button", { name: /^Show history references / }).first().click();
  await expect(page.getByText("Disputed · a review is open. Not used by your companion or supervisor.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Withdraw dispute / }).click();
  await expect(page.getByText("Not used by your companion or supervisor.", { exact: true })).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
});

test("the companion shows the context an answer used, takes a lesson selection, and lets the learner correct its context", async ({ page, request }, info) => {
  const session = await request.post("/test/companion-context-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await enterNextLesson(page);
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  // Select part of the lesson text before opening the companion.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector(".connected-lesson")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf("any other member");
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + "any other member".length);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
      return;
    }
    throw new Error("lesson text not found");
  });
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  await expect(page.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toBeVisible();
  await expect(page.getByText("Selected: “any other member”", { exact: true })).toBeVisible();
  // Each reply names the lesson its question was asked in: this one, another named one, or none recorded.
  const log = page.getByRole("log", { name: "Saved companion messages" });
  await expect(log.getByText(/^About: Minimum \(this lesson\)/)).toBeVisible();
  await expect(log.getByText("From: Maximum", { exact: true })).toBeVisible();
  await expect(log.getByText("About: Maximum", { exact: true })).toBeVisible();
  await expect(log.getByText("About: Lesson not recorded", { exact: true })).toBeVisible();
  await expect(log.getByText(/Earlier lesson/)).toHaveCount(0);
  // The earlier answer names what it used.
  await page.getByRole("button", { name: "Show context used", exact: true }).click();
  await expect(page.getByText("Answering: “Why does it say no greater than?”", { exact: true })).toBeVisible();
  await expect(page.getByText("You pointed at (Lesson text): “no greater than”", { exact: true })).toBeVisible();
  await expect(page.getByText("1 earlier message from this lesson:", { exact: true })).toBeVisible();
  await expect(page.getByText(/Rules it followed: deadline .* · no independent check open/)).toBeVisible();
  await page.getByRole("button", { name: "Don’t use this message again", exact: true }).click();
  await expect(page.getByText("You: “What does minimum mean here?” · not used again", { exact: true })).toBeVisible();
  await expect(page.getByText("Not used as context for later answers.", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("companion-context-used.png") });
  // A new question carries the selection; the server accepts it against this course version.
  await page.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("And what about this part?");
  const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const response = await sent;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ selection: { kind: "text", excerpt: "any other member" }, uiRevision: expect.any(Number) });
  expect(await response.json()).toMatchObject({ selectedAnchor: { kind: "text" } });
  await expect(page.getByText("Selected: “any other member”", { exact: true })).toHaveCount(0);
  await expect(log.getByText("And what about this part?", { exact: true })).toBeVisible();
});
