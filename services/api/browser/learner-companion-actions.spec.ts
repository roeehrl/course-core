import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

// Split from learner.spec.ts: actions on companion messages (what a reply was based on, deleting a question).

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];

test("what a reply was based on reads as plain words and leaves out a question the learner cancelled", async ({ page, request }) => {
  const session = await request.post("/test/companion-context-rich-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  const log = page.getByRole("log", { name: "Saved companion messages" });
  await expect(log.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toBeVisible();
  // The cancelled question stays in the conversation and can be asked again.
  await expect(log.getByText("Can you just tell me the answer to the check?", { exact: true })).toBeVisible();
  // A start-aligned chip, not a full-width "Show context used" button.
  await expect(page.getByRole("button", { name: "Show context used" })).toHaveCount(0);
  await log.getByRole("button", { name: /^Based on/ }).click();
  const block = page.getByRole("region", { name: "What this reply was based on" });
  // Two earlier messages (the first question and its answer); not the cancelled question.
  await expect(block.getByText("Earlier messages used", { exact: true })).toBeVisible();
  await expect(block.locator(".cc-act-based-item")).toHaveCount(2);
  await expect(block.getByText("You: “What does minimum mean here?”", { exact: true })).toBeVisible();
  await expect(block.getByText("Companion: “Minimum means no greater than any other member: m ≤ x for every x.”", { exact: true })).toBeVisible();
  await expect(block.getByText(/Can you just tell me the answer to the check\?”/)).toHaveCount(0);
  await expect(page.getByText(/\*\*|\$m|\\le/)).toHaveCount(0);
  await expect(block.getByText(/Context version|Evidence it could see|named briefly/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("a learner deletes one question with its answer, then erases their whole account", async ({ page, request }, info) => {
  const session = await request.post("/test/companion-context-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  // Delete the question that was answered: both go, after a confirmation.
  await expect(page.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toBeVisible();
  // Through the question's own menu and a confirm that starts on Cancel.
  const question = page.locator("[data-message-id]").filter({ hasText: "Why does it say no greater than?" });
  await question.hover();
  await question.getByRole("button", { name: "Message options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete question", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: /^Delete this question and its answer\? Suggestions based on it are removed too\./ });
  await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  // The question and its reply become one line (conversation §3.4).
  await expect(page.getByText("You deleted a question.", { exact: true })).toBeVisible();
  await expect(page.getByText("Why does it say no greater than?", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toHaveCount(0);
  if (!info.project.name.endsWith("desktop")) await page.getByRole("button", { name: "Close companion", exact: true }).click();
  // Erase the whole account from Your data.
  await openProfile(page);
  const panel = page.getByRole("region", { name: "Your data" });
  await panel.getByText("Erase my whole account", { exact: true }).click();
  const erase = panel.getByRole("button", { name: "Erase my account permanently", exact: true });
  await expect(erase).toBeDisabled();
  await panel.getByLabel(/Why are you erasing your account/).fill("I am leaving every course on this service.");
  await panel.getByLabel(/ERASE MY ACCOUNT/).fill("ERASE MY ACCOUNT");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await panel.getByText("Erase my whole account", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("erase-account.png") });
  await erase.click();
  await expect(page.getByRole("heading", { name: "Pick up where you left off.", exact: true })).toBeVisible();
  expect((await page.request.get("/api/enrollments")).status()).toBe(401);
});

// Split from "the companion shows the context an answer used, takes a lesson selection, and lets
// the learner correct its context": what an answer was based on, and the learner's correction.
test("the companion shows the context an answer used and lets the learner correct its context", async ({ page, request }, info) => {
  const session = await request.post("/test/companion-context-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  await expect(page.getByRole("heading", { name: "Minimum", exact: true })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Companion", exact: true });
  if (await trigger.isVisible()) await trigger.click();
  await expect(page.getByText("Because the minimum may be equal to another member, not only smaller.", { exact: true })).toBeVisible();
  // The earlier answer names what it was based on, in sections.
  const reply = page.locator("[data-message-id]").filter({ hasText: "Because the minimum may be equal to another member, not only smaller." });
  await reply.getByRole("button", { name: /^Based on/ }).click();
  const block = page.getByRole("region", { name: "What this reply was based on" });
  await expect(block.getByText("“Why does it say no greater than?”", { exact: true })).toBeVisible();
  await expect(block.getByText("Lesson text: “no greater than”", { exact: true })).toBeVisible();
  await expect(block.getByText("You: “What does minimum mean here?”", { exact: true })).toBeVisible();
  await expect(block.getByText("Rules for this reply", { exact: true })).toBeVisible();
  await expect(block.getByText(/^Deadline: .+\.$/)).toBeVisible();
  await expect(block.getByText(/counted check was open/)).toHaveCount(0);
  await block.getByRole("button", { name: "Don't use “What does minimum mean here?” again", exact: true }).click();
  await expect(block.getByRole("button", { name: "Use “What does minimum mean here?” again", exact: true })).toBeVisible();
  // The learner's own message says later answers leave it out.
  const asked = page.locator("[data-message-id]").filter({ hasText: "What does minimum mean here?" }).first();
  await expect(asked.getByText("Not used in later answers", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("companion-context-used.png") });
});
