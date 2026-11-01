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
  const trigger = page.locator(".connected-header .connected-companion-trigger");
  const companion = page.getByRole("complementary", { name: "Your companion", exact: true });
  // The button that opens the companion is in the header on every layout: the learning pane
  // starts under the header and keeps the window to its end, so the button never covers it.
  const checkGeometry = async () => {
    const pane = await page
      .getByRole("main", { name: "Learning content" })
      .boundingBox();
    const header = await page.locator(".connected-header").boundingBox();
    const button = await trigger.boundingBox();
    expect(pane).not.toBeNull();
    expect(header).not.toBeNull();
    expect(button).not.toBeNull();
    expect(button!.y).toBeGreaterThanOrEqual(header!.y - 0.5);
    expect(button!.y + button!.height).toBeLessThanOrEqual(header!.y + header!.height + 0.5);
    expect(pane!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 0.5);
    expect(pane!.y + pane!.height).toBeLessThanOrEqual(
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
  /** The sheet over the lesson: nonmodal, never inert behind it, and at Half the learning pane ends
   * above it. */
  const checkSheet = async (detent: string) => {
    await expect(companion).toBeVisible();
    await expect(companion).toHaveAttribute("data-placement", "sheet");
    await expect(companion).toHaveAttribute("data-detent", detent);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.locator("[inert]").count()).toBe(0);
    await expect(async () => {
      const sheet = (await companion.boundingBox())!;
      // A short window's Full leaves 48 px of the window's top; otherwise the learning pane ends
      // above the sheet.
      if (detent === "full") expect(Math.round(sheet.y)).toBe(48);
      else {
        const pane = (await page.getByRole("main", { name: "Learning content" }).boundingBox())!;
        expect(pane.y + pane.height).toBeLessThanOrEqual(sheet.y + 1);
      }
    }).toPass({ timeout: 10_000 });
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
  // With the sheet open at Half, the lesson above it is still read and used.
  await trigger.click();
  await checkSheet("half");
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
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(trigger).toBeFocused();
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
  // A short landscape window (under 480 px high): the sheet opens at Full.
  await page.setViewportSize({ width: 1280, height: 460 });
  // Layout settles after a resize; wait for it rather than sampling one frame.
  await expect(checkGeometry).toPass({ timeout: 10_000 });
  await trigger.click();
  await checkSheet("full");
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // 599 px is the widest phone window (see companionLayout); 600 and up use the
  // tablet's sheet.
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
