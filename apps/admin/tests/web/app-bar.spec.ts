import { test, expect, type Locator, type Page } from "@playwright/test";
import { expectAccessible, mockConnectedAdmin } from "./connectedAdmin";

/**
 * Phones and tablets: a compact top app bar and a navigation drawer instead of the sidebar. The
 * full navigation used to fill the whole first screen of a phone as a grid, pushing the top bar
 * (course, notifications, account) and the page below the fold. Now the page's heading is in the
 * first screen, and the navigation opens as a modal drawer from the inline start edge (the right
 * in Hebrew) that keeps focus, closes with Escape and gives focus back.
 *
 * The phone project runs the phone width; the desktop project runs two tablet widths and the
 * wide window, where the sidebar stays.
 */
const TEXT = {
  en: {
    open: "Open menu",
    drawer: "Menu",
    close: "Close menu",
    course: "Course & releases",
    learners: "Enrollments",
    courseTitle: "Sorting, step by step",
  },
  he: {
    open: "פתיחת התפריט",
    drawer: "תפריט",
    close: "סגירת התפריט",
    course: "קורס וגרסאות",
    learners: "הרשמות",
    courseTitle: "Sorting, step by step",
  },
} as const;
type Locale = keyof typeof TEXT;

const PHONE = [{ width: 390, height: 844 }];
const TABLETS = [
  { width: 834, height: 1112 },
  { width: 1024, height: 768 },
];

