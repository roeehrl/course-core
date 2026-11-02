import { expect, test, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { closeCompanion, companionPanel, composerBox, openCompanion } from "./companion-helpers";
import enCheck from "../../src/i18n/messages/en/checkCard.json";
import heCheck from "../../src/i18n/messages/he/checkCard.json";
import enHelp from "../../src/i18n/messages/en/helpRow.json";
import heHelp from "../../src/i18n/messages/he/helpRow.json";
import enFeedback from "../../src/i18n/messages/en/checkFeedback.json";
import heFeedback from "../../src/i18n/messages/he/checkFeedback.json";
import enVerdict from "../../src/i18n/messages/en/answerFeedback.json";
import heVerdict from "../../src/i18n/messages/he/answerFeedback.json";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enLesson from "../../src/i18n/messages/en/connectedLesson.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";

/*
 * A check's help, feedback and explanation in place (final design §4.1-§4.4), on the real API and
 * database, on desktop, phone and tablet: a wrong answer gets its feedback under the question and
 * the help row with "Try again" first; "I don't know yet" says "Noted…" and puts focus in the help
 * row; on a counted question the explanation is asked for once, then opens in place with Markdown
 * and math; a copied companion reply and a missing attempt are refused under the field; "Ask the
 * companion" opens the companion and sends nothing.
 */
const text = {
  en: { check: enCheck, help: enHelp, feedback: enFeedback, verdict: enVerdict, host: enHost, preview: enPreview, lesson: enLesson },
  he: { check: heCheck, help: heHelp, feedback: heFeedback, verdict: heVerdict, host: heHost, preview: hePreview, lesson: heLesson },
} as const;
type Locale = keyof typeof text;
/** axe once the reveal animations (M17, 160 ms) have finished, so it measures the colours that stay. */
async function axe(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity));
  return new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
}
const feedbackSlot = (page: Page) => page.locator(".connected-check .connected-answer-feedback");
const helpRow = (page: Page, locale: Locale = "en") => page.getByRole("group", { name: locale === "he" ? "עזרה בשאלה 1" : "Help with question 1" });

/** Signs in, opens the ordering course's first lesson, reads it and starts its first question. */
async function openCheck(page: Page, locale: Locale = "en") {
  const t = text[locale];
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: t.host["library.open"], exact: true })
    .click();
  await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  await page.getByTestId("next-step").getByRole("button").first().click();
  await page.getByRole("button", { name: t.lesson.markRead, exact: true }).click();
  await page.getByRole("button", { name: t.check["check.start"], exact: true }).click();
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeVisible();
  await closeCompanion(page, locale);
}

test("a wrong answer: the feedback in place under the question, and the help row with Try again first", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openCheck(page);
  await page.getByRole("radio", { name: "5", exact: true }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const slot = feedbackSlot(page);
  await expect(slot.locator(".cc-check-verdict")).toHaveText("Let's revisit this.");
  await expect(slot.locator(".cc-check-explanation")).toHaveText("2 is below 5.");
  // The question and the answer given stay above it.
  await expect(page.getByText("Which is smaller?", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "5", exact: true })).toBeChecked();
  const row = helpRow(page);
  await expect(row).toBeVisible();
  const first = row.getByRole("button").first();
  await expect(first).toHaveText("Try again");
  expect(await first.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(8, 123, 105)");
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("wrong-answer.png"), fullPage: true });
  // "Try again" is the next question, in the same place; its feedback slot starts empty.
  await first.click();
  await expect(page.getByRole("textbox", { name: "Your numeric answer", exact: true })).toBeEditable();
  await expect(slot).toHaveText("");
  await expect(helpRow(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const locale of ["en", "he"] as const) {
  test(`I don't know yet: Noted, and focus in the help row that opens (${locale})`, async ({ page }) => {
    const t = text[locale];
    await openCheck(page, locale);
    let solutions = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith("/solution")) solutions++;
    });
    await page.getByRole("button", { name: t.check["abstain.accessibilityLabel"], exact: true }).click();
    await expect(feedbackSlot(page)).toHaveText(t.feedback.abstained);
    const row = helpRow(page, locale);
    await expect(row.getByRole("button").first()).toBeFocused();
    // The author's explanation came with the receipt: it opens in place, without asking the server.
    const show = row.getByRole("button", { name: t.help.showExplanation, exact: true });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await show.click();
    await expect(row.getByRole("button", { name: t.help.hideExplanation, exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".cc-check-explanation-panel")).toHaveText("2 is below 5.");
    expect(solutions).toBe(0);
    expect((await axe(page)).violations).toEqual([]);
  });
}

