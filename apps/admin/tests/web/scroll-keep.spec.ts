import {
  test,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mockConnectedAdmin, MOCK_USER } from "./connectedAdmin";

/**
 * Opening and closing anything that floats over the page (the account menu and its dialogs, the
 * notification panel, the navigation drawer) never scrolls the page. Focus used to go back to
 * the account button in the sticky app bar without preventScroll; with the scroll padding under
 * the bar the browser then scrolled the page up (428px on a Chromium phone, 562px on a tablet,
 * 65px in WebKit) each time a menu or dialog closed. Runs on Chromium and WebKit at phone, tablet
 * and desktop sizes (playwright.config.ts), from a page scrolled well below its top.
 */
const TEXT = {
  en: {
    account: `Your account: ${MOCK_USER.displayName}`,
    dialogs: [
      ["Workspace language", "Workspace language"],
      ["Change password", "Change password"],
      ["Passkeys", "Passkeys"],
    ],
    close: (title: string) => new RegExp(`^Close \\W*${title}\\W*$`),
    cancel: "Cancel",
    notifications: "Needs attention",
    closeNotifications: "Close notifications",
    drawer: "Menu",
  },
  he: {
    account: new RegExp(`^החשבון שלך: \\W*${MOCK_USER.displayName}\\W*$`),
    dialogs: [
      ["שפת סביבת העבודה", "שפת סביבת העבודה"],
      ["שינוי סיסמה", "שינוי סיסמה"],
      ["מפתחות גישה", "מפתחות גישה"],
    ],
    close: (title: string) => new RegExp(`^סגירת \\W*${title}\\W*$`),
    cancel: "ביטול",
    notifications: "מחכה לטיפול",
    closeNotifications: "סגירת ההתראות",
    drawer: "תפריט",
  },
} as const;

/** Saves a screenshot next to the test's output, and in SHOTS_DIR when it is set. */
async function shot(page: Page, info: TestInfo, name: string) {
  const file = `${info.project.name}-${name}.png`;
  await page.screenshot({ path: info.outputPath(file) });
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `admin-${file}`) });
  }
}
/**
 * A tap or click where the control is on screen. Playwright's own click first scrolls the
 * control "into view", which for a control in the sticky app bar (inside the page's scroll
 * padding) scrolls the page itself; a person's tap does not.
 */
async function tap(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
/**
 * Whether the open menu offers this item. Passkeys are offered only where the browser has
 * WebAuthn (a PublicKeyCredential function), which Playwright's WebKit on Linux lacks: there
 * the item must be missing for that reason.
 */
async function offered(page: Page, item: Locator) {
  if (await item.count()) return true;
  expect(await page.evaluate(() => typeof window.PublicKeyCredential)).not.toBe(
    "function",
  );
  return false;
}
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/**
 * A page taller than the window, scrolled well down: 1500px under the sticky app bar of phones
 * and tablets. Wide windows have no sticky bar, so the page is scrolled as far as its top bar
 * (with the account button and the bell) stays in view.
 */
async function scrollDown(page: Page) {
  const at = await page.evaluate(() => {
    document.querySelector<HTMLElement>("#main-content")!.style.paddingBottom =
      "3200px";
    if (document.querySelector(".app-bar")) return 1500;
    const button = document.querySelector(".account-button")!;
    return Math.floor(button.getBoundingClientRect().top + window.scrollY) - 4;
  });
  expect(at).toBeGreaterThan(8);
  await page.evaluate((top) => window.scrollTo(0, top), at);
  await expect.poll(() => scrollY(page)).toBe(at);
  return at;
}

/** The window stays where it was: the check is soft, so every step is still captured. */
async function expectStill(page: Page, at: number, step: string) {
  // Give a late scroll (a focus change after an animation frame) the chance to happen.
  await page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))),
  );
  expect.soft(await scrollY(page), `scroll position after ${step}`).toBe(at);
}

async function open(page: Page, locale: "en" | "he") {
  await page.goto(`/admin/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".notification-bell")).toBeVisible();
}

async function closeAndCheck(
  page: Page,
  info: TestInfo,
  at: number,
  closed: Locator,
  focused: Locator,
  step: string,
) {
  await expect(closed).toHaveCount(0);
  await expect(focused).toBeFocused();
  await shot(page, info, step);
  await expectStill(page, at, step);
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: menus, dialogs, the notification panel and the drawer open and close without scrolling the page`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(120_000);
    const text = TEXT[locale];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockConnectedAdmin(page, context);
    await open(page, locale);
    const at = await scrollDown(page);
    const button = page.getByRole("button", { name: text.account });

    // The account menu alone: opened with a click, closed with Escape.
    await tap(page, button);
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expectStill(page, at, "menu opened");
    await page.keyboard.press("Escape");
    await closeAndCheck(
      page,
      info,
      at,
      menu,
      button,
      `${locale}-1-menu-closed`,
    );

    // Each account dialog, opened from the menu and closed with Escape.
    for (const [index, [item, title]] of text.dialogs.entries()) {
      await tap(page, button);
      await expect(menu).toBeVisible();
      const entry = menu.getByRole("menuitem", { name: item, exact: true });
      if (!(await offered(page, entry))) {
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);
        continue;
      }
      await tap(page, entry);
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await expectStill(page, at, `${title} opened`);
      await page.keyboard.press("Escape");
      await closeAndCheck(
        page,
        info,
        at,
        dialog,
        button,
        `${locale}-2-dialog-${index + 1}-closed`,
      );
    }

    // The password dialog closed with its close button, and with Cancel.
    const [passwordItem, passwordTitle] = text.dialogs[1];
    for (const how of ["close", "cancel"] as const) {
      await tap(page, button);
      await tap(
        page,
        menu.getByRole("menuitem", { name: passwordItem, exact: true }),
      );
      const dialog = page.getByRole("dialog", { name: passwordTitle });
      await expect(dialog).toBeVisible();
      await tap(
        page,
        dialog.getByRole("button", {
          name: how === "close" ? text.close(passwordTitle) : text.cancel,
        }),
      );
      await expect(dialog).toHaveCount(0);
      await expectStill(page, at, `password dialog closed with ${how}`);
    }

    // The notification panel: Escape, and its close button.
    const bell = page.locator(".notification-bell");
    for (const how of ["escape", "button"] as const) {
      await tap(page, bell);
      const panel = page.getByRole("dialog", { name: text.notifications });
      await expect(panel).toBeVisible();
      await expectStill(page, at, "notifications opened");
      if (how === "escape") await page.keyboard.press("Escape");
      else
        await tap(
          page,
          panel.getByRole("button", { name: text.closeNotifications }),
        );
      await closeAndCheck(
        page,
        info,
        at,
        panel,
        bell,
        `${locale}-3-notifications-closed-${how}`,
      );
    }

    // The navigation drawer on phones and tablets.
    const toggle = page.locator(".nav-toggle");
    if (await toggle.isVisible()) {
      await tap(page, toggle);
      const drawer = page.getByRole("dialog", { name: text.drawer });
      await expect(drawer).toBeVisible();
      await expectStill(page, at, "drawer opened");
      await page.keyboard.press("Escape");
      await closeAndCheck(
        page,
        info,
        at,
        drawer,
        toggle,
        `${locale}-4-drawer-closed`,
      );
    }
    expect(errors).toEqual([]);
  });
}
