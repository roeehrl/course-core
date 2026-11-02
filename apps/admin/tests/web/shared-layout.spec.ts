import { test, expect, type Page } from "@playwright/test";
import { openSection } from "../workspaceNav";

/**
 * The shared layout primitives of styles.css, on the demo workspace at the project's size (desktop
 * 1440 and phone 390; English and Hebrew):
 * - A card title with a long unbreakable token (a lab prompt's JSON) breaks inside the card; the
 *   page never scrolls sideways.
 * - Fields of a .form-grid line up at their top, whatever the length of their helper text.
 * - A .choice-row (AI supervision) keeps its control on the label's first line and its text
 *   beside it, not one word per line.
 * - A disabled primary still reads as the primary (a navy fill, not the flat grey of a disabled
 *   secondary), and primary and secondary buttons are the same height; a button in a .stack keeps
 *   its natural width on wide screens.
 * - The list of a .master-detail stays in view on wide screens (sticky, at most a window tall)
 *   and is capped with its own scroll when the two stack.
 * - Phone tables: a caption spans the card instead of breaking one word per line.
 * - A table in a scrolling frame does not break an identifier in the middle.
 * - The current sidebar item is exactly as tall as when it is not current.
 */

const SECTIONS = {
  en: {
    supervision: "AI supervision",
    enrollments: "Enrollments",
    keys: "Answer keys",
    policy: "Policy & extensions",
    course: "Course & releases",
  },
  he: {
    supervision: "פיקוח AI",
    enrollments: "הרשמות",
    keys: "מפתחות תשובות",
    policy: "מדיניות והארכות",
    course: "קורס וגרסאות",
  },
} as const;

async function open(page: Page, locale: "en" | "he") {
  await page.goto(`/admin/demo?locale=${locale}`);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "he" ? "rtl" : "ltr",
  );
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function section(page: Page, name: string) {
  await openSection(page, name);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
}

const pageWidth = (page: Page) =>
  page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, window.innerWidth),
  );

/** Adds markup to the first card of the page (or to <main>) for a measurement. */
const inject = (page: Page, html: string) =>
  page.evaluate((markup) => {
    const host =
      document.querySelector("main .card") ?? document.querySelector("main")!;
    const holder = document.createElement("div");
    holder.dataset.test = "probe";
    holder.className = "stack";
    holder.innerHTML = markup;
    host.prepend(holder);
  }, html);

