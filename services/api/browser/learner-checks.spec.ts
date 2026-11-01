import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

// Split from learner.spec.ts: checks (code recovery, a fresh check, the gate, a slower refresh).

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));

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
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your numeric answer", exact: true }),
    "4",
  );
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your code", exact: true }),
    "def solve(values):\n    return max(values)\n",
  );
  await page
    .getByRole("button", { name: "Check", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Get a fresh check · 2 min",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Get a fresh check · 2 min", exact: true })
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
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
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
    .getByRole("button", { name: "Check", exact: true })
    .click();
  await expect(
    page.getByText("Your independent checks are complete.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Finish this lesson →", exact: true })
    .click();
  await expect(
    page.getByText("1 of 2 lessons complete", { exact: true }),
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
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your numeric answer", exact: true }),
    "4",
  );
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page
    .getByRole("button", { name: "Get a fresh check · 2 min", exact: true })
    .click();
  await expect(
    page.getByText("Which value is smaller: 7 or 11?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
  ).toBeDisabled();
  await page.getByRole("radio", { name: "7", exact: true }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(
    page.getByText("Your independent checks are complete.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Finish this lesson →", exact: true })
    .click();
  await expect(
    page.getByText("1 of 2 lessons complete", { exact: true }),
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
  await openProfile(page);
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
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await openProfile(page);
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
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
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
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
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
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(
    page.getByText("Correct. 2 is below 5.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await fillAnswer(
    page.getByRole("textbox", { name: "Your numeric answer", exact: true }),
    "4",
  );
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(
    page.getByText("Your independent checks are complete.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Finish this lesson →", exact: true })
    .click();
  await expect(
    page.getByText("1 of 2 lessons complete", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Maximum", exact: true }),
  ).toBeVisible();
  // A visual loads as it nears the lesson's scrolling view; on a short phone it starts below the fold.
  await page.locator(".ccv-lazy").first().scrollIntoViewIfNeeded();
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
  await page.getByRole("button", { name: "Send", exact: true }).click();
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
  // P12: revisiting a finished lesson names where the learner returns, and takes them there.
  await page.getByRole("button", { name: "← Course roadmap", exact: true }).click();
  await page.getByRole("button", { name: "Lesson 1: Minimum, Completed", exact: true }).click();
  await expect(page.getByTestId("detour-return")).toContainText("You're revisiting a lesson you finished.");
  await page.getByRole("button", { name: "Back to Maximum", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Maximum", exact: true })).toBeVisible();
  await expect(page.getByTestId("detour-return")).toHaveCount(0);
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

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];

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
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
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
