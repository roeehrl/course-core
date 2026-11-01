import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";

/* One window-class function gives the SDK's layout class: compact < 600, medium 600–839 and
 * expanded >= 840 (CSS px divided by text scale). The companion follows (domain/companionLayout.ts):
 * a phone sheet under 600, a tablet sheet to 839, a panel beside the lesson from 840. The
 * boundaries are exercised on both sides here, on every engine that runs the connected suite. The
 * width loop needs one browser, not one per device project. */

async function openLesson(page: Page, request: Page["request"]) {
  const token = (await (await request.post("/test/session")).json()).token;
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
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
}

async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

const host = (page: Page) => page.locator(".connected-host");

// The width loop sets its own viewport sizes, so only desktop projects run it (@desktop-window).
test("599/600/839/840/1024: phone sheet, tablet sheet, docked panel", {
  tag: "@desktop-window",
}, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1024, height: 900 });
  await openLesson(page, page.request);
  const companion = page.getByRole("complementary", { name: "Your companion", exact: true });
  const toggle = page.locator(".connected-companion-trigger");
  const draft = page.getByRole("textbox", {
    name: "Message to your companion",
    exact: true,
  });
  const main = () => page.locator(".connected-main").boundingBox().then((box) => box!);

  // Expanded (opened at 1024): the panel is beside the lesson, flush at the window's end.
  await expect(host(page)).toHaveAttribute("data-window-class", "expanded");
  await expect(companion).toHaveAttribute("data-placement", "docked");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await draft.fill("Kept across every size");
  const paneBox = (await companion.boundingBox())!,
    lesson = await main();
  expect(paneBox.x).toBeGreaterThanOrEqual(lesson.x + lesson.width - 1);
  expect(Math.round(paneBox.width)).toBe(400);
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("expanded-1024.png") });

  // 840: still docked; the lesson keeps 479 px beside a 360 px panel.
  await page.setViewportSize({ width: 840, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "expanded");
  await expect(companion).toHaveAttribute("data-placement", "docked");
  const scrollbar = await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth);
  if (!scrollbar) {
    expect(Math.round((await companion.boundingBox())!.width)).toBe(360);
    expect(Math.round((await main()).width)).toBeGreaterThanOrEqual(479);
  }
  await noHorizontalScroll(page);

  // Medium: the tablet's sheet. The learner was not in the companion, so it closes; the lesson
  // takes the page's own layout and the whole width.
  await page.getByRole("heading", { name: "Minimum", exact: true }).click();
  await page.setViewportSize({ width: 839, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "medium");
  await expect(host(page)).not.toHaveClass(/is-compact/);
  await expect(companion).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).not.toHaveAttribute("aria-haspopup", /.*/);
  expect((await main()).width).toBeGreaterThan(839 - 2 * 20 - 30);
  await noHorizontalScroll(page);
  await toggle.click();
  await expect(companion).toHaveAttribute("data-placement", "sheet");
  await expect(companion).toHaveAttribute("data-detent", "half");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(draft).toHaveValue("Kept across every size");
  // 640 px wide, centred.
  const sheet = (await companion.boundingBox())!;
  expect(Math.round(sheet.width)).toBe(640);
  expect(Math.abs(sheet.x - (839 - scrollbar - sheet.width) / 2)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(companion).toHaveCount(0);
  await expect(toggle).toBeFocused();

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "medium");
  await toggle.click();
  await expect(companion).toHaveClass(/is-tablet/);
  expect(Math.round((await companion.boundingBox())!.width)).toBe(600 - scrollbar - 48);
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("medium-600.png") });
  await page.keyboard.press("Escape");
  await expect(companion).toHaveCount(0);

  // Compact: the phone's sheet, the full width; the lesson scrolls on its own. The button stays
  // in the header.
  await page.setViewportSize({ width: 599, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "compact");
  await expect(host(page)).toHaveClass(/is-compact/);
  await expect(page.locator(".connected-header .connected-companion-trigger")).toBeVisible();
  await page.screenshot({ path: info.outputPath("compact-599.png") });
  await toggle.click();
  await expect(companion).toHaveClass(/is-phone/);
  expect(Math.round((await companion.boundingBox())!.width)).toBe(599);
  await expect(draft).toHaveValue("Kept across every size");
  await page.keyboard.press("Escape");
  await expect(companion).toHaveCount(0);
  await noHorizontalScroll(page);

  // The panel choice is a device preference that survives a reload.
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(companion).toBeVisible();
  await page.getByRole("button", { name: "Close companion" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  await expect(companion).toHaveCount(0);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(errors).toEqual([]);
});

test("the account menu holds profile, record and account settings at every size", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openLesson(page, page.request);
  const menu = page.locator(".connected-menu-toggle");
  // The button is the account: the learner's initials and name, named as the account menu.
  await expect(menu).toHaveAccessibleName("Account and course menu, Browser learner");
  await expect(menu.locator(".connected-menu-avatar")).toHaveText("BL");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  // Settings are not scattered across the header: only the menu button and the notification bell
  // are there (and, beside a collapsed companion pane, the button that shows it).
  await expect(page.locator(".connected-header button:visible:not(.connected-companion-trigger)")).toHaveCount(2);
  const bell = (await page.locator(".connected-bell").boundingBox())!;
  expect(bell.height).toBeGreaterThanOrEqual(44);
  expect(bell.x).toBeGreaterThanOrEqual(0);
  const box = (await menu.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await menu.click();
  const panel = page.locator(".connected-menu-panel");
  await expect(panel.getByRole("group", { name: "Account" })).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("your-course-menu.png") });
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(panel).toBeHidden();
  await chooseFromMenu(page, "Learning record");
  await expect(
    page.getByRole("heading", { name: "Your learning record" }),
  ).toBeVisible();
  await menu.click();
  await expect(
    page
      .locator(".connected-menu-panel")
      .getByRole("button", { name: "Learning record" }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .locator(".connected-menu-panel")
    .getByRole("button", { name: "Learning path" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your learning path" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("the app reports what it can do once per window class, and the server keeps it (M02)", async ({ page }) => {
  const reports: { body: Record<string, unknown>; status: number }[] = [];
  page.on("response", async (response) => {
    if (response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/platform-capabilities"))
      reports.push({ body: response.request().postDataJSON(), status: response.status() });
  });
  await openLesson(page, page.request);
  const width = page.viewportSize()!.width;
  await expect.poll(() => reports.length).toBeGreaterThan(0);
  expect(reports[0]).toMatchObject({
    status: 200,
    body: {
      target: width < 600 ? "web_mobile" : "web_desktop",
      layoutClass: await host(page).getAttribute("data-window-class"),
      rendererIds: ["course-core-svg-v1"],
      nativeModules: [],
    },
  });
  // Moving through the lesson in the same window sends nothing new.
  const sent = reports.length;
  await page.getByRole("button", { name: "Mark this part read", exact: true }).first().click();
  await page.waitForTimeout(300);
  expect(reports.length).toBe(sent);
});
