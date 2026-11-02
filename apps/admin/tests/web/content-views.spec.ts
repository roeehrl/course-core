import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { mockConnectedAdmin } from "./connectedAdmin";
import {
  stubAnswerKeys,
  stubPlacement,
  stubResearch,
  stubRuns,
} from "./contentStub";
import { openSection } from "../workspaceNav";

/**
 * Content and workflow pages at a real course's size (contentStub.ts): 117 questions with lab
 * specifications, 40 supervisor runs, 117 placement questions over 14 chapters, 30 research
 * topics. Each page must fit its window (no sideways scroll), keep long course text out of
 * headings, and place the detail beside or below its list, never squeezed into the list column.
 * Runs on the desktop (1440) and phone (390) projects, in English and Hebrew; the tablet width
 * (805) is checked from the desktop project.
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

async function open(
  page: Page,
  locale: "en" | "he",
  section: string,
  stub: (page: Page) => Promise<void>,
  context: Parameters<typeof mockConnectedAdmin>[1],
) {
  await mockConnectedAdmin(page, context);
  await stub(page);
  await page.goto(`/admin/?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await page.getByRole("heading", { level: 1 }).waitFor();
  await openSection(page, catalog(locale, "adminApp")[`nav.${section}`]!);
  await expect(page.locator("main :is(.loading, .skeleton-rows)")).toHaveCount(
    0,
  );
}

async function expectNoSidewaysScroll(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}

/** Text boxes narrower than a few words: the one-word-per-line wrap. */
async function squeezedText(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) =>
    els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .filter((el) => el.getBoundingClientRect().width < 120)
      .map((el) => (el.textContent ?? "").slice(0, 40)),
  );
}

