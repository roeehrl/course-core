import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockSignedInLearner } from "./connectedAccount";

/**
 * Account settings from the learner's menu open as dialogs over the page. They used to appear
 * as cards at the top of the main column, pushing the learner's courses (or lesson) down. The
 * header and main column must not move by a pixel, only one dialog is ever open, focus stays
 * inside it and comes back to the menu button.
 */
const TEXT = {
  en: {
    dialogs: ["Change password", "Passkeys"],
    changed: "Your password was changed. Your other sessions were signed out.",
    current: "Current password",
    next: "New password",
    repeat: "Repeat new password",
  },
  he: {
    dialogs: ["שינוי סיסמה", "מפתחות גישה"],
    changed: "הסיסמה שונתה. שאר הסשנים שלך נותקו.",
    current: "הסיסמה הנוכחית",
    next: "סיסמה חדשה",
    repeat: "הקלדה חוזרת של הסיסמה החדשה",
  },
} as const;

async function expectAccessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
/** The header's and main column's boxes in page coordinates. */
async function layout(page: Page) {
  return page.evaluate(() =>
    [".connected-header", ".connected-main", ".connected-library h1"].map(
      (selector) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return {
          selector,
          x: Math.round(box.x + window.scrollX),
          y: Math.round(box.y + window.scrollY),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      },
    ),
  );
}
async function expectFocusTrapped(page: Page, dialog: Locator) {
  for (const key of ["Tab", "Shift+Tab"])
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press(key);
      expect(
        await dialog.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }
}
async function choose(page: Page, label: string) {
  const toggle = page.locator(".connected-menu-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
  await page
    .locator(".connected-menu-panel")
    .getByRole("button", { name: label, exact: true })
    .click();
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
  test(`${locale}: account dialogs open over the page, one at a time, keep focus and return it`, async ({
    page,
  }) => {
    const text = TEXT[locale];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockSignedInLearner(page);
    await open(page, locale);
    const toggle = page.locator(".connected-menu-toggle");
    const before = await layout(page);
    for (const title of text.dialogs) {
      await choose(page, title);
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(await page.getByRole("dialog").count()).toBe(1);
      expect(await layout(page)).toEqual(before);
      // Nothing account-related is drawn inside the main column.
      await expect(
        page.locator(".connected-main").getByRole("heading", { name: title }),
      ).toHaveCount(0);
      // The page behind is inert: its menu button cannot take focus.
      expect(
        await toggle.evaluate((element) => {
          element.focus();
          return document.activeElement === element;
        }),
      ).toBe(false);
      await expectFocusTrapped(page, dialog);
      await expectAccessible(page);
      const box = (await dialog.boundingBox())!;
      const viewport = page.viewportSize()!;
      if (viewport.width < 640)
        expect(Math.round(box.width)).toBe(viewport.width);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(toggle).toBeFocused();
      expect(await layout(page)).toEqual(before);
    }
    expect(errors).toEqual([]);
  });

  test(`${locale}: a changed password is confirmed in a message that floats over the page`, async ({
    page,
  }) => {
    const text = TEXT[locale];
    const mock = await mockSignedInLearner(page);
    await open(page, locale);
    const before = await layout(page);
    await choose(page, text.dialogs[0]);
    const form = page.getByRole("dialog", { name: text.dialogs[0] });
    await form.getByLabel(text.current).fill("an old passphrase");
    await form
      .getByLabel(text.next, { exact: true })
      .fill("a brand new passphrase");
    await form.getByLabel(text.repeat).fill("a brand new passphrase");
    await form
      .getByRole("button", { name: text.dialogs[0], exact: true })
      .click();
    await expect(form).toHaveCount(0);
    const toast = page.getByRole("status").filter({ hasText: text.changed });
    await expect(toast).toBeVisible();
    expect(mock.passwordChanges).toEqual([
      {
        currentPassword: "an old passphrase",
        newPassword: "a brand new passphrase",
      },
    ]);
    expect(await layout(page)).toEqual(before);
    await expect(page.locator(".connected-menu-toggle")).toBeFocused();
    await expectAccessible(page);
  });
}
