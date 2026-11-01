import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { TOKENS } from "../src/theme/palette";

/* The base app takes every colour from the design tokens (final design §1, TOK-1), so it follows
 * the dark theme with the AI surfaces instead of staying light around them. Forced-colours rules
 * name system colours (CanvasText, Highlight), which are not literals. */
const app = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
const LITERAL = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(|\b(white|black)\b/i;
const COLOUR_PROPERTY = /color|background|border|outline|shadow|fill|stroke|accent/;

describe("the base stylesheet", () => {
  const css = postcss.parse(app("src/connected/connected.css"));

  it("colours nothing with a literal: every colour is a token or mixed from tokens", () => {
    const literals: string[] = [];
    css.walkDecls((decl: Declaration) => {
      if (COLOUR_PROPERTY.test(decl.prop) && LITERAL.test(decl.value)) literals.push(`${decl.parent && "selector" in decl.parent ? decl.parent.selector : ""} { ${decl.prop}: ${decl.value} }`);
    });
    expect(literals).toEqual([]);
  });

  it("names only tokens that tokens.css declares, or its own mixes", () => {
    const declared = new Set<string>(Object.values(TOKENS));
    const tokens = app("src/connected/styles/tokens.css");
    for (const match of tokens.matchAll(/(--[a-z0-9-]+):/g)) declared.add(match[1]!);
    css.walkDecls((decl: Declaration) => {
      if (decl.prop.startsWith("--")) declared.add(decl.prop);
    });
    // Properties set from the page at run time (header height, keyboard inset, the sheet's padding).
    const runtime = new Set(["--connected-header-height", "--keyboard-inset", "--sheet-pad-end", "--disclosure-inset", "--disclosure-forced-gap"]);
    const unknown = new Set<string>();
    css.walkDecls((decl: Declaration) => {
      for (const match of decl.value.matchAll(/var\((--[a-z0-9-]+)/g))
        if (!declared.has(match[1]!) && !runtime.has(match[1]!)) unknown.add(match[1]!);
    });
    expect([...unknown]).toEqual([]);
  });

  it("gives the root, the body and the host the page background", () => {
    const backgrounds = new Map<string, string>();
    css.walkRules((rule) => {
      rule.walkDecls("background", (decl) => {
        for (const selector of rule.selectors) backgrounds.set(selector.replace(/\s+/g, " "), decl.value);
      });
    });
    expect(backgrounds.get("html:has(.connected-host)")).toBe("var(--page)");
    expect(backgrounds.get("html:has(.connected-host) body")).toBe("var(--page)");
    expect(backgrounds.get(".connected-host")).toBe("var(--page)");
  });

  it("draws focus as a 2 px --focus outline, and as the system highlight in forced colours", () => {
    const rings: string[] = [];
    css.walkRules((rule) => {
      if (!rule.selector.includes(":focus-visible")) return;
      const forced = rule.parent?.type === "atrule" && (rule.parent as AtRule).params.includes("forced-colors");
      rule.walkDecls(/^outline$/, (decl) => {
        rings.push(`${forced ? "forced " : ""}${decl.value.replace(/ !important$/, "")}`);
      });
      rule.walkDecls(/^box-shadow$/, () => {
        rings.push(`${rule.selector}: box-shadow`);
      });
    });
    expect(rings.length).toBeGreaterThan(3);
    for (const ring of rings) expect(ring).toMatch(/^(2px solid var\(--focus\)|forced 3px solid Highlight)$/);
  });

  it("sets the small labels above headings as sentence-case meta text, never tracked capitals", () => {
    const labels = [".connected-lesson-where", ".connected-part-top", ".connected-eyebrow", ".connected-menu-heading", ".connected-sources p"];
    const found = new Map<string, Map<string, string>>();
    css.walkRules((rule) => {
      for (const selector of rule.selectors.map((s) => s.trim()).filter((s) => labels.includes(s))) {
        const decls = found.get(selector) ?? new Map<string, string>();
        rule.walkDecls((decl) => void decls.set(decl.prop, decl.value.replace(/ !important$/, "")));
        found.set(selector, decls);
      }
    });
    for (const label of labels) {
      const decls = found.get(label);
      expect(decls, label).toBeDefined();
      expect(decls!.get("font-size"), label).toBe("var(--text-meta-size)");
      expect(decls!.get("color"), label).toBe("var(--ink-muted)");
      expect(decls!.has("text-transform"), label).toBe(false);
      expect(decls!.has("letter-spacing"), label).toBe(false);
    }
  });

  it("declares its own colour mixes wherever its rules apply: the host and dialogs portalled out of it", () => {
    const owners = new Map<string, string[]>();
    css.walkDecls(/^--connected-/, (decl) => {
      const selectors = decl.parent && "selectors" in decl.parent ? (decl.parent as Rule).selectors.map((s) => s.trim()) : [];
      owners.set(decl.prop, selectors);
    });
    expect(owners.size).toBeGreaterThan(0);
    for (const [property, selectors] of owners) expect(selectors, property).toEqual(expect.arrayContaining([".connected-host", ".connected-portal"]));
  });

  it("keeps its cards, notices and menus edged in forced colours", () => {
    const edged = new Set<string>();
    css.walkAtRules("media", (media) => {
      if (!media.params.includes("forced-colors")) return;
      media.walkRules((rule) => {
        if (rule.nodes.some((node) => node.type === "decl" && /^border(-color)?$/.test(node.prop) && /CanvasText/.test(node.value)))
          for (const selector of rule.selectors) edged.add(selector.trim());
      });
    });
    for (const surface of [".connected-reading-card", ".connected-menu-panel", ".connected-signin", ".connected-activity", ".connected-policy-panel", ".connected-recovery", ".connected-form-error", ".connected-toast", ".connected-practice-output"])
      expect(edged, surface).toContain(surface);
  });
});

describe("the base components", () => {
  it.each([
    "src/components/ui.tsx",
    "src/components/Overlay.tsx",
    "src/components/Overlay.web.tsx",
    "src/components/InlineReference.web.tsx",
    "src/components/LessonFlow.tsx",
  ])("%s takes its colours from the theme, with no colour literal", (file) => {
    const source = app(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(source.match(/["'`]#[0-9a-f]{3,8}["'`]|#[0-9a-f]{6}\b|\brgba?\(/gi) ?? []).toEqual([]);
  });
});
