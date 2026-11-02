import { test, expect, type Page } from "./health";
import AxeBuilder from "@axe-core/playwright";
import { closeCompanion, companionPanel, composerBox, openCompanion } from "./companion-helpers";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enRoadmap from "../../src/i18n/messages/en/courseRoadmap.json";
import heRoadmap from "../../src/i18n/messages/he/courseRoadmap.json";
import enLesson from "../../src/i18n/messages/en/connectedLesson.json";
import heLesson from "../../src/i18n/messages/he/connectedLesson.json";
import enCheck from "../../src/i18n/messages/en/checkCard.json";
import heCheck from "../../src/i18n/messages/he/checkCard.json";
import enCompanion from "../../src/i18n/messages/en/connectedCompanion.json";
import heCompanion from "../../src/i18n/messages/he/connectedCompanion.json";

/*
 * Credit honesty on the real connected host (final design §3.11): before sending, the credit line
 * (only while a counted question of this lesson is open, tied to the message box, its ⓘ by
 * keyboard, moved under the composer while a limitation takes the slot above); at the moment, the
 * inline choice and "Save for after the question" with "Send it now" once the check is answered;
 * after, the thread line, the check's reason line and the path back to a fresh check. English and
 * the Hebrew impersonal forms; axe on each state.
 */
const text = {
  en: { host: enHost, preview: enPreview, roadmap: enRoadmap, lesson: enLesson, check: enCheck, companion: enCompanion },
  he: { host: heHost, preview: hePreview, roadmap: heRoadmap, lesson: heLesson, check: heCheck, companion: heCompanion },
} as const;
type Locale = keyof typeof text;

async function axe(page: Page) {
  // Read once the reveals (M16, M17) have finished: mid-fade colours are not the real ones.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(result.violations).toEqual([]);
}
/** Signs a new learner in, starts the ordering course and reads its first lesson's part. */
async function readFirstLesson(page: Page, locale: Locale = "en") {
  const t = text[locale];
  const token = (await (await page.request.post("/test/session")).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: t.host["library.open"], exact: true })
    .click();
  await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  const resume = page.getByRole("button", { name: t.host["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
  const roadmap = page.getByRole("heading", { name: t.roadmap.path, exact: true });
  await expect(roadmap).toBeVisible();
  await expect(async () => {
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(roadmap).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: t.lesson.markRead, exact: true }).click();
}
async function startCheck(page: Page, locale: Locale = "en") {
  await page.getByRole("button", { name: text[locale].check["check.start"], exact: true }).click();
  await expect(page.getByTestId("question-kind")).toBeVisible();
}
const creditLine = (page: Page) => companionPanel(page).getByTestId("credit-line");
const companionPosts = (page: Page) => {
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/companion")) bodies.push(JSON.parse(r.postData()!));
  });
  return bodies;
};

test("the credit line shows only while this lesson's counted question is open, is read with the message box, and moves under it while offline", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await readFirstLesson(page);
  await openCompanion(page);
  // No counted question open yet: no line.
  await expect(composerBox(page)).toBeVisible();
  await expect(creditLine(page)).toHaveCount(0);
  await closeCompanion(page);
  await startCheck(page);
  await openCompanion(page);
  await expect(creditLine(page)).toHaveText("Question 1 counts. Asking now makes it practice.");
  await expect(creditLine(page)).toHaveClass(/is-notice/);
  const described = (await composerBox(page).getAttribute("aria-describedby")) ?? "";
  expect(described.split(" ")).toContain("cc-credit-line");
  await expect(page.locator("#cc-credit-line")).toHaveText("Question 1 counts. Asking now makes it practice.");
  // The ⓘ by keyboard: Enter opens one paragraph, Esc closes it and returns focus.
  const info = creditLine(page).getByRole("button", { name: "How questions count" });
  await info.focus();
  await page.keyboard.press("Enter");
  const popover = page.getByRole("dialog", { name: "How questions count" });
  await expect(popover).toContainText("Questions you answer on your own count toward finishing.");
  await expect(info).toHaveAttribute("aria-expanded", "true");
  // It lines up under the credit line, inside the companion, on every layout.
  const panelBox = (await companionPanel(page).boundingBox())!, popoverBox = (await popover.boundingBox())!;
  expect(popoverBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  // Esc closes only the popover (never the companion around it) and focus returns to the ⓘ.
  await expect(companionPanel(page)).toBeVisible();
  await expect(info).toBeFocused();
  // A limitation takes the slot above the message box: the line moves under it, never dropped.
  await context.setOffline(true);
  await expect(creditLine(page)).toHaveCount(1);
  await expect(creditLine(page)).toHaveClass(/is-meta/);
  await expect(creditLine(page)).toHaveText("Question 1 counts. Asking now makes it practice.");
  const box = await composerBox(page).boundingBox(), line = await creditLine(page).boundingBox();
  expect(line!.y).toBeGreaterThan(box!.y + box!.height);
  await context.setOffline(false);
  await expect(creditLine(page)).toHaveClass(/is-notice/);
  expect(errors).toEqual([]);
});

