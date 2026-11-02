import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type AtRule, type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { TOKENS, palette, shadows, type ColorToken, type Theme } from "../src/theme/palette";
import { cssTime } from "../src/connected/ui/media";

// The design tokens (final design §1): every colour on :root, the dark values under both guards
// (TOK-2), the same values as the hex palette React Native uses, and every contrast pair of the
// colour table met in both themes.
const css = readFileSync(join(__dirname, "../src/connected/styles/tokens.css"), "utf8");
const root = postcss.parse(css);

/** The custom properties a rule with exactly this selector declares, inside the given at-rule params (or none). */
function declared(selector: string, atRule?: string): Map<string, string> {
  const values = new Map<string, string>();
  root.walkRules((rule: Rule) => {
    if (rule.selector !== selector) return;
    const parent = rule.parent?.type === "atrule" ? (rule.parent as AtRule) : undefined;
    if ((parent?.params ?? undefined) !== atRule) return;
    rule.walkDecls((decl) => {
      if (decl.prop.startsWith("--")) values.set(decl.prop, decl.value.trim());
    });
  });
  return values;
}

const light = declared(":root");
const darkMedia = declared(':root:not([data-theme="light"])', "(prefers-color-scheme: dark)");
const darkChosen = declared(':root[data-theme="dark"]');
const tokens = Object.keys(TOKENS) as ColorToken[];

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** The colour table's pairs: foreground, background, the ratio it states (light, dark) and the minimum it must keep. */
const PAIRS: [ColorToken, ColorToken, [number, number], number][] = [
  ["ink", "surface2", [12.24, 12.95], 4.5],
  ["inkMuted", "surface2", [5.19, 7.17], 4.5],
  ["ink", "surface", [13.55, 14.63], 4.5],
  ["ink", "page", [12.71, 15.62], 4.5],
  ["inkMuted", "surface", [5.75, 8.1], 4.5],
  ["inkMuted", "page", [5.39, 8.65], 4.5],
  ["inkMuted", "bubble", [5.11, 6.41], 4.5],
  ["lineStrong", "surface", [3.77, 3.93], 3],
  ["lineStrong", "page", [3.53, 4.19], 3],
  ["lineStrong", "surface2", [3.4, 3.48], 3],
  ["ink", "bubble", [12.05, 11.57], 4.5],
  ["accent", "surface", [5.19, 8.29], 4.5],
  ["accent", "page", [4.87, 8.85], 4.5],
  ["accent", "accentSoft", [4.65, 5.89], 4.5],
  ["onAccent", "accentHover", [7.08, 10.22], 4.5],
  ["onAccent", "accent", [5.19, 8.55], 4.5],
  ["ink", "accentSoft", [12.15, 10.4], 4.5],
  ["companion", "surface", [6.23, 7.61], 3],
  ["danger", "surface", [7.26, 8.04], 4.5],
  ["onDanger", "danger", [7.26, 8.29], 4.5],
  ["inkMuted", "sendOff", [4.7, 6.41], 3],
];

