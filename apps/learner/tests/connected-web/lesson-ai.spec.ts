import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { closeCompanion, companionPanel, composerBox } from "./companion-helpers";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";

/*
 * AI in the lesson (final design §4.5, §4.6, §4.18), on the real API and PostgreSQL, at phone,
 * tablet and desktop: the "Unverified" pill and its note, the gate's help pill, new material
 * offered at the end of a lesson, a generated model's states and the detour banner.
 */

const resume = /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/;

async function signIn(page: Page, session: string, data?: Record<string, unknown>, locale?: "he") {
  const response = await page.request.post(session, data ? { data } : {});
  expect(response.ok(), await response.text()).toBe(true);
  await page.goto(`/${locale ? `?locale=${locale}` : ""}#signin=${(await response.json()).token}`);
}
/** Opens the course page from the library (late panels can move the button). */
async function openCourse(page: Page, locale: "en" | "he" = "en") {
  const roadmap = page.getByTestId("course-roadmap");
  const button = page.getByRole("button", { name: (locale === "he" ? heHost : enHost)["library.continue"], exact: true });
  await expect(async () => {
    if (await roadmap.isVisible()) return;
    await button.click({ timeout: 2_000 });
    await expect(roadmap).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
/** Opens the current lesson from the library or the course page (late panels can move the button). */
async function openCurrentLesson(page: Page) {
  const button = page.getByRole("button", { name: resume }).first();
  const lesson = page.locator("article[data-reading-part], .connected-check").first();
  await expect(async () => {
    if (await lesson.isVisible()) return;
    if (await button.count()) await button.click({ timeout: 2_000 });
    await expect(lesson).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
/** A learner command through the page's own signed-in session. */
async function command(page: Page, path: string, body: Record<string, unknown>) {
  const id = (await (await page.request.get("/api/enrollments")).json())[0].id as string;
  const snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  const csrf = (await page.context().cookies()).find((c) => c.name === "course_csrf")!.value;
  const response = await page.request.post(`/api/enrollments/${id}/${path}`, {
    headers: { origin: new URL(page.url()).origin, "x-csrf-token": csrf },
    data: { expectedRevision: snapshot.revision, idempotencyKey: `${path.replaceAll("/", "-")}-${Date.now()}`, ...body },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return snapshot;
}
/** The colour a token resolves to on this page, as computed styles report colours. */
async function token(page: Page, name: string) {
  return page.evaluate((property) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}
/** Waits for an opening note's fade (M16) to end, so what is checked is what stays on screen. */
async function settled(locator: ReturnType<Page["locator"]>) {
  await locator.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
}
async function readParts(page: Page, parts: number[]) {
  for (const part of parts) {
    await expect(page.getByRole("article", { name: `Reading part ${part}` })).toBeVisible();
    await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  }
}

test.describe("the Unverified pill", () => {
  test("opens its note by keyboard and by touch, and the note leads to the personal change", async ({ page }, info) => {
    await signIn(page, "/test/model-session", { generated: true });
    await openCurrentLesson(page);
    await readParts(page, [1]);
    const pill = page.getByRole("button", { name: "Unverified: this part was written by AI and hasn't been reviewed by a person" });
    await expect(pill).toBeVisible();
    // No warning glyph, no dashed gold: an info icon and the word on --surface-2.
    await expect(pill).toHaveText("Unverified");
    await expect(pill.locator('svg[data-icon="info"]')).toHaveCount(1);
    const look = await pill.locator(".cc-ai-unverified-pill").evaluate((el) => {
      const style = getComputedStyle(el);
      return { border: style.borderStyle, background: style.backgroundColor };
    });
    expect(look.border).toBe("none");
    expect(look.background).toBe(await token(page, "--surface-2"));
    // Keyboard: Enter opens the note, its link takes focus, Escape closes it and gives focus back.
    await pill.focus();
    await page.keyboard.press("Enter");
    const note = page.getByRole("dialog", { name: "About this AI-written part" });
    await expect(note).toContainText("Written by AI for you and checked automatically. No person has reviewed it yet. Your checks and progress never depend on it.");
    const link = note.getByRole("button", { name: "See this change, hide or undo it" });
    await expect(link).toBeFocused();
    await settled(note);
    await accessible(page);
    await page.screenshot({ path: info.outputPath("unverified-note.png") });
    await page.keyboard.press("Escape");
    await expect(note).toHaveCount(0);
    await expect(pill).toBeFocused();
    // Touch (a click with a mouse): the note opens again and its link opens the change.
    if (info.project.use.hasTouch) await pill.tap();
    else await pill.click();
    await note.getByRole("button", { name: "See this change, hide or undo it" }).click();
    const change = page.locator('[id^="personal-change-"]');
    await expect(change).toBeFocused();
    await expect(change).toBeInViewport();
  });

  test("names each kind in Hebrew and explains it there", async ({ page }) => {
    await signIn(page, "/test/model-session", { generated: true }, "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await openCourse(page, "he");
    await page.getByTestId("next-step").getByRole("button").click();
    await page.getByRole("button", { name: heLesson.markRead, exact: true }).click();
    const pill = page.getByRole("button", { name: "טרם נבדק: החלק הזה נכתב על ידי AI, ואדם עוד לא עבר עליו" });
    await expect(pill).toHaveText("טרם נבדק");
    await pill.click();
    await expect(page.getByRole("dialog")).toContainText("נכתב על ידי AI בשבילך ונבדק אוטומטית.");
    await expect(page.getByRole("dialog").getByRole("button", { name: "צפייה בשינוי, הסתרה או ביטול" })).toBeFocused();
    await settled(page.getByRole("dialog"));
    await accessible(page);
  });
});

test.describe("the gate's help pill", () => {
  // A first visit: the companion starts closed beside the lesson.
  test.use({ companionPane: "default" });

  test("puts the question in the companion's message box, sends nothing, and rings the box when it was open", async ({ page }, info) => {
    await signIn(page, "/test/content-lesson-session", { struggles: true });
    await openCurrentLesson(page);
    const gate = page.getByTestId("gate-decision");
    await expect(gate.getByRole("heading", { name: "Let's get you some help" })).toBeVisible();
    await expect(gate.getByText("Where you stand", { exact: true })).toBeVisible();
    // The dot is an offer, in the accent colour, not a warning.
    expect(await gate.locator(".connected-gate-dot").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await token(page, "--accent"));
    const pill = gate.getByRole("button", { name: /^Ask your companion/ });
    await expect(pill).toHaveClass(/cc-ui-pill-outline/);
    await expect(pill.locator('svg[data-icon="sparkle"]')).toHaveCount(1);
    expect(Math.round((await pill.boundingBox())!.height)).toBeGreaterThanOrEqual(40);
    // Other steps keep their copy.
    await expect(gate.getByRole("button", { name: /^Review “Minimum” before you try again$/ })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: info.outputPath("gate-help.png"), fullPage: true });
    await pill.click();
    const box = composerBox(page);
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(/^Can you explain .+ another way\?$/);
    await expect(box).toBeFocused();
    const question = await box.inputValue();
    // Nothing was sent: the question is only in the message box, not among the saved messages.
    await expect(companionPanel(page).getByRole("log").getByText(question)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("gate-help-prefilled.png") });
    if (info.project.name === "desktop") {
      // Beside the lesson the companion stays open: pressing again rings the message box (M15).
      await box.fill("");
      await pill.click();
      await expect(box).toHaveValue(question);
      await expect(box).toHaveAttribute("data-cc-ring", /hold|fade/);
    } else {
      // Over the lesson the companion is closed before a lesson control is pressed again.
      await closeCompanion(page);
      await pill.click();
      await expect(composerBox(page)).toHaveValue(question);
    }
  });
});

test.describe("new material for this lesson", () => {
  test("waits for the question, then is added at the end of the lesson and goes to it", async ({ page }, info) => {
    await signIn(page, "/test/model-session", { content: true, midAttempt: true });
    await openCurrentLesson(page);
    const card = page.getByRole("region", { name: "New for this lesson: an interactive simulation" });
    await expect(card).toContainText("Your companion made it for what you're working on. It goes at the end of this lesson; what you've done stays as it is.");
    await expect(card).toContainText("It'll be added after you finish this question.");
    await expect(card.getByRole("button", { name: "Add it to this lesson" })).toBeDisabled();
    // At the end of the lesson: after the check, before finishing.
    const [cardBox, checkBox] = await Promise.all([card.boundingBox(), page.locator(".connected-check").boundingBox()]);
    expect(cardBox!.y).toBeGreaterThan(checkBox!.y);
    await accessible(page);
    await page.screenshot({ path: info.outputPath("new-material-waiting.png"), fullPage: true });
    const snapshot = await (await page.request.get(`/api/enrollments/${(await (await page.request.get("/api/enrollments")).json())[0].id}`)).json();
    await command(page, "answers", { challengeId: snapshot.activeChallenges[0].challengeId, answer: "two" });
    await page.reload();
    await openCurrentLesson(page);
    await readParts(page, [1, 2]);
    await card.getByRole("button", { name: "Add it to this lesson" }).click();
    await expect(card.getByText("Added to the end of this lesson.", { exact: true })).toBeVisible();
    // The pressed button is gone: the line that says what happened has the focus.
    await expect(card.locator(".cc-ai-offer-outcome")).toBeFocused();
    await accessible(page);
    await page.screenshot({ path: info.outputPath("new-material-added.png"), fullPage: true });
    await card.getByRole("button", { name: "Go to it" }).click();
    const part = page.getByRole("article", { name: "Reading part 3" });
    await expect(part).toBeFocused();
    await expect(part).toHaveAttribute("data-cc-highlight", /hold|fade/);
    await expect(part.getByRole("button", { name: /^Unverified: / })).toBeVisible();
  });

  test("turned down, it says so and is not added", async ({ page }) => {
    await signIn(page, "/test/model-session", { content: true, midAttempt: true });
    await openCurrentLesson(page);
    const snapshot = await (await page.request.get(`/api/enrollments/${(await (await page.request.get("/api/enrollments")).json())[0].id}`)).json();
    await command(page, "answers", { challengeId: snapshot.activeChallenges[0].challengeId, answer: "two" });
    await page.reload();
    await openCurrentLesson(page);
    const card = page.getByRole("region", { name: "New for this lesson: an interactive simulation" });
    await card.getByRole("button", { name: "No thanks" }).click();
    await expect(card.getByText("Not added.", { exact: true })).toBeVisible();
    await readParts(page, [1, 2]);
    await expect(page.getByRole("article", { name: "Reading part 3" })).toHaveCount(0);
  });

  test("no longer available, it says nothing was added", async ({ page }) => {
    await signIn(page, "/test/model-session", { content: true, midAttempt: true });
    await openCurrentLesson(page);
    const snapshot = await (await page.request.get(`/api/enrollments/${(await (await page.request.get("/api/enrollments")).json())[0].id}`)).json();
    await command(page, "answers", { challengeId: snapshot.activeChallenges[0].challengeId, answer: "two" });
    // The learner's consent changed after the addition was made: it can no longer be delivered.
    await command(page, "supervision", { adaptiveTeaching: false });
    await command(page, "supervision", { adaptiveTeaching: true });
    await page.reload();
    await openCurrentLesson(page);
    const card = page.getByRole("region", { name: "New for this lesson: an interactive simulation" });
    await card.getByRole("button", { name: "Add it to this lesson" }).click();
    await expect(card.getByText("This is no longer available, so nothing was added.", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Go to it" })).toHaveCount(0);
  });
});

test("a generated model keeps its button and results in place, and says when this browser cannot run it", async ({ page }, info) => {
  await signIn(page, "/test/model-session", { content: true, component: true });
  await openCurrentLesson(page);
  await readParts(page, [1, 2]);
  const panel = page.getByRole("article", { name: "Reading part 3" }).getByRole("region", { name: "Line explorer" });
  const run = panel.locator(".cc-ai-model-run");
  await expect(run).toHaveAccessibleName("Run the model");
  await expect(run).toHaveAccessibleDescription("This runs in your browser, offline, and never counts as an answer.");
  const results = panel.locator(".cc-ai-model-results");
  expect((await results.boundingBox())!.height).toBeGreaterThanOrEqual(96);
  await accessible(page);
  await page.screenshot({ path: info.outputPath("model-ready.png") });
  // The runner's configuration is held, then refused: "Loading Python…" on the same button, then
  // the line that says this browser cannot run models takes its place and its focus.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/python-runner", async (route) => {
    await held;
    await route.fulfill({ status: 503, body: "" });
  });
  const width = (await run.boundingBox())!.width;
  await run.click();
  await expect(run).toHaveText("Loading Python…");
  await expect(run).toHaveAttribute("aria-disabled", "true");
  expect(Math.abs((await run.boundingBox())!.width - width)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("model-loading.png") });
  release();
  const line = panel.getByRole("alert");
  await expect(line).toHaveText("This browser can't run models. The description above has the same information.");
  await expect(line).toBeFocused();
  await expect(panel.getByRole("button", { name: "Run the model" })).toHaveCount(0);
  // The results box keeps its room, with no values: the description above has them.
  expect((await results.boundingBox())!.height).toBeGreaterThanOrEqual(96);
  await expect(results.getByText(/values at the starting position/)).toHaveCount(0);
  await expect(panel.getByText("This runs in your browser, offline, and never counts as an answer.")).toBeVisible();
  await accessible(page);
});

test.describe("the detour banner", () => {
  for (const locale of ["en", "he"] as const)
    test(`${locale}: an optional lesson says it is a detour in one row and takes the learner back`, async ({ page }, info) => {
      await signIn(page, "/test/content-lesson-session", undefined, locale === "he" ? "he" : undefined);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
      await openCourse(page, locale);
      const roadmap = page.getByTestId("course-roadmap");
      const name = locale === "he" ? /A closer look.*מסלול צדדי, לא חובה/ : /A closer look, Optional detour$/;
      await roadmap.getByRole("button", { name }).click();
      const banner = page.getByTestId("detour-return");
      await expect(banner).toBeVisible();
      // (Course text is isolated in a right-to-left sentence; the marks are not part of the words.)
      expect((await banner.textContent())!.replace(/[\u2066-\u2069]/g, "")).toBe(locale === "he" ? "זה מסלול צדדי, לא חובה.חזרה אל Minimum" : "You're on an optional detour.Back to Minimum");
      // No ל glued to the lesson's name in Hebrew (§7).
      const back = banner.getByRole("button", { name: locale === "he" ? /^חזרה אל \u2068?Minimum\u2069?$/ : "Back to Minimum" });
      const row = (await banner.boundingBox())!;
      if (info.project.name === "desktop") expect(Math.round(row.height)).toBe(40);
      // The arrow points along the reading direction.
      const flipped = await back.locator('svg[data-icon="arrow-right"]').evaluate((el) => getComputedStyle(el).transform);
      expect(flipped === "none").toBe(locale === "en");
      await accessible(page);
      await page.screenshot({ path: info.outputPath(`detour-${locale}.png`) });
      await back.click();
      await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
      await expect(page.getByTestId("detour-return")).toHaveCount(0);
    });
});
