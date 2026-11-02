import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { mockConnectedAdmin } from "./connectedAdmin";
import { stubAiServicesPage } from "./aiServicesPageStub";
import { workspaceNav } from "../workspaceNav";

/** The AI services page's layout with the pilot's data: as wide as the other admin pages, the
 * section links stuck under the top bar, one primary action per card, captions and pagers that
 * read on a phone, and the conversation details one row each. English and Hebrew. */
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

async function openPage(page: Page, locale: "en" | "he") {
  const nav = catalog(locale, "adminApp"),
    ai = catalog(locale, "aiServices");
  await page.goto(`/admin/?locale=${locale}`);
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: nav["nav.providers"], exact: true })
    .click();
  await expect(page.locator("#ai-check")).toBeVisible();
  await expect(page.locator(".ai-job").first()).toBeVisible();
  return ai;
}
const noSidewaysScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
const box = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!;

for (const locale of ["en", "he"] as const) {
  test(`${locale}: the page uses the content width and its section links stay in view`, async ({
    page,
    context,
  }, info) => {
    await mockConnectedAdmin(page, context);
    await stubAiServicesPage(page);
    const ai = await openPage(page, locale);
    await noSidewaysScroll(page);
    // As wide as the page heading's row: no cap that leaves a third of the page empty.
    const content = await box(page, ".page-heading");
    const section = await box(page, "#ai-connections");
    expect(section.width).toBeGreaterThan(content.width - 2);

    // Scrolled far down, the section links are still at the top, under the bar, and mark where
    // the reader is.
    const toc = page.getByRole("navigation", { name: ai["page.sections"] });
    await page.locator("#ai-check").scrollIntoViewIfNeeded();
    await page.evaluate(() =>
      window.scrollBy(0, document.getElementById("ai-check")!.offsetTop),
    );
    const bar = await page.evaluate(
      () =>
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--app-bar-height",
          ),
        ) || 0,
    );
    await expect
      .poll(async () => Math.round((await toc.boundingBox())!.y))
      // Right under the bar (the shared sticky offset leaves at most a small gap).
      .toBeLessThanOrEqual(Math.ceil(bar) + 20);
    await toc
      .getByRole("link", { name: ai["section.prices"], exact: true })
      .click();
    await expect(
      toc.getByRole("link", { name: ai["section.prices"], exact: true }),
    ).toHaveAttribute("aria-current", "true");
    // The section's heading is below the links, not under them.
    const tocBottom = (await toc.boundingBox())!;
    const heading = (await page.locator("#ai-prices h2").boundingBox())!;
    expect(heading.y).toBeGreaterThanOrEqual(tocBottom.y + tocBottom.height);
    await page.screenshot({ path: info.outputPath(`toc-${locale}.png`) });
  });

  test(`${locale}: one primary action per card, and a destructive one never the biggest`, async ({
    page,
    context,
  }) => {
    await mockConnectedAdmin(page, context);
    await stubAiServicesPage(page);
    const ai = await openPage(page, locale);
    // Quality check: "Check all jobs that are on" is the one primary; each job's own check is not.
    const check = page.locator("#ai-check");
    await expect(check.locator(".ai-on-jobs .button.primary")).toHaveCount(1);
    await expect(
      check.getByRole("button", { name: ai["check.on.runAll"], exact: true }),
    ).toHaveClass(/primary/);
    // Remove is quiet, last, and narrower than the other actions on a phone too.
    const row = page.locator(".ai-connection").first();
    const remove = row.getByRole("button", {
      name: ai["row.remove"],
      exact: true,
    });
    const replace = row.getByRole("button", {
      name: ai["row.replaceKey"],
      exact: true,
    });
    await expect(remove).toHaveClass(/quiet/);
    const r = (await remove.boundingBox())!,
      card = (await row.boundingBox())!;
    expect(r.width).toBeLessThan(card.width / 2);
    expect(r.width).toBeLessThanOrEqual((await replace.boundingBox())!.width);
    // Every save button says whether there is anything to save.
    for (const id of ["#ai-models", "#ai-prices", "#ai-spending"])
      await expect(page.locator(`${id} .ai-save-state`)).toHaveText(
        ai["save.none"]!,
      );
    await noSidewaysScroll(page);
  });

  test(`${locale}: spending tables, totals and pages read at every width`, async ({
    page,
    context,
  }) => {
    await mockConnectedAdmin(page, context);
    await stubAiServicesPage(page);
    const ai = await openPage(page, locale);
    const spending = page.locator("#ai-spending");
    await spending.getByText(ai["history.title"]!, { exact: true }).click();
    const byJob = spending.getByRole("table", { name: ai["history.byJob"] });
    const byPeriod = spending.getByRole("table", {
      name: ai["history.byPeriod"],
    });
    await expect(byJob).toBeVisible();
    // A caption is a title across its table, never one word per line.
    for (const table of [byJob, byPeriod]) {
      const caption = (await table.locator("caption").boundingBox())!;
      expect(caption.height).toBeLessThan(40);
    }
    // Sibling tables: the same column at the same place.
    if (page.viewportSize()!.width >= 700) {
      const calls = async (t: typeof byJob) =>
        (await t.locator("thead th").nth(1).boundingBox())!.width;
      expect(
        Math.abs((await calls(byJob)) - (await calls(byPeriod))),
      ).toBeLessThan(2);
    }
    // Amounts to the cent; a fraction of a cent says so.
    await expect(byPeriod).toContainText(/<\$?0\.01/);
    await expect(byPeriod).not.toContainText("0.0069");

    const learners = page.locator(".ai-learner-spend");
    await learners
      .getByText(ai["learnerSpend.title"]!, { exact: true })
      .click();
    await expect(
      learners.locator(".ai-learner-list summary").first(),
    ).toBeVisible();
    // Learners by their place in the list, never by an id.
    await expect(
      learners.locator(".ai-learner-list summary").first(),
    ).not.toContainText(/[0-9a-f]{8}/);
    // The totals: none alone on a row of its own beside empty columns.
    const totals = learners.locator(":scope > .ai-form > .ai-totals > div");
    const tops = new Set<number>();
    for (const item of await totals.all())
      tops.add(Math.round((await item.boundingBox())!.y));
    if (page.viewportSize()!.width >= 1000) expect(tops.size).toBe(1);
    await noSidewaysScroll(page);
  });

  test(`${locale}: each conversation of a check is one row, its messages in reading order`, async ({
    page,
    context,
  }) => {
    await mockConnectedAdmin(page, context);
    await stubAiServicesPage(page);
    const ai = await openPage(page, locale);
    const panel = page.locator("#ai-check .ai-dialogues");
    await panel.getByText(ai["check.details.title"]!, { exact: true }).click();
    const rows = panel.locator(".ai-dialogue > summary");
    await expect(rows.first()).toBeVisible();
    if (page.viewportSize()!.width >= 1000) {
      // One line per conversation on a wide page.
      for (const row of (await rows.all()).slice(0, 4))
        expect((await row.boundingBox())!.height).toBeLessThan(64);
    }
    // Only the failed ones, when asked.
    const all = await panel.locator(".ai-dialogue:visible").count();
    await panel.locator(".ai-dialogue-filter input").check();
    const failed = await panel.locator(".ai-dialogue:visible").count();
    expect(failed).toBeGreaterThan(0);
    expect(failed).toBeLessThan(all);
    await panel.locator(".ai-dialogue-filter input").uncheck();

    // The Hebrew message keeps its English sentence whole, and math shows without $.
    const hebrew = panel.locator(
      '[data-dialogue="companion.adversarial.hebrew-check"]',
    );
    await hebrew.locator("summary").click();
    await expect(
      hebrew.locator(".ai-bubble.learner bdi", {
        hasText: "What is the final position?",
      }),
    ).toHaveCount(1);
    await expect(hebrew.locator(".ai-reply")).not.toContainText("$");
    // On screen: the question mark right after "position", and the minus left of its number.
    const order = await hebrew.evaluate((root) => {
      const x = (node: Node, from: number, to: number) => {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        return range.getBoundingClientRect().left;
      };
      const text = (el: Element) => el.firstChild as Text;
      const question = [
        ...root.querySelectorAll(".ai-bubble.learner bdi"),
      ].find((b) => b.textContent!.includes("position?"))!;
      const q = text(question).data.indexOf("position?");
      const math = root.querySelector(".ai-reply .ai-math")!;
      return {
        mark: x(text(question), q + 8, q + 9) - x(text(question), q, q + 1),
        minus: x(text(math), 1, 2) - x(text(math), 0, 1),
      };
    });
    expect(order.mark).toBeGreaterThan(0);
    expect(order.minus).toBeGreaterThan(0);
    await expect(hebrew.locator(".ai-reply .ai-math").first()).toHaveText("-5");
    await noSidewaysScroll(page);
  });
}

/** Screenshots for review at 1440, 805 and 375 in both languages (COURSE_SCREENSHOT_DIR). */
const shots = process.env.COURSE_SCREENSHOT_DIR;
for (const locale of ["en", "he"] as const)
  test(`${locale}: review screenshots @desktop-window`, async ({
    page,
    context,
  }, info) => {
    test.skip(!shots || info.project.name !== "desktop");
    test.setTimeout(180_000);
    await mockConnectedAdmin(page, context);
    await stubAiServicesPage(page);
    for (const width of [1440, 805, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      const ai = await openPage(page, locale);
      await page.evaluate(() => {
        for (const d of document.querySelectorAll<HTMLDetailsElement>(
          ".ai-history, .ai-advanced",
        ))
          d.open = true;
      });
      await page.locator("#ai-check .ai-dialogues summary").first().click();
      await page
        .locator('[data-dialogue="companion.adversarial.hebrew-check"] summary')
        .click();
      await expect(
        page.locator(".ai-learner-list summary").first(),
      ).toBeVisible();
      await page.locator(".ai-learner-list summary").first().click();
      await noSidewaysScroll(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `${shots}/ai-${locale}-${width}-full.png`,
        fullPage: true,
      });
      void ai;
    }
  });
