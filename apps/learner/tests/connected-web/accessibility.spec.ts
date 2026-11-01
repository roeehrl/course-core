import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { closeCompanion, openCompanion } from "./companion-helpers";

/* I04/I05/P05/S12 on the connected lesson: control targets in the lesson and the
 * companion (24 px with a fine pointer, 44 px with a coarse one), prose line length, reflow at 200% and 400% browser zoom
 * (the course page, the lesson with its check and the companion, with no two-way scrolling
 * outside code, tables and math), forced colours on the same surfaces, and the answer actions
 * staying above an on-screen keyboard. The manual screen-reader traversal is in docs/accessibility.md. */

declare global {
  interface Window {
    __keyboard(height: number | null): void;
  }
}

async function installKeyboardSimulator(page: Page) {
  // Chromium cannot open a real keyboard; shrink a proxied visualViewport instead.
  await page.addInitScript(() => {
    const real = window.visualViewport;
    if (!real) return;
    let height: number | null = null;
    const fake = new EventTarget();
    for (const key of [
      "width",
      "offsetLeft",
      "offsetTop",
      "pageLeft",
      "pageTop",
      "scale",
    ] as const)
      Object.defineProperty(fake, key, { get: () => real[key] });
    Object.defineProperty(fake, "height", { get: () => height ?? real.height });
    for (const type of ["resize", "scroll"])
      real.addEventListener(type, () => fake.dispatchEvent(new Event(type)));
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      get: () => fake,
    });
    window.__keyboard = (next) => {
      height = next;
      fake.dispatchEvent(new Event("resize"));
    };
  });
}

async function openCheck(page: Page) {
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeVisible();
}

/** Every visible control in `scope` smaller than its minimum target: 24×24 CSS px under a fine
 * pointer, 44×44 under a coarse one (touch; the phone and tablet projects emulate it). Inline links in
 * running text are exempt (WCAG 2.5.5/2.5.8 inline exception); a native radio or
 * checkbox counts by its whole label. */
async function smallTargets(page: Page, scope: string) {
  return page.evaluate((selector) => {
    const roots = Array.from(document.querySelectorAll(selector));
    const controls = roots.flatMap((root) =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [role="button"], a[href], summary, select, textarea, input, [role="radio"], [role="checkbox"], [tabindex="0"]',
        ),
      ),
    );
    const small: string[] = [];
    const minimum = window.matchMedia("(pointer: coarse)").matches ? 44 : 24;
    for (const control of new Set(controls)) {
      if (control.closest("[hidden]") || control.getClientRects().length === 0)
        continue;
      if (
        control.tagName === "A" &&
        getComputedStyle(control).display === "inline"
      )
        continue;
      const target = control.matches(
        'input[type="radio"], input[type="checkbox"]',
      )
        ? (control.closest("label") ?? control)
        : control;
      const rect = target.getBoundingClientRect();
      if (rect.width < minimum - 0.5 || rect.height < minimum - 0.5)
        small.push(
          `${(target.getAttribute("aria-label") ?? target.textContent ?? target.tagName).trim().slice(0, 40)} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
        );
    }
    return small;
  }, scope);
}

/** What scrolls or overflows sideways: the page itself, and any box that scrolls sideways outside
 * code, tables and math (the only places a reader may scroll in two directions, final design §6). */
async function sidewaysScroll(page: Page) {
  return page.evaluate(() => {
    const wide = (el: Element) => el.scrollWidth > el.clientWidth + 1;
    const found = wide(document.documentElement) ? ["page"] : [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".connected-host *, .connected-portal *"))) {
      if (!wide(el) || el.getClientRects().length === 0) continue;
      const overflow = getComputedStyle(el).overflowX;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      if (el.closest('pre, code, table, math, [role="math"], .math-formula, .markdown-table, .connected-code-editor, .connected-practice-output')) continue;
      found.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 2).join(".")} ${el.scrollWidth}>${el.clientWidth}`);
    }
    return found;
  });
}

test("control targets across the connected lesson, header and companion: 24 px, 44 px on touch", async ({
  page,
}) => {
  await openCheck(page);
  expect(
    await smallTargets(page, ".connected-header, .connected-lesson-keeper"),
  ).toEqual([]);
  const trigger = page.locator(".connected-companion-trigger");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(page.locator("#connected-companion")).toBeVisible();
  expect(
    await smallTargets(
      page,
      "#connected-companion, .connected-companion-trigger",
    ),
  ).toEqual([]);
  if (await page.locator(".connected-host.is-compact").count()) await closeCompanion(page);
  await page.locator(".connected-menu-toggle").click();
  expect(await smallTargets(page, ".connected-menu-panel")).toEqual([]);
  // Under a coarse pointer the companion's own controls are 44×44 at least (final design §1.3):
  // Send and Stop, Close, Expand, the sheet handle, Jump to latest and the height buttons.
  if (await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)) {
    await page.keyboard.press("Escape");
    const panel = await openCompanion(page);
    const sizes = await panel
      .getByRole("button", { name: /^(Send|Stop reply|Close companion|Expand|Jump to latest)$/ })
      .or(panel.locator("[data-companion-control]"))
      .evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length).map((node) => {
        const rect = node.getBoundingClientRect();
        return `${(node.getAttribute("aria-label") ?? node.textContent ?? "").trim()} ${Math.round(rect.width)}×${Math.round(rect.height)}`;
      }));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) {
      const [w, h] = size.split(" ").at(-1)!.split("×").map(Number);
      expect(Math.min(w!, h!), size).toBeGreaterThanOrEqual(44);
    }
    await closeCompanion(page);
  }
});

