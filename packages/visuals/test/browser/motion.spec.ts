import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { motionStudyDemo } from "../../src/demos.js";
import { VisualRuntime } from "../../src/runtime.js";
import { flattenNodes } from "../../src/geometry.js";
import { LAYOUT_SET_BREAKPOINTS } from "../../src/motion.js";

const modeFor = (width: number) =>
  width < LAYOUT_SET_BREAKPOINTS.tabletPortrait
    ? "compact"
    : width < LAYOUT_SET_BREAKPOINTS.tabletLandscape
      ? "tabletPortrait"
      : width < LAYOUT_SET_BREAKPOINTS.wide
        ? "tabletLandscape"
        : "wide";

test("springs, stagger, the layout set and synchronized panes match the headless runtime", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("tab", { name: "05 · Springs, stagger & panes" })
    .click();
  const player = page.locator(".ccv-player");
  const svg = page.locator(".ccv-scene");
  await expect(svg).toBeVisible();
  // The layout follows the player's width through the four-layout set.
  // The width the player itself measures (ResizeObserver content box).
  const width = await player.evaluate(
    (el) =>
      new Promise<number>((resolve) => {
        const observer = new ResizeObserver((entries) => {
          observer.disconnect();
          resolve(Math.round(entries[0]!.contentRect.width));
        });
        observer.observe(el);
      }),
  );
  await expect(svg).toHaveAttribute("data-layout", modeFor(width));

  // Seek, then compare the spring-driven pointer with the headless runtime at the same time.
  const timeline = page.getByRole("slider", { name: "Timeline", exact: true });
  for (const t of [1700, 2950, 4400, 6610]) {
    await timeline.fill(String(t));
    const runtime = new VisualRuntime(motionStudyDemo, {
      viewportWidth: width,
    });
    runtime.seek(t);
    const nodes = flattenNodes(runtime.getSnapshot().frame.nodes);
    for (const id of ["pointer", "bestLine", "maxBar3"])
      await expect(svg.locator(`[data-node-id="${id}"]`)).toHaveAttribute(
        "transform",
        `matrix(${nodes.find((n) => n.id === id)!.matrix.join(" ")})`,
      );
  }
  // Panes describe the same step: at 6.61 s, step 5 (value 6, best 9).
  await timeline.fill("6610");
  await expect(page.locator(".ccv-pane-table tr[aria-current]")).toHaveText(
    "569",
  );
  await expect(page.locator(".ccv-pane-code li[aria-current]")).toHaveAttribute(
    "data-line",
    "3",
  );
  await expect(page.locator(".ccv-pane-formula dd")).toHaveText([
    "5",
    "6",
    "9",
  ]);
  await timeline.fill("4400");
  await expect(page.locator(".ccv-pane-table tr[aria-current]")).toHaveText(
    "399",
  );
  await expect(page.locator(".ccv-pane-code li[aria-current]")).toHaveAttribute(
    "data-line",
    "4",
  );

  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
  await player.screenshot({
    path: `test-results/${info.project.name}-motion.png`,
  });
  expect(errors).toEqual([]);
});

test("playback pauses while the player is off-screen and resumes when it returns", async ({
  page,
}) => {
  await page.goto("/#offscreen");
  const player = page.locator(".ccv-player");
  const timeline = page.getByRole("slider", { name: "Timeline", exact: true });
  await page.getByRole("button", { name: "Play animation" }).click();
  await expect
    .poll(async () => Number(await timeline.inputValue()))
    .toBeGreaterThan(0);
  await page.locator("#page-end").scrollIntoViewIfNeeded();
  await expect(player).toHaveAttribute("data-offscreen", "paused");
  const held = Number(await timeline.inputValue());
  await page.waitForTimeout(500);
  expect(Number(await timeline.inputValue())).toBe(held);
  await page.evaluate(() => scrollTo(0, 0));
  await expect(player).not.toHaveAttribute("data-offscreen", "paused");
  await expect(
    page.getByRole("button", { name: "Pause animation" }),
  ).toBeVisible();
  await expect
    .poll(async () => Number(await timeline.inputValue()))
    .toBeGreaterThan(held);
  // A viewer's pause is kept across scrolling.
  await page.getByRole("button", { name: "Pause animation" }).click();
  await page.locator("#page-end").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, 0));
  await expect(
    page.getByRole("button", { name: "Play animation" }),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id),
  ).toEqual([]);
});

test("with reduced motion, scrolling never starts playback", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#offscreen");
  const timeline = page.getByRole("slider", { name: "Timeline", exact: true });
  await expect(
    page.getByRole("button", { name: "Play animation" }),
  ).toBeDisabled();
  const start = await timeline.inputValue();
  await page.locator("#page-end").scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(300);
  expect(await timeline.inputValue()).toBe(start);
  await expect(page.locator(".ccv-player")).not.toHaveAttribute(
    "data-offscreen",
    "paused",
  );
});
