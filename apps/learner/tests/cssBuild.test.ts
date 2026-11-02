import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
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

  it("emits every learner stylesheet, with every direction selector, in the production export", () => {
    // The root check exports the app (npm run export:web) before it runs these tests.
    const folder = join(appRoot, "dist/_expo/static/css");
    expect(
      existsSync(folder),
      "no web export: run npm run export:web first",
    ).toBe(true);
    const files = readdirSync(folder).filter((file) => file.endsWith(".css"));
    const sheets = stylesheets(join(appRoot, "src"));
    // The export names each stylesheet <basename>-<hash>.css, so two sources may not share one.
    const names = sheets.map((sheet) => basename(sheet, ".css"));
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["connected", "tokens", "primitives", "layout", "companion", "companion-actions"]));
    for (const sheet of sheets) {
      const name = basename(sheet, ".css");
      const source = readFileSync(sheet, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // Exact basename: companion-<hash> is not companion-actions-<hash>.
      const exported = files
        .filter((file) => new RegExp(`^${name}-[0-9a-f]{32}\\.css$`).test(file))
        .map((file) => readFileSync(join(folder, file), "utf8"));
      expect(exported, `${name}.css in the export`).toHaveLength(1);
      expect(directionSelectors(exported[0]!), name).toHaveLength(
        directionSelectors(source).length,
      );
      expect(exported[0], name).not.toMatch(RTL_LANGUAGE_LIST);
    }
    const connected = readFileSync(
      join(appRoot, "src/connected/connected.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      directionSelectors(connected).filter((s) => s.startsWith(":dir")),
    ).not.toHaveLength(0);
    const css = readFileSync(
      join(folder, files.find((file) => /^connected-[0-9a-f]{32}\.css$/.test(file))!),
      "utf8",
    );
    expect(css).toContain("summary:dir(rtl):before");
  });
});

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}
