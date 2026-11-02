import { test, expect, type Locator, type Page } from "@playwright/test";
import { mockWorkspacePages } from "./workspacePagesStub";
import { closeWorkspaceNav, openSection, workspaceNav } from "../workspaceNav";

/**
 * The shell and the operations pages at the size a real pilot reaches (workspacePagesStub):
 * the sidebar in four labelled groups, the course page without the marketing banner and with
 * its long parts folded, the audit log as sentences with the raw record behind "Technical
 * details", policy changes with named settings, platform checks in full rows. Every width is a
 * real layout: no horizontal page scroll at 1440, 805 or 375px, in English and Hebrew.
 *
 * Set WP5_SHOTS to a folder to also save full-page screenshots of every page and width.
 */
const SHOTS = process.env.WP5_SHOTS;
const WIDTHS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 805, height: 1000 },
  { name: "phone", width: 375, height: 800 },
] as const;
const NAV = {
  en: {
    overview: "Overview",
    course: "Course & releases",
    learners: "Enrollments",
    audit: "Audit log",
    platform: "Platform",
    integrations: "Integrations",
    people: "People & roles",
    groups: ["Course", "Learners", "Rules & AI", "System"],
  },
  he: {
    overview: "סקירה כללית",
    course: "קורס וגרסאות",
    learners: "הרשמות",
    audit: "יומן ביקורת",
    platform: "פלטפורמה",
    integrations: "שילובים",
    people: "אנשים ותפקידים",
    groups: ["הקורס", "לומדים", "כללים ו-AI", "מערכת"],
  },
} as const;
type Locale = keyof typeof NAV;

