import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { mockConnectedAdmin } from "./connectedAdmin";
import { stubJobsOn } from "./qualityCheckStub";
import { workspaceNav } from "../workspaceNav";

/** "Jobs that are on" with both jobs approved without checking: check them again, or turn one
 * off after a confirmation, in English and Hebrew, on phone and desktop. */
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
    locale === "he"
      ? `\u2068${values[name] ?? ""}\u2069`
      : (values[name] ?? ""),
  );

async function openOnJobs(page: Page, locale: "en" | "he") {
  const nav = catalog(locale, "adminApp"),
    ai = catalog(locale, "aiServices");
  await page.goto(`/admin/?locale=${locale}`);
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: nav["nav.providers"], exact: true })
    .click();
  const section = page.getByRole("region", { name: ai["section.check"] });
  const list = section.locator(".ai-on-jobs");
  await expect(list.locator('[data-role="companion"]')).toBeVisible();
  return { section, list, ai };
}
async function noSidewaysScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const locale of ["en", "he"] as const) {
  test(`${locale}: each job that is on can be checked again or turned off`, async ({
    page,
    context,
  }, info) => {
    await mockConnectedAdmin(page, context);
    const requests = await stubJobsOn(page);
    const { list, ai } = await openOnJobs(page, locale);
    const tutor = list.locator('[data-role="companion"]');
    const job = ai["role.companion.name"]!;
    await expect(tutor).toContainText(ai["check.state.override"]!);
    await expect(
      tutor.getByRole("button", {
        name: fill(locale, ai["check.on.runFor"]!, { job }),
      }),
    ).toBeVisible();
    await expect(
      list.getByRole("button", { name: ai["check.on.runAll"]!, exact: true }),
    ).toBeVisible();
    await noSidewaysScroll(page);
    await list.screenshot({ path: info.outputPath(`jobs-on-${locale}.png`) });

    await tutor
      .getByRole("button", {
        name: fill(locale, ai["check.on.turnOffFor"]!, { job }),
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: fill(locale, ai["check.on.turnOffTitle"]!, { job }),
    });
    await expect(dialog).toContainText(ai["check.on.turnOffBody"]!);
    await page.screenshot({
      path: info.outputPath(`jobs-on-turn-off-${locale}.png`),
    });
    await dialog
      .getByRole("button", {
        name: ai["check.on.turnOffConfirm"]!,
        exact: true,
      })
      .click();
    await expect(dialog).toBeHidden();
    expect(requests.turnOff).toEqual([
      expect.objectContaining({ role: "companion", expectedRevision: 3 }),
    ]);
  });

  test(`${locale}: a failed check of an approved job keeps it on and offers to turn it off`, async ({
    page,
    context,
  }, info) => {
    await mockConnectedAdmin(page, context);
    await stubJobsOn(page, { failed: true });
    const { list, ai } = await openOnJobs(page, locale);
    const job = ai["role.companion.name"]!;
    // Right under the result: each job that failed (both, here) and is still on, with its own "Turn off".
    const still = list.locator(".ai-message", {
      has: page.getByRole("button", {
        name: fill(locale, ai["check.on.turnOffFor"]!, { job }),
      }),
    });
    await expect(still).toBeVisible();
    await expect(
      still.getByRole("button", {
        name: fill(locale, ai["check.on.turnOffFor"]!, {
          job: ai["role.supervisor.name"]!,
        }),
      }),
    ).toHaveCount(1);
    // The conversation details of the check of the jobs that are on open as for a draft's check.
    const panel = list.locator(".ai-dialogues");
    await panel.getByText(ai["check.details.title"]!, { exact: true }).click();
    await expect(panel.locator(".ai-dialogue").first()).toBeVisible();
    await noSidewaysScroll(page);
    await list.screenshot({
      path: info.outputPath(`jobs-on-failed-${locale}.png`),
    });
  });
}
