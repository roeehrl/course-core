import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./health";
import { companion, lengthenLesson, openLesson, settled, trigger } from "./shell-helpers";

/*
 * Focus view (final design §2.2, G7): Expand gives the companion the area under the app header,
 * one 720 px column; the lesson stays mounted but inert and hidden, and its scroll is kept for the
 * way back. "Show lesson beside" and Esc return to the panel; Esc first stops a reply being written
 * (tests/companionDock.test.tsx). Focus view is remembered for the browser session only. Desktop
 * windows (@desktop-window).
 */
test("Expand gives the companion the page, and the lesson comes back where it was", { tag: "@desktop-window" }, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLesson(page);
  await lengthenLesson(page);
  await expect(companion(page)).toHaveAttribute("data-view", "docked");
  await page.evaluate(() => window.scrollTo(0, 600));
  const scrolled = await page.evaluate(() => Math.round(window.scrollY));
  expect(scrolled).toBeGreaterThan(300);
  // A press where the button is (a locator click may first scroll the page).
  const expand = (await companion(page).getByRole("button", { name: "Expand", exact: true }).boundingBox())!;
  await page.mouse.click(expand.x + expand.width / 2, expand.y + expand.height / 2);
  await expect(companion(page)).toHaveAttribute("data-view", "focus");
  await expect(page.locator(".connected-host")).toHaveAttribute("data-companion-view", "focus");
  const main = page.locator("#connected-learning");
  await expect(main).toBeHidden();
  expect(await main.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await settled(companion(page));
  // Under the header, the window's width; the conversation in one 720 px column, centred.
  const header = (await page.locator(".connected-header").boundingBox())!;
  const frame = (await companion(page).boundingBox())!;
  expect(Math.round(frame.y)).toBe(Math.round(header.y + header.height));
  expect(frame.width).toBeGreaterThanOrEqual(1440 - 20);
  const body = (await companion(page).locator(".cc-shell-body").boundingBox())!;
  expect(Math.round(body.width)).toBe(720);
  expect(Math.abs(body.x + body.width / 2 - frame.width / 2)).toBeLessThanOrEqual(10);
  // The header row: the title and the lesson's title, About, "Show lesson beside", Close.
  await expect(companion(page).locator(".connected-dock-title")).toContainText("Minimum");
  await expect(companion(page).getByRole("button", { name: "About your companion", exact: true })).toBeVisible();
  await expect(companion(page).getByRole("button", { name: "Expand", exact: true })).toHaveCount(0);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("focus-view.png") });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  // Below 1024 the lesson's title gives way.
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(companion(page).locator(".cc-ui-panel-subtitle")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  // Back beside the lesson: the lesson shows again at the place it was left.
  await companion(page).getByRole("button", { name: "Show lesson beside", exact: true }).click();
  await expect(companion(page)).toHaveAttribute("data-view", "docked");
  // Focus goes to Expand, the button that took the place of the one pressed.
  await expect(companion(page).getByRole("button", { name: "Expand", exact: true })).toBeFocused();
  await expect(main).toBeVisible();
  expect(await main.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scrolled)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("separator", { name: "Resize companion" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Esc leaves focus view, and focus view lasts for the browser session", { tag: "@desktop-window" }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLesson(page);
  await companion(page).getByRole("button", { name: "Expand", exact: true }).click();
  await expect(companion(page)).toHaveAttribute("data-view", "focus");
  // Closed and opened again in the same session: focus view again; the lesson is never left
  // hidden behind a closed companion.
  await companion(page).getByRole("button", { name: "Close companion", exact: true }).click();
  await expect(companion(page)).toBeHidden();
  await expect(page.locator("#connected-learning")).toBeVisible();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await expect(companion(page)).toHaveAttribute("data-view", "focus");
  await expect(page.locator("#connected-learning")).toBeHidden();
  // Esc from the message box (a React Native text input, which stops key events bubbling): back
  // beside the lesson, still open; the next Esc closes it.
  // The focus stays in the box, with what was typed (§6): the box is still there, unlike "Show
  // lesson beside", whose place Expand takes.
  const draft = companion(page).getByRole("textbox", { name: "Message to your companion", exact: true });
  await draft.focus();
  await page.keyboard.type("draft text");
  await page.keyboard.press("Escape");
  await expect(companion(page)).toHaveAttribute("data-view", "docked");
  await expect(companion(page)).toBeVisible();
  await expect(page.locator("#connected-learning")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("course:learner-companion-view"))).toBeNull();
  await expect(draft).toBeFocused();
  // Still focused a frame later (the view change settles in the next frame).
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("draft text");
  await page.keyboard.type(" more");
  await expect(draft).toHaveValue("draft text more");
  await page.keyboard.press("Escape");
  await expect(companion(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  // A new session starts beside the lesson.
  await trigger(page).click();
  await companion(page).getByRole("button", { name: "Expand", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("course:learner-companion-view"))).toBe("focus");
  const fresh = await page.context().newPage();
  await openLesson(fresh);
  await expect(companion(fresh)).toHaveAttribute("data-view", "docked");
  await fresh.close();
});

test("a phone or tablet has no focus view: the sheet has no Expand", async ({ page }) => {
  if ((page.viewportSize()?.width ?? 0) >= 840) await page.setViewportSize({ width: 834, height: 1112 });
  await openLesson(page);
  await trigger(page).click();
  await expect(companion(page)).toHaveAttribute("data-placement", "sheet");
  await expect(companion(page).getByRole("button", { name: "Expand", exact: true })).toHaveCount(0);
  await expect(page.locator("#connected-learning")).toBeVisible();
});
