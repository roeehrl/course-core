import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { companionPanel, openCompanion } from "./companion-helpers";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";

/*
 * Setup shared by the conversation's own specs: a learner in the first lesson of "Ordering values"
 * (a synthetic course) with the companion open, and short ways to reach the thread, the message
 * box and the round button. Questions are scripted by the test host (/test/companion-draft,
 * /test/companion-job, /test/conversation-reply); no provider is called.
 */
export type Locale = "en" | "he";
const text = { en: { host: enHost, preview: enPreview }, he: { host: heHost, preview: hePreview } } as const;

/** Signs in a new learner of the given session (a learner of "Ordering values" by default), opens
 * the course's next lesson and the companion. */
export async function startLesson(page: Page, request: APIRequestContext, { locale = "en", session = "/test/session" }: { locale?: Locale; session?: string } = {}) {
  const t = text[locale];
  const token = (await (await request.post(session)).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
  if (session === "/test/session") {
    const library = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) });
    await library.getByRole("button", { name: t.host["library.open"], exact: true }).click();
    await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  } else await page.getByRole("button", { name: /^(Continue learning|Start the course|Continue lesson \d+|Start lesson \d+) →$/ }).first().click();
  await page.getByTestId("next-step").getByRole("button").first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  return openCompanion(page);
}

export const thread = (page: Page): Locator => companionPanel(page).getByRole("log");
export const box = (page: Page): Locator => companionPanel(page).getByRole("textbox");
/** The round Send/Stop button (one element in every state). */
export const roundButton = (page: Page): Locator => companionPanel(page).locator(".cc-chat-send");
/** The status region the conversation announces through. */
export const announcer = (page: Page): Locator => companionPanel(page).locator("[data-cc-announcer]");

/** Types and sends a question with the round button (Enter makes a line on touch screens). */
export async function ask(page: Page, text: string) {
  await box(page).fill(text);
  // Saved by the server (the bubble shows at once, before the save is confirmed).
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
  await roundButton(page).click();
  expect((await saved).status()).toBe(200);
  await expect(thread(page).getByText(text, { exact: true })).toBeVisible();
}

/** The scripted model streams pieces into the saved question's draft (retried until it is saved). */
export async function stream(request: APIRequestContext, question: string, pieces: string[], { end, gapMs = 150, reason }: { end?: "complete" | "withdrawn"; gapMs?: number; reason?: string } = {}) {
  await expect.poll(async () => (await (await request.post("/test/companion-draft", { data: { question, pieces, gapMs, ...(end ? { end } : {}), ...(reason ? { reason } : {}) } })).json()).reason ?? "opened").toBe("opened");
}

/** Stores a reply to the saved question, with the context flags as given (none derived). */
export async function storeReply(request: APIRequestContext, question: string, content: string, flags: { asksLearner?: boolean; cutShort?: boolean; checkAnswerWithheld?: string } = {}) {
  await expect.poll(async () => (await (await request.post("/test/conversation-reply", { data: { question, content, ...flags } })).json()).answered).toBe(true);
}

/** After a reload: back into the lesson the learner was in. */
export async function resumeLesson(page: Page) {
  await expect(async () => {
    const resume = page.getByTestId("next-step").getByRole("button").or(page.getByRole("button", { name: /^Continue learning →$/ }));
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(page.getByRole("heading", { name: "Minimum", exact: true, level: 1 })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** Waits until no finite animation runs (a fade-in measured halfway reads as low contrast). */
export async function settled(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity));
}

/** Nothing on the page scrolls sideways. */
export async function noSidewaysScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}
