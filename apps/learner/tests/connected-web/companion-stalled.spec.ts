import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./health";
import { announcer, ask, box, roundButton, startLesson, thread, settled } from "./conversation-helpers";
import enRow from "../../src/i18n/messages/en/replyRow.json";
import heRow from "../../src/i18n/messages/he/replyRow.json";
import enStates from "../../src/i18n/messages/en/replyStates.json";
import heStates from "../../src/i18n/messages/he/replyStates.json";

/*
 * A reply that does not come (final design §3.5; live finding U2): a question whose call got no
 * reply says "No reply came through." with "Ask again", never "still working" forever; a reply
 * that stops arriving part way pauses after 15 s and, after 45 s, says it may not finish, with
 * "Ask again". "Ask again" puts the question back in the box. In English and Hebrew, on every
 * device project. The stalled state is set by the test host (/test/companion-stall); time is the
 * page's own clock, moved forward.
 */
const text = { en: { row: enRow, states: enStates }, he: { row: heRow, states: heStates } } as const;

for (const locale of ["en", "he"] as const) {
  const t = text[locale];
  test(`no reply came through: the line and Ask again, which restores the question (${locale})`, async ({ page, request }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await startLesson(page, request, { locale });
    const question = `Stalled question ${locale} ${Date.now()}`;
    await ask(page, question);
    expect((await (await request.post("/test/companion-stall", { data: { question } })).json()).stalled).toBe(true);
    const row = thread(page).locator('[data-reply-state="ended"]');
    await expect(row).toContainText(t.row["ended.noReply"], { timeout: 15_000 });
    await expect(page.getByText(t.row.slow, { exact: true })).toHaveCount(0);
    // Over: the round button sends again, nothing offers to stop it.
    await expect(roundButton(page)).not.toHaveAccessibleName(/Stop|עצירה|עצירת/);
    await expect(announcer(page)).toHaveText(t.states["announce.ended"]);
    const askAgain = row.getByRole("button", { name: t.row.askAgain, exact: true });
    await expect(askAgain).toBeVisible();
    await settled(page);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`companion-stalled-${locale}.png`) });
    await box(page).fill("");
    await askAgain.click();
    await expect(box(page)).toHaveValue(question);
    const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
    await roundButton(page).click();
    expect((await sent).status()).toBe(200);
    await expect(thread(page).locator(".cc-chat-bubble").filter({ hasText: question })).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test(`a reply that stops arriving pauses at 15 s and may not finish at 45 s, with Ask again (${locale})`, async ({ page, request }) => {
    await startLesson(page, request, { locale });
    const question = `Paused reply ${locale} ${Date.now()}`;
    await ask(page, question);
    await page.clock.install();
    await expect.poll(async () => (await (await request.post("/test/conversation-dispatch", { data: { question, pieces: ["Compare the two values. "], gapMs: 50 } })).json()).opened).toBe(true);
    const row = thread(page).locator('[data-reply-state="streaming"]');
    await expect(row).toContainText("Compare the two values.", { timeout: 15_000 });
    await page.clock.fastForward(16_000);
    await expect(row).toContainText(t.row.paused);
    await expect(row.locator('[data-cc-caret="still"]')).toHaveCount(1);
    await page.clock.fastForward(30_000);
    await expect(row).toContainText(t.row.stalled);
    await expect(announcer(page)).toHaveText(t.states["announce.stalled"]);
    await row.getByRole("button", { name: t.row.askAgain, exact: true }).click();
    await expect(box(page)).toHaveValue(question);
    expect((await new AxeBuilder({ page }).include("#connected-companion").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  });
}
