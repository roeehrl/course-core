import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import postcss from "postcss";
import { expect, test, type Page } from "./health";
import { openCompanion, closeCompanion, companionPanel } from "./companion-helpers";
import { palette, type ColorToken } from "../../src/theme/palette";
import enHost from "../../src/i18n/messages/en/connectedHost.json";
import heHost from "../../src/i18n/messages/he/connectedHost.json";

/*
 * The whole page in the dark theme (final design §1, TOK-1/TOK-2): the course page, a lesson with
 * a check, the account menu, and the companion with a saved conversation (docked beside the lesson
 * on the desktop project, a sheet on the phone and tablet ones), in English and Hebrew. Under
 * `colorScheme: "dark"` no element keeps a light fill, every text keeps its contrast against the
 * background it is actually drawn on (computed styles), and axe finds nothing.
 *
 * Each part of the learner AI work converts the colour literals in its own files to the tokens.
 * Until a file is converted, what it colours is "pending": its rules (or, for a React Native
 * component with inline colours, its region) are left out of these checks and named in the test's
 * annotations. A converted file is checked as soon as it holds no literal, so once every file
 * uses the tokens this is a check of the entire page with nothing left out.
 */

test.use({ colorScheme: "dark" });

const ROOT = join(__dirname, "../..");
const COLOUR_PROPERTY = /color|background|border|outline|shadow|fill|stroke/;
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black)\b/i;
/** React Native components that colour a region with inline literals, and that region. */
const INLINE_SOURCES: Record<string, string> = {
  "src/components/ConnectedCompanion.tsx": "#connected-companion",
  "src/components/MarkdownContent.tsx": "#connected-companion",
  "src/connected/credit/SendConfirm.web.tsx": "#connected-companion",
  "src/components/CourseRoadmap.tsx": '[data-testid="roadmap-chapter"]',
};
/** Tokens whose dark value is light, so a fill in them is the design (the Stop button's ink, the
 * accent buttons, the danger fill), not a light fill left over from the light theme. */
