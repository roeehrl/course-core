import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

// Split from learner.spec.ts: the companion's conversation (lesson labels, a refused reply, offline).

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];

test("a question whose reply Core refused says it couldn't be answered and can be asked again", async ({ page, request }, info) => {
  const session = await request.post("/test/companion-refused-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  const log = page.getByRole("log", { name: "Saved companion messages" });
  await expect(log.getByText("Can you list every minimum rule at once?", { exact: true })).toBeVisible();
  await expect(log.getByText("Reply not shown · it did not pass the checks, so nothing of it was kept · you can ask your question again", { exact: true })).toBeVisible();
  // Not shown as still waiting.
  await expect(page.getByText(/Your question is queued|Building a reply|Checking the reply/)).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("companion-refused.png") });
  // Asking again puts the question back in the draft; sending it is a new question.
  await log.getByRole("button", { name: "Ask this question again", exact: true }).click();
  const box = page.getByRole("textbox", { name: "Message to your companion", exact: true });
  await expect(box).toHaveValue("Can you list every minimum rule at once?");
  const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  expect((await sent).status()).toBe(200);
  await expect(log.getByText("Can you list every minimum rule at once?", { exact: true })).toHaveCount(2);
});

test("the companion says when it is offline, holds the question, and sends it once the connection returns", async ({ page, request, context }, info) => {
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
  await expect(page.getByText("Companion: Available", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message to your companion", exact: true }).fill("Asked while the train is in a tunnel.");
  await context.setOffline(true);
  await expect(page.getByText(/^Companion: Offline/)).toBeVisible();
  let posted = 0;
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname.endsWith("/companion")) posted++; });
  await page.getByRole("button", { name: "Send when back online", exact: true }).click();
  await expect(page.getByText(/held on this device/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Waiting for connection…", exact: true })).toBeDisabled();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("companion-offline.png") });
  expect(posted).toBe(0);
  await context.setOffline(false);
  await expect(page.getByText("Asked while the train is in a tunnel.", { exact: true })).toBeVisible();
  await expect(page.getByText("Companion: Your question is queued", { exact: true })).toBeVisible();
  expect(posted).toBe(1);
  // A question still waiting can be cancelled and asked again; the conversation stays readable.
  const log = page.getByRole("log", { name: "Saved companion messages" });
  await expect(log.getByRole("button", { name: "Stop waiting for this answer", exact: true })).toBeVisible();
  await log.getByRole("button", { name: "Cancel and ask again", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message to your companion", exact: true })).toHaveValue("Asked while the train is in a tunnel.");
  await expect(log.getByText("Asked while the train is in a tunnel.", { exact: true })).toBeVisible();
  await expect(log.getByText("Cancelled before it was sent · nothing was used · your message is saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Companion: Available", { exact: true })).toBeVisible();
  await expect(log.getByRole("button", { name: "Stop waiting for this answer", exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

// Split from "the companion shows the context an answer used, takes a lesson selection, and lets
// the learner correct its context": the reply's lesson labels.
test("each companion reply names the lesson its question was asked in", async ({ page, request }) => {
  const session = await request.post("/test/companion-context-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  await expect(page.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toBeVisible();
  // Each reply names the lesson its question was asked in: this one, another named one, or none recorded.
  const log = page.getByRole("log", { name: "Saved companion messages" });
  await expect(log.getByText(/^About: Minimum \(this lesson\)/)).toBeVisible();
  await expect(log.getByText("From: Maximum", { exact: true })).toBeVisible();
  await expect(log.getByText("About: Maximum", { exact: true })).toBeVisible();
  await expect(log.getByText("About: Lesson not recorded", { exact: true })).toBeVisible();
  await expect(log.getByText(/Earlier lesson/)).toHaveCount(0);
});
