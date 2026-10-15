import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/* I05/P05/S12 on the connected lesson: 44 px targets in the lesson and the
 * companion, reflow at 200% and 400% zoom, forced colours, and the answer
 * actions staying above an on-screen keyboard. */

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
    .getByRole("button", { name: "Continue learning →", exact: true })
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

/** Every visible control in `scope` smaller than 44×44 CSS px. Inline links in
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
      if (rect.width < 44 - 0.5 || rect.height < 44 - 0.5)
        small.push(
          `${(target.getAttribute("aria-label") ?? target.textContent ?? target.tagName).trim().slice(0, 40)} ${Math.round(rect.width)}×${Math.round(rect.height)}`,
        );
    }
    return small;
  }, scope);
}

test("44 px targets across the connected lesson, header and companion", async ({
  page,
}) => {
  await openCheck(page);
  expect(
    await smallTargets(page, ".connected-header, .connected-lesson-keeper"),
  ).toEqual([]);
  const trigger = page.locator(".connected-companion-trigger");
  if (await trigger.isVisible()) await trigger.click();
  await expect(page.locator("#connected-companion")).toBeVisible();
  expect(
    await smallTargets(
      page,
      "#connected-companion, .connected-companion-trigger",
    ),
  ).toEqual([]);
  if (await page.getByRole("dialog", { name: "Your companion" }).isVisible())
    await page.keyboard.press("Escape");
  await page.locator(".connected-menu-toggle").click();
  expect(await smallTargets(page, ".connected-menu-panel")).toEqual([]);
});

for (const [zoom, size] of [
  ["200%", { width: 640, height: 400 }],
  ["400%", { width: 320, height: 640 }],
] as const)
  test(`reflows at ${zoom} zoom without horizontal scrolling or hidden actions`, async ({
    page,
  }, info) => {
    test.skip(
      !info.project.name.endsWith("desktop"),
      "Zoom is emulated from the desktop window.",
    );
    // A 1280×800 window at 200% (or 1280×2560 at 400%) lays out in this many CSS px.
    await page.setViewportSize(size);
    await openCheck(page);
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
      page.getByRole("button", { name: "Check answer", exact: true }),
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
    await page.screenshot({
      path: info.outputPath(`zoom-${zoom.replace("%", "")}.png`),
    });
  });

test("forced colours keep every control and the current step visible", async ({
  page,
  browserName,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openCheck(page);
  test.skip(
    !(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)),
    "This engine cannot emulate forced colours.",
  );
  const borderless = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.connected-host button, .connected-host [role="button"], .connected-host summary',
      ),
    )
      .filter((el) => !el.closest("[hidden]") && el.getClientRects().length > 0)
      .filter((el) => {
        const style = getComputedStyle(el);
        return (
          style.borderTopStyle === "none" ||
          parseFloat(style.borderTopWidth) === 0
        );
      })
      .map((el) =>
        (el.getAttribute("aria-label") ?? el.textContent ?? "")
          .trim()
          .slice(0, 40),
      ),
  );
  expect(borderless).toEqual([]);
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
  const check = page.getByRole("button", { name: "Check answer", exact: true });
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