describe("design tokens", () => {
  it("declares every colour on :root and again under both dark guards", () => {
    for (const token of tokens) {
      const name = TOKENS[token];
      expect(light.get(name), name).toBeDefined();
      expect(darkMedia.get(name), `${name} (prefers dark)`).toBeDefined();
      expect(darkChosen.get(name), `${name} (data-theme="dark")`).toBeDefined();
    }
    // The two dark blocks are the same block.
    expect([...darkChosen]).toEqual([...darkMedia]);
  });

  it("matches the hex palette React Native uses, in both themes", () => {
    for (const token of tokens) {
      expect(light.get(TOKENS[token]), token).toBe(palette.light[token].toLowerCase());
      expect(darkMedia.get(TOKENS[token]), token).toBe(palette.dark[token].toLowerCase());
    }
    for (const kind of ["menu", "sheet", "jump"] as const) {
      expect(light.get(`--shadow-${kind}`)).toBe(shadows.light[kind]);
      expect(darkMedia.get(`--shadow-${kind}`)).toBe(shadows.dark[kind]);
    }
  });

  it.each(["light", "dark"] as Theme[])("keeps every contrast pair of the colour table in %s", (theme) => {
    const index = theme === "light" ? 0 : 1;
    for (const [fg, bg, stated, minimum] of PAIRS) {
      const ratio = contrast(palette[theme][fg], palette[theme][bg]);
      expect(ratio, `${fg} on ${bg}`).toBeGreaterThanOrEqual(minimum);
      expect(ratio, `${fg} on ${bg} as stated`).toBeCloseTo(stated[index]!, 1);
    }
    // The focus outline keeps 3:1 on every background it can sit on.
    for (const bg of ["page", "surface", "surface2", "bubble", "accentSoft"] as ColorToken[])
      expect(contrast(palette[theme].focus, palette[theme][bg]), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
    // Lesson warnings (gold on sand) keep 4.5:1 on their fill and on the surface.
    expect(contrast(palette[theme].warning, palette[theme].warningSoft)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette[theme].warning, palette[theme].surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette[theme].onStage, palette[theme].stage)).toBeGreaterThanOrEqual(4.5);
  });

  it("declares the type, spacing, radius, target, elevation and motion tokens", () => {
    for (const role of ["chat", "reading", "meta", "micro", "button", "chip", "heading", "title"])
      for (const suffix of ["", "-size", "-line"]) expect(light.get(`--text-${role}${suffix}`), `--text-${role}${suffix}`).toBeDefined();
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => light.get(`--space-${n}`))).toEqual(["4px", "8px", "12px", "16px", "24px", "32px", "48px"]);
    expect(light.get("--target-min")).toBe("24px");
    expect(light.get("--target-touch")).toBe("44px");
    expect(declared(":root", "(pointer: coarse)").get("--target")).toBe("var(--target-touch)");
    for (let m = 1; m <= 18; m++) {
      expect(light.get(`--motion-m${m}-duration`), `M${m}`).toMatch(/^\d+ms$/);
      expect(light.get(`--motion-m${m}-easing`), `M${m}`).toBeDefined();
    }
  });

  it("sets the Hebrew floor and no tracking for Hebrew", () => {
    const he = declared(":lang(he)");
    expect(he.get("--text-meta")).toBe("14px/22px");
    expect(he.get("--text-button")).toBe("15px/22px");
    expect(he.get("--text-chip")).toBe("15px/22px");
    expect(he.get("--text-tag")).toBe("13px/18px");
    expect(he.get("--text-title-tracking")).toBe("0");
  });

  it("makes every movement instant under reduced motion, except the sheet's fade and the held highlights", () => {
    const reduced = declared(":root", "(prefers-reduced-motion: reduce)");
    for (const m of [1, 3, 4, 7, 8, 9, 10, 11, 13, 17, 18]) expect(reduced.get(`--motion-m${m}-duration`), `M${m}`).toBe("0ms");
    expect(reduced.get("--motion-m12-duration")).toBe("150ms");
    expect(reduced.get("--motion-m14-fade")).toBe("0ms");
    expect(reduced.get("--motion-m15-fade")).toBe("0ms");
    expect(reduced.get("--motion-m5-rest-opacity")).toBe("0.6");
  });

  it("reads a motion token's time in milliseconds as written and as the minified build writes it", () => {
    // The built stylesheet writes 150ms as .15s: read as 0.15 ms, every scripted motion was cut to a frame.
    expect(cssTime("150ms")).toBe(150);
    expect(cssTime(".15s")).toBe(150);
    expect(cssTime(" 0.3s")).toBe(300);
    expect(cssTime("0ms")).toBe(0);
    expect(cssTime("")).toBeUndefined();
    expect(cssTime("ease")).toBeUndefined();
    const motion = declared(":root");
    for (const m of [9, 10, 11, 12]) expect(cssTime(motion.get(`--motion-m${m}-duration`)!), `M${m}`).toBeGreaterThanOrEqual(100);
  });
});
