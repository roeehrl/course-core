import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Every id is unique on the page and every url(#…)/href="#…" resolves inside its own <svg>. */
async function scopedReferences(page: Page) {
  return page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    const unresolved: string[] = [];
    let references = 0;
    for (const svg of document.querySelectorAll("svg.ccv-scene"))
      for (const el of svg.querySelectorAll("*"))
        for (const attr of [
          "clip-path",
          "mask",
          "fill",
          "stroke",
          "marker-end",
          "href",
        ]) {
          const value = el.getAttribute(attr) ?? "";
          const id = (attr === "href" ? /^#(.+)$/ : /^url\(#(.+)\)$/).exec(
            value,
          )?.[1];
          if (!id) continue;
          references++;
          if (!svg.querySelector(`[id="${id}"]`))
            unresolved.push(`${attr}=${value}`);
        }
    return {
      duplicates: ids.length - new Set(ids).size,
      references,
      unresolved,
    };
  });
}

test("clip, mask, symbol/use and equation nodes render, fit the viewport and pass axe", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/");
  await page.getByRole("tab", { name: "04 · Clip, mask & equations" }).click();
  const svg = page.locator(".ccv-scene");
  await expect(svg).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(svg.locator("clipPath")).toHaveCount(1);
  await expect(svg.locator("mask")).toHaveCount(1);
  await expect(svg.locator("symbol")).toHaveCount(1);
  await expect(svg.locator("use")).toHaveCount(3);
  await expect(
    page.getByRole("img", { name: "y equals sine of omega t" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /^sigma of z, sub i/ }),
  ).toBeVisible();

  // The slider changes how many symbol instances render, and each instance has real size.
  await page
    .getByRole("slider", { name: "Tokens shown", exact: true })
    .fill("5");
  await expect(svg.locator("use")).toHaveCount(5);
  const sizes = await svg
    .locator("use")
    .evaluateAll((uses) =>
      uses.map((u) => (u as SVGGraphicsElement).getBoundingClientRect().width),
    );
  expect(sizes.every((w) => w > 10)).toBe(true);

  // The clip window follows the timeline: closed at 0 s, wide at the end.
  const timeline = page.getByRole("slider", { name: "Timeline", exact: true });
  const clipWidth = () =>
    svg
      .locator("clipPath rect")
      .evaluate((r) => Number(r.getAttribute("width")));
  await timeline.fill("0");
  await expect.poll(clipWidth).toBe(0);
  await timeline.fill("5000");
  await expect.poll(clipWidth).toBeGreaterThan(100);

  // Masked bars draw, and nothing (equation glyphs included) leaves the scene box.
  expect(
    await svg.locator('[data-node-id="fadeBar1"]').boundingBox(),
  ).not.toBeNull();
  const outside = await svg.evaluate((root) => {
    const outer = root.getBoundingClientRect();
    return [...root.querySelectorAll(":scope > g text")].flatMap((text) => {
      const rect = text.getBoundingClientRect();
      return rect.left < outer.left - 2 ||
        rect.right > outer.right + 2 ||
        rect.top < outer.top - 2 ||
        rect.bottom > outer.bottom + 2
        ? [text.textContent]
        : [];
    });
  });
  expect(outside).toEqual([]);
  const page_ = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(page_.scroll).toBeLessThanOrEqual(page_.width);

  // MathML text equivalent for each equation.
  await page.locator(".ccv-text summary").click();
  await expect(page.locator(".ccv-equations math")).toHaveCount(2);

  const refs = await scopedReferences(page);
  expect(refs).toEqual({
    duplicates: 0,
    references: refs.references,
    unresolved: [],
  });
  expect(refs.references).toBeGreaterThan(5);

  const axe = await new AxeBuilder({ page }).analyze();
  expect(
    axe.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  ).toEqual([]);
  await page
    .locator(".ccv-player")
    .screenshot({ path: `test-results/${info.project.name}-primitives.png` });
  expect(errors).toEqual([]);
});

test("two instances of one scene on a page keep their definitions apart", async ({
  page,
}) => {
  await page.goto("/#pair");
  await expect(page.locator(".ccv-scene")).toHaveCount(2);
  const refs = await scopedReferences(page);
  expect(refs).toEqual({
    duplicates: 0,
    references: refs.references,
    unresolved: [],
  });
  // Same scene, different ids: the second instance's clip is its own element.
  const clips = await page
    .locator("clipPath")
    .evaluateAll((c) => c.map((e) => e.id));
  expect(clips).toHaveLength(2);
  expect(new Set(clips).size).toBe(2);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});
