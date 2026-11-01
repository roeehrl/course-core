import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

// Split from learner.spec.ts: where the companion sits on each layout.

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));
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
    "The draft didn't pass the course's checks, so it needs revising.",
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

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];
