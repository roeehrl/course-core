import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./health";
import { announcer, ask, box, roundButton, startLesson, thread, resumeLesson, settled } from "./conversation-helpers";
import { closeCompanion, companionPanel, openCompanion } from "./companion-helpers";

/*
 * The companion's limitations (final design §3.13): one banner at a time above the composer, with
 * at most one action; nothing while it is ready. The offline flow end to end; a companion not set
 * up; each paused variant; a lesson not taking questions; outside a lesson with a draft and "Go to
 * {lesson}"; browser storage off; a message recovered after a lost confirmation. axe in English
 * and Hebrew, light and dark. States are set by the test host; no model is involved.
 */
const notice = (page: Page) => companionPanel(page).locator(".cc-chat-notice");
const axe = async (page: Page) => {
  await settled(page);
  expect((await new AxeBuilder({ page }).include("#connected-companion").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
};

test("offline: the banner, Send with its clock, the question waiting with Cancel, and sent once back online", async ({ page, context, request }, info) => {
  await startLesson(page, request);
  await expect(notice(page)).toHaveCount(0);
  await context.setOffline(true);
  await expect(notice(page)).toHaveText("You're offline. Your message sends when you reconnect.");
  await box(page).fill("Held while offline");
  await expect(roundButton(page)).toHaveAttribute("title", "Sends when you're back online");
  await roundButton(page).click();
  const held = thread(page).locator(".cc-chat-turn.is-learner").filter({ hasText: "Held while offline" });
  await expect(held.getByText("Waiting to send", { exact: true })).toBeVisible();
  await expect(box(page)).toHaveValue("");
  await axe(page);
  await page.screenshot({ path: info.outputPath("offline.png") });
  // Cancel puts the text back in the box.
  await held.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(box(page)).toHaveValue("Held while offline");
  await expect(held).toHaveCount(0);
  await roundButton(page).click();
  const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  await context.setOffline(false);
  expect((await sent).status()).toBe(200);
  await expect(announcer(page)).toHaveText("Back online. Sending your question.");
  await expect(thread(page).getByText("Waiting to send", { exact: true })).toHaveCount(0);
  await expect(thread(page).getByText("Held while offline", { exact: true })).toBeVisible();
});

test("not set up: the companion says it is not on yet, and a question asked waits to send", async ({ page, request }) => {
  await startLesson(page, request, { session: "/test/companion-off-session" });
  await expect(notice(page)).toHaveText("Your companion isn't on for this course yet. You can still ask; questions are saved and answered once it's on.");
  await expect(box(page)).toBeVisible();
  // A question asked now is held like a paused one (§3.5): "Waiting to send" with Cancel under it,
  // never "Preparing a reply…", and the round button stays Send.
  const question = `Not set up ${Date.now()}`;
  await ask(page, question);
  const turn = thread(page).locator(".cc-chat-turn.is-learner").filter({ hasText: question });
  await expect(turn.getByText("Waiting to send", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(turn.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(thread(page).locator('[data-reply-state="preparing"]')).toHaveCount(0);
  await expect(thread(page).getByText("Preparing a reply…")).toHaveCount(0);
  await expect(roundButton(page)).toHaveAccessibleName("Send");
  await expect(announcer(page)).not.toContainText("Companion is replying");
  await axe(page);
});

for (const [ceiling, text, more] of [
  ["workspace", "Help is paused for now. Your question is saved, and course staff know.", "This course has a shared limit on help. Course staff can raise it."],
  ["enrollment", "Your help limit in this course is used up for now. Your question is saved, and course staff know.", undefined],
  ["daily", "Help is paused until tomorrow. Your question is saved.", "Today's questions for this course are used up."],
  ["artifact", "Help for this lesson is paused until tomorrow. Your question is saved.", undefined],
] as const)
  test(`paused (${ceiling}): one banner, the question waits to send with Cancel`, async ({ page, request }) => {
    await startLesson(page, request);
    const question = `Paused ${ceiling} ${Date.now()}`;
    await ask(page, question);
    expect((await (await request.post("/test/companion-job", { data: { question, state: "budget_wait", ceiling } })).json()).updated).toBe(true);
    await expect(notice(page)).toContainText(text, { timeout: 15_000 });
    const turn = thread(page).locator(".cc-chat-turn.is-learner").filter({ hasText: question });
    await expect(turn.getByText("Waiting to send", { exact: true })).toBeVisible();
    await expect(turn.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    if (more) {
      await notice(page).getByRole("button", { name: "More about this" }).click();
      await expect(notice(page)).toContainText(more);
    } else await expect(notice(page).getByRole("button", { name: "More about this" })).toHaveCount(0);
    await axe(page);
  });

test("a rate limit in front of the server (HTTP 429 with Retry-After) counts down under the question, and the text goes back to the box", async ({ page, request }) => {
  await startLesson(page, request);
  // A proxy's answer: no JSON body, only the header says when to ask again.
  await page.route(/\/companion$/, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 429, headers: { "Retry-After": "42", "Content-Type": "text/plain" }, body: "Too Many Requests" })
      : route.continue());
  const question = `Rate limited ${Date.now()}`;
  await box(page).fill(question);
  await roundButton(page).click();
  const row = thread(page).locator(".cc-chat-row").filter({ hasText: "Too many questions at once." });
  await expect(row).toContainText(/You can ask again in 0:4[0-2]\./);
  await expect(box(page)).toHaveValue(question);
  await expect(thread(page).getByText("Couldn't send. Your text is back in the box.")).toHaveCount(0);
});

test("a lesson not taking questions keeps the draft and cannot send", async ({ page, request }) => {
  // The server's answer for this lesson, as a policy that closes it reports it.
  await page.route(/\/api\/enrollments\/[0-9a-f-]{36}$/, async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const first = snapshot.course?.chapters?.[0]?.episodes?.[0]?.id;
    await route.fulfill({ response, json: first ? { ...snapshot, inaccessibleEpisodeIds: [first] } : snapshot });
  });
  await startLesson(page, request);
  await expect(notice(page)).toHaveText("This lesson isn't taking questions right now. Your draft is safe.");
  await box(page).fill("Kept for later");
  await expect(roundButton(page)).toHaveAttribute("aria-disabled", "true");
  await expect(roundButton(page)).toHaveAccessibleDescription("This lesson isn't taking questions right now. Your draft is safe.");
  await axe(page);
});

test("outside a lesson: where the conversation lives, no composer, and Go to {lesson} opens the lesson", async ({ page, request }) => {
  await startLesson(page, request);
  await closeCompanion(page);
  await page.getByRole("button", { name: "← Course roadmap" }).click();
  await expect(page.getByTestId("next-step")).toBeVisible();
  await openCompanion(page);
  await expect(notice(page)).toContainText("Open a lesson to ask about it. Your conversation stays here.");
  // A draft belongs to its lesson: none here, so no box (a draft kept outside a lesson is unit-tested).
  await expect(box(page)).toHaveCount(0);
  await axe(page);
  await notice(page).getByRole("button", { name: /^Go to / }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("next-step")).toHaveCount(0);
});

test("browser storage off: the draft is kept in this tab only, and the banner says so", async ({ page, request }) => {
  // Every write to browser storage is refused (a full or blocked store).
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("refused", "QuotaExceededError");
    };
  });
  await startLesson(page, request);
  await box(page).fill("In this tab");
  await expect(notice(page)).toHaveText("Your draft is kept in this tab only, because browser storage is off.");
  await expect(box(page)).toHaveValue("In this tab");
  await axe(page);
});

