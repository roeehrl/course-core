import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { workspaceNav } from "../workspaceNav";

/**
 * A dialog never runs off a small phone screen. On a Hebrew phone the scheduled-price dialog was
 * taller than the window and its buttons ("Save scheduled price", "Cancel") were cut off at the
 * bottom edge until the dialog itself was scrolled. Now every dialog stays inside the window, its
 * body scrolls, and its actions stay at its bottom edge. Checked on the real API at 390x844 and
 * 375x667, in English and Hebrew, on Chromium and WebKit phones (playwright.real.config.ts).
 */
const TEXT = {
  en: {
    code: "One-time sign-in code",
    useCode: "Use code",
    aiServices: "AI services",
    edit: "Change scheduled price",
    dialog: /^Price from /,
    more: "More price types",
    save: "Save scheduled price",
    cancel: "Cancel",
    keep: "Keep the current price",
    keepDialog: /^Remove the change scheduled for /,
  },
  he: {
    code: "קוד כניסה חד-פעמי",
    useCode: "שימוש בקוד",
    aiServices: "שירותי AI",
    edit: "שינוי המחיר המתוזמן",
    dialog: /^המחיר מ-/,
    more: "סוגי מחיר נוספים",
    save: "שמירת המחיר המתוזמן",
    cancel: "ביטול",
    keep: "השארת המחיר הנוכחי",
    keepDialog: /^לבטל את השינוי שמתוזמן ל-/,
  },
} as const;
const SIZES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
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

/** The control is wholly on screen and inside the dialog's visible box. */
async function expectReachable(page: Page, dialog: Locator, control: Locator) {
  const view = page.viewportSize()!;
  const box = (await control.boundingBox())!;
  const frame = (await dialog.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(frame.y);
  expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  // Nothing covers it: the point a tap lands on is the control itself.
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

/** The dialog stays inside the window. */
async function expectInside(page: Page, dialog: Locator) {
  const view = page.viewportSize()!;
  const frame = (await dialog.boundingBox())!;
  expect(frame.y).toBeGreaterThanOrEqual(0);
  expect(frame.y + frame.height).toBeLessThanOrEqual(view.height + 0.5);
  expect(frame.x).toBeGreaterThanOrEqual(0);
  expect(frame.x + frame.width).toBeLessThanOrEqual(view.width + 0.5);
}

for (const locale of ["en", "he"] as const)
  test(`${locale}: the scheduled-price dialog and its confirmation fit 390x844 and 375x667 phones, with their actions in reach @webkit @phone-only`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const text = TEXT[locale];
    const fixture = await (
      await page.request.post("/test/pricing-fixture", {
        data: { scheduled: true },
      })
    ).json();
    await page.goto(`/admin/?locale=${locale}`);
    await page.getByLabel(text.code).fill(fixture.code);
    await page.getByRole("button", { name: text.useCode, exact: true }).click();
    await (
      await workspaceNav(page)
    )
      .getByRole("button", { name: text.aiServices })
      .click();
    const block = page
      .locator("#ai-prices fieldset.ai-price", { hasText: "public-text-model" })
      .first();
    await expect(block.locator(".ai-price-scheduled")).toHaveCount(1);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      const name = `${locale}-${size.width}x${size.height}`;
      await block.getByRole("button", { name: text.edit }).click();
      const dialog = page.getByRole("dialog", { name: text.dialog });
      await expect(dialog).toBeVisible();
      await dialog.evaluate((d) =>
        Promise.all(d.getAnimations().map((a) => a.finished)),
      );
      // The tallest form: every price type shown.
      const more = dialog.locator("details");
      if (!(await more.evaluate((d) => (d as HTMLDetailsElement).open)))
        await dialog.getByText(text.more, { exact: true }).click();
      await shot(page, `${name}-price-dialog`);
      await expectInside(page, dialog);
      const save = dialog.getByRole("button", { name: text.save });
      const cancel = dialog.getByRole("button", { name: text.cancel });
      await expectReachable(page, dialog, save);
      await expectReachable(page, dialog, cancel);
      // The body scrolls under the actions; they stay at the bottom edge.
      const scrolls = await dialog.evaluate(
        (d) => d.scrollHeight > d.clientHeight + 1,
      );
      if (size.height === 667) expect(scrolls).toBe(true);
      if (scrolls) await expect(dialog).toHaveAttribute("data-more-below", "");
      await dialog.evaluate((d) => d.scrollTo({ top: d.scrollHeight }));
      await expect(dialog).not.toHaveAttribute("data-more-below");
      await expectReachable(page, dialog, save);
      await shot(page, `${name}-price-dialog-end`);
      await cancel.click();
      await expect(dialog).toHaveCount(0);

      await block.getByRole("button", { name: text.keep }).click();
      const confirm = page.getByRole("dialog", { name: text.keepDialog });
      await expect(confirm).toBeVisible();
      await expectInside(page, confirm);
      await expectReachable(
        page,
        confirm,
        confirm.getByRole("button", { name: text.keep }),
      );
      await expectReachable(
        page,
        confirm,
        confirm.getByRole("button", { name: text.cancel }),
      );
      await confirm.getByRole("button", { name: text.cancel }).click();
      await expect(confirm).toHaveCount(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });
