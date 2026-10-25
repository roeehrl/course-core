import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The web export (Expo/Metro) compiles CSS with Lightning CSS for the browsers in package.json
 * `browserslist`. For a target without :dir() it rewrites `:dir(rtl)` into a list of
 * right-to-left `:lang()` values, which follows the language rather than the direction: a
 * disclosure inside left-to-right content on a Hebrew page, or in a dir="auto" block, would get
 * the right-to-left chevron. The targets therefore leave out browsers without :dir().
 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The modules Expo's CSS transform worker itself loads.
const fromExpo = createRequire(
  createRequire(join(appRoot, "package.json")).resolve("expo/package.json"),
);
const fromMetroConfig = createRequire(
  fromExpo.resolve("@expo/metro-config/package.json"),
);
const { getBrowserslistTargets } = fromMetroConfig(
  "./build/transform-worker/browserslist",
) as { getBrowserslistTargets(root: string): Promise<object> };
const lightningcss = fromMetroConfig("lightningcss") as {
  transform(options: object): { code: Uint8Array };
  browserslistToTargets(list: string[]): object;
};
const browserslist = fromMetroConfig("browserslist") as (
  query?: string,
) => string[];

const PROBE = [
  ".host details > summary:dir(rtl)::before { transform: rotate(135deg); }",
  '[dir="rtl"] .flip { transform: scaleX(-1); }',
].join("\n");
/** The options Expo's transform worker passes for a global stylesheet. */
const compile = (targets: object) =>
  String(
    lightningcss.transform({
      filename: "probe.css",
      code: Buffer.from(PROBE),
      errorRecovery: true,
      minify: true,
      targets,
      include: 1, // Nesting
    }).code,
  );
/** Direction selectors written in source CSS (an attribute or :dir()). */
const directionSelectors = (css: string) =>
  css.match(/\[dir=("?)(rtl|ltr)\1\]|:dir\((rtl|ltr)\)/g) ?? [];
/** Lightning CSS's rewrite of :dir(rtl): Arabic, Hebrew and the other RTL languages. */
const RTL_LANGUAGE_LIST = /:lang\(ar\)|:lang\(ae\)/;

describe("the web export keeps direction selectors", () => {
  it("compiles :dir() unchanged for the app's browser targets", async () => {
    const css = compile(await getBrowserslistTargets(appRoot));
    expect(css).toContain("summary:dir(rtl):before");
    expect(css).toContain("[dir=rtl] .flip");
    expect(css).not.toMatch(RTL_LANGUAGE_LIST);
  });

  it("would catch browser targets that rewrite :dir() into :lang()", () => {
    // browserslist's defaults (what Expo uses without a browserslist) include browsers
    // without :dir().
    const css = compile(
      lightningcss.browserslistToTargets(browserslist("defaults")),
    );
    expect(css).not.toContain(":dir(");
    expect(css).toMatch(RTL_LANGUAGE_LIST);
  });

  it("emits every direction selector of the connected stylesheet in the production export", () => {
    // The root check exports the app (npm run export:web) before it runs these tests.
    const folder = join(appRoot, "dist/_expo/static/css");
    expect(
      existsSync(folder),
      "no web export: run npm run export:web first",
    ).toBe(true);
    const source = readFileSync(
      join(appRoot, "src/connected/connected.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const exported = readdirSync(folder)
      .filter((file) => file.startsWith("connected-") && file.endsWith(".css"))
      .map((file) => readFileSync(join(folder, file), "utf8"));
    expect(exported).toHaveLength(1);
    const css = exported[0]!;
    expect(
      directionSelectors(source).filter((s) => s.startsWith(":dir")),
    ).not.toHaveLength(0);
    expect(directionSelectors(css)).toHaveLength(
      directionSelectors(source).length,
    );
    expect(css).toContain("summary:dir(rtl):before");
    expect(css).not.toMatch(RTL_LANGUAGE_LIST);
  });
});
