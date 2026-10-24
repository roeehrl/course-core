import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  expectAccessible,
  mockConnectedAdmin,
  MOCK_USER,
} from "./connectedAdmin";

/**
 * The signed-in person's menu and its dialogs on the connected host. Account settings used to
 * open as cards stacked above the whole admin shell, pushing the sidebar and top bar below the
 * fold. Here every dialog opens over the page: the shell must not move by a pixel, only one
 * dialog is ever open, focus stays inside it and comes back to the menu button.
 */
const TEXT = {
  en: {
    account: `Your account: ${MOCK_USER.displayName}`,
    language: "Language",
    dialogs: [
      ["Workspace language", "Workspace language"],
      ["Change password", "Change password"],
      ["Passkeys", "Passkeys"],
    ],
    signOut: "Sign out",
    changed: "Your password was changed. Your other sessions were signed out.",
    current: "Current password",
    next: "New password",
    repeat: "Repeat new password",
  },
  he: {
    account: new RegExp(`^החשבון שלך: \\W*${MOCK_USER.displayName}\\W*$`),
    language: "שפה",
    dialogs: [
      ["שפת סביבת העבודה", "שפת סביבת העבודה"],
      ["שינוי סיסמה", "שינוי סיסמה"],
      ["מפתחות גישה", "מפתחות גישה"],
    ],
    signOut: "יציאה",
    changed: "הסיסמה שונתה. שאר הסשנים שלך נותקו.",
    current: "הסיסמה הנוכחית",
    next: "סיסמה חדשה",
    repeat: "הקלדה חוזרת של הסיסמה החדשה",
  },
} as const;

/** The shell's boxes in page coordinates (scrolling does not count as moving). */
async function shell(page: Page) {
  return page.evaluate(() =>
    [".sidebar", ".topbar", ".page-heading"].map((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return {
        selector,
        x: Math.round(box.x + window.scrollX),
        y: Math.round(box.y + window.scrollY),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    }),
  );
}
const openDialogs = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelectorAll('dialog[open], [role="dialog"]:not(dialog)')
        .length,
  );