async function expectNoHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}
/** Text broken one word per line: a box much taller than its line height for its words. */
async function wordPerLine(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).checkVisibility())
      .filter((element) => {
        const words = (element.textContent ?? "").trim().split(/\s+/).length;
        const line = parseFloat(getComputedStyle(element).lineHeight) || 20;
        const lines = element.getBoundingClientRect().height / line;
        return words >= 3 && lines >= words - 0.5;
      })
      .map((element) => element.textContent?.trim()),
  );
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
async function open(page: Page, locale: Locale) {
  await page.goto(`/admin/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}
async function go(page: Page, name: string) {
  await openSection(page, name);
  await expect(page.locator("main :is(.loading, .skeleton-rows)")).toHaveCount(
    0,
  );
}

test.describe.configure({ mode: "parallel" });

for (const locale of ["en", "he"] as const)
  for (const size of WIDTHS)
    test(`${locale} ${size.width}px: shell and operations pages @desktop-window`, async ({
      page,
      context,
    }) => {
      test.setTimeout(120_000);
      const text = NAV[locale];
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width: size.width, height: size.height });
      await mockWorkspacePages(page, context);
      await open(page, locale);
      const tag = `${locale}-${size.name}`;

      // E14: four labelled groups; "Answer reviews"/"Answer keys" and "AI services"/"AI
      // supervision" sit under different headings.
      const nav = await workspaceNav(page);
      await expect(nav.locator(".nav-group-label")).toHaveText([
        ...text.groups,
      ]);
      expect(await nav.locator('[role="group"]').count()).toBe(4);
      if (size.width < 1100) await shot(page, `nav-${tag}`);
      await closeWorkspaceNav(page);

      // E6/E8: the course page opens on the course itself, its parts are one click away and
      // its 56 objectives are folded.
      await expect(page.locator(".hero-card")).toHaveCount(0);
      await expect(page.locator(".course-header h2")).toBeVisible();
      await expect(page.locator("nav.section-nav a").first()).toBeVisible();
      await expect(page.locator(".objectives-disclosure")).not.toHaveAttribute(
        "open",
      );
      await expect(page.locator(".objectives li").first()).toBeHidden();
      // E7: the update source is one choice per line; the hours field is sized for a number.
      const sources = page.locator("fieldset.update-source > label");
      await expect(sources).toHaveCount(3);
      const xs = await sources.evaluateAll((labels) =>
        labels.map((label) => Math.round(label.getBoundingClientRect().x)),
      );
      expect(new Set(xs).size).toBe(1);
      const hours = page.locator(".input-with-unit > input");
      expect((await hours.boundingBox())!.width).toBeLessThan(200);
      // E8: fingerprints are behind copy buttons, not printed.
      await expect(page.getByText("c".repeat(64))).toHaveCount(0);
      await expect(page.locator(".creator-list .copy-text")).toHaveCount(2);
      await expectNoHorizontalOverflow(page);
      await shot(page, `course-${tag}`);

      await go(page, text.overview);
      await expect(page.locator("button.stat-link")).toHaveCount(4);
      await expect(page.locator(".count-row-value.zero").first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot(page, `overview-${tag}`);

      // E1/E2/E3: sentences, not payloads; raw codes only inside "Technical details".
      await go(page, text.audit);
      const table = page.locator("table.audit-table");
      await expect(table).toBeVisible();
      for (const raw of ["chargedMicroUsd", "provider.quality_check.finished"])
        await expect(page.getByText(raw, { exact: true }).first()).toBeHidden();
      expect(await table.locator("tbody tr").count()).toBe(24);
      if (size.width >= 700) {
        // What happened is the widest column.
        const widths = await table
          .locator("thead th")
          .evaluateAll((cells) =>
            cells.map((cell) => cell.getBoundingClientRect().width),
          );
        expect(widths[0]!).toBeGreaterThan(Math.max(widths[1]!, widths[2]!));
      }
      // Every date fits its cell, on one line, at every width (none cut off at the table's edge).
      expect(
        await page
          .locator("table.audit-table td.cell-date")
          .evaluateAll(
            (cells) =>
              cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
                .length,
          ),
      ).toBe(0);
      const changes = page.locator("table.policy-changes");
      await expect(changes.first()).toBeVisible();
      await expect(page.getByText("placement.assessmentIds")).toBeHidden();
      expect(
        await wordPerLine(changes.locator(".setting-path, td > *")),
      ).toEqual([]);
      await expectNoHorizontalOverflow(page);
      await shot(page, `audit-${tag}`);
      // The raw record is one click away.
      await page.locator("details.quiet-details > summary").first().click();
      await expect(
        page.locator("details.quiet-details[open] dd").first(),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.getByRole("button", { name: /Older|ישנים/ }).click();
      await expect(page.locator(".audit-page")).toContainText("2");
      await expect(
        page.getByRole("button", { name: /Newer|חדשים/ }),
      ).toBeEnabled();

      // E4: six checks fill whole rows, and the cards in a row are the same height.
      await go(page, text.platform);
      const cards = page.locator(".readiness-grid > .card");
      await expect(cards).toHaveCount(6);
      const boxes = await cards.evaluateAll((items) =>
        items.map((item) => {
          const box = item.getBoundingClientRect();
          return { top: Math.round(box.top), height: Math.round(box.height) };
        }),
      );
      const rows = new Map<number, number[]>();
      for (const box of boxes)
        rows.set(box.top, [...(rows.get(box.top) ?? []), box.height]);
      const perRow = [...rows.values()].map((heights) => heights.length);
      expect(new Set(perRow).size).toBe(1);
      for (const heights of rows.values())
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(
          1,
        );
      expect(await wordPerLine(page.locator(".check-facts dt"))).toEqual([]);
      await expectNoHorizontalOverflow(page);
      await shot(page, `platform-${tag}`);

      // E5: what each course needs is a table; AI connections link to AI services.
      await go(page, text.integrations);
      await expect(
        page.locator("table.requirements-table").first(),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot(page, `integrations-${tag}`);

      // E9/E16: the reference is behind a copy button; "Edit profile" keeps its size.
      await go(page, text.learners);
      const profile = page.locator(".enrollment-profile");
      await expect(profile.locator(".copy-text")).toBeVisible();
      const edit = profile.locator(".section-heading > .button");
      const title = profile.locator(".section-heading h2");
      expect((await edit.boundingBox())!.width).toBeLessThan(
        (await profile.boundingBox())!.width * 0.6,
      );
      expect(
        Math.abs(
          (await edit.boundingBox())!.y - (await title.boundingBox())!.y,
        ),
      ).toBeLessThan(24);
      await expectNoHorizontalOverflow(page);
      await shot(page, `enrollments-${tag}`);

      // E11: no course access yet is said once.
      await go(page, text.people);
      await expect(page.locator(".card .empty").last()).toBeVisible();
      await expect(page.locator(".card:has(.empty) .notice.blue")).toHaveCount(
        0,
      );
      await expectNoHorizontalOverflow(page);
      // The members table fits its card: it never scrolls sideways inside it.
      expect(
        await page
          .locator(".table-wrap:has(table.people-table)")
          .evaluate((wrap) => wrap.scrollWidth - wrap.clientWidth),
      ).toBeLessThanOrEqual(1);
      await shot(page, `people-${tag}`);
      expect(errors).toEqual([]);
    });

test("phones and tablets: the app bar names the section only once the page heading has scrolled under it @desktop-window", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockWorkspacePages(page, context);
  await open(page, "en");
  const title = page.locator(".app-bar-title strong");
  await expect(title).toHaveText("Course & releases");
  await expect(title).toBeHidden();
  await page.mouse.wheel(0, 900);
  await expect(page.locator(".app-bar")).toHaveClass(/title-in-bar/);
  await expect(title).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(title).toBeHidden();
});
