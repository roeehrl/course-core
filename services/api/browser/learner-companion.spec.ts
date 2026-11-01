import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

// Split from learner.spec.ts: the companion's conversation (lesson dividers, a refused reply, offline).

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];

test("a question whose reply Core refused says it was removed and can be asked again", async ({ page, request }, info) => {
  const session = await request.post("/test/companion-refused-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  const log = page.getByRole("log", { name: "Saved companion messages" });
  await expect(log.getByText("Can you list every minimum rule at once?", { exact: true })).toBeVisible();
  await expect(log.getByText("This reply was removed because it didn't pass the course's checks.", { exact: true })).toBeVisible();
  // Not shown as still waiting.
  await expect(page.getByText(/Preparing a reply|Checking the reply/)).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("companion-refused.png") });
  // Asking again puts the question back in the box; sending it is a new question.
  await log.getByRole("button", { name: "Ask again", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Message to your companion", exact: true });
  await expect(box).toHaveValue("Can you list every minimum rule at once?");
  const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  await page.locator("#connected-companion .cc-chat-send").click();
  expect((await sent).status()).toBe(200);
  await expect(log.getByText("Can you list every minimum rule at once?", { exact: true })).toHaveCount(2);
});

test("the companion says when it is offline, holds the question with Cancel, and sends it once the connection returns", async ({ page, request, context }, info) => {
  const session = await request.post("/test/hypothesis-session");
  expect(session.ok()).toBe(true);
  const stream = page.waitForRequest((r) => new URL(r.url()).pathname.endsWith("/events/stream"));
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  // The conversation follows the enrollment's resumable event stream.
  expect((await stream).headers()["accept"]).toContain("text/event-stream");
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  const notice = page.locator("#connected-companion .cc-chat-notice");
  // Ready: nothing is said.
  await expect(notice).toHaveCount(0);
  await expect(page.getByText(/^Companion: /)).toHaveCount(0);
  const box = page.getByRole("textbox", { name: "Message to your companion", exact: true });
  const send = page.locator("#connected-companion .cc-chat-send");
  await box.fill("Asked while the train is in a tunnel.");
  await context.setOffline(true);
  await expect(notice).toHaveText("You're offline. Your message sends when you reconnect.");
  let posted = 0;
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/companion")) posted++; });
  await expect(send).toHaveAttribute("title", "Sends when you're back online");
  await send.click();
  const log = page.getByRole("log", { name: "Saved companion messages" });
  const held = log.locator(".cc-chat-turn.is-learner").filter({ hasText: "Asked while the train is in a tunnel." });
  await expect(held.getByText("Waiting to send", { exact: true })).toBeVisible();
  await expect(held.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("companion-offline.png") });
  expect(posted).toBe(0);
  await context.setOffline(false);
  await expect(held.getByText("Waiting to send", { exact: true })).toHaveCount(0);
  await expect(log.getByText("Asked while the train is in a tunnel.", { exact: true })).toBeVisible();
  await expect.poll(() => posted).toBe(1);
  // A question not yet under way is stopped before it is asked: its text goes back to the box and
  // it leaves the conversation; the conversation stays readable.
  await expect(send).toHaveAccessibleName("Stop reply");
  await send.click();
  await expect(box).toHaveValue("Asked while the train is in a tunnel.");
  await expect(log.getByText("Asked while the train is in a tunnel.", { exact: true })).toHaveCount(0, { timeout: 15_000 });
  await expect(send).toHaveAccessibleName("Send");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

// Split from "the companion shows the context an answer used, takes a lesson selection, and lets
// the learner correct its context": the lessons of the conversation.
test("the conversation names each lesson once, in a divider where its questions start", async ({ page, request }) => {
  const session = await request.post("/test/companion-context-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  await expect(page.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toBeVisible();
  // One divider per lesson where its questions start: this one, another named one, or none recorded.
  const dividers = page.locator("#connected-companion [role=log] .cc-chat-divider");
  await expect(dividers.filter({ hasText: /^Minimum$/ })).toHaveCount(1);
  await expect(dividers.filter({ hasText: /^Maximum$/ })).toHaveCount(1);
  await expect(dividers.filter({ hasText: /^Lesson not recorded$/ })).toHaveCount(1);
  // No label on each message any more.
  await expect(page.getByText(/^(About|From): /)).toHaveCount(0);
  await expect(page.getByText(/this lesson\)|Earlier lesson/)).toHaveCount(0);
});
