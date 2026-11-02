import { nextControlKey, test, expect, type Page } from "./health";
import { ask, box, roundButton, startLesson, stream, thread } from "./conversation-helpers";
import { closeCompanion, companionPanel, composerBox, openCompanion } from "./companion-helpers";

/*
 * The companion redesign end to end, across its parts (final design §3-§5; integration's journeys):
 * a check's "Ask the companion" through "Send as practice" to the check's reason and its way back;
 * a lesson selection to the anchor chip above the sent question and back to the lesson; a reply
 * notification to the lesson part and the reply; a phone's sheet showing the check asked about
 * above it before going Full; focus view, where Esc stops a reply and then leaves; the trigger's
 * dot to the oldest unread reply; and the panel's Tab order. Replies are scripted by the test
 * host; no model is involved.
 */

/** A learner of "Ordering values" in its first lesson, the part read and its check open. */
async function openCheck(page: Page, request: Page["request"]) {
  await startLesson(page, request);
  await closeCompanion(page);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeVisible();
}
const helpRow = (page: Page) => page.getByRole("group", { name: "Help with question 1" });
/** Selects `word` in the first reading part, as a learner's drag would. */
async function selectInLesson(page: Page, word: string) {
  await page.evaluate((target) => {
    const walker = document.createTreeWalker(document.querySelector("[data-reading-part]")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(target) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + target.length);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
  }, word);
}

test("a check's Ask the companion: the question goes as its chip with the credit line, Send as practice says so in the thread, and the check says why with a way back", async ({ page, request }) => {
  await openCheck(page, request);
  await page.getByRole("button", { name: "Get help", exact: true }).click();
  await helpRow(page).getByRole("button", { name: "Ask the companion", exact: true }).click();
  const panel = companionPanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator(".cc-chat-attachment")).toContainText("Question 1");
  await expect(panel.getByTestId("credit-line")).toContainText("Question 1 counts. Asking now makes it practice.");
  await expect(composerBox(page)).toBeFocused();
  await composerBox(page).fill("How do I compare these two values?");
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/companion")) posts.push(r.postData() ?? "");
  });
  await roundButton(page).click();
  // Nothing is sent before the choice; the safe choice has the focus.
  await expect(panel.getByRole("button", { name: "Keep it counted" })).toBeFocused();
  expect(posts).toEqual([]);
  await panel.getByRole("button", { name: "Send as practice" }).click();
  await expect(composerBox(page)).toBeFocused();
  await expect(panel.getByRole("note").filter({ hasText: "Question 1 is now practice." })).toBeVisible();
  // The attached question went with the message.
  await expect.poll(() => posts.length).toBe(1);
  expect(JSON.parse(posts[0]!)).toMatchObject({ allowAssessmentAssistance: true });
  await closeCompanion(page);
  const check = page.locator(".connected-check");
  await expect(page.getByTestId("question-kind")).toHaveText("Practice. This question does not count toward finishing the lesson.");
  await expect(check.getByText("You asked your companion for help.", { exact: true })).toBeVisible();
  await check.getByRole("button", { name: /^Get a fresh check/ }).click();
  await expect(page.getByTestId("question-kind")).toHaveText("Counts toward this lesson. Answer on your own.");
});

test("a lesson selection: Ask companion attaches it, the sent question carries it as its anchor chip, and the chip shows the part again", async ({ page, request }) => {
  await startLesson(page, request);
  await closeCompanion(page);
  await selectInLesson(page, "member");
  await page.getByRole("button", { name: "Ask companion", exact: true }).click();
  await openCompanion(page);
  await expect(companionPanel(page).locator(".cc-chat-attachment")).toContainText("Selected: “member”");
  const question = `What does member mean here ${Date.now()}`;
  await ask(page, question);
  const turn = thread(page).locator(".cc-chat-turn.is-learner").filter({ hasText: question });
  const anchor = turn.getByRole("button", { name: /Selected: “member”/ });
  await expect(anchor).toBeVisible();
  // The chip is above the bubble.
  expect((await anchor.boundingBox())!.y).toBeLessThan((await turn.locator(".cc-chat-bubble").boundingBox())!.y);
  await expect(companionPanel(page).locator(".cc-chat-attachment")).toHaveCount(0);
  await anchor.click();
  // The part is shown and marked (M14).
  const marked = page.locator(".connected-lesson-keeper:not([hidden]) [data-cc-highlight]");
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText("member");
  await expect(marked).toBeInViewport();
});

