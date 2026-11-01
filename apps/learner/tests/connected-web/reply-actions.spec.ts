import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./health";
import { companionPanel, openCompanion } from "./companion-helpers";
import enReplyActions from "../../src/i18n/messages/en/replyActions.json";
import heReplyActions from "../../src/i18n/messages/he/replyActions.json";
import enVote from "../../src/i18n/messages/en/voteControls.json";
import heVote from "../../src/i18n/messages/he/voteControls.json";
import enMenu from "../../src/i18n/messages/en/replyMenu.json";
import heMenu from "../../src/i18n/messages/he/replyMenu.json";
import enBasedOn from "../../src/i18n/messages/en/basedOn.json";
import heBasedOn from "../../src/i18n/messages/he/basedOn.json";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";

/*
 * The actions on companion messages in the real app (final design §3.7): the reply's row (Copy,
 * Helpful, Not helpful, More), votes that are saved and read back, the optional comment and a
 * report, the More menu by keyboard, deleting a question through its own menu and confirm, "Try
 * question 1" back to the check, the row's order in Hebrew, and axe on the open "Based on".
 * Sessions are /test/actions-session (services/api/browser/fixtures/actions.ts); no provider.
 */
const text = {
  en: { reply: enReplyActions, vote: enVote, menu: enMenu, basedOn: enBasedOn, host: enHost },
  he: { reply: heReplyActions, vote: heVote, menu: heMenu, basedOn: heBasedOn, host: heHost },
} as const;
const LATEST_REPLY = /Compare them on a number line/;

