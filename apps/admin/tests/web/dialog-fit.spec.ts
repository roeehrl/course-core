import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mockConnectedAdmin, MOCK_USER } from "./connectedAdmin";

/**
 * The account dialogs fit small phones: each is a bottom sheet inside the window, its body
 * scrolls, and its own buttons stay at its bottom edge while the rest scrolls under them (with a
 * divider only while there is more below). A form's button at the end of a long list (Add a
 * passkey) stays with its field and is reached by scrolling. 375x420 stands for a small phone with the on-screen
 * keyboard up. English and Hebrew, Chromium and WebKit phones (playwright.config.ts). The
 * scheduled-price dialog is checked the same way on the real API (tests/real/dialog-fit).
 */
const TEXT = {
  en: {
    account: `Your account: ${MOCK_USER.displayName}`,
    dialogs: [
      { item: "Change password", kept: ["Change password", "Cancel"], end: [] },
      { item: "Passkeys", kept: ["Close"], end: ["Add a passkey"] },
      { item: "Workspace language", kept: ["Close"], end: [] },
    ],
  },
  he: {
    account: new RegExp(`^החשבון שלך: \\W*${MOCK_USER.displayName}\\W*$`),
    dialogs: [
      { item: "שינוי סיסמה", kept: ["שינוי סיסמה", "ביטול"], end: [] },
      { item: "מפתחות גישה", kept: ["סגירה"], end: ["הוספת מפתח גישה"] },
      { item: "שפת סביבת העבודה", kept: ["סגירה"], end: [] },
    ],
  },
} as const;
const SIZES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
  { width: 375, height: 420 },
] as const;

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, `admin-${test.info().project.name}-${name}.png`),
    });
  }
}

/**
 * Whether the open menu offers this item. Passkeys are offered only where the browser has
 * WebAuthn, which Playwright's WebKit on Linux lacks: there the item must be missing for that
 * reason.
 */
async function offered(page: Page, item: Locator) {
  if (await item.count()) return true;
  expect(await page.evaluate(() => typeof window.PublicKeyCredential)).toBe(
    "undefined",
  );
  return false;
}
/** Wholly on screen and inside the dialog, and the point a tap lands on is the control. */
async function expectReachable(page: Page, dialog: Locator, control: Locator) {
  const view = page.viewportSize()!;
  const box = (await control.boundingBox())!;
  const frame = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(frame.y);
  expect(box.y + box.height).toBeLessThanOrEqual(
    Math.min(view.height, frame.y + frame.height) + 0.5,
  );
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(
    await control.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return !!hit && element.contains(hit);
    }),
  ).toBe(true);
}

for (const locale of ["en", "he"] as const)
  test(`${locale}: the account dialogs fit 390x844, 375x667 and a phone with its keyboard up, with their buttons in reach`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    const text = TEXT[locale];
    await mockConnectedAdmin(page, context);
    // Enough passkeys that the list is longer than a small phone.
    await page.route("**/auth/passkeys", (route) =>
      route.fulfill({
        json: {
          available: true,
          passkeys: Array.from({ length: 6 }, (_, index) => ({
            id: `pk-${index}`,
            name: `Passkey ${index + 1}`,
            createdAt: "2026-10-01T09:30:00.000Z",
            lastUsedAt: "2026-10-20T15:10:00.000Z",
            backedUp: index % 2 === 0,
          })),
        },
      }),
    );
    await page.goto(`/admin/?locale=${locale}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const button = page.getByRole("button", { name: text.account });
    for (const size of SIZES) {
      await page.setViewportSize(size);
      const name = `${locale}-${size.width}x${size.height}`;
      for (const [index, { item, kept, end }] of text.dialogs.entries()) {
        await button.click();
        const entry = page.getByRole("menuitem", { name: item, exact: true });
        await expect(page.getByRole("menu")).toBeVisible();
        if (!(await offered(page, entry))) {
          await page.keyboard.press("Escape");
          continue;
        }
        await entry.click();
        const dialog = page.getByRole("dialog", { name: item });
        await expect(dialog).toBeVisible();
        // Measured where the sheet comes to rest, after it slides in.
        await dialog.evaluate((d) =>
          Promise.all(d.getAnimations().map((a) => a.finished)),
        );
        const frame = (await dialog.boundingBox())!;
        expect(frame.y).toBeGreaterThanOrEqual(0);
        expect(Math.round(frame.y + frame.height)).toBe(size.height);
        // The dialog's own buttons are in reach as it opens.
        for (const label of kept)
          await expectReachable(
            page,
            dialog,
            dialog.getByRole("button", { name: label, exact: true }),
          );
        const scrolls = await dialog.evaluate(
          (d) => d.scrollHeight > d.clientHeight + 1,
        );
        if (size.height === 420 && index < 2) expect(scrolls).toBe(true);
        if (scrolls) {
          await expect(dialog).toHaveAttribute("data-more-below", "");
          await shot(page, `${name}-dialog-${index + 1}`);
          await dialog.evaluate((d) => d.scrollTo({ top: d.scrollHeight }));
          await expect(dialog).not.toHaveAttribute("data-more-below");
          // A form's own button at the end of a long list is reached by scrolling to it.
          for (const label of [...kept, ...end])
            await expectReachable(
              page,
              dialog,
              dialog.getByRole("button", { name: label, exact: true }),
            );
          await shot(page, `${name}-dialog-${index + 1}-end`);
        } else {
          await expect(dialog).not.toHaveAttribute("data-more-below");
          for (const label of end)
            await expectReachable(
              page,
              dialog,
              dialog.getByRole("button", { name: label, exact: true }),
            );
          await shot(page, `${name}-dialog-${index + 1}`);
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
    }
  });
