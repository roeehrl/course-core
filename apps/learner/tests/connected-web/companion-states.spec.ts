import { test, expect, type Page } from "./health";
import enCompanion from "../../src/i18n/messages/en/connectedCompanion.json";
import heCompanion from "../../src/i18n/messages/he/connectedCompanion.json";
import enJob from "../../src/i18n/messages/en/companionClient.json";
import heJob from "../../src/i18n/messages/he/companionClient.json";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";
import enPreview from "../../src/i18n/messages/en/enrollmentPreview.json";
import hePreview from "../../src/i18n/messages/he/enrollmentPreview.json";
import enDock from "../../src/i18n/messages/en/companionDock.json";
import heDock from "../../src/i18n/messages/he/companionDock.json";

// The companion's question states in the real app, over the real event stream, in English and
// Hebrew: a queued question offers "Stop waiting"; the moment its reply's call is sent (the draft
// opens) it offers Stop instead, within a second of the first draft text at the latest; a question
// held by a spending limit says that help is paused, why, and that staff were told. The model is
// scripted by the test host; no provider is called.
const text = {
  en: { companion: enCompanion, job: enJob, host: enHost, preview: enPreview, dock: enDock },
  he: { companion: heCompanion, job: heJob, host: heHost, preview: hePreview, dock: heDock },
} as const;
type Locale = keyof typeof text;

async function openCompanion(page: Page, locale: Locale, token: string, phone: boolean) {
  const t = text[locale];
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: t.host["library.open"], exact: true }).click();
  await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  await page.getByRole("button", { name: t.host["library.continue"], exact: true }).click();
  if (phone) await page.getByRole("button", { name: t.dock.open, exact: true }).click();
}
async function ask(page: Page, locale: Locale, question: string) {
  const t = text[locale].companion;
  await page.getByRole("textbox", { name: t["draft.label"], exact: true }).fill(question);
  await page.getByRole("button", { name: t["send.send"], exact: true }).click();
  // Read from the saved conversation: while it sends, the (read-only) box still holds the same text.
  await expect(page.getByRole("log", { name: t.log }).getByText(question, { exact: true })).toBeVisible();
}
/** The card of one saved question in the conversation log. */
const card = (page: Page, locale: Locale, question: string) =>
  page.getByRole("log", { name: text[locale].companion.log }).locator("div").filter({ hasText: question })
    .filter({ has: page.getByRole("button") }).last();

for (const locale of ["en", "he"] as const) {
  test(`the reply's Stop replaces the queued controls within a second of the first draft, and a held question says help is paused (${locale})`, async ({ page, request }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const t = text[locale];
    const token = (await (await request.post("/test/session")).json()).token;
    await openCompanion(page, locale, token, !info.project.name.endsWith("desktop"));

    // Queued: nothing is sent yet, so the learner may stop waiting (it costs nothing).
    const question = `State question ${locale} ${Date.now()}`;
    await ask(page, locale, question);
    const questionCard = card(page, locale, question);
    await expect(questionCard.getByText(t.job["job.queued"], { exact: true })).toBeVisible();
    await expect(questionCard.getByRole("button", { name: t.companion.cancel, exact: true })).toBeVisible();
    await expect(questionCard.getByRole("button", { name: t.companion["stop.start"], exact: true })).toHaveCount(0);

    // Time the first draft text and the Stop button in the page itself, as the learner sees them.
    await page.evaluate(({ stop, region }) => {
      const marks: { draft?: number; stop?: number; stopWaitingWithDraft?: boolean } = {};
      (window as unknown as { __marks: typeof marks }).__marks = marks;
      const check = () => {
        const now = performance.now();
        const buttons = [...document.querySelectorAll<HTMLElement>("button,[role=button]")].map((b) => b.textContent?.trim());
        if (marks.stop === undefined && buttons.includes(stop.start)) marks.stop = now;
        const draft = [...document.querySelectorAll<HTMLElement>("[aria-label]")].find((e) => e.getAttribute("aria-label") === region);
        if (marks.draft === undefined && draft?.textContent?.includes("Picture both values")) marks.draft = now;
        if (draft && buttons.includes(stop.waiting)) marks.stopWaitingWithDraft = true;
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    }, { stop: { start: t.companion["stop.start"], waiting: t.companion.cancel }, region: t.companion["reply.region"] });
    await expect.poll(async () => (await (await request.post("/test/companion-draft", { data: { question,
      pieces: ["Picture both values on a number line. ", "The one farther left ", "is smaller."], end: "complete", gapMs: 400 } })).json()).reason ?? "opened").toBe("opened");
    const draft = page.getByLabel(t.companion["reply.region"], { exact: true });
    await expect(draft).toContainText("Picture both values on a number line.");
    await expect(questionCard.getByRole("button", { name: t.companion["stop.start"], exact: true })).toBeVisible();
    const marks = await page.evaluate(() => (window as unknown as { __marks: { draft?: number; stop?: number; stopWaitingWithDraft?: boolean } }).__marks);
    expect(marks.draft, "the first draft text was seen").toBeDefined();
    expect(marks.stop, "Stop was seen").toBeDefined();
    // Within 1 s of the first draft (in practice before it: the call's dispatch shows first).
    expect(marks.stop! - marks.draft!).toBeLessThan(1000);
    expect(marks.stopWaitingWithDraft ?? false, "never the queued controls beside a draft").toBe(false);
    await expect(questionCard.getByRole("button", { name: t.companion.cancel, exact: true })).toHaveCount(0);
    await expect(questionCard.getByRole("button", { name: t.companion.retry, exact: true })).toHaveCount(0);
    await info.attach(`timing-${locale}`, { body: JSON.stringify({ stopAfterDraftMs: marks.stop! - marks.draft! }), contentType: "application/json" });
    await expect(draft).toContainText("is smaller.");

    // Held by a spending limit: the workspace total in English, the learner's own limit in Hebrew.
    const held = `Held question ${locale} ${Date.now()}`;
    await ask(page, locale, held);
    const ceiling = locale === "en" ? "workspace" : "enrollment";
    expect((await (await request.post("/test/companion-job", { data: { question: held, state: "budget_wait", ceiling } })).json()).updated).toBe(true);
    const heldCard = card(page, locale, held);
    const notice = t.job[ceiling === "workspace" ? "job.pausedWorkspace" : "job.pausedLearner"];
    await expect(heldCard.getByText(notice, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status").filter({ hasText: t.companion["state.paused"] })).toBeVisible();
    await expect(heldCard.getByRole("button", { name: t.companion.retry, exact: true })).toBeVisible();
    // The notice fits: no sideways scrolling at this size, in either direction.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}
