import { expect, test, type Page } from "@playwright/test";
import {
  disclosureMarkers,
  expectOneIndicatorEach,
  expectToggleSemantics,
} from "../disclosureMarkers";

/* Every <details> in the connected lesson shows one disclosure indicator: the
 * design's chevron, never also the engine's own marker (older Safari/iOS drew
 * a stray "▸" through ::-webkit-details-marker). The open/closed state stays
 * the native <details> expanded state. Runs at phone/tablet/desktop and on
 * WebKit (desktop, iPhone, iPad). */

async function openLessonWithHelp(page: Page) {
  const signIn = await page.request.post("/test/media-session");
  expect(signIn.ok()).toBeTruthy();
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  const resources = page.locator("details.connected-resources");
  await expect(resources).toBeVisible();
  return resources;
}

test("each lesson disclosure shows one chevron that follows its expanded state", async ({
  page,
}, info) => {
  const resources = await openLessonWithHelp(page);
  const markers = await expectOneIndicatorEach(page);
  expect(markers.map((marker) => marker.label).join(" | ")).toContain(
    "reviewed resource",
  );
  await expectToggleSemantics(page, resources);
  // The chevron sits in the summary's own start padding, inside the summary
  // box and clear of its text, at every window class.
  const geometry = await resources
    .locator(":scope > summary")
    .evaluate((el) => {
      const box = el.getBoundingClientRect();
      const first = el.firstElementChild!.getBoundingClientRect();
      const padding = parseFloat(getComputedStyle(el).paddingInlineStart);
      return {
        left: box.left,
        textLeft: first.left,
        padding,
        width: box.width,
      };
    });
  expect(geometry.padding).toBeGreaterThanOrEqual(18);
  expect(geometry.textLeft - geometry.left).toBeGreaterThanOrEqual(18);
  await resources.locator(":scope > summary").screenshot({
    path: info.outputPath("resources-summary.png"),
  });
});

test("forced colours keep the single chevron visible in the system text colour", async ({
  page,
}, info) => {
  await page.emulateMedia({ forcedColors: "active" });
  const resources = await openLessonWithHelp(page);
  // Every engine CI runs emulates forced colours; losing that fails instead of skipping.
  expect(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
  ).toBe(true);
  await expectOneIndicatorEach(page);
  await expectToggleSemantics(page, resources);
  // The chevron keeps clear of the summary's forced-colours border.
  const gap = await resources.locator(":scope > summary").evaluate((el) => {
    const before = getComputedStyle(el, "::before");
    return parseFloat(before.insetInlineStart || before.left);
  });
  expect(gap).toBeGreaterThanOrEqual(8);
  await resources.locator(":scope > summary").screenshot({
    path: info.outputPath("resources-summary-forced.png"),
  });
});

test("the marker check flags a disclosure that still draws the engine's marker", async ({
  page,
}) => {
  await openLessonWithHelp(page);
  // A bare <details> outside the host's styles keeps the native marker and has
  // no chevron; the check must report it, or it proves nothing.
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "marker-probe";
    probe.innerHTML = "<details><summary>Unstyled details</summary>x</details>";
    document.body.append(probe);
  });
  expect(await disclosureMarkers(page, "#marker-probe")).toEqual([
    expect.objectContaining({ nativeMarker: true, chevron: false }),
  ]);
});