test("a message whose confirmation was lost shows once, as the conversation has it, and after a reload it is recovered with a banner", async ({ page, request }) => {
  await startLesson(page, request);
  // The server saves it; the answer never reaches the page.
  let lost!: () => void;
  const answerLost = new Promise<void>((resolve) => (lost = resolve));
  await page.route(/\/companion$/, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch();
    await route.abort("connectionreset");
    lost();
  });
  await box(page).fill("Was this saved?");
  await roundButton(page).click();
  await answerLost;
  // The answer to the send was lost, but the conversation read back has the question: it shows
  // once, as saved (without that read it would say the save was not confirmed; unit-tested).
  await expect(thread(page).locator("[data-message-id]").filter({ hasText: "Was this saved?" })).toHaveCount(1, { timeout: 15_000 });
  await expect(thread(page).getByText("Was this saved?", { exact: true })).toHaveCount(1);
  await page.unroute(/\/companion$/);
  await page.reload();
  await resumeLesson(page);
  await openCompanion(page);
  await expect(notice(page)).toContainText("Your last message was recovered. Check it in the conversation before sending another.");
  await expect(thread(page).locator("[data-message-id]").filter({ hasText: "Was this saved?" })).toHaveCount(1, { timeout: 15_000 });
  await expect(thread(page).getByText("Was this saved?", { exact: true })).toHaveCount(1);
  await notice(page).getByRole("button", { name: "Show it" }).click();
  await expect(notice(page)).toHaveCount(0);
});

for (const locale of ["en", "he"] as const)
  for (const scheme of ["light", "dark"] as const)
    test(`banners pass axe in ${locale}, ${scheme}`, async ({ page, request }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await startLesson(page, request, { locale, session: "/test/session" });
      const question = `${locale === "he" ? "מושהית" : "Paused"} ${scheme} ${Date.now()}`;
      await ask(page, question);
      expect((await (await request.post("/test/companion-job", { data: { question, state: "budget_wait", ceiling: "workspace" } })).json()).updated).toBe(true);
      await expect(notice(page)).toBeVisible({ timeout: 15_000 });
      await settled(page);
      // The message actions are the actions slot's, still drawn in the light palette until the
      // app-wide theme lands; the conversation's own surfaces are checked here.
      expect((await new AxeBuilder({ page }).include("#connected-companion").exclude(".cc-chat-bubble-actions").exclude(".cc-chat-reply-actions")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`banner-${locale}-${scheme}.png`) });
    });
