import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { openSection, workspaceNav, workspaceNavNames } from "../workspaceNav";
import { fieldIconOverlaps } from "../fieldIcons";
import { trackedHebrew } from "../hebrewText";

/** Every view of the public demo, in English and Hebrew. The demo client stands in for the
 * answer keys, allowances, media, supervision, platform and integrations ports with fictional
 * in-memory data, so those views show their content rather than "not available here". */

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
const PORTED: Record<string, string> = {
  assessments: "assessmentsView",
  media: "mediaView",
  supervision: "supervisionView",
  platform: "platformView",
  integrations: "integrationsView",
};

async function expectNoHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}

for (const locale of ["en", "he"] as const)
  test(`every demo view renders in ${locale}, accessibly and without overflow`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const nav = catalog(locale, "adminApp");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`/admin/demo?locale=${locale}`);
    await expect(page.locator("html")).toHaveAttribute(
      "dir",
      locale === "he" ? "rtl" : "ltr",
    );
    for (const key of ["allowances", ...Object.keys(PORTED)])
      await expect(
        (await workspaceNav(page)).getByRole("button", {
          name: nav[`nav.${key}`],
          exact: true,
        }),
      ).toBeVisible();
    const names = await workspaceNavNames(page);
    for (const name of names) {
      await (
        await workspaceNav(page)
      )
        .getByRole("button", { name, exact: true })
        .click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
      await expect(page.locator("main .loading")).toHaveCount(0);
      await expect(page.locator('main [role="alert"]')).toHaveCount(0);
      const ported = Object.entries(PORTED).find(
        ([key]) => nav[`nav.${key}`] === name,
      );
      if (ported) {
        await expect(page.locator("main .card").first()).toBeVisible();
        await expect(page.locator("main")).not.toContainText(
          catalog(locale, ported[1])["unavailable.title"]!,
        );
      }
      await expectNoHorizontalOverflow(page);
      // No icon or sign drawn in a field (search, "$") covers the field's text.
      expect(
        await fieldIconOverlaps(page.locator("main"), `${name}: `),
      ).toEqual([]);
      // Hebrew labels are not letter-spaced or case-transformed (sidebar and bar included).
      if (locale === "he")
        expect(await trackedHebrew(page.locator("body")), name).toEqual([]);
      expect(
        (
          await new AxeBuilder({ page })
            .include("main")
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations.map((v) => `${name}: ${v.id} ${v.nodes[0]?.target}`),
      ).toEqual([]);
    }
    expect(pageErrors).toEqual([]);
  });

/** The demo client also stands in for the administrator ledger commands: approving or
 * rejecting learner-accepted terms, revocations, refunds, exceptional grants and
 * course-wide deadline changes, each previewed first and applied with a reason. */
test("demo ledger: approve accepted terms, refuse an exception past the course limit, revoke and change a cohort deadline", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/admin/demo");
  await openSection(page, "Policy & extensions");
  await expect(
    page.getByText(
      "The learner accepted these exact terms. They also need an administrator’s approval.",
    ),
  ).toBeVisible();
  // Rejecting needs a reason before the button works.
  await expect(
    page.getByRole("button", { name: "Reject offer" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Approve learner-accepted terms" })
    .click();
  await expect(page.getByText(/Demo approval recorded/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve learner-accepted terms" }),
  ).toHaveCount(0);

  // An exception the course's ultimate deadline would cut short is refused, not shortened.
  await page
    .getByRole("button", { name: /Whole course/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Exceptional grant for this scope" })
    .click();
  const exception = page.getByRole("dialog", { name: "Exceptional grant" });
  await exception
    .getByRole("spinbutton", { name: "Extra calendar days" })
    .fill("30");
  await exception.getByRole("button", { name: "Preview the effect" }).click();
  await expect(exception.getByRole("alert")).toContainText("binding ancestor");
  await exception
    .getByRole("spinbutton", { name: "Extra calendar days" })
    .fill("2");
  await exception.getByRole("button", { name: "Preview the effect" }).click();
  await expect(
    exception.getByText("No allowance pool is debited."),
  ).toBeVisible();
  await exception.getByRole("textbox", { name: "Reason" }).fill("DEC-104");
  await exception
    .getByRole("button", { name: "Apply: exceptional grant" })
    .click();
  await expect(page.getByText(/Demo exceptional grant recorded/)).toBeVisible();

  await page.getByRole("button", { name: "Revoke grant" }).first().click();
  const revoke = page.getByRole("dialog", { name: "Revoke grant" });
  await revoke.getByRole("button", { name: "Preview the effect" }).click();
  await revoke.getByRole("textbox", { name: "Reason" }).fill("TICKET-7");
  await revoke.getByRole("button", { name: "Apply: revoke grant" }).click();
  await expect(page.getByText(/Demo grant revoked/)).toBeVisible();

  await page
    .getByRole("button", { name: "Change a deadline for all learners" })
    .click();
  const cohort = page.getByRole("dialog", {
    name: "Change a deadline for all learners",
  });
  await cohort
    .getByLabel("New absolute deadline (UTC)")
    .fill("2026-11-28T17:00");
  await cohort
    .getByRole("button", { name: "Preview every enrollment" })
    .click();
  await expect(cohort.getByText(/Not changed/)).toBeVisible();
  // The earlier deadline cuts the approved grant short: it must be acknowledged first.
  await expect(
    cohort.getByRole("button", { name: "Apply to all previewed learners" }),
  ).toBeDisabled();
  for (const box of await cohort.getByRole("checkbox").all()) await box.check();
  await cohort
    .getByRole("textbox", { name: "Reason for this change" })
    .fill("ROOM-2");
  await cohort
    .getByRole("button", { name: "Apply to all previewed learners" })
    .click();
  await expect(page.getByText(/Demo deadline change applied/)).toBeVisible();

  // The allowances view reads the same ledger: the approved offer is no longer pending.
  await openSection(page, "Extensions & accommodations");
  await expect(page.locator("main .loading")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(
    "Approve learner-accepted terms",
  );
});