async function open(page: Page, locale: Locale) {
  await page.goto(`/admin/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".notification-bell")).toBeVisible();
}

/** The element's box in the window, rounded. */
async function box(locator: Locator) {
  const rect = (await locator.boundingBox())!;
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}
const scrollY = (page: Page) => page.evaluate(() => window.scrollY);
async function expectNoHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(width);
}
const active = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    return {
      tag: element?.tagName.toLowerCase(),
      text: element?.textContent?.trim(),
      inDrawer: Boolean(element?.closest(".nav-drawer")),
      current: element?.getAttribute("aria-current"),
    };
  });

/** Tabs forward and backward past both ends; focus never leaves the drawer. */
async function expectFocusTrapped(page: Page, drawer: Locator) {
  const count = await drawer.locator("button:not([disabled]), select").count();
  for (const key of ["Tab", "Shift+Tab"])
    for (let step = 0; step < count + 2; step++) {
      await page.keyboard.press(key);
      expect((await active(page)).inDrawer).toBe(true);
    }
}

for (const locale of ["en", "he"] as const)
  test(`${locale}: the app bar leaves the page in the first screen and the drawer keeps and returns focus`, async ({
    page,
    context,
  }, info) => {
    const text = TEXT[locale];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockConnectedAdmin(page, context);
    const sizes = info.project.name === "phone" ? PHONE : TABLETS;
    for (const size of sizes) {
      await page.setViewportSize(size);
      await open(page, locale);
      const phone = size.width < 720;
      const bar = page.locator(".app-bar");
      const toggle = page.getByRole("button", { name: text.open });
      const heading = page.getByRole("heading", { level: 1 });

      // The bar: menu button, the product mark, the section's name; no sidebar.
      await expect(bar).toBeVisible();
      await expect(page.locator(".sidebar")).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(bar.locator(".app-bar-mark")).toBeVisible();
      await expect(bar.locator(".app-bar-title strong")).toHaveText(
        text.course,
      );
      const barBox = await box(bar);
      expect(barBox.y).toBe(0);
      expect(barBox.height).toBeLessThanOrEqual(64);
      // Notifications and the account menu are in the bar, inside the window.
      for (const control of [
        toggle,
        bar.locator(".notification-bell"),
        bar.locator(".account-button"),
      ]) {
        await expect(control).toBeVisible();
        const controlBox = await box(control);
        expect(controlBox.x).toBeGreaterThanOrEqual(0);
        expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(size.width);
        expect(controlBox.height).toBeGreaterThanOrEqual(44);
      }
      // Tablets keep the course picker in the bar; phones name the course under the section.
      if (phone) {
        await expect(bar.locator("#course-select")).toHaveCount(0);
        await expect(bar.locator(".app-bar-title small")).toHaveText(
          text.courseTitle,
        );
      } else await expect(bar.locator("#course-select")).toBeVisible();

      // The page heading is in the first screen, right under the bar, without scrolling.
      expect(await scrollY(page)).toBe(0);
      const headingBox = await box(heading);
      expect(headingBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
      expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(
        Math.min(size.height, 260),
      );
      await expectNoHorizontalOverflow(page);
      await expectAccessible(page);

      // The skip link shows above the sticky bar when the keyboard reaches it.
      const skip = page.locator(".skip-link");
      await skip.focus();
      await expect(skip).toBeFocused();
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== "running"),
      );
      const skipBox = await box(skip);
      expect(
        await page.evaluate(
          ([x, y]) => document.elementFromPoint(x!, y!)?.className,
          [skipBox.x + skipBox.width / 2, skipBox.y + skipBox.height / 2],
        ),
      ).toBe("skip-link");
      await heading.focus();

      // Opening: a modal drawer against the inline start edge, focus on the current section.
      await toggle.click();
      const drawer = page.getByRole("dialog", { name: text.drawer });
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute("aria-modal", "true");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(
        drawer.getByRole("button", { name: text.course, exact: true }),
      ).toBeFocused();
      await expect(
        drawer.getByRole("button", { name: text.course, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== "running"),
      );
      const drawerBox = await box(drawer);
      if (locale === "he")
        expect(drawerBox.x + drawerBox.width).toBe(size.width);
      else expect(drawerBox.x).toBe(0);
      expect(drawerBox.y).toBe(0);
      expect(drawerBox.height).toBe(size.height);
      expect(drawerBox.width).toBeLessThan(size.width - 40);
      // On phones the course picker is the drawer's first control.
      await expect(drawer.locator("#course-select")).toHaveCount(phone ? 1 : 0);
      // The page behind is inert and does not move.
      expect(
        await toggle.evaluate((element) => {
          (element as HTMLElement).focus();
          return document.activeElement === element;
        }),
      ).toBe(false);
      expect(await scrollY(page)).toBe(0);
      await expectFocusTrapped(page, drawer);
      await expectAccessible(page);

      // Escape closes it and focus goes back to the menu button.
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");

      // The keyboard opens it too; the close button closes it, focus back on the menu button.
      await page.keyboard.press("Enter");
      await expect(drawer).toBeVisible();
      await drawer.getByRole("button", { name: text.close }).click();
      await expect(drawer).toHaveCount(0);
      await expect(toggle).toBeFocused();

      // A tap on the dimmed page beside the drawer closes it.
      await toggle.click();
      await expect(drawer).toBeVisible();
      await page.mouse.click(
        locale === "he" ? 12 : size.width - 12,
        size.height / 2,
      );
      await expect(drawer).toHaveCount(0);
      await expect(toggle).toBeFocused();

      // Choosing a section closes the drawer and moves focus to the new page's heading.
      await toggle.click();
      await drawer
        .getByRole("button", { name: text.learners, exact: true })
        .click();
      await expect(drawer).toHaveCount(0);
      await expect(heading).toHaveText(text.learners);
      await expect(heading).toBeFocused();
      await expect(bar.locator(".app-bar-title strong")).toHaveText(
        text.learners,
      );
      expect(await scrollY(page)).toBe(0);
      await expectNoHorizontalOverflow(page);
    }
    expect(errors).toEqual([]);
  });

test("wide windows keep the sidebar; a drawer left open closes when the window widens @desktop-window", async ({
  page,
  context,
}) => {
  await mockConnectedAdmin(page, context);
  for (const width of [1440, 1180, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page, "en");
    await expect(page.locator(".sidebar .nav-links")).toBeVisible();
    await expect(page.locator(".nav-toggle")).toHaveCount(0);
    await expect(page.locator(".topbar #course-select")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1099, height: 900 });
  await page.locator(".nav-toggle").click();
  await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
  await expect(page.locator(".sidebar .nav-links")).toBeVisible();
  // The page is not left locked after the drawer went away.
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});
