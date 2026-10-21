import { AxeBuilder } from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { lensDemo } from "../../src/demos.js";
import { VisualRuntime } from "../../src/runtime.js";
import { renderSvg } from "../../src/svg.js";

test("the 0.5 primitives render in the browser: image, radial gradient, matrix, morph, colour, camera", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("tab", { name: /Zoom, morph/ }).click();
  const scene = page.locator(".ccv-scene");
  await expect(scene).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  // The embedded image decodes (naturalWidth comes from the PNG itself).
  const image = scene.locator("image");
  await expect(image).toHaveAttribute("aria-label", /checkered tile/);
  const decoded = await image.evaluate(async (el) => {
    const img = new Image();
    img.src = el.getAttribute("href")!;
    await img.decode();
    return img.naturalWidth;
  });
  expect(decoded).toBe(16);
  await expect(scene.locator("radialGradient")).toHaveCount(1);
  await expect(
    scene.locator('[role="img"][aria-label^="R equals"]'),
  ).toHaveCount(1);
  // Seek: the camera zooms (viewBox), the shape morphs and changes colour, as headless.
  const slider = page.getByRole("slider", { name: "Timeline", exact: true });
  await slider.fill("2000");
  const runtime = new VisualRuntime(lensDemo, {
    viewportWidth: await scene.evaluate((svg) =>
      Math.round(
        svg.parentElement!.closest(".ccv-player")!.getBoundingClientRect()
          .width,
      ),
    ),
  });
  const frame = runtime.seek(2000);
  await expect(scene).toHaveAttribute("viewBox", "120 57.5 400 225");
  const shape = scene.locator('[data-node-id="lensShape"]');
  await expect(shape).toHaveAttribute("fill", "#0f8a7a");
  await expect(shape.locator("path")).toHaveAttribute(
    "d",
    "M0 -56 L56 0 L0 56 L-56 0 Z",
  );
  expect(frame.camera).toEqual({ x: 320, y: 170, zoom: 1.6 });
  // Pointer-free controls still work under the camera: the rotation slider turns the shape.
  await page.getByRole("slider", { name: "Rotation (degrees)" }).fill("45");
  await expect(shape).toHaveAttribute("transform", /matrix\(0\.7071/);
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await page
    .locator(".ccv-player")
    .screenshot({ path: `test-results/${info.project.name}-lens.png` });
  expect(errors).toEqual([]);
});

