import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, {
  type AtRule,
  type Declaration,
  type Node,
  type Rule,
} from "postcss";
import { describe, expect, it } from "vitest";

// The stylesheets are written as flat CSS. A rule inside another rule is
// almost always a lost closing brace: the bundler then treats every later
// rule as nested under that selector and none of them match.
function cssStructureProblems(css: string, from: string): string[] {
  let root;
  try {
    root = postcss.parse(css, { from });
  } catch (error) {
    return [`${from}: does not parse: ${(error as Error).message}`];
  }
  const problems: string[] = [];
  const where = (node: Node) => `${from}:${node.source?.start?.line ?? "?"}`;
  root.walk((node) => {
    if (node.type === "decl" && node.parent?.type === "root") {
      problems.push(
        `${where(node)}: declaration "${node.prop}" outside any rule`,
      );
    }
    if (node.type !== "rule") return;
    const rule = node as Rule;
    for (
      let parent = rule.parent;
      parent && parent.type !== "root";
      parent = parent.parent
    ) {
      if (parent.type === "rule") {
        problems.push(
          `${where(rule)}: "${rule.selector}" is nested inside "${(parent as Rule).selector}" (missing "}"?)`,
        );
        break;
      }
    }
    if (!rule.nodes.some((child) => child.type !== "comment")) {
      problems.push(`${where(rule)}: "${rule.selector}" has an empty body`);
    }
  });
  return problems;
}

// Hebrew has no capitals, and letter-spacing pulls its words apart. A rule that sets a
// letter-spacing other than 0 or a text-transform (tracked capitals, or large headings drawn
// tighter, for Latin script) needs each of its selectors again, with :lang(he), in a rule that sets
// letter-spacing: 0 and text-transform: none. Negative tracking counts too (0.1.58 qualification:
// Hebrew headings were drawn at -1.2px and -0.35px). A selector that itself names a language
// (:lang(en) for the Latin product name) needs no reset.
function hebrewTrackingProblems(css: string, from: string): string[] {
  const root = postcss.parse(css, { from });
  const squash = (selector: string) => selector.replace(/\s+/g, " ").trim();
  const resets = new Set<string>();
  root.walkRules((rule) => {
    const value = (prop: string) =>
      rule.nodes
        .filter((n): n is Declaration => n.type === "decl" && n.prop === prop)
        .map((d) => d.value.trim());
    if (
      value("letter-spacing").some((v) => /^(0(px|em|rem)?|normal)$/.test(v)) &&
      value("text-transform").includes("none")
    )
      for (const selector of rule.selectors) resets.add(squash(selector));
  });
  const problems = new Set<string>();
  root.walkDecls((decl) => {
    const value = decl.value.trim();
    const latin =
      (decl.prop === "letter-spacing" &&
        !/^(0(px|em|rem)?|normal)$/.test(value)) ||
      (decl.prop === "text-transform" && value !== "none");
    if (!latin || decl.parent?.type !== "rule") return;
    for (const selector of (decl.parent as Rule).selectors) {
      if (selector.includes(":lang(")) continue;
      const reset = `${squash(selector)}:lang(he)`;
      if (!resets.has(reset))
        problems.add(
          `${from}:${decl.source?.start?.line ?? "?"}: "${squash(selector)}" sets ${decl.prop}: ${value} without a "${reset}" reset`,
        );
    }
  });
  return [...problems];
}

// A default for a kind of form control (a rule whose only condition is the element, apart from
// the app's host class) must not out-rank a component's rule for the same control. Its type and
// attribute conditions go inside :where(), leaving at most the bare element (or nothing, after
// the host class) and a state such as :focus-visible. Before, the admin's text-field rule
// (input:not([type="checkbox"]):not([type="radio"]), specificity 0,2,1) silently replaced the
// padding, border and size of .ai-field input (0,1,1). Rules with a combinator are structure,
// not defaults, and forced-colour and reduced-motion overrides are meant to win.
const STATES =
  /:(focus-visible|focus-within|focus|hover|active|disabled|enabled|checked|placeholder-shown|invalid|read-only)(?![\w-])/g;