test("a reply notification opens the lesson part, marked, with the companion at the reply", async ({ page }) => {
  const QUESTION = "Why is the smallest value always the minimum of the list?";
  const ANSWER = "Because no other member is smaller than it.";
  const body = (await (await page.request.post("/test/notify-session", { data: { question: QUESTION } })).json()) as { token: string; questionId: string };
  await page.goto(`/#signin=${body.token}`);
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: /^(Open course|Continue learning →)$/ }).click();
  const replyId = ((await (await page.request.post("/test/notify-reply", { data: { answer: ANSWER, questionId: body.questionId, away: true } })).json()) as { replyMessageId: string }).replyMessageId;
  await page.reload();
  await page.getByRole("button", { name: "Notifications, 1 new" }).click();
  await page.locator(".connected-notifications-panel").getByRole("button", { name: "Open reply", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  await expect(page.locator(".connected-lesson-keeper:not([hidden]) .connected-reading-card[data-cc-highlight]")).toHaveCount(1);
  const answer = companionPanel(page).locator(`[data-message-id="${replyId}"]`);
  await expect(answer).toContainText(ANSWER);
  await expect(answer).toBeInViewport();
});

test("on a phone, Ask the companion at a check low in the lesson shows that check above the sheet, then the sheet goes Full", { tag: "@desktop-window" }, async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCheck(page, request);
  // The learner scrolled back up to the lesson's start: the check is below the half the sheet leaves.
  await page.locator(".connected-main").evaluate((pane) => pane.scrollTo({ top: 0 }));
  await page.getByRole("button", { name: "Get help", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Get help", exact: true }).click();
  await helpRow(page).getByRole("button", { name: "Ask the companion", exact: true }).click();
  const panel = companionPanel(page);
  await expect(panel).toHaveAttribute("data-placement", "sheet");
  await expect(composerBox(page)).toBeFocused();
  await expect(panel).toHaveAttribute("data-detent", "full");
  // The check's question is in the strip Full leaves above the sheet (G6, §4.1).
  const strip = await page.evaluate(() => ({
    top: document.querySelector(".connected-header")!.getBoundingClientRect().bottom,
    bottom: document.querySelector("#connected-companion")!.getBoundingClientRect().top,
  }));
  const title = (await page.locator("#connected-check-title").boundingBox())!;
  expect(title.y).toBeGreaterThanOrEqual(strip.top - 1);
  expect(title.y + title.height).toBeLessThanOrEqual(strip.bottom + 1);
});

test("in focus view Esc first stops the reply being written, then leaves focus view", { tag: "@desktop-window" }, async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startLesson(page, request);
  const panel = companionPanel(page);
  await panel.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(panel).toHaveAttribute("data-view", "focus");
  const question = `Focus view question ${Date.now()}`;
  await ask(page, question);
  await stream(request, question, Array.from({ length: 12 }, (_, i) => `Part ${i + 1} of the reply. `), { gapMs: 400 });
  await expect(thread(page).locator('[data-reply-state="streaming"]')).toContainText("Part 1");
  await box(page).focus();
  await page.keyboard.press("Escape");
  await expect(thread(page).locator('[data-reply-state="stopped"]')).toBeVisible();
  await expect(panel).toHaveAttribute("data-view", "focus");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-view", "docked");
  await expect(panel).toBeVisible();
});

