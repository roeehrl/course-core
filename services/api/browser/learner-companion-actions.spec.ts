import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

// Split from learner.spec.ts: actions on companion messages (context used, deleting a question).

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];

test("context used reads as plain words and leaves out a question the learner cancelled", async ({ page, request }) => {
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
  await page.getByRole("button", { name: "Show context used", exact: true }).click();
  // Two earlier messages (the first question and its answer); not the cancelled question.
  await expect(page.getByText("2 earlier messages from this lesson:", { exact: true })).toBeVisible();
  await expect(page.getByText("You: “What does minimum mean here?”", { exact: true })).toBeVisible();
  await expect(page.getByText("Companion: “Minimum means no greater than any other member: m ≤ x for every x.”", { exact: true })).toBeVisible();
  await expect(page.getByText(/Can you just tell me the answer to the check\?”/)).toHaveCount(0);
  await expect(page.getByText(/\*\*|\$m|\\le/)).toHaveCount(0);
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
  await page.getByRole("button", { name: "Delete this question", exact: true }).nth(1).click();
  await expect(page.getByText(/Suggestions based on it are revoked/)).toBeVisible();
  await page.getByRole("button", { name: "Delete question", exact: true }).click();
  await expect(page.getByText("You deleted this question.", { exact: true })).toBeVisible();
  await expect(page.getByText("Removed with the question you deleted.", { exact: true })).toBeVisible();
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
// the learner correct its context": the context an answer used, and the learner's correction.
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
  // The earlier answer names what it used.
  await page.getByRole("button", { name: "Show context used", exact: true }).click();
  await expect(page.getByText("Answering: “Why does it say no greater than?”", { exact: true })).toBeVisible();
  await expect(page.getByText("You pointed at (Lesson text): “no greater than”", { exact: true })).toBeVisible();
  await expect(page.getByText("1 earlier message from this lesson:", { exact: true })).toBeVisible();
  await expect(page.getByText(/Rules it followed: deadline .* · no independent check open/)).toBeVisible();
  await page.getByRole("button", { name: "Don’t use this message again", exact: true }).click();
  await expect(page.getByText("You: “What does minimum mean here?” · not used again", { exact: true })).toBeVisible();
  await expect(page.getByText("Not used as context for later answers.", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("companion-context-used.png") });
});
