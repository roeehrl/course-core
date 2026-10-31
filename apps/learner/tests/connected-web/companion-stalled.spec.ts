import AxeBuilder from "@axe-core/playwright";
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

// A question whose call got no reply (live finding U2): the real learner app on the real API shows
// "Reply unavailable" with "Ask again" instead of "Still working" forever, in English and Hebrew,
// on desktop and phone. "Ask again" puts the question back in the draft. The stalled state is set
// by the test host (/test/companion-stall); no provider is called.
const text = {
  en: { companion: enCompanion, job: enJob, host: enHost, preview: enPreview, dock: enDock },
  he: { companion: heCompanion, job: heJob, host: heHost, preview: hePreview, dock: heDock },
} as const;

async function openCompanion(page: Page, locale: "en" | "he", token: string, phone: boolean) {
  const t = text[locale];
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
  await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: t.host["library.open"], exact: true }).click();
  await page.getByRole("button", { name: t.preview.start, exact: true }).click();
  await page.getByTestId("next-step").getByRole("button").click();
  if (phone) await page.getByRole("button", { name: t.dock.open, exact: true }).click();
}

for (const locale of ["en", "he"] as const) {
  test(`a stalled question reads "Reply unavailable" and can be asked again (${locale})`, async ({ page, request }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const t = text[locale];
    const token = (await (await request.post("/test/session")).json()).token;
    await openCompanion(page, locale, token, !info.project.name.endsWith("desktop"));
    const question = `Stalled question ${locale} ${Date.now()}`;
    const box = page.getByRole("textbox", { name: t.companion["draft.label"], exact: true });
    await box.fill(question);
    await page.getByRole("button", { name: t.companion["send.send"], exact: true }).click();
    const log = page.getByRole("log", { name: t.companion.log });
    await expect(log.getByText(question, { exact: true })).toBeVisible();
    // The call for it got no reply and nothing can settle it any more.
    expect((await (await request.post("/test/companion-stall", { data: { question } })).json()).stalled).toBe(true);
    await expect(log.getByText(t.job["job.stalled"], { exact: true })).toBeVisible({ timeout: 15_000 });
    // Not "still working", and no controls for a reply that will never come.
    await expect(page.getByText(t.job["job.stillWorking"], { exact: true })).toHaveCount(0);
    await expect(page.getByText(t.companion["state.still_working"], { exact: true })).toHaveCount(0);
    await expect(page.getByText(t.companion["sent.waiting"], { exact: true })).toHaveCount(0);
    await expect(log.getByRole("button", { name: t.companion.cancel, exact: true })).toHaveCount(0);
    await expect(log.getByRole("button", { name: t.companion["stop.start"], exact: true })).toHaveCount(0);
    const askAgain = log.getByRole("button", { name: t.companion.askAgain, exact: true });
    await expect(askAgain).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).exclude("iframe").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`companion-stalled-${locale}.png`) });
    // "Ask again" restores the question to the draft; sending it is a new question.
    await box.fill("");
    await askAgain.click();
    await expect(box).toHaveValue(question);
    const sent = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/companion"));
    await page.getByRole("button", { name: t.companion["send.send"], exact: true }).click();
    expect((await sent).status()).toBe(200);
    await expect(log.getByText(question, { exact: true })).toHaveCount(2);
    expect(errors).toEqual([]);
  });
}
