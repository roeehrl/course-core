// Learner-owned real API acceptance with current learner-facing copy.
import { expect, test } from "./health";
import { chooseFromMenu } from "./learner-menu";
import AxeBuilder from "@axe-core/playwright";
import type { ServerSnapshot } from "../../src/client/apiClient";

test("signed-in lesson, independent evidence, reload, server gate and account isolation", async ({
  page,
  request,
}, testInfo) => {
  let enrollmentWrites = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/enrollments"
    )
      enrollmentWrites++;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    // The read-only API harness doesn't serve a favicon. Keep all renderer,
    // script and other resource failures visible to this assertion.
    if (
      message.location().url.endsWith("/favicon.ico") &&
      message.text().includes("404 (Not Found)")
    )
      return;
    if (message.type() === "error") errors.push(message.text());
  });
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
  expect(enrollmentWrites).toBe(0);
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ordering values", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
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
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await expect(
    page.getByText("Which is smaller?", { exact: true }),
  ).toBeVisible();
  expect(enrollmentWrites).toBe(1);
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(
    page.getByText("Correct. 2 is below 5.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
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
  // This is the released SDK experience from the compiled, real API course,
  // mounted by ConnectedLesson -> VisualBlock -> fromVisualExperience.
  const enrollments = await (await page.request.get("/api/enrollments")).json();
  const enrollmentId = enrollments[0].id as string;
  const readSnapshot = async (): Promise<ServerSnapshot> => {
    const response = await page.request.get(`/api/enrollments/${enrollmentId}`);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const beforeVisual = await readSnapshot();
  const episode = beforeVisual.course.chapters
    .flatMap((chapter) => chapter.episodes)
    .find((episode) => episode.title === "Maximum")!;
  const block = episode.blocks.find((block) => block.type === "visual")!;
  expect(block.type).toBe("visual");
  if (block.type !== "visual")
    throw new Error("Expected public visual fixture");
  const experience = beforeVisual.course.visuals.find(
    (visual) => visual.id === block.visualId,
  )!;
  expect(experience.rendererId).toBe("course-core-svg-v1");
  expect(experience.timeline.cues.length).toBeGreaterThan(0);
  expect(
    experience.timeline.cues.every((cue) => /^cue-\d+$/.test(cue.event)),
  ).toBe(true);
  const player = page.getByRole("region", {
    name: "Order from motion",
    exact: true,
  });
  // The visual loads as it nears the lesson's scrolling view; on a short phone it starts
  // below the fold, so bring it into view as a learner would.
  await page.locator(".ccv-lazy").first().scrollIntoViewIfNeeded();
  const svg = player.locator("svg.ccv-scene");
  await expect(svg).toBeVisible();
  await expect(
    player.getByRole("button", { name: "Play animation", exact: true }),
  ).toBeEnabled();
  const initialGeometry = await svg.innerHTML();
  const timeline = player.getByRole("slider", {
    name: "Timeline",
    exact: true,
  });
  await timeline.fill(String(experience.timeline.durationMs));
  await expect(timeline).toHaveValue(String(experience.timeline.durationMs));
  expect(await svg.innerHTML()).not.toBe(initialGeometry);
  await expect(player.locator(".ccv-cue")).toContainText(
    "Ordered: 1, 2, 3, 4, 5, 6",
  );
  // Resizing preserves playback position while selecting compact geometry.
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(svg).toHaveAttribute("viewBox", "0 0 420 515");
  await expect(timeline).toHaveValue(String(experience.timeline.durationMs));
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    player.getByRole("button", { name: "Play animation", exact: true }),
  ).toBeDisabled();
  await expect(player).toContainText("Still mode");
  const afterVisual = await readSnapshot();
  expect(afterVisual.revision).toBe(beforeVisual.revision);
  expect(
    afterVisual.lessons.find((lesson) => lesson.id === episode.id)
      ?.completedBlockIds,
  ).not.toContain(block.id);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize(originalViewport);
  const visualAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(visualAccessibility.violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("connected-sdk-visual.png"),
    fullPage: true,
  });
  await chooseFromMenu(page, "Sign out");
  await expect(
    page.getByRole("heading", {
      name: "Pick up where you left off.",
      exact: true,
    }),
  ).toBeVisible();
  expect((await page.request.get("/api/enrollments")).status()).toBe(401);
  expect(errors).toEqual([]);
});
