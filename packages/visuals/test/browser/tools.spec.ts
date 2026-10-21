import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { motionStudyDemo } from "../../src/demos.js";
import { flattenNodes } from "../../src/geometry.js";
import { VisualRuntime } from "../../src/runtime.js";

test("the inspector drives the player, shows computed node properties and runs publish checks", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/#inspector");
  const inspector = page.locator(".ccv-inspector");
  await expect(inspector).toBeVisible();
  // Jump to a keyframe: the player follows (one runtime).
  await inspector.getByRole("button", { name: "2.40 s" }).click();
  await expect(
    page.getByRole("slider", { name: "Timeline", exact: true }),
  ).toHaveValue("2400");
  await expect(
    inspector.getByRole("button", { name: "2.40 s" }),
  ).toHaveAttribute("aria-pressed", "true");
  // The node table shows the same computed value the headless runtime does.
  await inspector.getByLabel("Selected node").selectOption("pointer");
  const runtime = new VisualRuntime(motionStudyDemo);
  runtime.seek(2400);
  const pointer = flattenNodes(runtime.getSnapshot().frame.nodes).find(
    (n) => n.id === "pointer",
  )!;
  await expect(
    inspector
      .locator("tr")
      .filter({ has: page.locator("th", { hasText: /^x$/ }) })
      .locator("td"),
  ).toHaveText(String(Number(pointer.x.toFixed(3))));
  await inspector.getByRole("button", { name: "Run checks" }).click();
  // The first status is the checks'; the export controls have their own.
  await expect(inspector.getByRole("status").first()).toHaveText(
    "All checks pass at every layout.",
  );
  // The preview shows every layout of the set, at the same time as the player.
  await expect(page.locator(".ccv-preview figcaption")).toHaveText([
    "Phone · 390 px · COMPACT",
    "Tablet portrait · 768 px · TABLET PORTRAIT",
    "Tablet landscape · 1024 px · TABLET LANDSCAPE",
    "Desktop · 1440 px · WIDE",
  ]);
  await expect(
    page.locator('.ccv-preview [data-node-id="pointer"]'),
  ).toHaveCount(4);
  await inspector.getByRole("button", { name: "5.10 s" }).click();
  for (const transform of await page
    .locator('.ccv-preview [data-node-id="pointer"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("transform"))))
    expect(transform).not.toBeNull();
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
  await page.screenshot({
    path: `test-results/${info.project.name}-tools.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("inspector parameters cover every state field and update the player and preview", async ({
  page,
}) => {
  await page.goto("/#inspector-state");
  const inspector = page.locator(".ccv-inspector");
  const count = inspector.getByLabel(/Tokens shown/);
  await count.fill("5");
  await expect(
    page.getByRole("slider", { name: "Tokens shown", exact: true }),
  ).toHaveValue("5");
  await expect(page.locator(".ccv-player .ccv-scene use")).toHaveCount(5);
  await expect(
    page.locator(".ccv-preview .ccv-scene").first().locator("use"),
  ).toHaveCount(5);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});
