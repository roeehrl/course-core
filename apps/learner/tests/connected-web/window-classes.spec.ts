import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { chooseFromMenu } from "./learner-menu";

/* One window-class function decides the learner layout: compact < 600,
 * medium 600–839 and expanded >= 840 (CSS px divided by text scale). The
 * boundaries are exercised on both sides here, on every engine that runs the
 * connected suite. The width loop needs one browser, not one per device project. */

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
    .getByRole("button", { name: "Continue learning →", exact: true })
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
test("599/600/839/840/1024: compact sheet, collapsible medium pane, expanded pane", {
  tag: "@desktop-window",
}, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1024, height: 900 });
  await openLesson(page, page.request);
  const pane = page.getByRole("complementary", { name: "Your companion" });
  const sheet = page.getByRole("dialog", { name: "Your companion" });
  const toggle = page.locator(".connected-companion-trigger");
  const draft = page.getByRole("textbox", {
    name: "Message to your companion",
    exact: true,
  });

  // Expanded (opened at 1024): the pane is beside the lesson by default.
  await expect(host(page)).toHaveAttribute("data-window-class", "expanded");
  await expect(pane).toBeVisible();
  await draft.fill("Kept across every size");
  const paneBox = (await pane.boundingBox())!,
    main = (await page.locator(".connected-main").boundingBox())!;
  expect(paneBox.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("expanded-1024.png") });

  await page.setViewportSize({ width: 840, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "expanded");
  await expect(pane).toBeVisible();
  await noHorizontalScroll(page);

  // Medium: still a pane, and the learner can collapse it to give the lesson the width.
  await page.setViewportSize({ width: 839, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "medium");
  await expect(host(page)).not.toHaveClass(/is-compact/);
  await expect(pane).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await noHorizontalScroll(page);
  const close = page.getByRole("button", { name: "Close companion" });
  await expect(close).toHaveAttribute("aria-expanded", "true");
  await close.click();
  await expect(pane).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).not.toHaveAttribute("aria-haspopup", /.*/);
  // Collapsed, the lesson takes the full width.
  const full = (await page.locator(".connected-main").boundingBox())!;
  expect(full.width).toBeGreaterThan(839 - 2 * 20 - 30);
  await toggle.click();
  await expect(pane).toBeVisible();
  await expect(draft).toHaveValue("Kept across every size");

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "medium");
  await expect(pane).toBeVisible();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath("medium-600.png") });
  const narrow = (await page.locator(".connected-main").boundingBox())!;
  expect(narrow.width).toBeGreaterThanOrEqual(280);

  // Compact: the companion is a sheet behind a button; the lesson scrolls on its own.
  // (Had focus stayed in the companion, narrowing would keep it open as a sheet.)
  await page.getByRole("heading", { name: "Minimum", exact: true }).click();
  await page.setViewportSize({ width: 599, height: 900 });
  await expect(host(page)).toHaveAttribute("data-window-class", "compact");
  await expect(host(page)).toHaveClass(/is-compact/);
  await expect(pane).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
  await page.screenshot({ path: info.outputPath("compact-599.png") });
  await toggle.click();
  await expect(sheet).toBeVisible();
  await expect(draft).toHaveValue("Kept across every size");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await noHorizontalScroll(page);

  // The pane choice is a device preference that survives a reload.
  await page.setViewportSize({ width: 839, height: 900 });
  await expect(pane).toBeVisible();
  await page.getByRole("button", { name: "Close companion" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Minimum", exact: true }),
  ).toBeVisible();
  await expect(pane).toHaveCount(0);
  await expect(toggle).toBeVisible();
  expect(errors).toEqual([]);
});

test("the secondary Your course menu holds profile, record and account settings at every size", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openLesson(page, page.request);
  const menu = page.locator(".connected-menu-toggle");
  await expect(menu).toHaveText(/Your course/);
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  // Settings are not scattered across the header: only the menu button and the notification bell
  // are there.
  await expect(page.locator(".connected-header button:visible")).toHaveCount(2);
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
