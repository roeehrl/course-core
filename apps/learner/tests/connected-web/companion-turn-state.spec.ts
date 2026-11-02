import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./health";
import { ask, box, startLesson, storeReply, thread, settled } from "./conversation-helpers";

/*
 * Whose turn it is (final design §3.3, G2; the owner's "it says 'what would you like to
 * understand' after it asked me a question"): a stored reply that asks the learner something sets
 * its question at weight 600 with "Your turn", the box says "Your answer…" and the answer chips
 * send a visible turn; the tag goes after any send. A reply stored before the server marked asking
 * replies is read by the same rule in the app. Replies are stored by the test host.
 */
for (const locale of ["en", "he"] as const) {
  test(`a reply that asks the learner: 600-weight question, "Your turn", "Your answer…" and answer chips (${locale})`, async ({ page, request }, info) => {
    const he = locale === "he";
    await startLesson(page, request, { locale });
    const question = he ? `למה 2 קטן מ-3? ${Date.now()}` : `Why is 2 smaller than 3? ${Date.now()}`;
    await ask(page, question);
    const answer = he
      ? "על ציר המספרים 2 נמצא משמאל ל-3.\n\nאיזה מספר נמצא משמאל כשמשווים את 4 ל-9?"
      : "On the number line 2 sits left of 3.\n\nWhich number sits further left when you compare 4 and 9?";
    // Stored as the supervisor stores a reply: the server marks that it asks the learner.
    expect((await (await request.post("/test/companion-job", { data: { question, state: "applied", answer } })).json()).updated).toBe(true);
    const closing = thread(page).locator("[data-cc-question]");
    await expect(closing).toBeVisible({ timeout: 15_000 });
    await expect(closing).toHaveText(he ? "איזה מספר נמצא משמאל כשמשווים את 4 ל-9?" : "Which number sits further left when you compare 4 and 9?");
    expect(await closing.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600");
    const tag = thread(page).getByText(he ? "מחכה לתשובה" : "Your turn", { exact: true });
    await expect(tag).toBeVisible();
    await expect(box(page)).toHaveAttribute("placeholder", he ? "כתיבת תשובה…" : "Your answer…");
    const chips = thread(page).getByRole("group", { name: he ? "תשובות מוצעות" : "Suggested answers" });
    await expect(chips.getByRole("button")).toHaveText(he ? ["עוד לא ברור לי", "רמז, בבקשה", "דוגמה, בבקשה"] : ["I'm not sure", "Give me a hint", "Show me an example"]);
    await settled(page);
    expect((await new AxeBuilder({ page }).include("#connected-companion").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`your-turn-${locale}.png`) });
    // An answer chip sends a visible turn, and the turn is over.
    const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
    await chips.getByRole("button").first().click();
    expect((await sent).status()).toBe(200);
    await expect(thread(page).locator(".cc-chat-bubble").filter({ hasText: he ? "עוד לא ברור לי" : "I'm not sure" })).toBeVisible();
    await expect(tag).toHaveCount(0);
    await expect(box(page)).toHaveAttribute("placeholder", he ? "ההודעה הבאה…" : "Write your next message…");
  });
}