test("lesson prose keeps a readable line length (I04)", async ({ page }, info) => {
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  const prose = page.locator(".connected-reading-card .connected-prose");
  await expect(prose.first()).toBeVisible();
  // Characters per line: each prose block's width over the width of "0" in its own
  // font (the CSS `ch`), and the widest line actually laid out.
  const measure = await prose.first().evaluate((root) => {
    const canvas = document.createElement("canvas").getContext("2d")!;
    const blocks = Array.from(root.querySelectorAll<HTMLElement>("[dir]"))
      .filter((el) => el.textContent?.trim() && el.getClientRects().length)
      .map((el) => {
        const style = getComputedStyle(el);
        canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const ch = canvas.measureText("0").width;
        const range = document.createRange();
        range.selectNodeContents(el);
        const widest = Math.max(
          ...Array.from(range.getClientRects()).map((rect) => rect.width),
        );
        return {
          box: el.getBoundingClientRect().width / ch,
          line: widest / ch,
        };
      });
    const card = root.closest(".connected-reading-card")!.getBoundingClientRect();
    return {
      blocks,
      prose: root.getBoundingClientRect().width,
      card: card.width,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(measure.blocks.length).toBeGreaterThan(0);
  for (const block of measure.blocks) {
    expect(block.box).toBeLessThanOrEqual(75);
    expect(block.line).toBeLessThanOrEqual(75);
  }
  expect(measure.overflow).toBeLessThanOrEqual(1);
  if (info.project.name.endsWith("desktop"))
    // The card keeps the full column; only the prose measure is narrower.
    expect(measure.prose).toBeLessThan(measure.card - 80);
  else
    // Phones and tablets: the prose uses the card's width, no forced narrow column.
    expect(measure.prose).toBeGreaterThan(Math.min(measure.card - 80, 300));
});

/* Browser zoom (Ctrl/Cmd +) in Chromium is a device-scale change: at 200% a
 * 1280×800 window has devicePixelRatio 2 and lays out in 640×400 CSS px, and
 * every length, media query and resolution query follows from that. A context
 * with deviceScaleFactor = zoom and viewport = window / zoom reproduces that
 * state exactly; the test checks the page sees it (devicePixelRatio, innerWidth,
 * resolution media query) and that the screenshot has the window's physical
 * size. It does not cover text-only zoom (Firefox "Zoom text only", Safari's
 * text size) or OS-level magnifiers; docs/accessibility.md lists the manual checks. */
for (const [zoom, factor, physical] of [
  ["200%", 2, { width: 1280, height: 800 }],
  ["400%", 4, { width: 1280, height: 2560 }],
] as const)
  // Zoom is applied to the desktop window; other projects exclude @desktop-window.
  test(`reflows at ${zoom} browser zoom without horizontal scrolling or hidden actions`, {
    tag: "@desktop-window",
  }, async ({ browser }, info) => {
    const size = {
      width: physical.width / factor,
      height: physical.height / factor,
    };
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: size,
      deviceScaleFactor: factor,
    });
    const page = await context.newPage();
    expect(
      await page.evaluate(() => ({
        ratio: window.devicePixelRatio,
        width: window.innerWidth,
        resolution: matchMedia(
          `(resolution: ${window.devicePixelRatio}dppx)`,
        ).matches,
      })),
    ).toEqual({ ratio: factor, width: size.width, resolution: true });
    // The course page first: its cards and the next-step button reflow too.
    const token = (await (await page.request.post("/test/session")).json()).token;
    await page.goto(`/#signin=${token}`);
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
      .getByRole("button", { name: "Open course", exact: true })
      .click();
    await page.getByRole("button", { name: "Start course", exact: true }).click();
    const start = page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ });
    await expect(start).toBeVisible();
    expect(await sidewaysScroll(page), "course page").toEqual([]);
    await start.scrollIntoViewIfNeeded();
    await expect(start).toBeInViewport();
    await start.click();
    await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
    await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
    await expect(page.getByRole("radio", { name: "2", exact: true })).toBeVisible();
    expect(await sidewaysScroll(page), "lesson with its check").toEqual([]);
    const overflow = await page.evaluate(() => {
      const wide = (el: Element) => el.scrollWidth > el.clientWidth + 1;
      return [
        wide(document.documentElement) ? "page" : "",
        ...Array.from(
          document.querySelectorAll(
            ".connected-reading-card, .connected-check, .connected-header",
          ),
        )
          .filter(wide)
          .map((el) => el.className),
      ].filter(Boolean);
    });
    expect(overflow).toEqual([]);
    for (const control of [
      page.getByRole("button", { name: "Check", exact: true }),
      page.locator(".connected-menu-toggle"),
      page.locator(".connected-companion-trigger"),
    ]) {
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }
    // A focused answer option is not hidden behind the sticky actions (2.4.11).
    const option = page.getByRole("radio", { name: "2", exact: true });
    await option.focus();
    const optionBox = (await option.boundingBox())!;
    const bar = (await page
      .locator(".connected-answer-actions")
      .boundingBox())!;
    expect(
      optionBox.y + optionBox.height <= bar.y + 1 ||
        optionBox.y >= bar.y + bar.height - 1,
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    const shot = await page.screenshot({
      path: info.outputPath(`zoom-${zoom.replace("%", "")}.png`),
    });
    // The physical window is unchanged: 1280 device pixels wide.
    expect(shot.readUInt32BE(16)).toBe(physical.width);
    // The companion reflows as well: its controls stay reachable and nothing in it scrolls sideways.
    const panel = await openCompanion(page);
    expect(await sidewaysScroll(page), "companion").toEqual([]);
    for (const name of ["Close companion", "Send"]) {
      const control = panel.getByRole("button", { name, exact: true });
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }
    await page.screenshot({ path: info.outputPath(`zoom-${zoom.replace("%", "")}-companion.png`) });
    await closeCompanion(page);
    await context.close();
  });

