import { expect, type Locator, type Page } from "@playwright/test";
import enCompanion from "../../src/i18n/messages/en/connectedCompanion.json";
import heCompanion from "../../src/i18n/messages/he/connectedCompanion.json";
import enDock from "../../src/i18n/messages/en/companionDock.json";
import heDock from "../../src/i18n/messages/he/companionDock.json";

/*
 * The companion as every test outside its own shell reaches it, whatever the layout: the
 * `#connected-companion` region (never its role, which is "complementary" beside the lesson and
 * may differ as a sheet), opened by the trigger's class, and shown full height where a sheet
 * offers heights, so a test sees the whole conversation and the composer.
 */
type Locale = "en" | "he";
const text = { en: { companion: enCompanion, dock: enDock }, he: { companion: heCompanion, dock: heDock } } as const;

/** The companion's region. */
export function companionPanel(page: Page): Locator {
  return page.locator("#connected-companion");
}

/** Opens the companion on any layout (a no-op when it shows), full height where a sheet offers it. */
export async function openCompanion(page: Page, { detent = "full" }: { detent?: "full" | "half" } = {}) {
  const panel = companionPanel(page);
  if (!(await panel.isVisible())) await page.locator(".connected-companion-trigger:visible").click();
  await expect(panel).toBeVisible();
  if (detent === "full") {
    const full = panel.locator('[data-detent="full"]:not([aria-pressed="true"])');
    if (await full.count()) await full.first().click();
  }
  return panel;
}

/** Closes the companion when it shows (a no-op otherwise). */
export async function closeCompanion(page: Page, locale: Locale = "en") {
  const panel = companionPanel(page);
  if (!(await panel.isVisible())) return;
  await panel.getByRole("button", { name: text[locale].dock.close, exact: true }).click();
  await expect(panel).toBeHidden();
}

/** The message box. */
export function composerBox(page: Page, locale: Locale = "en"): Locator {
  return companionPanel(page).getByRole("textbox", { name: text[locale].companion["draft.label"], exact: true });
}

/** Types a question and presses Send (consent and outcomes are the caller's). */
export async function sendQuestion(page: Page, question: string, locale: Locale = "en") {
  await openCompanion(page);
  await composerBox(page, locale).fill(question);
  await companionPanel(page).getByRole("button", { name: text[locale].companion["send.send"], exact: true }).click();
}
