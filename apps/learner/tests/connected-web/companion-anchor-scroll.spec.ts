import { test, expect, type Page } from "./health";
import { ask, roundButton, startLesson, thread } from "./conversation-helpers";
import { companionPanel } from "./companion-helpers";

/*
 * Anchor on send (final design §3.8, G1; the owner's "very bad animation"): the new question moves
 * near the top of the thread (its top 16 px below the thread's) and the reply grows downward from
 * there; nothing scrolls while text streams; when it grows past the bottom, Jump to latest appears
 * with its dot and brings the end into view. Answering the companion's question anchors that
 * question instead, so question, answer and reply read together. Scripted by the test host.
 */
const top = (page: Page) => thread(page).evaluate((el) => el.getBoundingClientRect().top);
const scrollTop = (page: Page) => thread(page).evaluate((el) => Math.round(el.scrollTop));

test("the new question sits 16 px below the thread's top, the reply grows downward, nothing moves while it streams, and Jump to latest shows with a dot", async ({ page, request }, info) => {
  await startLesson(page, request);
  // Some earlier conversation, so the thread scrolls.
  for (let i = 1; i <= 3; i++) {
    const earlier = `Earlier question ${i} ${Date.now()}`;
    await ask(page, earlier);
    expect((await (await request.post("/test/companion-job", { data: { question: earlier, state: "applied", answer: `Earlier answer ${i}. `.repeat(12) } })).json()).updated).toBe(true);
    await expect(thread(page).getByText(`Earlier answer ${i}.`, { exact: false })).toBeVisible({ timeout: 15_000 });
  }
  const question = `Anchored question ${Date.now()}`;
  await ask(page, question);
  const bubble = thread(page).locator(".cc-chat-bubble").filter({ hasText: question });
  // M3 is 240 ms; then the bubble's top is 16 px below the thread's.
  await expect.poll(async () => Math.round((await bubble.boundingBox())!.y - (await top(page))), { timeout: 3_000 }).toBeGreaterThanOrEqual(14);
  await expect.poll(async () => Math.round((await bubble.boundingBox())!.y - (await top(page))), { timeout: 3_000 }).toBeLessThanOrEqual(18);
  // The anchor's smooth scroll has come to rest.
  await expect.poll(async () => {
    const first = await scrollTop(page);
    await page.waitForTimeout(200);
    return first === (await scrollTop(page));
  }).toBe(true);
  const anchored = await scrollTop(page);
  const pieces = Array.from({ length: 24 }, (_, i) => `Line ${i + 1}: compare the two values on the number line and keep the smaller one.\n\n`);
  await expect.poll(async () => (await (await request.post("/test/conversation-dispatch", { data: { question, pieces, gapMs: 150, end: "complete" } })).json()).opened).toBe(true);
  const reply = thread(page).locator('[data-reply-state="streaming"]');
  await expect(reply).toContainText("Line 1:", { timeout: 15_000 });
  const startY = (await reply.boundingBox())!.y;
  for (let sample = 0; sample < 14; sample++) {
    expect(await scrollTop(page), `scroll at sample ${sample}`).toBe(anchored);
    expect(Math.round((await reply.boundingBox())!.y), `reply start at sample ${sample}`).toBe(Math.round(startY));
    await page.waitForTimeout(150);
  }
  const jump = companionPanel(page).getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();
  await expect(jump.locator(".cc-chat-jump-dot")).toBeVisible();
  expect(await scrollTop(page)).toBe(anchored);
  await page.screenshot({ path: info.outputPath("anchored-streaming.png") });
  // Once the reply is written, Jump brings its end into view.
  await expect(reply).toContainText("Line 24:", { timeout: 15_000 });
  await jump.click();
  await expect(jump).toBeHidden();
  await expect.poll(() => thread(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(30);
  await expect(roundButton(page)).toBeVisible();
});

test("answering the companion's question anchors that question, with the answer and reply under it", async ({ page, request }) => {
  await startLesson(page, request);
  const question = `Ask me back ${Date.now()}`;
  await ask(page, question);
  const answer = `${"Some explanation first. ".repeat(10)}\n\nWhat happens to x before b is added?`;
  expect((await (await request.post("/test/companion-job", { data: { question, state: "applied", answer } })).json()).updated).toBe(true);
  const closing = thread(page).locator("[data-cc-question]");
  await expect(closing).toBeVisible({ timeout: 15_000 });
  await ask(page, "It gets multiplied by w");
  await expect.poll(async () => Math.round((await closing.boundingBox())!.y - (await top(page))), { timeout: 3_000 }).toBeLessThanOrEqual(18);
  const bubble = thread(page).locator(".cc-chat-bubble").filter({ hasText: "It gets multiplied by w" });
  const view = (await thread(page).boundingBox())!;
  expect((await bubble.boundingBox())!.y).toBeLessThan(view.y + view.height / 2);
});
