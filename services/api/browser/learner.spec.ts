import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));

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
  const progressText = page.locator("#connected-steps-summary");
  const before = await progressText.textContent();
  const help = page.getByText("2 reviewed resources for this lesson");
  await expect(help).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await help.click();
  await expect(page.getByText(/doesn't count toward progress/)).toBeVisible();
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
  await expect(page.getByText("2 reviewed resources for this lesson")).toBeVisible();
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
    const progressText = page.locator("#connected-steps-summary");
    const before = await progressText.textContent();
    await page.getByText("2 reviewed resources for this lesson").click();
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
  const progressText = page.locator("#connected-steps-summary");
  const before = await progressText.textContent();
  const help = page.getByText("1 reviewed resource for this lesson");
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
      await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
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

test("placement: “I don't know yet” stops at that topic without recording a wrong answer", async ({ page, request }) => {
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
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Find my starting point" }).click();
  const run = page.locator("section.connected-placement");
  await expect(run.getByRole("heading", { name: "Placement question 1 of at most 4" })).toBeVisible();
  const abstain = run.getByRole("button", { name: "I don't know yet", exact: true });
  await expect(abstain).toBeVisible();
  await expect(run.getByText(/is not a wrong answer\. Placement stops at that topic/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await abstain.click();
  await expect(run.getByText(/marked “I don't know yet”, so placement stopped there/)).toBeVisible();
  await run.getByRole("button", { name: "See my result" }).click();
  await expect(run.getByRole("heading", { name: "Your placement result" })).toBeVisible();
  const enrollments = await (await page.request.get("/api/enrollments")).json();
  const placement = await (await page.request.get(`/api/enrollments/${enrollments[0].id}/placement`)).json();
  expect(placement.run).toMatchObject({ stopReason: "not_demonstrated", itemsUsed: 1, proposal: { exempt: [], startEpisodeId: "min" } });
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
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  await expect(page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })).toBeVisible();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await expect(page.getByText("Already know this material?")).toHaveCount(0);
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
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  const answers = run.getByRole("region", { name: "Your written answers" });
  await expect(answers.getByText("Reviewer: Why is the kept value the maximum at the end?")).toBeVisible();
  expect((await (await page.request.get(`/api/enrollments/${(await (await page.request.get("/api/enrollments")).json())[0].id}`)).json()).lessons.map((l: { status: string }) => l.status)).toEqual(["available", "locked"]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await fillAnswer(answers.getByRole("textbox", { name: "Your reply to the reviewer" }), "The kept value is never less than any element seen, because each comparison keeps the larger of the two values.");
  await answers.getByRole("button", { name: "Send reply", exact: true }).click();
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
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
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
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
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
  await open.getByRole("button", { name: "Send reply", exact: true }).click();
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
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  await expect(page.getByRole("heading", { name: "Your learning path", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Placement answers a reviewer asked about" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a due delayed check is optional, fresh and records retention without changing progress", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/retention-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  const panel = page.getByRole("region", { name: "Delayed checks" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Shown once")).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: "Take the delayed check" }).click();
  await expect(page.getByText("Minimum of 12 and 7?")).toBeVisible();
  await fillAnswer(page.getByRole("textbox", { name: "Your numeric answer", exact: true }), "7");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByText(/Correct\./)).toBeVisible();
  await page.getByRole("button", { name: /Course roadmap/ }).click();
  await expect(page.getByRole("region", { name: "Delayed checks" }).getByText("Retained")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("retention.png"), fullPage: true });
  expect(errors).toEqual([]);
});
