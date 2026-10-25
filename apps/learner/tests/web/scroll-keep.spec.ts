import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mockSignedInLearner } from "./connectedAccount";

/**
 * Opening and closing the account menu, its dialogs and the notifications never scrolls the
 * page. Focus used to go back to the menu button in the sticky header without preventScroll, and
 * the header's scroll padding then scrolled the page up (417px in Chromium on a desktop, 81px in
 * WebKit on a tablet). Runs on Chromium and WebKit at phone, tablet and desktop sizes
 * (playwright.config.ts), from a page scrolled well below its top. Phones scroll the learning
 * pane, not the window: both are checked.
 *
 * The account dialogs' close button shows an icon only. Its name ("Close Change password")
 * is for assistive technology; it used to show as a link reading "Close Change password".
 */
const TEXT = {
  en: {
    dialogs: ["Change password", "Passkeys"],
    close: (title: string) => new RegExp(`^Close \\W*${title}\\W*$`),
    cancel: "Cancel",
    passkeysClose: "Close",
  },
  he: {
    dialogs: ["שינוי סיסמה", "מפתחות גישה"],
    close: (title: string) => new RegExp(`^סגירת \\W*${title}\\W*$`),
    cancel: "ביטול",
    passkeysClose: "סגירה",
  },
} as const;

/** Saves a screenshot next to the test's output, and in SHOTS_DIR when it is set. */
async function shot(page: Page, info: TestInfo, name: string) {
  const file = `${info.project.name}-${name}.png`;
  await page.screenshot({ path: info.outputPath(file) });
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `learner-${file}`) });
  }
}
/**
 * A tap or click where the control is on screen. Playwright's own click first scrolls the
 * control "into view", which for a control in the sticky header (inside the page's scroll
 * padding) scrolls the page itself; a person's tap does not.
 */
async function tap(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
/**
 * Whether the menu offers this item. Passkeys are offered only where the browser has WebAuthn
 * (a PublicKeyCredential function), which Playwright's WebKit on Linux lacks: there the item
 * must be missing for that reason.
 */
async function offered(page: Page, item: Locator) {
  if (await item.count()) return true;
  expect(await page.evaluate(() => typeof window.PublicKeyCredential)).not.toBe("function");
  return false;
}
/** Where the window and the learning pane are scrolled to. */
const place = (page: Page) =>
  page.evaluate(() => ({
    window: Math.round(window.scrollY),
    pane: Math.round(document.querySelector(".connected-main")!.scrollTop),
  }));

/** A page taller than the window, scrolled well down (the pane on phones, the window otherwise). */
async function scrollDown(page: Page) {
  await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".connected-main")!;
    // Content, not the pane, grows: the pane keeps its height on phones and scrolls.
    document.querySelector<HTMLElement>(".connected-library")!.style.paddingBottom =
      "3200px";
    if (document.querySelector(".connected-host.is-compact")) main.scrollTop = 1500;
    else window.scrollTo(0, 1500);
  });
  await expect
    .poll(async () => Math.max(...Object.values(await place(page))))
    .toBe(1500);
  return place(page);
}

/** Nothing moved: the check is soft, so every step is still captured. */
async function expectStill(
  page: Page,
  at: { window: number; pane: number },
  step: string,
) {
  // Give a late scroll (a focus change after an animation frame) the chance to happen.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))),
  );
  expect.soft(await place(page), `scroll position after ${step}`).toEqual(at);
}

async function open(page: Page, locale: "en" | "he") {
  await page.goto(`/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await expect(page.locator(".connected-library h1")).toBeVisible();
  await expect(page.locator(".connected-bell")).toBeVisible();
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: the account menu, its dialogs and the notifications open and close without scrolling the page`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    const text = TEXT[locale];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockSignedInLearner(page);
    await open(page, locale);
    const at = await scrollDown(page);
    const toggle = page.locator(".connected-menu-toggle");
    const panel = page.locator(".connected-menu-panel");

    // The menu alone, closed with Escape.
    await tap(page, toggle);
    await expect(panel).toBeVisible();
    await expectStill(page, at, "menu opened");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
    await expectStill(page, at, "menu closed");

    for (const [index, title] of text.dialogs.entries()) {
      // The closed menu's items are hidden: count them anyway.
      if (!(await offered(page, panel.getByRole("button", { name: title, exact: true, includeHidden: true })))) continue;
      for (const how of ["escape", "close", "footer"] as const) {
        await tap(page, toggle);
        await tap(page, panel.getByRole("button", { name: title, exact: true }));
        const dialog = page.getByRole("dialog", { name: title });
        await expect(dialog).toBeVisible();
        await expectStill(page, at, `${title} opened`);
        // The title is the dialog's one heading; the close button shows an icon, not its name.
        // (Soft checks: the screenshots below are still taken when one fails.)
        await expect
          .soft(dialog.getByRole("heading", { name: title, exact: true }))
          .toHaveCount(1);
        const close = dialog.getByRole("button", { name: text.close(title) });
        await expect(close).toBeVisible();
        expect
          .soft(await close.evaluate((element) => element.textContent?.trim()))
          .toBe("");
        await expect.soft(close.locator("svg")).toHaveCount(1);
        const box = (await close.boundingBox())!;
        expect.soft(box.width).toBeGreaterThanOrEqual(44);
        expect.soft(box.height).toBeGreaterThanOrEqual(44);
        await expect.soft(dialog.getByText(text.close(title))).toHaveCount(0);
        if (how === "escape") {
          if (index === 1)
            // One way to close the passkeys dialog: no second "Close" beside "Add a passkey".
            await expect
              .soft(dialog.getByRole("button", { name: text.passkeysClose, exact: true }))
              .toHaveCount(0);
          await shot(page, info, `${locale}-dialog-${index + 1}-open`);
          await page.keyboard.press("Escape");
        } else if (how === "close") await tap(page, close);
        else if (index === 0)
          await tap(page, dialog.getByRole("button", { name: text.cancel, exact: true }));
        else continue;
        await expect(dialog).toHaveCount(0);
        await expect(toggle).toBeFocused();
        if (how === "escape") await shot(page, info, `${locale}-dialog-${index + 1}-closed`);
        await expectStill(page, at, `${title} closed with ${how}`);
      }
      // The passkeys dialog skipped its footer round: close it.
      if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
    }

    // The notifications: opened and closed with Escape.
    const bell = page.locator(".connected-bell");
    await tap(page, bell);
    await expect(page.locator(".connected-notifications-panel")).toBeVisible();
    await expectStill(page, at, "notifications opened");
    await page.keyboard.press("Escape");
    await expect(page.locator(".connected-notifications-panel")).toBeHidden();
    await expect(bell).toBeFocused();
    await expectStill(page, at, "notifications closed");
    expect(errors).toEqual([]);
  });
}