test("export downloads the headless SVG and a PNG of the current frame; previews show device chrome", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#inspector-lens");
  const inspector = page.locator(".ccv-inspector");
  await inspector.getByRole("button", { name: "2.00 s" }).click();
  const [svgDownload] = await Promise.all([
    page.waitForEvent("download"),
    inspector.getByRole("button", { name: "Download SVG" }).click(),
  ]);
  expect(svgDownload.suggestedFilename()).toBe("lens-study-2000ms.svg");
  const svg = await readFile((await svgDownload.path())!, "utf8");
  const runtime = new VisualRuntime(lensDemo, {
    viewportWidth: await page
      .locator(".ccv-player")
      .first()
      .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
  });
  expect(svg).toBe(
    renderSvg(runtime.seek(2000), {
      idPrefix: "export",
      title: lensDemo.title,
      xmlns: true,
    }),
  );
  await expect(inspector.getByRole("status").last()).toHaveText(
    "Saved lens-study-2000ms.svg.",
  );
  const [pngDownload] = await Promise.all([
    page.waitForEvent("download"),
    inspector.getByRole("button", { name: "Download PNG" }).click(),
  ]);
  expect(pngDownload.suggestedFilename()).toBe("lens-study-2000ms.png");
  const png = await readFile((await pngDownload.path())!);
  expect([...png.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  // IHDR: twice the layout size.
  expect(png.readUInt32BE(16)).toBe(runtime.getSnapshot().frame.width * 2);
  // Device chrome around each preview; decorative parts are hidden from assistive tech.
  for (const chrome of ["phone", "tablet", "desktop"])
    await expect(page.locator(`.ccv-device-${chrome}`).first()).toBeVisible();
  await expect(page.locator(".ccv-device-bar[aria-hidden='true']")).toHaveCount(
    4,
  );
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await page
    .locator(".ccv-preview")
    .screenshot({ path: `test-results/${info.project.name}-chrome.png` });
  expect(errors).toEqual([]);
});

test("completion is reported once: playback to the end, then replay, scrubbing and reset add nothing", async ({
  page,
}) => {
  await page.goto("/#completion");
  const count = page.locator("#completions");
  await expect(count).toHaveText("Completions: 0");
  const slider = page.getByRole("slider", { name: "Timeline", exact: true });
  await page.getByRole("button", { name: "Play animation" }).click();
  await expect(count).toHaveText("Completions: 1", { timeout: 15_000 });
  await expect(slider).toHaveValue("4000");
  // Replay to the end, scrub across the end repeatedly, reset and play again.
  await page.getByRole("button", { name: "Play animation" }).click();
  await expect(slider).toHaveValue("4000", { timeout: 15_000 });
  for (const value of ["1000", "4000", "0", "4000", "3990", "4000"])
    await slider.fill(value);
  await page.getByRole("button", { name: "Reset" }).click();
  await slider.focus();
  await page.keyboard.press("End");
  await expect(slider).toHaveValue("4000");
  await page.waitForTimeout(200);
  await expect(count).toHaveText("Completions: 1");
});

test("a lazy player loads near the viewport, is disposed away from it, and keeps its state and completion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#lazy");
  const lazy = page.locator(".ccv-lazy");
  const state = page.locator("#runtime-state");
  // Far below the fold: nothing parsed or rendered, a placeholder with the text alternative.
  await expect(lazy).toHaveAttribute("data-lazy", "waiting");
  await expect(state).toHaveText("Runtime: none");
  await expect(lazy.locator("svg")).toHaveCount(0);
  await expect(lazy).toContainText("A purple square");
  await lazy.scrollIntoViewIfNeeded();
  await expect(lazy).toHaveAttribute("data-lazy", "loaded");
  await expect(state).toHaveText("Runtime: live");
  await page.getByRole("slider", { name: "Rotation (degrees)" }).fill("60");
  const slider = page.getByRole("slider", { name: "Timeline", exact: true });
  await slider.fill("4000");
  await expect(page.locator("#completions")).toHaveText("Completions: 1");
  await slider.fill("2000");
  const height = await lazy.evaluate((el) => el.getBoundingClientRect().height);
  // Away from the viewport for longer than disposeAfterMs: disposed, space kept.
  await page.evaluate(() => scrollTo(0, 0));
  await expect(state).toHaveText("Runtime: disposed");
  await expect(lazy).toHaveAttribute("data-lazy", "waiting");
  expect(
    Math.abs(
      (await lazy.evaluate((el) => el.getBoundingClientRect().height)) - height,
    ),
  ).toBeLessThan(2);
  // Back: restored with the same state and time; completion is not reported again.
  await lazy.scrollIntoViewIfNeeded();
  await expect(state).toHaveText("Runtime: live");
  await expect(
    page.getByRole("slider", { name: "Rotation (degrees)" }),
  ).toHaveValue("60");
  await expect(slider).toHaveValue("2000");
  await slider.fill("4000");
  await page.waitForTimeout(200);
  await expect(page.locator("#completions")).toHaveText("Completions: 1");
  // Eager (a debug tool inspecting it): loads while far away and is never disposed.
  await page.evaluate(() => scrollTo(0, 0));
  await expect(state).toHaveText("Runtime: disposed");
  await page.getByLabel("Keep loaded (as while inspecting)").check();
  await expect(state).toHaveText("Runtime: live");
  await page.waitForTimeout(600);
  await expect(state).toHaveText("Runtime: live");
  await page.getByLabel("Keep loaded (as while inspecting)").uncheck();
  // Keyboard users can load it without scrolling: the button loads it at once.
  await page.evaluate(() => scrollTo(0, 0));
  await expect(state).toHaveText("Runtime: disposed");
  await page.getByRole("button", { name: "Show the visual now" }).focus();
  await page.keyboard.press("Enter");
  await expect(state).toHaveText("Runtime: live");
  expect(errors).toEqual([]);
});
