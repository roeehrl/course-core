import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Declaration, type Node, type Rule } from "postcss";
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

// Hebrew has no capitals, and letter-spacing pulls its words apart. A rule that sets a positive
// letter-spacing or a text-transform (tracked capitals for Latin script) needs each of its
// selectors again, with :lang(he), in a rule that sets letter-spacing: 0 and text-transform: none.
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
        !/^(0(px|em|rem)?|normal|-.*)$/.test(value)) ||
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
      ".a:lang(he) { letter-spacing: 0; }",
    ].join("\n");
    expect(hebrewTrackingProblems(css, "x.css")).toEqual([
      'x.css:1: ".a" sets letter-spacing: 1.5px without a ".a:lang(he)" reset',
      'x.css:1: ".a" sets text-transform: uppercase without a ".a:lang(he)" reset',
      'x.css:2: ".b span" sets letter-spacing: 0.08em without a ".b span:lang(he)" reset',
    ]);
    expect(
      hebrewTrackingProblems(
        `${css}\n.a:lang(he),\n.b span:lang(he) { letter-spacing: 0; text-transform: none; }`,
        "x.css",
      ),
    ).toEqual([]);
  });
});
