import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { DISABLED, colors } from "../src/components/ui";

// Disabled buttons on the lesson page used to fade with opacity, which left their labels at 2 to
// 2.8:1 (white on pale teal, teal on the page). They now keep muted colours with a label contrast
// of at least 4.5:1 (WCAG 1.4.3 does not require it of disabled controls; the owner does).
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("disabled buttons", () => {
  it("keep a label contrast of at least 4.5:1 on their fill and on every background they sit on", () => {
    expect(contrast(DISABLED.onFill, DISABLED.fill)).toBeGreaterThanOrEqual(4.5);
    for (const background of [colors.white, colors.paper, colors.mint, colors.lilac, colors.sand])
      expect(contrast(DISABLED.text, background), `on ${background}`).toBeGreaterThanOrEqual(4.5);
  });

  it("are never faded with opacity on the lesson page", () => {
    const css = readFileSync(join(__dirname, "../src/connected/connected.css"), "utf8");
    const faded: string[] = [];
    postcss.parse(css).walkRules((rule: Rule) => {
      if (!rule.selector.includes(":disabled")) return;
      // The account dialogs' own sheet (.connected-portal) is outside the lesson page.
      if (rule.selectors.every((selector) => selector.includes(".connected-portal"))) return;
      rule.walkDecls("opacity", (decl) => { if (Number(decl.value) < 1) faded.push(`${rule.selector} { opacity: ${decl.value} }`); });
    });
    expect(faded).toEqual([]);
    // Each colour a disabled rule sets for a label keeps 4.5:1 on the fill or the page it is on.
    for (const label of ["#56706b", "#3f5a55"]) expect(css).toContain(label);
    expect(contrast("#3f5a55", "#dfe9e5")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#56706b", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#56706b", "#f8f8f2")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#56706b", "#e8f6ed")).toBeGreaterThanOrEqual(4.5);
  });
});
