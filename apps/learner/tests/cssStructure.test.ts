import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Node, type Rule } from "postcss";
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

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("learner stylesheet structure", () => {
  const files = stylesheets(join(appRoot, "src"));

  it("finds the stylesheets", () => {
    expect(files.map((file) => relative(appRoot, file))).toContain(
      join("src", "connected", "connected.css"),
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
});
