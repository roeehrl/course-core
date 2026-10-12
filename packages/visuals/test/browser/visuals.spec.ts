import { expect, test } from "@playwright/test";

test("all scenes render at the viewport, preserve controls on resize, and have no horizontal overflow", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  for (let i = 0; i < 3; i++) {
    await page.getByRole("tab").nth(i).click();
    await expect(page.locator(".ccv-scene")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    // SVG text must fit its viewBox; this catches invisible clipping, not just DOM overflow.
    const outside = await page.locator(".ccv-scene").evaluate((svg) => {
      return [...svg.querySelectorAll("text")].flatMap((text) => {
        const rect = text.getBoundingClientRect(),
          outer = svg.getBoundingClientRect();
        return rect.left < outer.left - 2 ||
          rect.right > outer.right + 2 ||
          rect.top < outer.top - 2 ||
          rect.bottom > outer.bottom + 2
          ? [text.textContent]
          : [];
      });
    });
    expect(outside).toEqual([]);
    if (i === 0 || i === 2)
      await page
        .locator(".ccv-player")
        .screenshot({ path: `test-results/${info.project.name}-${i}.png` });
  }
  await page
    .getByRole("combobox", { name: "Current stage", exact: true })
    .selectOption("Reflect");
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(
    page.getByRole("combobox", { name: "Current stage", exact: true }),
  ).toHaveValue("Reflect");
  expect(errors).toEqual([]);
});
test("play/pause/seek, keyboard activation and pointer manipulation update actual SVG", async ({
  page,
}) => {
  await page.goto("/");
  const play = page.getByRole("button", { name: "Play animation" });
  await play.click();
  await expect(
    page.getByRole("button", { name: "Pause animation" }),
  ).toBeVisible();
  await page.waitForTimeout(180);
  await page.getByRole("button", { name: "Pause animation" }).click();
  const slider = page.getByRole("slider", { name: "Timeline", exact: true });
  expect(Number(await slider.inputValue())).toBeGreaterThan(0);
  await slider.fill("5000");
  await expect(slider).toHaveValue("5000");
  await page.getByRole("tab").nth(1).click();
  const target = page.locator('[data-node-id="target"]');
  await target.focus();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("slider", { name: "Target position", exact: true }),
  ).toHaveValue("0");
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("slider", { name: "Target position", exact: true }),
  ).toHaveValue("1");
  const before = await target.getAttribute("transform");
  await page.keyboard.press("End");
  await expect(
    page.getByRole("slider", { name: "Target position", exact: true }),
  ).toHaveValue("100");
  expect(await target.getAttribute("transform")).not.toBe(before);
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bounds!.x - 100, bounds!.y + bounds!.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  expect(
    Number(
      await page
        .getByRole("slider", { name: "Target position", exact: true })
        .inputValue(),
    ),
  ).toBeLessThan(100);
  await page.getByRole("tab").nth(2).click();
  await page.locator('[data-node-id="name1"] text').click();
  await expect(
    page.getByRole("combobox", { name: "Current stage", exact: true }),
  ).toHaveValue("Explore");
  await page.getByRole("button", { name: "Select Reflect." }).focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("combobox", { name: "Current stage", exact: true }),
  ).toHaveValue("Reflect");
});
test("reduced motion starts on representative frame, disables animation, keeps keyboard controls and text", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Play animation" }),
  ).toBeDisabled();
  await expect(page.locator(".ccv-text")).toHaveAttribute("open", "");
  await expect(page.locator(".ccv-text")).toContainText("completed order");
  await page.getByRole("tab").nth(1).click();
  const slider = page.getByRole("slider", { name: "Timeline", exact: true });
  await expect(slider).toHaveValue("3000");
  await page.waitForTimeout(100);
  await expect(slider).toHaveValue("3000");
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("3010");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    page.getByRole("button", { name: "Play animation" }),
  ).toBeEnabled();
});