const WHERE = /:where\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g;
const CONTROL = /(^|[\s(,])(input|select|textarea|button|summary|a)(?![\w-])/;
function outrankingFieldDefaults(
  css: string,
  from: string,
  { host = "", allowed = [] as string[] } = {},
): string[] {
  const root = postcss.parse(css, { from });
  const problems: string[] = [];
  root.walkRules((rule) => {
    const parent = rule.parent;
    if (
      parent?.type === "atrule" &&
      /forced-colors|prefers-reduced-motion/.test((parent as AtRule).params)
    )
      return;
    for (const raw of rule.selectors) {
      let selector = raw.replace(/\s+/g, " ").trim();
      if (host) {
        if (!selector.startsWith(`${host} `)) continue;
        selector = selector.slice(host.length + 1);
      }
      const outer = selector.replace(WHERE, "").replace(/\([^()]*\)/g, "()");
      if (/[\s>+~]/.test(outer) || /[.#]/.test(outer)) continue;
      if (!CONTROL.test(selector) || allowed.includes(selector)) continue;
      const bare = outer.replace(/::[a-z-]+/g, "").replace(STATES, "");
      // Under the host class even a bare element adds to the class: (0,1,1) beats (0,1,0).
      if (host ? bare !== "" : !/^[a-z]*$/.test(bare))
        problems.push(
          `${from}:${rule.source?.start?.line ?? "?"}: "${raw.replace(/\s+/g, " ")}" out-ranks component rules for the same control; put its conditions inside :where()`,
        );
    }
  });
  return problems;
}

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("admin stylesheet structure", () => {
  const files = stylesheets(join(appRoot, "src"));

  it("finds the stylesheets", () => {
    expect(files.map((file) => relative(appRoot, file))).toContain(
      join("src", "styles.css"),
    );
  });

  it.each(files.map((file) => [relative(appRoot, file), file]))(
    "%s has balanced, flat, non-empty rules",
    (name, file) => {
      expect(cssStructureProblems(readFileSync(file, "utf8"), name)).toEqual(
        [],
      );
    },
  );

  it("keeps the release, impact and overview lists as top-level styled rules", () => {
    const root = postcss.parse(
      readFileSync(join(appRoot, "src", "styles.css"), "utf8"),
    );
    for (const selector of [
      '.gate-outcome input[type="radio"]',
      ".release-diff",
      ".impact-list",
      ".impact-list li",
      ".overview-list",
      ".overview-list li",
      ".audit-payload",
    ]) {
      const rules = root.nodes.filter(
        (node): node is Rule =>
          node.type === "rule" && node.selector === selector,
      );
      expect(rules, selector).toHaveLength(1);
      expect(rules[0]!.nodes.length, selector).toBeGreaterThan(0);
    }
  });

  it("reports a missing closing brace that swallows later rules", () => {
    const css = `.a input {\n  margin: 0;\n/* later */\n.b {\n  color: red;\n}\n}\n`;
    expect(cssStructureProblems(css, "x.css")).toEqual([
      'x.css:4: ".b" is nested inside ".a input" (missing "}"?)',
    ]);
  });

  it("reports the broken merge shape: unclosed rule, headers without bodies", () => {
    const css = [
      '.gate input[type="radio"] {',
      "  margin: 0;",
      ".impact-list {",
      ".overview-list {",
      "  margin: 0;",
      "}",
      ".impact-list li {",
      ".overview-list li {",
      "  gap: 12px;",
      "}",
    ].join("\n");
    const problems = cssStructureProblems(css, "x.css");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not parse: .*Unclosed block/);
  });

  it("reports empty rules and stray declarations", () => {
    expect(
      cssStructureProblems(
        ".a {}\n.b { /* only a comment */ }\ncolor: red;\n",
        "x.css",
      ),
    ).toEqual([
      'x.css:1: ".a" has an empty body',
      'x.css:2: ".b" has an empty body',
      'x.css:3: declaration "color" outside any rule',
    ]);
  });

  it("allows rules inside media queries and other at-rules", () => {
    const css =
      "@media (max-width: 600px) { .a { margin: 0; } }\n@supports (display: grid) { .b { display: grid; } }\n";
    expect(cssStructureProblems(css, "x.css")).toEqual([]);
  });

  it("reports a rule nested in a rule even inside a media query", () => {
    const css =
      "@media (max-width: 600px) { .a { margin: 0; .b { color: red; } } }\n";
    expect(cssStructureProblems(css, "x.css")).toEqual([
      'x.css:1: ".b" is nested inside ".a" (missing "}"?)',
    ]);
  });

  it.each(files.map((file) => [relative(appRoot, file), file]))(
    "%s keeps Hebrew labels untracked and uncapitalized",
    (name, file) => {
      expect(hebrewTrackingProblems(readFileSync(file, "utf8"), name)).toEqual(
        [],
      );
    },
  );

  it("reports tracking or a case transform without a Hebrew reset", () => {
    const css = [
      ".a { letter-spacing: 1.5px; text-transform: uppercase; }",
      ".b span { letter-spacing: 0.08em; }",
      ".c { letter-spacing: -1px; text-transform: none; }",
      ".d :lang(en) { letter-spacing: -0.7px; }",
      ".a:lang(he) { letter-spacing: 0; }",
    ].join("\n");
    expect(hebrewTrackingProblems(css, "x.css")).toEqual([
      'x.css:1: ".a" sets letter-spacing: 1.5px without a ".a:lang(he)" reset',
      'x.css:1: ".a" sets text-transform: uppercase without a ".a:lang(he)" reset',
      'x.css:2: ".b span" sets letter-spacing: 0.08em without a ".b span:lang(he)" reset',
      'x.css:3: ".c" sets letter-spacing: -1px without a ".c:lang(he)" reset',
    ]);
    expect(
      hebrewTrackingProblems(
        `${css}\n.a:lang(he),\n.b span:lang(he),\n.c:lang(he) { letter-spacing: 0; text-transform: none; }`,
        "x.css",
      ),
    ).toEqual([]);
  });

  it.each(files.map((file) => [relative(appRoot, file), file]))(
    "%s keeps form-control defaults below component rules",
    (name, file) => {
      expect(
        outrankingFieldDefaults(readFileSync(file, "utf8"), name, {
          // Radio buttons and checkboxes keep their native size inside components whose rules
          // are written for text fields (.ai-field input): that guard is meant to win.
          allowed: ['input[type="checkbox"]', 'input[type="radio"]'],
        }),
      ).toEqual([]);
    },
  );

  it("reports a form-control default that out-ranks component rules", () => {
    const css = [
      'input:not([type="checkbox"]):not([type="radio"]), select { width: 100%; }',
      'input[type="search"] { padding: 0; }',
      'input:where(:not([type="checkbox"])), select, textarea { width: 100%; }',
      "button:disabled, input:focus-visible, textarea::placeholder { opacity: 1; }",
      ".a input, .b > select, button svg, :root { color: red; }",
    ].join("\n");
    expect(outrankingFieldDefaults(css, "x.css")).toEqual([
      'x.css:1: "input:not([type="checkbox"]):not([type="radio"])" out-ranks component rules for the same control; put its conditions inside :where()',
      'x.css:2: "input[type="search"]" out-ranks component rules for the same control; put its conditions inside :where()',
    ]);
  });
});
