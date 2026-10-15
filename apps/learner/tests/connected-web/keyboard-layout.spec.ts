import { test, expect, type Page } from "@playwright/test";

/* An on-screen keyboard shrinks only the visual viewport on iOS and on current
 * Android Chrome; the layout viewport (window/document size) stays put. Chromium
 * cannot open a real keyboard here, so this suite replaces `window.visualViewport`
 * before the app loads with a proxy whose height can be lowered and that fires
 * `resize` like a keyboard would. Physical-device verification is separate. */
declare global {
  interface Window {
    __keyboard(height: number | null): void;
  }
}

async function installKeyboardSimulator(page: Page) {
  await page.addInitScript(() => {
    const real = window.visualViewport;
    if (!real) return;
    let height: number | null = null;
    const fake = new EventTarget();
    for (const key of ["width", "offsetLeft", "offsetTop", "pageLeft", "pageTop", "scale"] as const)
      Object.defineProperty(fake, key, { get: () => real[key] });
    Object.defineProperty(fake, "height", { get: () => height ?? real.height });
    for (const type of ["resize", "scroll"])
      real.addEventListener(type, () => fake.dispatchEvent(new Event(type)));
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    window.__keyboard = (next) => {
      height = next;
      fake.dispatchEvent(new Event("resize"));
    };
  });
}

async function layoutState(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector(".connected-host")!,
      main = document.querySelector<HTMLElement>(".connected-main")!,
      active = document.activeElement as HTMLTextAreaElement | null;
    return {
      compact: host.classList.contains("is-compact"),
      withCompanion: document.querySelector(".connected-layout")!.classList.contains("with-companion"),
      dock: document.querySelector("#connected-companion")!.className,
      activeLabel: active?.getAttribute("aria-label") ?? null,
      selection: [active?.selectionStart ?? null, active?.selectionEnd ?? null],
      windowScroll: Math.round(window.scrollY),
      mainScroll: Math.round(main.scrollTop),
    };
  });
}

async function settle(page: Page) {
  // Two frames: React commits a dimension change on the next render after `resize`.
  for (let i = 0; i < 2; i++)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}

test("an on-screen keyboard does not flip the learner layout while typing", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await installKeyboardSimulator(page);
  // Landscape tablet is the case at risk: wide enough for the side-by-side layout.
  if (/tablet|ipad/.test(info.project.name)) await page.setViewportSize({ width: 1194, height: 834 });
  const token = (await (await request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();

  const wide = !/phone/.test(info.project.name);
  if (wide) await expect(page.getByRole("complementary", { name: "Your companion" })).toBeVisible();
  else await page.getByRole("button", { name: "Companion", exact: true }).click();
  const draft = page.getByRole("textbox", { name: "Message to your companion", exact: true });
  await draft.fill("Why is the smallest value first?");
  await draft.focus();
  await draft.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 9));
  // Scroll the page's own scroll container so a container swap would show up.
  await page.evaluate(() => {
    window.scrollTo(0, 120);
    document.querySelector<HTMLElement>(".connected-main")!.scrollTop = 80;
  });
  await settle(page);
  const before = await layoutState(page);
  expect(before.compact).toBe(!wide);
  expect(before.withCompanion).toBe(wide);
  expect(before.activeLabel).toBe("Message to your companion");
  expect(before.selection).toEqual([4, 9]);

  const viewport = page.viewportSize()!;
  // A tablet keyboard takes roughly half of a landscape screen.
  await page.evaluate((h) => window.__keyboard(h), Math.round(viewport.height * 0.45));
  await settle(page);
  expect(await page.evaluate(() => window.visualViewport!.height)).toBeLessThan(620);
  expect(await layoutState(page)).toEqual(before);
  if (wide) {
    await expect(page.getByRole("complementary", { name: "Your companion" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Your companion" })).toHaveCount(0);
  } else await expect(page.getByRole("dialog", { name: "Your companion" })).toBeVisible();
  await expect(draft).toBeFocused();
  await page.keyboard.type("X");
  await expect(draft).toHaveValue("Why Xe smallest value first?");

  // Keyboard closes: still the same layout, focus and scroll.
  await page.evaluate(() => window.__keyboard(null));
  await settle(page);
  expect(await layoutState(page)).toEqual({ ...before, selection: [5, 5] });

  if (wide) {
    // Browsers that shrink the layout viewport for the keyboard as well: the
    // height-only shrink is held back while the field is focused...
    await page.setViewportSize({ width: viewport.width, height: 560 });
    await settle(page);
    expect((await layoutState(page)).compact).toBe(false);
    await expect(draft).toBeFocused();
    // ...and applied once editing ends, so a genuinely short window is compact.
    await draft.blur();
    await expect(page.locator(".connected-host")).toHaveClass(/is-compact/);
    await page.setViewportSize(viewport);
    await expect(page.locator(".connected-host")).not.toHaveClass(/is-compact/);
    // A width change (rotation/resize) applies immediately even while typing.
    await draft.focus();
    await page.setViewportSize({ width: 560, height: viewport.height });
    await expect(page.locator(".connected-host")).toHaveClass(/is-compact/);
    await page.setViewportSize(viewport);
  }
  expect(errors).toEqual([]);
});
