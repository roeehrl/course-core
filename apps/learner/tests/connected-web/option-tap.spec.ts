import { expect, test } from "./health";

/* A tap on an answer option selects it, every time. On WebKit's iPhone and iPad profiles a tap
 * once could focus an option without choosing it; this taps through the options again and
 * again with real touch input (tap() on a touch device), and clicks on the projects without touch. */
test("tapping an answer option always selects it", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  const options = page.getByRole("radiogroup").first().getByRole("radio");
  await expect(options.first()).toBeVisible();
  const count = await options.count();
  expect(count).toBeGreaterThan(1);
  const touch = Boolean(info.project.use.hasTouch);
  const misses: string[] = [];
  for (let round = 0; round < 12; round++) {
    const option = options.nth(round % count);
    const name = (await option.getAttribute("aria-label")) ?? String(round % count);
    if (touch) await option.tap();
    else await option.click();
    // Checked within a frame or two of the tap, not only after a retry.
    try {
      await expect(option).toHaveAttribute("aria-checked", "true", { timeout: 1500 });
    } catch {
      misses.push(`round ${round}: ${name}`);
    }
  }
  expect(misses).toEqual([]);
  // One option is chosen: the last one tapped.
  await expect(options.and(page.locator('[aria-checked="true"]'))).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("an option tapped while another request is in flight is chosen, and locked only while its own answer saves", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  const options = page.getByRole("radiogroup").first().getByRole("radio");
  await expect(options.first()).toBeVisible();
  const touch = Boolean(info.project.use.hasTouch);
  const press = (index: number) => (touch ? options.nth(index).tap() : options.nth(index).click());
  // Hold a companion message at the server, so a request is in flight while the learner answers.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/enrollments\/[^/]+\/companion$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await held;
    await route.fallback();
  });
  const sheet = !info.project.name.endsWith("desktop");
  if (sheet) await page.getByRole("button", { name: "Companion", exact: true }).click();
  await page.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("Which is smallest?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Switch to practice & send" }).click();
  if (sheet) await page.getByRole("button", { name: "Close companion" }).click();
  for (const index of [0, 1, 0]) {
    await press(index);
    await expect(options.nth(index)).toHaveAttribute("aria-checked", "true", { timeout: 1500 });
  }
  release();
  await expect(page.getByRole("button", { name: "Check answer", exact: true })).toBeEnabled();
  // While the answer itself saves, the options are locked, and a tap neither chooses nor focuses one.
  let releaseAnswer: () => void = () => {};
  const answerHeld = new Promise<void>((resolve) => (releaseAnswer = resolve));
  await page.route(/\/api\/enrollments\/[^/]+\/answers$/, async (route) => {
    await answerHeld;
    await route.fallback();
  });
  await page.getByRole("button", { name: "Check answer", exact: true }).click();
  await expect(options.nth(1)).toHaveAttribute("aria-disabled", "true");
  const box = (await options.nth(1).boundingBox())!;
  if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(options.nth(1)).toHaveAttribute("aria-checked", "false");
  await expect(options.nth(1)).not.toBeFocused();
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/answers"));
  releaseAnswer();
  expect((await answered).status()).toBe(200);
  expect(errors).toEqual([]);
});