for (const locale of ["en", "he"] as const) {
  test(`answer keys: 117 questions are one line each, with search and filters (${locale})`, async ({
    page,
    context,
  }) => {
    const text = catalog(locale, "assessmentsView");
    await open(page, locale, "assessments", stubAnswerKeys, context);
    const rows = page
      .getByRole("list", { name: text["questions.title"] })
      .locator(".cv-row-summary");
    // The first page of rows, then "Show more"; each row is one compact line on a wide window.
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeLessThanOrEqual(41);
    const wide = page.viewportSize()!.width >= 1100;
    for (const box of await rows.evaluateAll((els) =>
      els.slice(0, 40).map((el) => el.getBoundingClientRect().height),
    ))
      expect(box).toBeLessThan(wide ? 70 : 140);
    // No editor is rendered until a question is opened.
    await expect(page.locator(".cv-row-panel")).toHaveCount(0);
    // A lab's specification is never a heading.
    await expect(
      page.getByRole("heading").filter({ hasText: "standard-library Python" }),
    ).toHaveCount(0);
    const lab = page.getByRole("button", {
      name: /Chapter 2 lab: tiled matrix multiplication simulator/,
    });
    await expect(lab).toBeVisible();
    await lab.click();
    const prompt = page.locator(".cv-row-panel .cv-prose");
    await expect(prompt).toHaveClass(/cv-clamped/);
    expect(
      await prompt.evaluate((el) => el.scrollHeight > el.clientHeight + 4),
    ).toBe(true);
    await page.getByRole("button", { name: text["prompt.more"] }).click();
    await expect(prompt).not.toHaveClass(/cv-clamped/);
    // Search narrows the list.
    await page.getByLabel(text["filter.search"]!).fill("softmax of the scores");
    await expect(rows).toHaveCount(7);
    expect(await squeezedText(page, ".cv-row-title")).toEqual([]);
    await expectNoSidewaysScroll(page);
    // The whole page is a few screens, not 175,000 px.
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBeLessThan(wide ? 8_000 : 16_000);
  });

  test(`run inspector: the chosen run sits beside the list, in words (${locale})`, async ({
    page,
    context,
  }) => {
    await open(page, locale, "runs", stubRuns, context);
    const list = page.locator(".cv-runs-list");
    const detail = page.locator(".cv-runs-detail");
    const runCard = detail.locator(".card").filter({
      has: page.locator(".timeline"),
    });
    await expect(runCard).toBeVisible();
    const [listBox, detailBox] = [
      (await list.boundingBox())!,
      (await detail.boundingBox())!,
    ];
    if (page.viewportSize()!.width >= 1100) {
      // Two columns: the detail is in the wide column, not under the list.
      expect(detailBox.width).toBeGreaterThan(600);
      expect(Math.abs(detailBox.y - listBox.y)).toBeLessThan(4);
      if (locale === "he") expect(detailBox.x).toBeLessThan(listBox.x);
      else expect(detailBox.x).toBeGreaterThan(listBox.x + listBox.width);
      await expect(page.locator(".cv-runs-picker")).toBeHidden();
    } else {
      // One column: a picker above the run instead of 40 buttons.
      await expect(page.locator(".cv-runs-picker select")).toBeVisible();
      await expect(page.locator(".cv-runs-buttons")).toBeHidden();
      expect(detailBox.y).toBeLessThan(listBox.y + listBox.height + 40);
    }
    // Events in words and local formatting; no raw event names or ISO times.
    const timeline = runCard.locator(".timeline");
    await expect(timeline).not.toContainText("session.ended");
    await expect(timeline).not.toContainText(/\d{4}-\d{2}-\d{2}T/);
    await expect(timeline).toContainText(
      catalog(locale, "supervisionView")["eventType.session_ended"]!,
    );
    // The run's ID is behind "Technical details", not in the card's text.
    await expect(runCard.locator(".quiet-details")).not.toHaveAttribute("open");
    // Replay, retry and stop are actions in the card's header, not view tabs.
    const views = runCard.getByRole("navigation", {
      name: catalog(locale, "runsView")["viewsNav"],
    });
    await expect(
      views.getByRole("button", {
        name: catalog(locale, "runsView")["view.retry"],
      }),
    ).toHaveCount(0);
    // The views keep their natural width from the reading start: never spread across a row.
    // On a phone they are one row that scrolls sideways inside the bar.
    const tabs = await views.locator(".button").evaluateAll((buttons) =>
      buttons.map((b) => {
        const r = b.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(b);
        return {
          top: Math.round(r.top),
          left: r.left,
          right: r.right,
          spare: r.width - text.getBoundingClientRect().width,
        };
      }),
    );
    // No view is stretched past its label and padding.
    for (const tab of tabs) expect(tab.spare).toBeLessThanOrEqual(40);
    const rtl = locale === "he";
    for (let i = 1; i < tabs.length; i++)
      if (tabs[i]!.top === tabs[i - 1]!.top)
        expect(
          rtl
            ? tabs[i - 1]!.left - tabs[i]!.right
            : tabs[i]!.left - tabs[i - 1]!.right,
        ).toBeLessThanOrEqual(8);
    if (page.viewportSize()!.width < 700)
      expect(new Set(tabs.map((tab) => tab.top)).size).toBe(1);
    await expectNoSidewaysScroll(page);
  });

  test(`placement: chapters of choices and a save bar in view (${locale})`, async ({
    page,
    context,
  }) => {
    const text = catalog(locale, "placementView");
    await open(page, locale, "placement", stubPlacement, context);
    const groups = page
      .locator(".cv-choice-groups")
      .first()
      .locator(".cv-group");
    await expect(groups).toHaveCount(13);
    // Closed by default: 117 checkboxes are not all on the page at once.
    await expect(
      page.locator(".cv-choice-groups input[type=checkbox]:visible"),
    ).toHaveCount(0);
    await groups.first().locator("summary").click();
    const choice = groups.first().locator(".cv-choice-text").first();
    // The question's ID is its own line, not glued to cut-off text.
    await expect(choice.locator("small.mono")).toBeVisible();
    const [textBox, idBox] = [
      (await choice.locator(".cv-clamp-2").boundingBox())!,
      (await choice.locator("small.mono").boundingBox())!,
    ];
    expect(idBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);
    // "Leave this chapter out" changes the count and makes the form dirty.
    await groups
      .first()
      .getByRole("button", { name: text["group.off"] })
      .click();
    await expect(groups.first().locator("summary")).toContainText(
      text["group.count"]!.replace("{on}", "0").replace("{total}", "9"),
    );
    const save = page.getByRole("button", { name: text["form.save"] });
    await expect(save).toBeInViewport();
    await expectNoSidewaysScroll(page);
  });

  test(`research: one compact list for empty topics, actions in a fixed order (${locale})`, async ({
    page,
    context,
  }) => {
    const text = catalog(locale, "researchView");
    await open(page, locale, "research", stubResearch, context);
    const cards = page.locator(".cv-topic-head");
    await expect(cards).toHaveCount(3);
    // Every topic card has "Add source" then "Search YouTube" at the same place.
    const positions = await cards.evaluateAll((heads) =>
      heads.map((head) =>
        [...head.querySelectorAll(".cv-actions .button")].map((b) =>
          Math.round(b.getBoundingClientRect().x),
        ),
      ),
    );
    for (const p of positions) expect(p).toEqual(positions[0]);
    const firstActions = cards.first().locator(".cv-actions .button");
    await expect(firstActions.nth(0)).toContainText(text["source.add"]!);
    await expect(firstActions.nth(1)).toContainText(text["youtube.search"]!);
    await expect(page.locator(".cv-topic-row")).toHaveCount(27);
    // Display names start with a capital, not a raw lower-case query.
    await expect(cards.first().locator("h2")).toHaveText(/^What is/);
    expect(await squeezedText(page, ".cv-topic-text strong")).toEqual([]);
    await expectNoSidewaysScroll(page);
  });
}

test("content pages fit a tablet window @desktop-window", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 805, height: 1000 });
  for (const [section, stub] of [
    ["assessments", stubAnswerKeys],
    ["runs", stubRuns],
    ["placement", stubPlacement],
    ["research", stubResearch],
  ] as const) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await open(page, "en", section, stub, context);
    await expectNoSidewaysScroll(page);
  }
  // Below 850px the runs list is a picker and the run follows it.
  await open(page, "en", "runs", stubRuns, context);
  await expect(page.locator(".cv-runs-picker select")).toBeVisible();
});