test("an older reply stored without the server's mark is read by the same rule, and a plain reply offers follow-ups", async ({ page, request }) => {
  await startLesson(page, request);
  const first = `Old row ${Date.now()}`;
  await ask(page, first);
  await storeReply(request, first, "Compare them on the number line. Which one is further left?");
  await expect(thread(page).getByText("Your turn", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(box(page)).toHaveAttribute("placeholder", "Your answer…");
  const second = `Plain row ${Date.now()}`;
  await ask(page, second);
  await expect(thread(page).getByText("Your turn", { exact: true })).toHaveCount(0);
  await storeReply(request, second, "The one further left is smaller.", { asksLearner: false });
  await expect(thread(page).getByText("The one further left is smaller.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(box(page)).toHaveAttribute("placeholder", "Reply…");
  // That reply ended the exchange the first one opened: back to the lesson, or another question.
  await expect(thread(page).getByRole("button", { name: "Back to the lesson" })).toBeVisible();
  await expect(thread(page).getByRole("group", { name: "Suggested answers" }).getByRole("button")).toHaveText(["Ask another question"]);
  const third = `Plain again ${Date.now()}`;
  await ask(page, third);
  await storeReply(request, third, "Both are whole numbers.", { asksLearner: false });
  await expect(thread(page).getByText("Both are whole numbers.", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(thread(page).getByRole("button", { name: "Back to the lesson" })).toHaveCount(0);
  await expect(thread(page).getByRole("group", { name: "Suggested answers" }).getByRole("button")).toHaveText(["Explain it another way", "Show me an example", "Quiz me on this"]);
  // Typing hides the chips.
  await box(page).fill("x");
  await expect(thread(page).getByRole("group", { name: "Suggested answers" })).toHaveCount(0);
});

/*
 * The end of a run of practice (the owner's lesson 1.1 report: twelve replies in a row ended with
 * "Your turn"). Core's pacing (services/api/src/companion-pacing.ts) makes the reply after right
 * answers confirm and point back to the lesson without a question; the app then offers "Back to the
 * lesson" in place of "Your turn", with "Ask another question" beside it.
 */
for (const locale of ["en", "he"] as const) {
  test(`a reply that ends a run of practice: "Back to the lesson" instead of "Your turn", and "Ask another question" (${locale})`, async ({ page, request }, info) => {
    const he = locale === "he";
    await startLesson(page, request, { locale });
    const question = he ? `למה 2 קטן מ-3? ${Date.now()}` : `Why is 2 smaller than 3? ${Date.now()}`;
    await ask(page, question);
    await storeReply(request, question, he ? "2 נמצא משמאל ל-3.\n\nאיזה מספר קטן יותר, 4 או 9?" : "2 sits left of 3.\n\nWhich is smaller, 4 or 9?");
    await expect(thread(page).getByText(he ? "מחכה לתשובה" : "Your turn", { exact: true })).toBeVisible({ timeout: 15_000 });
    const answer = he ? `4, כי הוא משמאל ${Date.now()}` : `4, it is further left ${Date.now()}`;
    await ask(page, answer);
    await storeReply(request, answer, he
      ? "נכון: 4 נמצא משמאל ל-9, ולכן הוא קטן יותר. הראית שמשווים מספרים לפי המקום שלהם על הציר. אפשר להמשיך לחלק הבא בשיעור."
      : "Correct: 4 sits left of 9, so it is smaller. You have shown that you compare numbers by their place on the line. Continue with the next part of the lesson.", { asksLearner: false });
    const back = thread(page).getByRole("button", { name: he ? "חזרה לשיעור" : "Back to the lesson" });
    await expect(back).toBeVisible({ timeout: 15_000 });
    await expect(thread(page).getByText(he ? "מחכה לתשובה" : "Your turn", { exact: true })).toHaveCount(0);
    await expect(box(page)).toHaveAttribute("placeholder", he ? "תגובה…" : "Reply…");
    const chips = thread(page).getByRole("group", { name: he ? "תשובות מוצעות" : "Suggested answers" });
    await expect(chips.getByRole("button")).toHaveText([he ? "עוד שאלת תרגול" : "Ask another question"]);
    await settled(page);
    expect((await new AxeBuilder({ page }).include("#connected-companion").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`back-to-lesson-${locale}.png`) });
    // Another question is the learner's own request to practise: it is sent as a visible turn.
    const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
    await chips.getByRole("button").first().click();
    expect((await sent).status()).toBe(200);
    await expect(thread(page).locator(".cc-chat-bubble").filter({ hasText: he ? "עוד שאלת תרגול, בבקשה" : "Ask me another question" })).toBeVisible();
    await expect(back).toHaveCount(0);
  });
}