for (const locale of ["en", "he"] as const) {
  const name = SECTIONS[locale];

  test(`${locale}: long card titles, form grids and option rows keep their layout`, async ({
    page,
  }) => {
    await open(page, locale);
    await section(page, name.keys);
    const width = page.viewportSize()!.width;
    await inject(
      page,
      `<section class="card"><div class="section-heading"><div><h2>Chapter 9 lab: tiled matrix multiply {"c":C,"ops":int,"tiles":[[0,0,0,0],[1,1,1,1]],"stride_bytes_per_row_major_tile":4096}</h2></div><span class="badge">Key ready</span></div></section>
       <div class="form-grid" data-test="grid">
         <div class="field"><label for="p1">Provider</label><input id="p1"><small>A short note.</small></div>
         <div class="field"><label for="p2">Most extra planned minutes per learner over the whole course</label><input id="p2"><small>A much longer helper text that wraps over several lines on narrow screens, so that the field below it would sit lower if fields lined up at their bottom edge.</small></div>
         <div class="field"><label for="p3">First day</label><input id="p3"></div>
       </div>`,
    );
    expect(await pageWidth(page)).toBeLessThanOrEqual(width);
    const title = page.locator('[data-test="probe"] h2');
    const card = page.locator('[data-test="probe"] .card');
    const [titleBox, cardBox] = [
      (await title.boundingBox())!,
      (await card.boundingBox())!,
    ];
    expect(titleBox.x).toBeGreaterThanOrEqual(cardBox.x - 1);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width + 1,
    );

    // Fields of one row start at the same height; on phones the grid is one column.
    const tops = await page
      .locator('[data-test="grid"] input')
      .evaluateAll((inputs) =>
        inputs.map((input) => {
          const field = input.closest(".field")!.getBoundingClientRect();
          return { field: Math.round(field.top), left: field.left };
        }),
      );
    if (width >= 900) {
      expect(tops[0]!.field).toBe(tops[1]!.field);
      expect(tops[2]!.field).toBeGreaterThan(tops[0]!.field);
    } else {
      expect(new Set(tops.map((t) => Math.round(t.left))).size).toBe(1);
    }

    // AI supervision: each option keeps its control on the label's first line, text beside it.
    await section(page, name.supervision);
    const rows = page.locator(".choice-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(3);
    for (const row of (await rows.all()).slice(0, 4)) {
      const m = await row.evaluate((label) => {
        const control = label.querySelector("input")!.getBoundingClientRect();
        const strong = label.querySelector("strong")!;
        const range = document.createRange();
        range.selectNodeContents(strong);
        const firstLine = range.getClientRects()[0]!;
        const text = label
          .querySelector(":scope > span")!
          .getBoundingClientRect();
        return {
          controlMiddle: control.top + control.height / 2,
          lineTop: firstLine.top,
          lineBottom: firstLine.bottom,
          textWidth: text.width,
          rowWidth: label.getBoundingClientRect().width,
          gap:
            getComputedStyle(label).direction === "rtl"
              ? control.left - text.right
              : text.left - control.right,
        };
      });
      expect(m.controlMiddle).toBeGreaterThanOrEqual(m.lineTop - 1);
      expect(m.controlMiddle).toBeLessThanOrEqual(m.lineBottom + 1);
      expect(m.textWidth).toBeGreaterThan(m.rowWidth * 0.6);
      expect(m.gap).toBeGreaterThanOrEqual(8);
    }
    expect(await pageWidth(page)).toBeLessThanOrEqual(width);
  });

  test(`${locale}: buttons share one height and a disabled primary still reads as the primary`, async ({
    page,
  }) => {
    await open(page, locale);
    await section(page, name.course);
    await inject(
      page,
      `<button class="button primary" data-b="primary">Save</button>
       <button class="button" data-b="secondary">Cancel</button>
       <button class="button primary" data-b="primary-off" disabled>Save settings</button>
       <button class="button" data-b="secondary-off" disabled>Check</button>`,
    );
    const measure = (key: string) =>
      page.locator(`[data-b="${key}"]`).evaluate((button) => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        const parent = button.parentElement!.getBoundingClientRect();
        return {
          height: box.height,
          width: box.width,
          parentWidth: parent.width,
          background: style.backgroundColor,
        };
      });
    const [primary, secondary, primaryOff, secondaryOff] = await Promise.all(
      ["primary", "secondary", "primary-off", "secondary-off"].map(measure),
    );
    expect(primary!.height).toBe(secondary!.height);
    expect(primaryOff!.background).not.toBe(secondaryOff!.background);
    // Navy: blue clearly above red.
    const [r, , b] = primaryOff!.background.match(/\d+/g)!.map(Number);
    expect(b! - r!).toBeGreaterThan(30);
    if (page.viewportSize()!.width >= 700)
      expect(primary!.width).toBeLessThan(primary!.parentWidth / 2);
  });

  test(`${locale}: master/detail lists stay in view and are capped when stacked`, async ({
    page,
  }) => {
    await open(page, locale);
    await section(page, name.enrollments);
    const list = page.locator(".master-detail > :first-child");
    const state = await list.evaluate((element) => ({
      position: getComputedStyle(element).position,
      height: element.getBoundingClientRect().height,
      listMax: getComputedStyle(element.querySelector(".selector-list")!)
        .maxHeight,
      wide:
        element.parentElement!.getBoundingClientRect().width >
        element.getBoundingClientRect().width * 1.5,
    }));
    const viewport = page.viewportSize()!;
    if (state.wide) {
      expect(state.position).toBe("sticky");
      expect(state.height).toBeLessThanOrEqual(viewport.height);
    } else {
      expect(state.position).toBe("static");
      expect(parseFloat(state.listMax)).toBeLessThanOrEqual(
        viewport.height * 0.5 + 1,
      );
    }
  });

  test(`${locale}: table captions, identifiers and sidebar items keep their shape`, async ({
    page,
  }) => {
    await open(page, locale);
    await section(page, name.policy);
    const width = page.viewportSize()!.width;
    await inject(
      page,
      `<div class="table-wrap"><table class="data-table"><caption>How much one learner spends</caption>
        <thead><tr><th scope="col">Setting</th><th scope="col">Value</th></tr></thead>
        <tbody><tr><th scope="row"><span class="mono" dir="ltr" data-test="id">policy.work.remediationCyclesPerConcept</span></th><td>Not set</td></tr></tbody>
      </table></div>`,
    );
    expect(await pageWidth(page)).toBeLessThanOrEqual(width);
    const caption = await page
      .locator('[data-test="probe"] caption')
      .evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        tableWidth: element.closest("table")!.getBoundingClientRect().width,
      }));
    expect(caption.width).toBeGreaterThanOrEqual(caption.tableWidth - 2);
    // The identifier is on one line (it fits the frame or the card's full width).
    const id = page.locator('[data-test="id"]');
    const lines = await id.evaluate(
      (element) => element.getClientRects().length,
    );
    expect(lines).toBe(1);

    if (width >= 1100) {
      const item = page
        .locator(".sidebar .nav-links button")
        .filter({ hasText: name.course });
      const before = (await item.boundingBox())!.height;
      await item.click();
      await expect(item).toHaveAttribute("aria-current", "page");
      expect((await item.boundingBox())!.height).toBe(before);
    }
  });
}
