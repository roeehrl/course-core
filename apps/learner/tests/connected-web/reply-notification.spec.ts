import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "./health";
import { companionPanel, composerBox } from "./companion-helpers";

/*
 * Real API and PostgreSQL: a companion reply that arrives while the learner is away (final design
 * §4.8). The bell's row names the lesson and quotes the question; opening it lands in that lesson
 * with the part the question was about marked, and the companion open at the reply (its message
 * box focused with a fine pointer only, so a touch keyboard does not cover the reply). A reply
 * whose lesson left the course opens the course page with the companion. A reply that settles
 * while the learner is here goes to no bell: it stays unread on this device until the companion
 * shows it (unread.ts; the trigger's dot and the check's line read that).
 */

// A first visit: no remembered companion pane, so the notification is what opens it.
test.use({ companionPane: "default" });

const QUESTION = "Why is the smallest value always the minimum of the list?";
const ANSWER = "Because no other member is smaller than it. Which member would you check first?";

async function session(page: Page) {
  const body = (await (await page.request.post("/test/notify-session", { data: { question: QUESTION } })).json()) as {
    token: string;
    enrollmentId: string;
    questionId: string;
  };
  await page.goto(`/#signin=${body.token}`);
  return body;
}
/** Opens the course, so this device has shown its conversation once (the question, no reply yet). */
async function openCourse(page: Page, enrollmentId: string) {
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: /^(Open course|Continue learning →)$/ })
    .click();
  await expect.poll(() => seen(page, enrollmentId)).toBe("");
}
/** Waits for the panel's opening fade (M16), so axe reads its colours as they settle. */
const settled = (panel: Locator) => panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
/** The newest reply this device has shown for the enrollment (unread.ts), or null. */
const seen = (page: Page, enrollmentId: string) =>
  page.evaluate((id) => window.localStorage.getItem(`course:companion-seen:${id}`), enrollmentId);
const reply = async (page: Page, data: { questionId: string; away: boolean; lessonGone?: boolean }) =>
  ((await (await page.request.post("/test/notify-reply", { data: { answer: ANSWER, ...data } })).json()) as { replyMessageId: string }).replyMessageId;
const axe = (page: Page, include?: string) => {
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  return (include ? builder.include(include) : builder).analyze();
};
const coarse = (page: Page) => page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);

test("a reply while away: the bell names its lesson and question, and Open shows the part and the reply", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { enrollmentId, questionId } = await session(page);
  await openCourse(page, enrollmentId);
  const replyId = await reply(page, { questionId, away: true });
  await page.reload();

  const bell = page.getByRole("button", { name: "Notifications, 1 new" });
  // Something new: the bell carries the `--accent` dot, and its name says how many.
  await expect(bell.locator(".connected-bell-dot")).toBeVisible();
  await bell.click();
  const panel = page.locator(".connected-notifications-panel");
  await expect(panel).toBeVisible();
  const row = panel.getByRole("button", { name: "Open reply", exact: true });
  await expect(row).toContainText("Your companion replied about “Minimum”.");
  await expect(row).toContainText(`${QUESTION} · `);
  await expect(row).toHaveAccessibleDescription(/^New\. Your companion replied about “Minimum”\. Why is the smallest value .+ · \d/);
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  // The list stays inside the screen at every size, and the open panel passes axe.
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await settled(panel);
  expect((await axe(page, ".connected-header")).violations).toEqual([]);

  await row.click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  // The part the question was about is shown and marked (M14; held 2 s with reduced motion).
  await expect(page.locator(".connected-lesson-keeper:not([hidden]) .connected-reading-card[data-cc-highlight]")).toHaveCount(1);
  // The companion is open at the reply.
  const companion = companionPanel(page);
  await expect(companion).toBeVisible();
  const answer = companion.locator(`[data-message-id="${replyId}"]`);
  await expect(answer).toContainText(ANSWER);
  await expect(answer).toBeInViewport();
  if (await coarse(page)) await expect(composerBox(page)).not.toBeFocused();
  else await expect(composerBox(page)).toBeFocused();
  // Read on the server (the bell's dot is gone) and seen on this device.
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.locator(".connected-bell-dot")).toHaveCount(0);
  await expect.poll(() => seen(page, enrollmentId)).not.toBe("");
  // The sheet's opening (M12; a fade with reduced motion) has ended, so axe reads settled colours.
  await settled(companion);
  expect((await axe(page)).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test("a reply about a lesson that left the course says so and opens the course page with the companion", async ({ page }) => {
  const { enrollmentId, questionId } = await session(page);
  await openCourse(page, enrollmentId);
  const replyId = await reply(page, { questionId, away: true, lessonGone: true });
  await page.reload();
  await page.getByRole("button", { name: "Notifications, 1 new" }).click();
  const row = page.locator(".connected-notifications-panel").getByRole("button", { name: "Open reply", exact: true });
  await expect(row).toContainText("Your companion answered your question.");
  await expect(row).toContainText("The lesson this was about is no longer in the course.");
  await expect(row).toHaveAccessibleDescription(/The lesson this was about is no longer in the course\.$/);
  await row.click();
  await expect(page.getByRole("heading", { name: "Your learning path" })).toBeVisible();
  const companion = companionPanel(page);
  await expect(companion).toBeVisible();
  await expect(companion.locator(`[data-message-id="${replyId}"]`)).toContainText(ANSWER);
});

test("a reply while the learner is here and the companion is closed goes to no bell and stays unread until the companion shows it", async ({ page }) => {
  const { enrollmentId, questionId } = await session(page);
  await openCourse(page, enrollmentId);
  await reply(page, { questionId, away: false });
  await page.reload();
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.locator(".connected-notifications-panel")).toContainText("No notifications.");
  await page.keyboard.press("Escape");
  // Back in the course, the reply is unread on this device while the companion is closed, and
  // seen once it opens.
  await openCourse(page, enrollmentId);
  await expect(page.locator(".connected-companion-trigger:visible")).toBeVisible();
  await expect(companionPanel(page)).toBeHidden();
  expect(await seen(page, enrollmentId)).toBe("");
  await page.locator(".connected-companion-trigger:visible").click();
  await expect(companionPanel(page).getByText(ANSWER)).toBeVisible();
  await expect.poll(() => seen(page, enrollmentId)).not.toBe("");
});