const LIGHT_IN_DARK: ColorToken[] = ["ink", "inkMuted", "focus", "accent", "accentHover", "companion", "danger", "warning"];

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}
/** Stylesheets (by the basename the export keeps) that still colour something with a literal. */
function pendingSheets(): string[] {
  return stylesheets(join(ROOT, "src"))
    .filter((file) => !file.endsWith("tokens.css"))
    .filter((file) => {
      let literal = false;
      postcss.parse(readFileSync(file, "utf8")).walkDecls((decl) => {
        if (COLOUR_PROPERTY.test(decl.prop) && LITERAL.test(decl.value)) literal = true;
      });
      return literal;
    })
    .map((file) => file.split("/").pop()!.replace(/\.css$/, ""));
}
/** Regions still coloured by a component's inline literals. */
function pendingRegions(): string[] {
  return [...new Set(Object.entries(INLINE_SOURCES)
    .filter(([file]) => /["'`]#[0-9a-f]{3,8}["'`]/i.test(readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
    .map(([, region]) => region))];
}

type Finding = string;
/** Marks what pending files colour (data-theme-pending), then lists light fills and text below its
 * contrast minimum everywhere else. */
async function audit(page: Page, where: string) {
  const sheets = pendingSheets(), regions = pendingRegions();
  test.info().annotations.push({ type: "pending dark theme", description: `${where}: ${[...sheets.map((s) => `${s}.css`), ...regions].join(", ") || "none"}` });
  const allowed = LIGHT_IN_DARK.map((token) => palette.dark[token]);
  const result = await page.evaluate(({ sheets, regions, allowed }) => {
    const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black)\b/i;
    const COLOUR_PROPERTY = /color|background|border|outline|shadow|fill|stroke/;
    for (const old of document.querySelectorAll("[data-theme-pending]")) old.removeAttribute("data-theme-pending");
    const pending = new Set<Element>();
    const sheetName = (sheet: CSSStyleSheet) =>
      sheet.href ? sheet.href.split("/").pop()!.replace(/\?.*$/, "").replace(/(-[0-9a-f]{16,})?\.css$/, "") : "";
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) {
          if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
          continue;
        }
        const style = rule.style;
        let literal = false;
        for (let i = 0; i < style.length && !literal; i++)
          literal = COLOUR_PROPERTY.test(style[i]!) && LITERAL.test(style.getPropertyValue(style[i]!));
        if (!literal) continue;
        const selector = rule.selectorText.replace(/::?(before|after|placeholder|marker|selection|-webkit-[a-z-]+)\b/g, "");
        try {
          for (const element of document.querySelectorAll(selector)) pending.add(element);
        } catch {
          /* a selector the engine cannot query: nothing to mark */
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets))
      if (sheets.includes(sheetName(sheet))) visit(sheet.cssRules);
    for (const region of regions)
      for (const root of document.querySelectorAll(region)) {
        pending.add(root);
        for (const element of root.querySelectorAll("*")) pending.add(element);
      }
    for (const element of pending) element.setAttribute("data-theme-pending", "");

    type RGBA = [number, number, number, number];
    const parse = (value: string): RGBA | null => {
      let match = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(value);
      if (match) return [+match[1]!, +match[2]!, +match[3]!, match[4] === undefined ? 1 : +match[4]];
      match = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)$/.exec(value);
      if (match) return [+match[1]! * 255, +match[2]! * 255, +match[3]! * 255, match[4] === undefined ? 1 : +match[4]];
      return null;
    };
    const over = (top: RGBA, bottom: RGBA): RGBA => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      return [0, 1, 2].map((i) => (top[i]! * top[3] + bottom[i]! * bottom[3] * (1 - top[3])) / a).concat(a) as RGBA;
    };
    const luminance = ([r, g, b]: RGBA) => {
      const [R, G, B] = [r, g, b].map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!;
    };
    const contrast = (a: RGBA, b: RGBA) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const hex = ([r, g, b]: RGBA) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
    const describe = (element: Element) => {
      const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? ` class="${element.className.split(" ").slice(0, 2).join(" ")}"` : ""}> "${label}"`;
    };
    const shown = (element: Element) => {
      if (element.closest("[hidden], svg, video, canvas, iframe, img, picture")) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && parseFloat(style.opacity) > 0.05;
    };
    const page = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
    /** The colour behind an element: its own and its ancestors' fills, composited over the page. */
    const backdrop = (element: Element): RGBA | null => {
      const layers: RGBA[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") return null;
        const fill = parse(style.backgroundColor);
        if (fill && fill[3] > 0) {
          layers.push(fill);
          if (fill[3] >= 1) break;
        }
      }
      return layers.reduceRight<RGBA>((below, layer) => over(layer, below), page);
    };
    const lightFills: string[] = [], lowContrast: string[] = [];
    const allowedFills = new Set(allowed.map((value) => value.toUpperCase()));
    for (const element of document.querySelectorAll("body *")) {
      if (pending.has(element) || !shown(element)) continue;
      const fill = parse(getComputedStyle(element).backgroundColor);
      if (fill && fill[3] >= 0.5 && luminance(fill) > 0.4 && !allowedFills.has(hex(fill)))
        lightFills.push(`${describe(element)} fill ${hex(fill)}`);
    }
    for (const element of document.querySelectorAll("body *")) {
      if (!shown(element) || element.closest("[data-theme-pending]")) continue;
      const text = Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const style = getComputedStyle(element);
      if (style.clipPath !== "none" || style.clip.startsWith("rect")) continue;
      const behind = backdrop(element);
      const ink = parse(style.color);
      if (!behind || !ink) continue;
      const drawn = over(ink, behind);
      const size = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700;
      const minimum = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const ratio = contrast(drawn, behind);
      if (ratio < minimum - 0.005)
        lowContrast.push(`${describe(element)} ${hex(drawn)} on ${hex(behind)} ${ratio.toFixed(2)}:1`);
    }
    return {
      lightFills,
      lowContrast,
      page: [document.documentElement, document.body, document.querySelector(".connected-host")!].map((node) => getComputedStyle(node).backgroundColor),
    };
  }, { sheets, regions, allowed });
  // The page itself is the dark --page, from the root down (TOK-2).
  expect(result.page, `${where}: page background`).toEqual(Array(3).fill("rgb(15, 21, 23)"));
  expect(result.lightFills, `${where}: light fills`).toEqual([] as Finding[]);
  expect(result.lowContrast, `${where}: text contrast`).toEqual([] as Finding[]);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .exclude("[data-theme-pending]")
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `${where}: axe`).toEqual([]);
}

async function signIn(page: Page, session: string, locale: "en" | "he" = "en", data?: Record<string, unknown>) {
  const token = (await (await page.request.post(session, data ? { data } : undefined)).json()).token;
  await page.goto(`/?locale=${locale}#signin=${token}`);
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
}
/** From the library into the first lesson of an enrolled course. */
async function resumeLesson(page: Page, locale: "en" | "he", reading: RegExp) {
  const host = locale === "he" ? heHost : enHost;
  const resume = page.getByRole("button", { name: host["library.continue"], exact: true }).or(page.getByTestId("next-step").getByRole("button"));
  await expect(async () => {
    if (await resume.count()) await resume.first().click({ timeout: 2_000 });
    await expect(page.getByText(reading).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test("the course page, a lesson and its check are dark throughout, readable and axe clean", async ({ page }) => {
  await signIn(page, "/test/session");
  const course = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) });
  await expect(course).toBeVisible();
  await audit(page, "library");
  await course.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  const start = page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ });
  await expect(start).toBeVisible();
  await audit(page, "course page");
  await start.click();
  await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toBeVisible();
  await audit(page, "lesson");
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeVisible();
  await audit(page, "check");
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await audit(page, "check with an answer chosen");
  if (await page.locator(".connected-host.is-compact").count()) await closeCompanion(page);
  await page.locator(".connected-menu-toggle").click();
  await expect(page.locator(".connected-menu-panel")).toBeVisible();
  await audit(page, "account menu");
});

for (const locale of ["en", "he"] as const)
  test(`${locale}: the companion with a saved conversation is dark, docked or as a sheet, beside a dark lesson`, async ({ page }, info) => {
    if (locale === "en") await signIn(page, "/test/theme-session", "en", { conversation: true });
    else await signIn(page, "/test/hebrew-reading-session", "he", { conversation: true });
    await resumeLesson(page, locale, locale === "en" ? /no greater than any other member/ : /בשיעור הזה מחפשים/);
    const panel = await openCompanion(page);
    await expect(panel.locator("[data-message-id]").first()).toBeVisible();
    await audit(page, `${locale} companion`);
    // The desktop page with the lesson and the companion docked beside it (the Main-dark artboard).
    await page.screenshot({ path: info.outputPath(`companion-dark-${locale}.png`) });
    await closeCompanion(page, locale);
    await expect(companionPanel(page)).toBeHidden();
    await audit(page, `${locale} lesson after closing the companion`);
  });
