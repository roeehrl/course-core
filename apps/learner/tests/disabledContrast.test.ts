import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { DISABLED_TOKENS } from "../src/components/ui";
import { TOKENS, palette, type ColorToken, type Theme } from "../src/theme/palette";

// Disabled buttons on the lesson page used to fade with opacity, which left their labels at 2 to
// 2.8:1 (white on pale teal, teal on the page). They now keep muted colours with a label contrast
// of at least 4.5:1 (WCAG 1.4.3 does not require it of disabled controls; the owner does), in the
// light and the dark theme. Colours are read from the hex palette (src/theme/palette.ts), which
// tokens.css declares as custom properties (tests/tokens.test.ts keeps the two equal).
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const THEMES: Theme[] = ["light", "dark"];
/** Every background a disabled button sits on: the page, cards and menus, the second surface
 * (banners, chips, the former lilac cards), the info and warning notices. */
const BACKGROUNDS: ColorToken[] = ["page", "surface", "surface2", "accentSoft", "warningSoft"];
const BY_PROPERTY = Object.fromEntries(Object.entries(TOKENS).map(([key, property]) => [property, key as ColorToken]));

/** A label colour as each theme draws it: a token resolves through the palette, a literal is the
 * same in both. */
function resolve(value: string): Record<Theme, string> {
  const token = /^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1];
  if (!token) return { light: value, dark: value };
  const key = BY_PROPERTY[token];
  if (!key) throw new Error(`${value} is not a colour token`);
  return { light: palette.light[key], dark: palette.dark[key] };
}

describe("disabled buttons", () => {
  it("keep a label contrast of at least 4.5:1 on their fill and on every background they sit on", () => {
    for (const theme of THEMES) {
      const colour = palette[theme];
      expect(contrast(colour[DISABLED_TOKENS.onFill], colour[DISABLED_TOKENS.fill]), theme).toBeGreaterThanOrEqual(4.5);
      for (const background of BACKGROUNDS)
        expect(contrast(colour[DISABLED_TOKENS.text], colour[background]), `${theme} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("are never faded with opacity, and every label colour a disabled rule sets keeps 4.5:1", () => {
    // Every stylesheet of the app: rules moved out of connected.css stay covered.
    const css = stylesheets(join(__dirname, "../src")).map((file) => readFileSync(file, "utf8"));
    expect(css.length).toBeGreaterThan(1);
    const faded: string[] = [], labels = new Set<string>(), unfilled = new Set<string>();
    /** Label colours of rules that paint their own fill under the label, with that fill. */
    const painted = new Map<string, Set<string>>();
    const COLOUR = /^(#[0-9a-f]{6}|var\(--[a-z0-9-]+\))$/i;
    for (const sheet of css) postcss.parse(sheet).walkRules((rule: Rule) => {
      if (!rule.selector.includes(":disabled")) return;
      rule.walkDecls("opacity", (decl) => { if (Number(decl.value) < 1) faded.push(`${rule.selector} { opacity: ${decl.value} }`); });
      let fill: string | undefined;
      rule.walkDecls(/^background(-color)?$/, (decl) => { if (COLOUR.test(decl.value)) fill = decl.value.toLowerCase(); });
      rule.walkDecls("color", (decl) => {
        if (!COLOUR.test(decl.value)) return;
        const label = decl.value.toLowerCase();
        labels.add(label);
        // A rule that keeps a solid fill while disabled (Check stays accent while the grader
        // works) draws its label on that fill only.
        if (fill) painted.set(label, (painted.get(label) ?? new Set()).add(fill));
        else unfilled.add(label);
      });
    });
    // The account dialogs (.connected-portal) included: a disabled button there faded to about 2:1.
    expect(faded).toEqual([]);
    // The app's own disabled labels are the muted-ink token; the base stylesheet sets no other.
    expect(labels).toContain(`var(${TOKENS[DISABLED_TOKENS.text]})`);
    // A label colour may end up on the disabled fill as well as on a page background (the
    // companion's disabled Send read #56706b on #dfe9e5, 4.31:1, in the 0.1.60 qualification).
    for (const label of labels) {
      const drawn = resolve(label);
      for (const theme of THEMES) {
        // A literal colour is written for the light theme; a token is checked in both.
        if (!label.startsWith("var(") && theme === "dark") continue;
        if (unfilled.has(label))
          for (const background of [DISABLED_TOKENS.fill, ...BACKGROUNDS])
            expect(contrast(drawn[theme], palette[theme][background]), `${label} on ${background} (${theme})`).toBeGreaterThanOrEqual(4.5);
        for (const fill of painted.get(label) ?? [])
          expect(contrast(drawn[theme], resolve(fill)[theme]), `${label} on ${fill} (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}
