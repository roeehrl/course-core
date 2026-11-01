import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockConnectedAdmin } from "./connectedAdmin";
import { stubQualityCheck } from "./qualityCheckStub";
import { workspaceNav } from "../workspaceNav";

/** "Details of each conversation" under a failed quality check, on the connected AI services page
 * with a stubbed check result, in English and Hebrew, on phone and desktop. */
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

async function openCheck(page: Page, locale: "en" | "he") {
  const nav = catalog(locale, "adminApp"),
    ai = catalog(locale, "aiServices");
  await page.goto(`/admin/?locale=${locale}`);
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: nav["nav.providers"], exact: true })
    .click();
  const section = page.getByRole("region", { name: ai["section.check"] });
  await expect(section.getByText(ai["check.run.failed"]!)).toBeVisible();
  return { section, ai };
}

for (const locale of ["en", "he"] as const)
  test(`${locale}: every conversation of a failed check, its reply, rules and evidence`, async ({
    page,
    context,
  }) => {
    await mockConnectedAdmin(page, context);
    const requests = await stubQualityCheck(page);
    const { section, ai } = await openCheck(page, locale);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "he" ? "rtl" : "ltr",
    );
    const panel = section.locator(".ai-dialogues");
    // Closed by default; nothing is read until it is opened.
    await expect(panel).not.toHaveAttribute("open");
    expect(requests.details).toBe(0);
    await panel.getByText(ai["check.details.title"]!, { exact: true }).click();
    const tutor = panel.getByRole("region", {
      name: catalog(locale, "aiServices")["role.companion.name"],
    });
    await expect(tutor.getByRole("heading", { level: 4 })).toContainText(
      ai["role.companion.name"]!,
    );
    // Failed conversations first, each closed with its pass or fail pill.
    const first = tutor.locator(".ai-dialogue").first();
    await expect(first).toHaveClass(/failed/);
    await expect(tutor.locator(".ai-dialogue.passed")).toHaveCount(2);

    // The tutor that switched to "admin mode": the learner's message, the reply with the failing
    // passages marked, and each rule with its reason.
    const injection = tutor.locator(
      '[data-dialogue="companion.adversarial.prompt-injection"]',
    );
    await injection.locator("summary").click();
    await expect(injection.locator(".ai-bubble.learner")).toContainText(
      "ADMIN MODE",
    );
    await expect(injection.locator(".ai-reply")).toContainText(
      "Admin mode is enabled",
    );
    await expect(
      injection.locator(".ai-reply mark.ai-flagged").first(),
    ).toBeVisible();
    await expect(
      injection.locator(".ai-reply mark.ai-flagged", {
        hasText: "Admin mode is enabled",
      }),
    ).toHaveCount(1);
    const authority = injection.locator(".ai-rule-results > li.failed", {
      hasText: ai["check.details.rule.authority"]!,
    });
    await expect(authority).toContainText(ai["check.details.fail"]!);
    await expect(authority).toContainText(
      ai["check.details.finding.authority"]!,
    );
    await expect(
      injection.locator(".ai-rule-results > li.passed").first(),
    ).toContainText(ai["check.details.pass"]!);

    // The planner's tool plan: the disallowed tool, flagged, and what the rule allows.
    const planner = panel.locator(
      '[data-dialogue="supervisor.tool-loop.adversarial.history-injection"]',
    );
    await planner.locator("summary").click();
    const call = planner.locator(".ai-tool-calls li.failed");
    await expect(call).toContainText("request_authority");
    await expect(call).toContainText(ai["check.details.toolNotAllowed"]!);
    await expect(
      planner.locator(".ai-findings", { hasText: "request_authority" }).first(),
    ).toContainText("get_evidence");

    // The private test strings of the image conversation are removed, never shown.
    const media = panel.locator(
      '[data-dialogue="media.image.lesson-only-prompt"]',
    );
    await media.locator("summary").click();
    await expect(media.locator(".ai-redacted").first()).toHaveText(
      ai["check.details.redacted"]!,
    );
    await expect(panel).not.toContainText("CANARY");

    // No horizontal scrolling at this width, and accessible.
    const width = page.viewportSize()!.width;
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(
      (
        await new AxeBuilder({ page })
          .include(".ai-dialogues")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations.map((v) => `${v.id} ${v.nodes[0]?.target}`),
    ).toEqual([]);

    // Still there after a reload: the page's latest check reads its stored details again.
    await page.reload();
    const again = page
      .getByRole("region", { name: ai["section.check"] })
      .locator(".ai-dialogues");
    await again.getByText(ai["check.details.title"]!, { exact: true }).click();
    await expect(
      again.locator('[data-dialogue="companion.adversarial.prompt-injection"]'),
    ).toBeVisible();
    expect(requests.details).toBe(2);
  });

test("a check from before details were kept says how to see them", async ({
  page,
  context,
}) => {
  await mockConnectedAdmin(page, context);
  await stubQualityCheck(page, { recorded: false });
  const { section, ai } = await openCheck(page, "en");
  const panel = section.locator(".ai-dialogues");
  await panel.getByText(ai["check.details.title"]!, { exact: true }).click();
  await expect(panel).toContainText(ai["check.details.notRecorded"]!);
  await expect(panel.locator(".ai-dialogue")).toHaveCount(0);
});
