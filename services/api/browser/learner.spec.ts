import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";

/** Opens the course from the course list, then its current lesson. A press was
 * once lost in CI while the page was still settling after sign-in,
 * so each press is retried until the page has changed. */
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
  await checkGeometry();
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
  await page
    .getByRole("button", { name: "Learning record", exact: true })
    .click();
  const rejected = page.getByText(
    "Draft rejected by reference checks · revision needed",
    { exact: true },
  );
  await rejected.scrollIntoViewIfNeeded();
  await checkGeometry();
  expect(
    await rejected.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 500 });
  await checkGeometry();
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Your companion" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(
    page.getByRole("button", { name: "Companion", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 834, height: 1112 });
  await checkGeometry();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
  await page.getByRole("button", { name: "My profile", exact: true }).click();
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
  await page
    .getByRole("button", { name: "Learning record", exact: true })
    .click();
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
  await page.getByRole("button", { name: "My profile", exact: true }).click();
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
  await page.getByRole("button", { name: "My profile", exact: true }).click();
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
  await page.getByRole("button", { name: "My profile", exact: true }).click();
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
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
  await page.getByRole("button", { name: "My profile", exact: true }).click();
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
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
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
  await page.getByRole("button", { name: /Load video player/ }).click();
  await expect(page.locator("iframe")).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?playsinline=1&rel=0",
  );
  await expect
    .poll(() => players.length)
    .toBeGreaterThan(0);
  expect(players.every((url) => url.startsWith("https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ"))).toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
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
  await page.getByRole("button", { name: "My profile", exact: true }).click();
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
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations,
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
  // One read-only view and one data download by the owner.
  expect((await request.get(`/api/admin/enrollments/${id}/learner-view`, { headers: fixture.reviewer })).status()).toBe(200);
  expect((await request.get(`/api/admin/enrollments/${id}/export`, { headers: fixture.reviewer })).status()).toBe(200);
  await page.getByRole("button", { name: "My profile", exact: true }).click();
  const panel = page.getByRole("region", { name: "Your data" });
  const access = panel.getByRole("region", { name: "Staff access to your record" });
  await expect(access.getByRole("listitem")).toHaveCount(2);
  await expect(access.getByRole("listitem").nth(0)).toContainText("Rubric reviewer (owner) viewed your record");
  await expect(access.getByRole("listitem").nth(1)).toContainText("Rubric reviewer (owner) downloaded a copy of your data");
  await expect(access.getByText(/They can also download a copy of your data/)).toBeVisible();
  await access.scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({ page }).include(".connected-staff-views").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box = (await access.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await access.screenshot({ path: testInfo.outputPath("staff-access.png") });
  // The same records are in the learner's own data file.
  const exported = await (await page.request.get(`/api/enrollments/${id}/export`)).json();
  expect(exported.staffViews).toHaveLength(1);
  expect(exported.staffExports).toMatchObject([{ exporterName: "Rubric reviewer", exporterRole: "owner" }]);
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
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
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
      // Wait for the next item to be issued first; WebKit reports a fetch that a
      // reload cancels as a page error even though the app handles it.
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
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
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
  await declinePlacement(page);
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Continue learning →", exact: true })).toBeVisible();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
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
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
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

test("a due delayed check is optional, fresh and records retention without changing progress", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/retention-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  const panel = page.getByRole("region", { name: "Delayed checks" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Shown once")).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
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
  await page.getByRole("button", { name: "My profile", exact: true }).click();
  const panel = page.getByRole("region", { name: "Your personal changes" });
  await expect(panel.getByText("Added explanation or example")).toBeVisible();
  await expect(panel.getByText(/· optional ·/)).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});
