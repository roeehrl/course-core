import { test, expect, type Page } from "./health";
import { announcer, ask, box, roundButton, startLesson, stream, thread } from "./conversation-helpers";
import enRow from "../../src/i18n/messages/en/replyRow.json";
import heRow from "../../src/i18n/messages/he/replyRow.json";
import enTurn from "../../src/i18n/messages/en/learnerTurn.json";
import heTurn from "../../src/i18n/messages/he/learnerTurn.json";
import enNotice from "../../src/i18n/messages/en/noticeSlot.json";
import heNotice from "../../src/i18n/messages/he/noticeSlot.json";
import enStop from "../../src/i18n/messages/en/sendStopButton.json";
import heStop from "../../src/i18n/messages/he/sendStopButton.json";

/*
 * The states of a question in the real app, over the real event stream, in English and Hebrew
 * (final design §3.5): the round button is "Stop reply" from the moment a question is accepted,
 * within a second of the dispatch frame at the latest, and never with queued controls beside a
 * draft; a question held by a spending limit waits to send, with Cancel on the question and the
 * paused banner above the composer (no status line); replies grow from the anchored question; a
 * question stopped after its call was sent says so and can be asked again. Scripted by the test
 * host; no provider is called.
 */
const text = { en: { row: enRow, turn: enTurn, notice: enNotice, stop: enStop }, he: { row: heRow, turn: heTurn, notice: heNotice, stop: heStop } } as const;
const statusLine = (page: Page) => page.locator("#connected-companion").getByText(/^(Companion|המנחה): /);

for (const locale of ["en", "he"] as const) {
  const t = text[locale];
  test(`Stop is the round button within a second of the dispatch frame, never beside queued controls, and a held question waits to send (${locale})`, async ({ page, request }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await startLesson(page, request, { locale });
    const question = `State question ${locale} ${Date.now()}`;
    // Time the first draft text and the Stop name in the page itself, as the learner sees them.
    await page.evaluate(({ stop }) => {
      const marks: { draft?: number; stop?: number; cancelWithDraft?: boolean } = {};
      (window as unknown as { __marks: typeof marks }).__marks = marks;
      const check = () => {
        const now = performance.now();
        const button = document.querySelector(".cc-chat-send");
        if (marks.stop === undefined && button?.getAttribute("aria-label") === stop) marks.stop = now;
        const draft = document.querySelector('[data-reply-state="streaming"]');
        if (marks.draft === undefined && draft?.textContent?.includes("Picture both values")) marks.draft = now;
        if (draft && document.querySelector("#connected-companion [role=log] .cc-chat-footer")) marks.cancelWithDraft = true;
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    }, { stop: t.stop.stop });
    await ask(page, question);
    // Accepted: nothing is under the question, and the round button stops it.
    await expect(roundButton(page)).toHaveAccessibleName(t.stop.stop);
    await expect(thread(page).locator(".cc-chat-footer")).toHaveCount(0);
    await stream(request, question, ["Picture both values on a number line. ", "The one farther left ", "is smaller."], { end: "complete", gapMs: 400 });
    const draft = thread(page).locator('[data-reply-state="streaming"]');
    await expect(draft).toContainText("is smaller.");
    const marks = await page.evaluate(() => (window as unknown as { __marks: { draft?: number; stop?: number; cancelWithDraft?: boolean } }).__marks);
    expect(marks.draft, "the first draft text was seen").toBeDefined();
    expect(marks.stop, "Stop was seen").toBeDefined();
    expect(marks.stop! - marks.draft!).toBeLessThan(1000);
    expect(marks.cancelWithDraft ?? false, "never the queued controls beside a draft").toBe(false);
    await expect(statusLine(page)).toHaveCount(0);
    // The reply is stored; then a question held by a spending limit.
    expect((await (await request.post("/test/companion-job", { data: { question, state: "applied", answer: "Compare positions on the line." } })).json()).updated).toBe(true);
    await expect(thread(page).getByText("Compare positions on the line.", { exact: true })).toBeVisible({ timeout: 15_000 });
    const held = `Held question ${locale} ${Date.now()}`;
    await ask(page, held);
    const ceiling = locale === "en" ? "workspace" : "enrollment";
    expect((await (await request.post("/test/companion-job", { data: { question: held, state: "budget_wait", ceiling } })).json()).updated).toBe(true);
    const banner = page.locator("#connected-companion .cc-chat-notice");
    await expect(banner).toContainText(t.notice[ceiling === "workspace" ? "paused.workspace" : "paused.enrollment"], { timeout: 15_000 });
    const heldTurn = thread(page).locator(".cc-chat-turn.is-learner").filter({ hasText: held });
    await expect(heldTurn.getByText(t.turn.held, { exact: true })).toBeVisible();
    await expect(heldTurn.getByRole("button", { name: t.turn.cancel, exact: true })).toBeVisible();
    await expect(statusLine(page)).toHaveCount(0);
    await expect(announcer(page)).toHaveText(t.turn.held);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });

  test(`a question stopped after its call was sent says so and can be asked again (${locale})`, async ({ page, request }) => {
    await startLesson(page, request, { locale });
    const stopped = `Stopped question ${locale} ${Date.now()}`;
    await ask(page, stopped);
    expect((await (await request.post("/test/companion-job", { data: { question: stopped, state: "cancelled" } })).json()).updated).toBe(true);
    const row = thread(page).locator('[data-reply-state="stopped"]');
    await expect(row).toContainText(t.row.stopped, { timeout: 15_000 });
    // Not an error: no alert icon on the learner's own Stop.
    await expect(row.locator(".cc-ui-status.is-error")).toHaveCount(0);
    await box(page).fill("");
    await row.getByRole("button", { name: t.row.askAgain, exact: true }).click();
    await expect(box(page)).toHaveValue(stopped);
    await expect(box(page)).toBeFocused();
  });
}
