import { expect, test, type Page } from "./health";

/* S12, automated part of the screen-reader traversal in docs/accessibility.md (steps 2 to 8).
 * A screen reader's browse mode reads the accessibility tree in document order; Playwright's
 * aria snapshot is that tree. These checks walk it through a whole lesson: what a reader would
 * announce, in what order, where focus lands after each action, and that changes are announced
 * through a live region. A person with VoiceOver and NVDA still runs the manual script: this does
 * not prove how a particular reader voices any of it. */

async function signIn(page: Page) {
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
}
const tree = (page: Page, selector = "body") => page.locator(selector).ariaSnapshot();
/** Whether the focused element sits inside `selector`. */
const focusedWithin = (page: Page, selector: string) =>
  page.evaluate((s) => !!document.activeElement?.closest(s), selector);

test("a lesson read in document order: landmarks, headings, named controls, focus after each step and announced feedback", async ({ page }) => {
  await signIn(page);
  // Step 2: each course is an article with its heading, then its "Open course" button.
  const course = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) });
  expect(await course.ariaSnapshot()).toMatch(/heading "Ordering values" \[level=\d\][\s\S]*button "Open course"/);
  expect(await page.getByRole("banner").count()).toBeGreaterThan(0);
  expect(await page.getByRole("main").count()).toBeGreaterThan(0);
  await course.getByRole("button", { name: "Open course", exact: true }).click();
  // Step 3: the preview is read before the button that starts the course.
  const preview = await tree(page, "main");
  expect(preview.indexOf('button "Start course"')).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).focus();
  await page.keyboard.press("Enter");

  // Step 4: focus moves to the lesson's level-1 heading; the steps are a list naming the current one.
  await expect(page.locator(":focus")).toHaveAttribute("data-reading-heading", /.*/);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
  await expect(page.locator('[aria-current="step"]')).toHaveCount(1);

  // Step 5: the reading part is an article named "Reading part 1"; prose follows its label, and
  // no TeX source is read out.
  const part = page.getByRole("article", { name: "Reading part 1" });
  await expect(part).toBeVisible();
  const reading = await part.ariaSnapshot();
  expect(reading).not.toMatch(/\\\(|\\\[|\$\$/);
  expect(reading).toMatch(/button "Mark this part read"/);

  // Every control in the lesson has a name a reader can announce.
  const lesson = await tree(page, ".connected-lesson-keeper");
  expect(lesson).not.toMatch(/- (button|link|checkbox|radio|combobox|textbox)\s*(\[|$)/m);

  // Step 7: marking the part read with the keyboard keeps focus in the lesson, not at the page top:
  // it moves to what comes next (here the check, the lesson's only part being read).
  await part.getByRole("button", { name: "Mark this part read" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Start the next check →", exact: true })).toBeVisible();
  await expect(page.locator("#connected-check-title")).toBeFocused();
  expect(await focusedWithin(page, ".connected-lesson-keeper")).toBe(true);

  // Step 8: the check is a radio group read with each option; feedback goes to a live region.
  await page.getByRole("button", { name: "Start the next check →", exact: true }).focus();
  await page.keyboard.press("Enter");
  const option = page.getByRole("radio", { name: "2", exact: true });
  await expect(option).toBeVisible();
  const group = await tree(page, ".connected-lesson-keeper");
  expect(group).toMatch(/radio "2"/);
  await option.focus();
  await page.keyboard.press("Space");
  await expect(option).toBeChecked();
  const live = page.locator('[aria-live="polite"], [role="status"], [role="alert"]');
  const before = await live.allInnerTexts();
  await page.getByRole("button", { name: "Check answer", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await live.allInnerTexts()).join(" ").trim().length > before.join(" ").trim().length)
    .toBe(true);
  // Focus stays near the answer: on the check's heading, right above the result and next steps.
  await expect(page.locator("#connected-check-title")).toBeFocused();
});

test("keyboard Tab order follows the reading order of the lesson and never gets stuck", async ({ page }) => {
  await signIn(page);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("button", { name: "Continue learning →", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark this part read" })).toBeVisible();
  // Tab from the lesson heading until the required step; every stop is a named, visible control
  // and the stops inside the lesson come in document order.
  const seen: { name: string; order: number }[] = [];
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const all = Array.from(document.querySelectorAll("*"));
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
      const box = el.getBoundingClientRect();
      return { name, order: all.indexOf(el), visible: box.width > 0 && box.height > 0, inLesson: !!el.closest(".connected-lesson-keeper") };
    });
    if (!stop) continue;
    expect(stop.visible, `focused control ${stop.name} is visible`).toBe(true);
    expect(stop.name.length, "focused control has a name").toBeGreaterThan(0);
    if (stop.inLesson) seen.push({ name: stop.name, order: stop.order });
    if (stop.name === "Mark this part read") break;
  }
  expect(seen.at(-1)?.name).toBe("Mark this part read");
  const orders = seen.map((s) => s.order);
  expect(orders).toEqual([...orders].sort((a, b) => a - b));
});