test("the trigger's dot leads to the oldest unread reply", async ({ page }) => {
  const QUESTION = "Which member is the smallest?";
  const ANSWER = "The one no other member is smaller than.";
  const body = (await (await page.request.post("/test/notify-session", { data: { question: QUESTION } })).json()) as { token: string; questionId: string; enrollmentId: string };
  await page.goto(`/#signin=${body.token}`);
  const course = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: /^(Open course|Continue learning →)$/ });
  await course.click();
  // This device has shown the conversation once (the question, no reply yet).
  await expect.poll(() => page.evaluate((id) => window.localStorage.getItem(`course:companion-seen:${id}`), body.enrollmentId)).toBe("");
  const replyId = ((await (await page.request.post("/test/notify-reply", { data: { answer: ANSWER, questionId: body.questionId, away: false } })).json()) as { replyMessageId: string }).replyMessageId;
  await page.reload();
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: /^(Open course|Continue learning →)$/ }).click();
  const trigger = page.locator(".connected-companion-trigger:visible");
  await expect(trigger).toHaveAccessibleName("Companion, 1 new reply");
  await expect(trigger.locator(".cc-shell-trigger-dot")).toBeVisible();
  await trigger.click();
  const answer = companionPanel(page).locator(`[data-message-id="${replyId}"]`);
  await expect(answer).toBeInViewport();
  await expect(trigger).toHaveAccessibleName("Companion");
});

test("the panel's Tab order: header, thread, Jump to latest, the notice's action, the attachment, the box, the round button", { tag: "@desktop-window" }, async ({ page, request, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startLesson(page, request);
  // A conversation long enough to scroll, with a reply that has chips under it.
  for (let i = 1; i <= 3; i++) {
    const question = `Tab order question ${i} ${Date.now()}`;
    await ask(page, question);
    await expect.poll(async () => (await (await request.post("/test/companion-job", { data: { question, state: "applied", answer: `Answer ${i}. `.repeat(40) } })).json()).updated).toBe(true);
    await expect(thread(page).getByText(`Answer ${i}.`, { exact: false })).toBeVisible({ timeout: 15_000 });
  }
  // A counted question open and attached: the credit line (with its ⓘ) and the "Question 1" chip.
  await closeCompanion(page);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("button", { name: "Get help", exact: true }).click();
  await helpRow(page).getByRole("button", { name: "Ask the companion", exact: true }).click();
  const panel = companionPanel(page);
  await expect(panel.locator(".cc-chat-attachment")).toContainText("Question 1");
  // Away from the end: Jump to latest shows.
  await thread(page).evaluate((log) => log.scrollTo({ top: 0 }));
  const jump = panel.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();
  // From the header's last control, every stop until the round button and one more.
  await panel.getByRole("button", { name: "Close companion", exact: true }).focus();
  const stops: string[] = [];
  for (let i = 0; i < 80 && !stops.includes("round"); i++) {
    await page.keyboard.press(nextControlKey(browserName));
    stops.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "none";
      if (el.getAttribute("role") === "log") return "thread";
      if (el.classList.contains("cc-chat-jump")) return "jump";
      if (el.closest(".cc-chat-attachment")) return "attachment";
      if (el.classList.contains("cc-chat-field")) return "textarea";
      if (el.classList.contains("cc-chat-send")) return "round";
      if (el.closest(".cc-chat-notice")) return "notice";
      if (el.closest(".cc-chat-chips")) return "chips";
      return el.closest("#connected-companion") ? "inside" : "outside";
    }));
  }
  // The order of §5. The reply chips sit under the latest reply in the thread (§3.3), so they come
  // with the thread, before Jump to latest.
  const at = (name: string) => stops.indexOf(name);
  for (const name of ["thread", "chips", "notice", "attachment", "textarea", "round"]) expect(at(name), name).toBeGreaterThanOrEqual(0);
  expect(at("thread")).toBeLessThan(at("chips"));
  expect(at("chips")).toBeLessThan(at("notice"));
  expect(at("notice")).toBeLessThan(at("attachment"));
  expect(stops.slice(at("attachment"), at("round") + 1)).toEqual(["attachment", "textarea", "round"]);
  // Every stop on the way is the companion's own: none falls out to the page.
  expect(stops).not.toContain("outside");
  // Jump to latest is a stop while the end is out of view: Tabbing through the thread brings the
  // end into view (and hides it), so it is checked from the notice's action, a step back.
  await thread(page).evaluate((log) => log.scrollTo({ top: 0 }));
  await expect(jump).toBeVisible();
  await panel.locator(".cc-chat-notice button").first().focus();
  await page.keyboard.press(nextControlKey(browserName, true));
  await expect(jump).toBeFocused();
  await page.keyboard.press(nextControlKey(browserName, true));
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role='log']")))).toBe(true);
});