test("Show explanation on a counted question: asked once, then in place with Markdown and math", async ({ page }, info) => {
  await openCheck(page);
  // The author's explanation as Markdown with math (the server's own response, re-worded here).
  const solutions: string[] = [];
  await page.route("**/solution", async (route) => {
    solutions.push(route.request().url());
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, explanation: "**Two** is the smaller one: $2 < 5$." } });
  });
  await page.getByRole("button", { name: "Get help", exact: true }).click();
  const row = helpRow(page);
  await expect(row).toContainText("Help turns this question into practice.");
  await row.getByRole("button", { name: "Show explanation", exact: true }).click();
  const confirm = page.getByRole("group", { name: "Opening the explanation makes question 1 practice." });
  await expect(confirm.getByRole("button", { name: "Keep it counted", exact: true })).toBeFocused();
  expect((await axe(page)).violations).toEqual([]);
  // Esc keeps it counted: nothing was asked of the server.
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  expect(solutions).toEqual([]);
  await expect(page.getByTestId("question-kind")).toHaveText("Counts toward this lesson. Answer on your own.");
  await row.getByRole("button", { name: "Show explanation", exact: true }).click();
  await page.getByRole("button", { name: "Show as practice", exact: true }).click();
  const panel = page.getByRole("region", { name: "Explanation" });
  await expect(panel).toContainText("Two is the smaller one");
  await expect(panel).not.toContainText("**");
  await expect(panel).not.toContainText("$");
  await expect(panel.locator("math")).toHaveCount(1);
  expect(solutions).toHaveLength(1);
  // Focus moves from the confirm that went to the button that hides the explanation again.
  await expect(row.getByRole("button", { name: "Hide explanation", exact: true })).toBeFocused();
  await expect(row.getByRole("button", { name: "Hide explanation", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Solution viewed", { exact: true })).toBeVisible();
  // The server made the question practice; the kind line says so.
  await expect(page.getByTestId("question-kind")).toContainText("Practice.");
  // Never in the page notice: the explanation shows once, in the check.
  await expect(page.getByText(/Two is the smaller one/)).toHaveCount(1);
  expect((await axe(page)).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("explanation.png"), fullPage: true });
  await row.getByRole("button", { name: "Hide explanation", exact: true }).click();
  await expect(panel).toHaveCount(0);
});

test("a written answer that repeats the companion is refused under the field, nothing recorded", async ({ page }) => {
  const fixture = await (await page.request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page.getByRole("region", { name: "Already know some of this?" }).getByRole("button", { name: "Start from the beginning" }).click();
  await expect(page.locator("section.connected-placement")).toHaveCount(0);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  const field = page.getByRole("textbox", { name: "Your explanation" });
  await expect(field).toBeEditable();
  // The companion said this to the learner earlier; the learner pastes it as their answer.
  const reply = "Keeping the smaller value at each comparison means the running value is always the minimum of what you have seen.";
  const enrollmentId = (await (await page.request.get("/api/enrollments")).json())[0].id;
  expect((await (await page.request.post("/test/checks-companion-reply", { data: { enrollmentId, text: reply } })).json()).stored).toBe(true);
  await field.fill(reply);
  const border = await field.evaluate((el) => getComputedStyle(el).borderColor);
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  const error = page.getByText("This repeats your companion's words. Write it in your own words; nothing was recorded.", { exact: true });
  await expect(error).toBeVisible();
  // Linked to the field, said under it; the field keeps its border and the learner's text.
  const describedBy = await field.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`[id="${describedBy}"]`)).toContainText("This repeats your companion's words.");
  expect(await field.evaluate((el) => getComputedStyle(el).borderColor)).toBe(border);
  await expect(field).toHaveValue(reply);
  // Nothing recorded: the question is still open, and nothing went to the page notice.
  await expect(page.getByRole("button", { name: "Submit for review", exact: true })).toBeEnabled();
  await expect(page.getByText(/repeats your companion/)).toHaveCount(1);
  expect((await axe(page)).violations).toEqual([]);
});

test("an attempt the question requires is asked for under the field, and the help bar stays", async ({ page }) => {
  await openCheck(page);
  // The server refuses "I don't know yet" on a question that needs an attempt.
  await page.route("**/answers", (route) =>
    route.request().postDataJSON().abstain
      ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "ABSTAIN_NOT_ALLOWED" }) })
      : route.continue());
  await page.getByRole("button", { name: "I don't know yet: record no answer and get help", exact: true }).click();
  const refusal = page.getByRole("alert").filter({ hasText: "This question needs an attempt. A partial answer is fine." });
  await expect(refusal).toBeVisible();
  // Under the answer field, above "Check" (§4.4).
  expect(await refusal.evaluate((node) => {
    const field = document.querySelector(".connected-check [role='radio']")!, check = document.querySelector(".connected-check .cc-check-submit")!;
    return Boolean(field.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) && Boolean(node.compareDocumentPosition(check) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  // The pressed button went while the request was saved; the learner is put back at the answer.
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: "Get help", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeEnabled();
  await expect(feedbackSlot(page)).toHaveText("");
  // Said once, in place: not in the page error above the lesson.
  await expect(page.getByText(/needs an attempt/)).toHaveCount(1);
});

test("Ask the companion with the panel already open rings the composer it attaches the question to", { tag: "@desktop-window" }, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCheck(page);
  await openCompanion(page);
  const pill = companionPanel(page).locator(".cc-chat-pill");
  await expect(pill).not.toHaveAttribute("data-cc-ring", /.+/);
  await page.getByRole("button", { name: "Get help", exact: true }).click();
  await helpRow(page).getByRole("button", { name: "Ask the companion", exact: true }).click();
  // Only the "Question 1" chip goes in; the open composer is marked (M15, §4.1).
  await expect(companionPanel(page).locator(".cc-chat-attachment")).toContainText("Question 1");
  await expect(pill).toHaveAttribute("data-cc-ring", /.+/);
});

test("Ask the companion opens the companion at the message box and sends nothing", async ({ page }) => {
  await openCheck(page);
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/companion($|\/)/.test(new URL(r.url()).pathname)) sent.push(r.url());
  });
  await page.getByRole("button", { name: "Get help", exact: true }).click();
  await helpRow(page).getByRole("button", { name: "Ask the companion", exact: true }).click();
  await expect(companionPanel(page)).toBeVisible();
  await expect(composerBox(page)).toBeFocused();
  await expect(composerBox(page)).toHaveValue("");
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
  // Closed with Esc, it gives the focus back where it was opened from: the learner is at the
  // check again, not at the header's trigger (§6).
  await page.keyboard.press("Escape");
  await expect(companionPanel(page)).toBeHidden();
  await expect(helpRow(page).getByRole("button", { name: "Ask the companion", exact: true })).toBeFocused();
});