test("a question saved for after the check waits in the thread and is sent once the check is answered", async ({ page }) => {
  await readFirstLesson(page);
  await startCheck(page);
  await openCompanion(page);
  const posts = companionPosts(page);
  await composerBox(page).fill("How do I compare two values?");
  await companionPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await companionPanel(page).getByRole("button", { name: "Save for after the question" }).click();
  await expect(composerBox(page)).toHaveValue("");
  await expect(composerBox(page)).toBeFocused();
  const saved = companionPanel(page).getByRole("note").filter({ hasText: "A question is saved for after the check." });
  await expect(saved).toBeVisible();
  const sendNow = saved.getByRole("button", { name: "Send it now" });
  await expect(sendNow).toBeDisabled();
  expect(posts).toHaveLength(0);
  await axe(page);
  // Kept on this device: still there after a reload.
  await page.reload();
  const resume = page.getByRole("button", { name: "Continue learning →", exact: true }).or(page.getByTestId("next-step").getByRole("button"));
  await expect(async () => {
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(page.getByTestId("question-kind")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await openCompanion(page);
  await expect(saved).toBeVisible();
  await closeCompanion(page);
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start the next check →", exact: true })).toBeVisible();
  await openCompanion(page);
  await expect(sendNow).toBeEnabled();
  const sent = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/companion"));
  await sendNow.click();
  expect((await sent).status()).toBe(200);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ content: "How do I compare two values?" });
  expect(posts[0]!.allowAssessmentAssistance).toBeUndefined();
  await expect(companionPanel(page).getByText("How do I compare two values?", { exact: true })).toBeVisible();
  await expect(saved).toHaveCount(0);
});

test("after sending as practice the thread says so, and the check says why with a way back to a check that counts", async ({ page }) => {
  await readFirstLesson(page);
  await startCheck(page);
  await openCompanion(page);
  await composerBox(page).fill("Explain how to compare these values.");
  await companionPanel(page).getByRole("button", { name: "Send", exact: true }).click();
  await companionPanel(page).getByRole("button", { name: "Send as practice" }).click();
  await expect(composerBox(page)).toHaveValue("");
  // The confirm row went: the focus stays in the message box, as after any send (§6).
  await expect(composerBox(page)).toBeFocused();
  const line = companionPanel(page).getByRole("note").filter({ hasText: "Question 1 is now practice." });
  await expect(line).toBeVisible();
  // The line follows the learner's message that made the question practice, and comes before its
  // reply row from the first frame, so it never moves when the reply arrives.
  const question = companionPanel(page).getByText("Explain how to compare these values.", { exact: true });
  expect((await line.boundingBox())!.y).toBeGreaterThan((await question.boundingBox())!.y);
  const preparing = companionPanel(page).locator('[data-reply-state="preparing"]');
  await expect(preparing).toBeVisible();
  expect((await preparing.boundingBox())!.y).toBeGreaterThan((await line.boundingBox())!.y);
  // Nothing in scope counts any more: no credit line.
  await expect(creditLine(page)).toHaveCount(0);
  await closeCompanion(page);
  const check = page.locator(".connected-check");
  await expect(page.getByTestId("question-kind")).toHaveText("Practice. This question does not count toward finishing the lesson.");
  await expect(check.getByText("You asked your companion for help.", { exact: true })).toBeVisible();
  // Meta type (13/20) in ink, the reason muted: the check card's own paragraph style does not apply.
  await expect(page.getByTestId("question-kind")).toHaveCSS("font-size", "13px");
  const color = (selector: string) => page.locator(selector).first().evaluate((node) => getComputedStyle(node).color);
  expect(await color("[data-testid=question-kind]")).not.toBe(await color(".cc-credit-kind-reason"));
  await expect(check.getByText("You asked your companion for help.", { exact: true })).toHaveCSS("font-size", "13px");
  await expect(check.getByText("Want this to count? A fresh check is ready when you are.", { exact: true })).toBeVisible();
  const fresh = check.getByRole("button", { name: /^Get a fresh check/ });
  await expect(fresh).toBeVisible();
  await axe(page);
  await fresh.click();
  await expect(page.getByTestId("question-kind")).toHaveText("Counts toward this lesson. Answer on your own.");
  await expect(check.getByText("You asked your companion for help.", { exact: true })).toHaveCount(0);
});

test("Hebrew: the credit line, the choice, the thread line and the reason use impersonal forms", async ({ page }) => {
  await readFirstLesson(page, "he");
  await startCheck(page, "he");
  await openCompanion(page);
  await expect(creditLine(page)).toHaveText("שאלה 1 נספרת. פנייה למנחה עכשיו תהפוך אותה לתרגול.");
  await expect(creditLine(page).getByRole("button", { name: "איך שאלות נספרות" })).toBeVisible();
  // The line starts at the right, as the interface does.
  const panelBox = (await companionPanel(page).boundingBox())!, icon = (await creditLine(page).locator("svg").first().boundingBox())!;
  expect(icon.x).toBeGreaterThan(panelBox.x + panelBox.width / 2);
  await composerBox(page, "he").fill("איך משווים בין שני ערכים?");
  await companionPanel(page).getByRole("button", { name: text.he.companion["send.send"], exact: true }).click();
  const row = companionPanel(page).getByRole("group", { name: "פנייה למנחה עכשיו תהפוך את שאלה 1 לתרגול, והיא לא תיספר לסיום השיעור." });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "להשאיר נספרת" })).toBeFocused();
  await expect(row.getByRole("button", { name: "שמירה לאחרי השאלה" })).toBeVisible();
  await axe(page);
  await row.getByRole("button", { name: "שליחה כתרגול" }).click();
  await expect(companionPanel(page).getByRole("note").filter({ hasText: "שאלה 1 היא עכשיו תרגול." })).toBeVisible();
  await closeCompanion(page, "he");
  await expect(page.getByTestId("question-kind")).toHaveText("תרגול. השאלה הזו לא נספרת לסיום השיעור.");
  const check = page.locator(".connected-check");
  await expect(check.getByText("הייתה פנייה למנחה.", { exact: true })).toBeVisible();
  await expect(check.getByText("כדי שזה ייספר, אפשר לעשות בדיקה חדשה.", { exact: true })).toBeVisible();
  await axe(page);
});