async function session(page: Page, body: Record<string, unknown> = {}, locale: "en" | "he" = "en") {
  const response = await page.request.post("/test/actions-session", { data: body });
  expect(response.ok()).toBe(true);
  const { token, enrollmentId } = (await response.json()) as { token: string; enrollmentId: string };
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await enterLesson(page, locale);
  return enrollmentId;
}
/** From the library or the course page into the lesson, its check open. */
async function enterLesson(page: Page, locale: "en" | "he" = "en") {
  const resume = page.getByRole("button", { name: text[locale].host["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
  const lesson = page.locator(".connected-check");
  await expect(async () => {
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(lesson).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
/** The action row of the reply that matches `reply`. */
function rowOf(page: Page, reply: RegExp, locale: "en" | "he" = "en") {
  return companionPanel(page).locator("[data-message-id]").filter({ hasText: reply }).getByRole("group", { name: text[locale].reply.group, exact: true });
}
const feedback = async (page: Page, enrollment: string) =>
  ((await (await page.request.get(`/test/actions-feedback?enrollment=${enrollment}`)).json()) as { rows: { vote: string | null; comment: string | null; reported: boolean }[] }).rows;

test("the reply's row copies, votes, takes a comment and a report, and keeps the vote after a reload", async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
  const t = text.en;
  const enrollment = await session(page);
  await openCompanion(page);
  const row = rowOf(page, LATEST_REPLY);
  await expect(row).toBeVisible();
  // Copy: a check mark for 2 s and "Copied", said once.
  await row.getByRole("button", { name: t.reply.copy, exact: true }).click();
  await expect(row.getByRole("status")).toHaveText(t.reply.copied);
  await expect(row.getByRole("status")).toHaveText("", { timeout: 4_000 });
  // Helpful: pressed at once, then "Thanks, noted." in Based on's place.
  const helpful = row.getByRole("button", { name: t.vote.helpful, exact: true });
  await helpful.click();
  await expect(helpful).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByRole("status")).toHaveText(t.reply.thanks);
  await expect.poll(() => feedback(page, enrollment)).toEqual([{ vote: "helpful", comment: null, reported: false }]);
  // Not helpful with a comment, then a report from More.
  await row.getByRole("button", { name: t.vote.notHelpful, exact: true }).click();
  const note = companionPanel(page).getByRole("textbox", { name: t.vote["note.label"], exact: true });
  await expect(note).toBeFocused();
  await note.fill("It skipped the comparison.");
  await page.keyboard.press("Enter");
  await expect(note).toBeHidden();
  await row.getByRole("button", { name: t.menu.more, exact: true }).click();
  await companionPanel(page).getByRole("menuitem", { name: t.menu.report, exact: true }).click();
  await expect.poll(() => feedback(page, enrollment)).toEqual([{ vote: "not_helpful", comment: "It skipped the comparison.", reported: true }]);
  await page.screenshot({ path: info.outputPath("reply-row.png") });
  // Read back after a reload.
  await page.reload();
  await enterLesson(page);
  await openCompanion(page);
  await expect(rowOf(page, LATEST_REPLY).getByRole("button", { name: t.vote.notHelpful, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(rowOf(page, LATEST_REPLY).getByRole("button", { name: t.vote.helpful, exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("More works from the keyboard and leaves a reply out of later answers", async ({ page }) => {
  const t = text.en;
  await session(page);
  await openCompanion(page);
  const row = rowOf(page, LATEST_REPLY);
  const more = row.getByRole("button", { name: t.menu.more, exact: true });
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = companionPanel(page).getByRole("menu", { name: t.menu.label, exact: true });
  await expect(menu.getByRole("menuitem", { name: t.menu.exclude, exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: t.menu.report, exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const reply = companionPanel(page).locator("[data-message-id]").filter({ hasText: LATEST_REPLY });
  await expect(reply.getByText(t.reply.excluded, { exact: true })).toBeVisible();
  await more.click();
  await expect(companionPanel(page).getByRole("menuitem", { name: t.menu.include, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a question is deleted through its own menu and a confirm that starts on Cancel", async ({ page }, info) => {
  await session(page);
  await openCompanion(page);
  const panel = companionPanel(page);
  const question = panel.locator("[data-message-id]").filter({ hasText: "What does minimum mean here?" });
  const options = question.getByRole("button", { name: "Message options", exact: true });
  await question.hover();
  await options.click();
  await panel.getByRole("menuitem", { name: "Delete question", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: /^Delete this question and its answer\?/ });
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  // The danger fill, not the accent.
  const fills = await confirm.getByRole("button", { name: "Delete", exact: true }).evaluate((node) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--danger)";
    node.parentElement!.append(probe);
    const danger = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { background: getComputedStyle(node).backgroundColor, danger };
  });
  expect(fills.background).toBe(fills.danger);
  await page.screenshot({ path: info.outputPath("delete-confirm.png") });
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(options).toBeFocused();
  await expect(panel.getByText("What does minimum mean here?", { exact: true })).toBeVisible();
  await options.click();
  await panel.getByRole("menuitem", { name: "Delete question", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(confirm).toBeHidden();
  // The question and its answer go; one line says a question was deleted (conversation words it).
  await expect(panel.getByText("What does minimum mean here?", { exact: true })).toHaveCount(0);
  await expect(panel.getByText(/Minimum means no greater than any other member/)).toHaveCount(0);
  await expect(panel.getByText(/^You deleted (a|this) question\.$/)).toBeVisible();
});

test("“Try question 1” shows the check and focuses its answer, leaving the companion out of the way", async ({ page }) => {
  await session(page);
  await openCompanion(page);
  const row = rowOf(page, LATEST_REPLY);
  const tryIt = row.getByRole("button", { name: /^Try question \d+$/ });
  await expect(tryIt).toBeVisible();
  await tryIt.click();
  const answer = page.locator(".connected-check").getByRole("textbox").or(page.locator(".connected-check input")).first();
  await expect(answer).toBeFocused();
  await expect(page.locator(".connected-check")).toBeInViewport();
  // Beside the lesson the companion stays open; as a sheet it gives way to the lesson.
  if (page.viewportSize()!.width >= 840) await expect(companionPanel(page)).toBeVisible();
});

test("the Hebrew row starts at the right, and an open Based on passes axe", async ({ page }, info) => {
  const t = text.he;
  await session(page, { withheld: true }, "he");
  await openCompanion(page);
  const row = rowOf(page, LATEST_REPLY, "he");
  const x = async (name: string) => (await row.getByRole("button", { name, exact: true }).boundingBox())!.x;
  const [copy, helpful, notHelpful, more] = [await x(t.reply.copy), await x(t.vote.helpful), await x(t.vote.notHelpful), await x(t.menu.more)];
  expect(copy).toBeGreaterThan(helpful);
  expect(helpful).toBeGreaterThan(notHelpful);
  expect(notHelpful).toBeGreaterThan(more);
  const rowBox = (await row.boundingBox())!, reply = (await companionPanel(page).locator("[data-message-id]").filter({ hasText: LATEST_REPLY }).boundingBox())!;
  expect(rowBox.x + rowBox.width).toBeGreaterThan(reply.x + reply.width - 48);
  await row.getByRole("button", { name: new RegExp(`^${t.basedOn["chip.short"]}`) }).click();
  await expect(companionPanel(page).getByRole("region", { name: t.basedOn.region, exact: true })).toBeVisible();
  // The hint in place of an answer has its footnote instead of Based on.
  const hint = companionPanel(page).locator("[data-message-id]").filter({ hasText: /I can't give or confirm/ }).first();
  await hint.hover();
  await hint.getByRole("button", { name: t.basedOn["withheld.chip"], exact: true }).click();
  await expect(hint.getByText(t.basedOn["withheld.more"], { exact: true })).toBeVisible();
  const results = await new AxeBuilder({ page }).include("#connected-companion").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("reply-actions-he.png") });
});
