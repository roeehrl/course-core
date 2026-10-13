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