/** Controls, cards and notices with no visible edge once forced colours remove every fill. */
async function edgeless(page: Page) {
  return page.evaluate(() => {
    const noEdge = (el: Element) => {
      const style = getComputedStyle(el);
      return style.borderTopStyle === "none" || parseFloat(style.borderTopWidth) === 0;
    };
    const label = (el: Element) =>
      (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40);
    const shown = (el: Element) => !el.closest("[hidden]") && el.getClientRects().length > 0;
    return {
      controls: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.connected-host button, .connected-host [role="button"], .connected-host summary',
        ),
      )
        .filter(shown)
        .filter(noEdge)
        .map(label),
      // The base app's cards and notices (React Native cards, Notice, the reading card, menus).
      surfaces: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.connected-reading-card, .connected-menu-panel, .connected-signin, .connected-activity, .connected-policy-panel, .connected-toast, .connected-host [data-tone]',
        ),
      )
        .filter(shown)
        .filter(noEdge)
        .map((el) => `${el.className || el.getAttribute("data-tone")}: ${label(el)}`),
    };
  });
}

test("forced colours keep every control and the current step visible", async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  // The course page: every control and card keeps an edge.
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await expect(page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })).toBeVisible();
  // Every engine CI runs emulates forced colours; losing that fails instead of skipping.
  expect(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
  ).toBe(true);
  expect(await edgeless(page), "course page").toEqual({ controls: [], surfaces: [] });
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toBeVisible();
  expect(await edgeless(page), "lesson").toEqual({ controls: [], surfaces: [] });
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeVisible();
  expect(await edgeless(page), "check").toEqual({ controls: [], surfaces: [] });
  // The companion: its controls keep their edges too, docked or as a sheet.
  await openCompanion(page);
  expect((await edgeless(page)).controls, "companion").toEqual([]);
  await closeCompanion(page);
  const current = page.locator('.connected-step[aria-current="step"]');
  expect(
    parseFloat(
      await current.evaluate((el) => getComputedStyle(el).borderTopWidth),
    ),
  ).toBeGreaterThanOrEqual(3);
  // Keyboard focus (focus-visible) shows the system highlight outline. WebKit
  // does not move Tab focus to buttons by default, so this part is Chromium-only.
  if (browserName !== "chromium") return;
  await page.locator(".connected-menu-toggle").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator(".connected-menu-toggle")).toBeFocused();
  expect(
    await page
      .locator(".connected-menu-toggle")
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe("none");
});

test("the answer actions stay above an on-screen keyboard", async ({
  page,
}, info) => {
  await installKeyboardSimulator(page);
  if (info.project.name.endsWith("desktop"))
    await page.setViewportSize({ width: 390, height: 844 });
  await openCheck(page);
  const check = page.getByRole("button", { name: "Check", exact: true });
  // The learner is at the question; a keyboard then covers where the actions
  // would naturally be.
  await page
    .getByText("Which is smaller?")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  const natural = (await check.boundingBox())!;
  const covered = Math.round(natural.y - 20);
  expect(covered).toBeGreaterThan(80);
  await page.evaluate((h) => window.__keyboard(h), covered);
  await expect
    .poll(async () => {
      const box = await check.boundingBox();
      const visible = await page.evaluate(
        () => window.visualViewport!.offsetTop + window.visualViewport!.height,
      );
      return box !== null && box.y >= 0 && box.y + box.height <= visible + 1;
    })
    .toBe(true);
  // Still pressable where it is shown.
  expect(
    await check.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
      );
    }),
  ).toBe(true);
  await page.evaluate(() => window.__keyboard(null));
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.querySelector(".connected-host")!)
          .getPropertyValue("--keyboard-inset")
          .trim(),
      ),
    )
    .toBe("0px");
});
