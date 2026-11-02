import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { mockConnectedAdmin } from "./connectedAdmin";
import { stubDraftBesideOn } from "./qualityCheckStub";
import { workspaceNav } from "../workspaceNav";

/**
 * A new model saved beside the models that are on: the page still says AI services are on, with
 * the waiting draft as a note, and a model Google answered 404 for is named on its job and in the
 * check's result. English and Hebrew, phone and desktop; stubbed API, no provider.
 */
const catalog = (locale: string, namespace: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../src/i18n/messages/${locale}/${namespace}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, string>;
/** A message with its values; Hebrew isolates each value (FSI … PDI), as the page's translator does. */
const fill = (
  locale: "en" | "he",
  text: string,
  values: Record<string, string>,
) =>
  text.replace(/\{(\w+)\}/g, (_, name: string) =>
    locale === "he" ? `⁨${values[name] ?? ""}⁩` : (values[name] ?? ""),
  );
/** The ICU plural branch for one (`{count, plural, one {…} …}`), with `#` as 1. */
const one = (text: string) =>
  /one \{([^}]*)\}/.exec(text)![1]!.replace("#", "1");

async function openAiServices(page: Page, locale: "en" | "he") {
  const nav = catalog(locale, "adminApp");
  await page.goto(`/admin/ai-services?locale=${locale}`);
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: nav["nav.providers"], exact: true })
    .click();
  const ai = catalog(locale, "aiServices");
  const bar = page.locator(".ai-status-bar");
  await expect(bar).toBeVisible();
  return { ai, bar };
}
async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: AI services stay on while a new tutor model waits for its check`, async ({
    page,
    context,
  }, info) => {
    await mockConnectedAdmin(page, context);
    await stubDraftBesideOn(page);
    const { ai, bar } = await openAiServices(page, locale);
    await expect(bar).toHaveClass(/\bon\b/);
    await expect(bar).toContainText(ai["status.on"]!);
    await expect(bar).not.toContainText(ai["status.off"]!.replace(/:$/, ""));
    await expect(bar).toContainText(ai["status.pending"]!);
    const link = bar.getByRole("link", { name: one(ai["issue.check"]!) });
    await expect(link).toBeVisible();
    // The models card says the same: learners keep the models that are on.
    await expect(
      page.getByRole("region", { name: ai["section.models"]! }),
    ).toContainText(ai["models.pending"]!);
    await noSidewaysScroll(page);
    await bar.screenshot({
      path: info.outputPath(`header-draft-waiting-${locale}.png`),
    });
    await page.screenshot({
      path: info.outputPath(`page-draft-waiting-${locale}.png`),
    });
  });

  test(`${locale}: a model Google answered "not found" for is named on its job and in the check`, async ({
    page,
    context,
  }, info) => {
    await mockConnectedAdmin(page, context);
    await stubDraftBesideOn(page, { notFound: true });
    const { ai, bar } = await openAiServices(page, locale);
    // The models that are on still work: AI services are on.
    await expect(bar).toContainText(ai["status.on"]!);
    const models = page.getByRole("region", { name: ai["section.models"]! });
    const service = catalog(locale, "aiServices")["service.google"]!;
    const warning = models.getByText(
      fill(locale, ai["models.unavailableChoice"]!, {
        service,
        model: "gemini-2.5-pro",
      }),
    );
    await expect(warning).toBeVisible();
    const tutor = models.getByLabel(
      fill(locale, ai["models.modelFor"]!, {
        job: ai["role.companion.name"]!,
      }),
    );
    // Listed only as the current choice, never as a model to pick.
    await expect(
      tutor.locator("option", { hasText: "gemini-2.5-pro" }),
    ).toHaveCount(1);
    const check = page.getByRole("region", { name: ai["section.check"]! });
    await expect(check).toContainText(
      fill(locale, ai["check.run.modelUnavailable"]!, {
        service,
        job: ai["role.companion.name"]!,
      }),
    );
    await noSidewaysScroll(page);
    await warning
      .locator("xpath=ancestor::div[contains(@class,'ai-job')][1]")
      .screenshot({
        path: info.outputPath(`models-unavailable-${locale}.png`),
      });
    // The check's own result, scrolled into view (a tall element screenshot would catch the sticky bar).
    const result = check.locator(".ai-message", {
      hasText: ai["role.companion.name"]!,
    });
    await expect(result).toHaveCount(1);
    await result.scrollIntoViewIfNeeded();
    await result.screenshot({
      path: info.outputPath(`check-not-found-${locale}.png`),
    });
  });

  for (const [fault, key] of [
    ["UNKNOWN_MODEL", "check.run.modelNotConfigured"],
    ["CAPABILITY_MISMATCH", "check.run.capabilityMissing"],
  ] as const)
    test(`${locale}: a check stopped on this workspace's own setup says so (${fault})`, async ({
      page,
      context,
    }, info) => {
      await mockConnectedAdmin(page, context);
      await stubDraftBesideOn(page, { localFault: fault });
      const { ai } = await openAiServices(page, locale);
      const check = page.getByRole("region", { name: ai["section.check"]! });
      const job = ai["role.companion.name"]!;
      await expect(check).toContainText(fill(locale, ai[key]!, { job }));
      await expect(check).not.toContainText(ai["err.modelUnavailable"]!);
      await noSidewaysScroll(page);
      const result = check.locator(".ai-message", { hasText: job });
      await expect(result).toHaveCount(1);
      await result.scrollIntoViewIfNeeded();
      await result.screenshot({
        path: info.outputPath(
          `check-local-${fault.toLowerCase()}-${locale}.png`,
        ),
      });
    });
}
