import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mockSignedInLearner } from "./connectedAccount";

/**
 * The account sheets fit small phones: the sheet fills the window and no more, its head (the
 * title and the close button) stays at the top, the body scrolls, and the change-password form
 * keeps its buttons at the bottom edge while its fields scroll under them. 375x420 stands for a
 * small phone with the on-screen keyboard up. English and Hebrew, Chromium and WebKit phones
 * (playwright.config.ts).
 */
const TEXT = {
  en: {
    password: "Change password",
    passkeys: "Passkeys",
    submit: "Change password",
    cancel: "Cancel",
    close: (title: string) => new RegExp(`^Close \\W*${title}\\W*$`),
  },
  he: {
    password: "שינוי סיסמה",
    passkeys: "מפתחות גישה",
    submit: "שינוי סיסמה",
    cancel: "ביטול",
    close: (title: string) => new RegExp(`^סגירת \\W*${title}\\W*$`),
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
      path: join(dir, `learner-${test.info().project.name}-${name}.png`),
    });
  }
}

/** Wholly on screen, and the point a tap lands on is the control itself. */
async function expectReachable(page: Page, control: Locator) {
  const view = page.viewportSize()!;
  const box = (await control.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(
    await control.evaluate((element) => {
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && element.contains(hit);
    }),
  ).toBe(true);
}

async function choose(page: Page, label: string) {
  const toggle = page.locator(".connected-menu-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.locator(".connected-menu-panel").getByRole("button", { name: label, exact: true }).click();
}

for (const locale of ["en", "he"] as const)
  test(`${locale}: the account sheets fit 390x844, 375x667 and a phone with its keyboard up`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const text = TEXT[locale];
    await mockSignedInLearner(page);
    await page.goto(`/?locale=${locale}`);
    await expect(page.locator(".connected-library h1")).toBeVisible();
    for (const size of SIZES) {
      await page.setViewportSize(size);
      const name = `${locale}-${size.width}x${size.height}`;
      for (const title of [text.password, text.passkeys]) {
        await choose(page, title);
        const dialog = page.getByRole("dialog", { name: title });
        await expect(dialog).toBeVisible();
        const frame = (await dialog.boundingBox())!;
        expect(Math.round(frame.y)).toBe(0);
        expect(Math.round(frame.height)).toBe(size.height);
        expect(Math.round(frame.width)).toBe(size.width);
        await expectReachable(page, dialog.getByRole("button", { name: text.close(title) }));
        const body = dialog.locator(".learner-sheet-body");
        if (title === text.password) {
          const submit = dialog.getByRole("button", { name: text.submit, exact: true });
          const cancel = dialog.getByRole("button", { name: text.cancel, exact: true });
          await expectReachable(page, submit);
          await expectReachable(page, cancel);
          const scrolls = await body.evaluate((b) => b.scrollHeight > b.clientHeight + 1);
          if (size.height === 420) {
            // The fields scroll under the buttons, which stay at the bottom edge.
            expect(scrolls).toBe(true);
            await expect(body).toHaveAttribute("data-more-below", "");
          }
          await shot(page, `${name}-password`);
          if (scrolls) {
            await body.evaluate((b) => b.scrollTo({ top: b.scrollHeight }));
            await expect(body).not.toHaveAttribute("data-more-below");
            await expectReachable(page, submit);
            await expectReachable(page, cancel);
            await expectReachable(page, dialog.getByRole("button", { name: text.close(title) }));
            await shot(page, `${name}-password-end`);
          }
        } else await shot(page, `${name}-passkeys`);
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      }
    }
  });
