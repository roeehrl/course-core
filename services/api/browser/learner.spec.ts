import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("compact companion reserves space without covering reading or activity, including short landscape windows", async ({
  page,
  request,
}, info) => {
  const session = await request.post("/test/model-session", {
    data: { generated: true, repair: true },
  });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  for (let step = 0; step < 2; step++)
    await page
      .getByRole("button", { name: "Continue learning →", exact: true })
      .click();
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  for (let step = 0; step < 2; step++)
    await page
      .getByRole("button", { name: "Continue learning →", exact: true })
      .click();
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  await page
    .getByRole("textbox", { name: "Your numeric answer", exact: true })
    .fill("4");
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your code", exact: true })
    .fill("def solve(values):\n    return max(values)\n");
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
  await page
    .getByRole("textbox", { name: "Your code", exact: true })
    .fill("def solve(values):\n    return values.index(min(values))\n");
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  await page
    .getByRole("textbox", { name: "Your numeric answer", exact: true })
    .fill("4");
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  await page
    .getByRole("textbox", { name: "Your numeric answer", exact: true })
    .fill("4");
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
  if (testInfo.project.name !== "desktop")
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
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
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
  for (let step = 0; step < 2; step++)
    await page
      .getByRole("button", { name: "Continue learning →", exact: true })
      .click();
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
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "My profile", exact: true }).click();
  const panel = page.getByRole("region", { name: "Your data" });
  await expect(panel).toBeVisible();
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download my data (JSON)" }).click();
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
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Continue learning →", exact: true })).toBeVisible();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
});
