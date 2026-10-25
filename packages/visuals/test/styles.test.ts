import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss, { type Declaration, type Rule } from "postcss";

// Hebrew has no capitals, and letter-spacing pulls its words apart. A rule that sets a
// letter-spacing other than 0 (tracked capitals, or a display heading drawn tighter, for Latin
// script) or a text-transform needs each of its selectors again, with :lang(he), in a rule that
// sets letter-spacing: 0 and text-transform: none. Negative tracking counts too: Hebrew letters
// set that close run into each other. The same check runs on the admin and learner stylesheets
// (their tests/cssStructure.test.ts).
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

test("the shipped stylesheet keeps Hebrew labels untracked and uncapitalized", () => {
  const css = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );
  assert.deepEqual(hebrewTrackingProblems(css, "src/styles.css"), []);
  // The labels the player sets in tracked capitals are among the checked rules.
  for (const selector of [
    ".ccv-eyebrow",
    ".ccv-heading h2",
    ".ccv-pane h3",
    ".ccv-controls legend",
  ])
    assert.ok(
      hebrewTrackingProblems(
        css.replace(`${selector}:lang(he)`, ".unrelated"),
        "x.css",
      ).length > 0,
      selector,
    );
});

test("reports tracking or a case transform without a Hebrew reset", () => {
  const css = [
    ".a { letter-spacing: 1.5px; text-transform: uppercase; }",
    ".b span { letter-spacing: 0.08em; }",
    ".c { letter-spacing: -1px; text-transform: none; }",
    ".a:lang(he) { letter-spacing: 0; }",
  ].join("\n");
  assert.deepEqual(hebrewTrackingProblems(css, "x.css"), [
    'x.css:1: ".a" sets letter-spacing: 1.5px without a ".a:lang(he)" reset',
    'x.css:1: ".a" sets text-transform: uppercase without a ".a:lang(he)" reset',
    'x.css:2: ".b span" sets letter-spacing: 0.08em without a ".b span:lang(he)" reset',
    'x.css:3: ".c" sets letter-spacing: -1px without a ".c:lang(he)" reset',
  ]);
  assert.deepEqual(
    hebrewTrackingProblems(
      `${css}\n.a:lang(he),\n.b span:lang(he),\n.c:lang(he) { letter-spacing: 0; text-transform: none; }`,
      "x.css",
    ),
    [],
  );
});