/** Tabs forward and backward past both ends; focus never leaves the dialog. */
async function expectFocusTrapped(page: Page, dialog: Locator) {
  const count = await dialog.evaluate(
    (element) =>
      element.querySelectorAll(
        'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled])',
      ).length,
  );
  for (const key of ["Tab", "Shift+Tab"])
    for (let step = 0; step < count + 2; step++) {
      await page.keyboard.press(key);
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
}

async function openConnected(page: Page, locale: "en" | "he") {
  await page.goto(`/admin/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".notification-bell")).toBeVisible();
  const button = page.getByRole("button", { name: TEXT[locale].account });
  await button.scrollIntoViewIfNeeded();
  return button;
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: each account dialog opens over the page without moving the shell, one at a time, with focus kept and returned`, async ({
    page,
    context,
  }) => {
    const text = TEXT[locale];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockConnectedAdmin(page, context);
    const button = await openConnected(page, locale);
    // No strip of account buttons or banner above the shell.
    await expect(page.locator(".connection-bar")).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const frame = document.querySelector(".app-frame")!;
        return frame.getBoundingClientRect().top + window.scrollY;
      }),
    ).toBe(0);
    await expect(
      page.getByRole("button", { name: text.signOut, exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel(text.language, { exact: true })).toHaveCount(
      0,
    );
    const before = await shell(page);

    // The menu floats over the page too.
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    expect(await shell(page)).toEqual(before);
    const menuBox = (await page.locator(".account-popover").boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();

    for (const [item, title] of text.dialogs) {
      // Keyboard: Down Arrow opens on the first item; type-ahead and arrows reach the rest.
      await button.focus();
      await page.keyboard.press("ArrowDown");
      await expect(menu).toBeVisible();
      const target = menu.getByRole("menuitem", { name: item, exact: true });
      for (let step = 0; step < 10; step++) {
        if (await target.evaluate((el) => el === document.activeElement)) break;
        await page.keyboard.press("ArrowDown");
      }
      await expect(target).toBeFocused();
      await expect(target).toHaveAttribute("aria-haspopup", "dialog");
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await expect(menu).toHaveCount(0);
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(await openDialogs(page)).toBe(1);
      expect(await shell(page)).toEqual(before);
      // The page behind is inert: the menu button cannot be reached.
      expect(
        await button.evaluate((element) => {
          element.focus();
          return document.activeElement === element;
        }),
      ).toBe(false);
      await expectFocusTrapped(page, dialog);
      await expectAccessible(page);
      const box = (await dialog.boundingBox())!;
      if (viewport.width < 640) {
        // A bottom sheet on phones: full width, resting on the bottom edge.
        expect(Math.round(box.width)).toBe(viewport.width);
        expect(Math.round(box.y + box.height)).toBe(viewport.height);
      } else {
        expect(box.width).toBeLessThan(viewport.width - 200);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      expect(await openDialogs(page)).toBe(0);
      await expect(button).toBeFocused();
      expect(await shell(page)).toEqual(before);
    }

    // Cancel closes too, and returns focus to the menu button.
    await button.click();
    await menu
      .getByRole("menuitem", { name: text.dialogs[1][0], exact: true })
      .click();
    const password = page.getByRole("dialog", { name: text.dialogs[1][1] });
    await expect(password.getByLabel(text.current)).toBeFocused();
    await password
      .getByRole("button", { name: locale === "he" ? "ביטול" : "Cancel" })
      .click();
    await expect(password).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(errors).toEqual([]);
  });

  test(`${locale}: a changed password is confirmed in a message that floats over the page`, async ({
    page,
    context,
  }) => {
    const text = TEXT[locale];
    const mock = await mockConnectedAdmin(page, context);
    const button = await openConnected(page, locale);
    const before = await shell(page);
    await button.click();
    await page
      .getByRole("menuitem", { name: text.dialogs[1][0], exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: text.dialogs[1][1] });
    await dialog.getByLabel(text.current).fill("an old passphrase");
    await dialog
      .getByLabel(text.next, { exact: true })
      .fill("a brand new passphrase");
    await dialog.getByLabel(text.repeat).fill("a brand new passphrase");
    await dialog
      .getByRole("button", { name: text.dialogs[1][1], exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const toast = page.getByRole("status").filter({ hasText: text.changed });
    await expect(toast).toBeVisible();
    expect(mock.passwordChanges).toEqual([
      {
        currentPassword: "an old passphrase",
        newPassword: "a brand new passphrase",
      },
    ]);
    await expect(button).toBeFocused();
    expect(await shell(page)).toEqual(before);
    const box = (await toast.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await expectAccessible(page);
  });
}

test("the language is chosen in the account menu, saved to the account and announced as checked", async ({
  page,
  context,
}) => {
  const mock = await mockConnectedAdmin(page, context);
  await page.goto("/admin/");
  const button = page.getByRole("button", { name: TEXT.en.account });
  await button.click();
  const group = page.getByRole("group", { name: "Language" });
  await expect(
    group.getByRole("menuitemradio", { name: "English" }),
  ).toHaveAttribute("aria-checked", "true");
  await group.getByRole("menuitemradio", { name: "עברית" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("menu")).toHaveCount(0);
  const hebrew = page.getByRole("button", { name: TEXT.he.account });
  await expect(hebrew).toBeFocused();
  await expect.poll(() => mock.savedLocales).toEqual([{ locale: "he" }]);
  await page.keyboard.press("ArrowUp");
  // Up Arrow opens the menu on its last item.
  await expect(
    page.getByRole("menuitem", { name: TEXT.he.signOut }),
  ).toBeFocused();
  await expect(
    page.getByRole("menuitemradio", { name: "עברית" }),
  ).toHaveAttribute("aria-checked", "true");
  // Pseudo-locales are for development; a real language link does not list them.
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
});

test("signing out from the menu returns to the sign-in form", async ({
  page,
  context,
}) => {
  const mock = await mockConnectedAdmin(page, context);
  await page.goto("/admin/");
  await page.getByRole("button", { name: TEXT.en.account }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to administration" }),
  ).toBeVisible();
  expect(mock.signOuts).toBe(1);
});

test("before any course exists, the first-run screen has the same header and account menu", async ({
  page,
  context,
}) => {
  await mockConnectedAdmin(page, context, { courses: false });
  await page.goto("/admin/");
  await expect(page.locator(".startup-header")).toBeVisible();
  const button = page.getByRole("button", { name: TEXT.en.account });
  await button.click();
  await page.getByRole("menuitem", { name: "Passkeys" }).click();
  await expect(page.getByRole("dialog", { name: "Passkeys" })).toBeVisible();
  await expect(page.getByText("Passkey on Mac", { exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();
});

test("on a tablet the top bar keeps the course picker and every action on one row", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  await mockConnectedAdmin(page, context);
  await page.goto("/admin/");
  await expect(page.locator(".notification-bell")).toBeVisible();
  const middle = async (locator: string) => {
    const box = (await page.locator(locator).boundingBox())!;
    return box.y + box.height / 2;
  };
  const row = await middle(".account-button");
  for (const locator of ["#course-select", ".notification-bell"])
    expect(Math.abs((await middle(locator)) - row)).toBeLessThan(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).toBeLessThanOrEqual(0);
});
