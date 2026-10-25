import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type InlineConfig } from "vite";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The production build minifies CSS with Lightning CSS for the browsers in vite.config.ts
 * (`build.cssTarget`). For a target without :dir() it rewrites `:dir(rtl)` into a list of
 * right-to-left `:lang()` values, which follows the language rather than the direction: wrong
 * for mixed content and dir="auto" fields. These tests build through the app's own Vite config
 * and check the emitted CSS.
 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "admin-css-build-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const probe = join(scratch, "direction-probe.css");
writeFileSync(
  probe,
  [
    ".probe-start:dir(rtl) { transform: scaleX(-1); }",
    ".probe-end:dir(ltr) { transform: rotate(90deg); }",
    '[dir="rtl"] .probe-page { transform: scaleX(-1); }',
  ].join("\n"),
);

type Output = {
  output: { type: string; fileName: string; source?: string | Uint8Array }[];
};
/** Builds CSS entries with vite.config.ts (plus overrides) and returns the emitted CSS. */
async function emittedCss(
  entries: string[],
  overrides: InlineConfig["build"] = {},
): Promise<string> {
  const result = (await build({
    configFile: join(appRoot, "vite.config.ts"),
    root: appRoot,
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: entries }, ...overrides },
  })) as Output | Output[];
  const css = (Array.isArray(result) ? result : [result])
    .flatMap((bundle) => bundle.output)
    .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
    .map((file) => String(file.source));
  expect(css.length).toBeGreaterThan(0);
  return css.join("\n");
}
/** Direction selectors written in source CSS (an attribute or :dir()). */
const directionSelectors = (css: string) =>
  css.match(/\[dir=("?)(rtl|ltr)\1\]|:dir\((rtl|ltr)\)/g) ?? [];
/** Lightning CSS's rewrite of :dir(rtl): Arabic, Hebrew and the other RTL languages. */
const RTL_LANGUAGE_LIST = /:lang\(ar\)|:lang\(ae\)/;

describe("the production CSS build keeps direction selectors", () => {
  it("keeps :dir() and [dir] selectors for the configured browsers", async () => {
    const css = await emittedCss([probe]);
    expect(css).toContain(".probe-start:dir(rtl)");
    expect(css).toContain(".probe-end:dir(ltr)");
    expect(css).toMatch(/\[dir=rtl\] \.probe-page/);
    expect(css).not.toMatch(RTL_LANGUAGE_LIST);
  });

  it("would catch a browser target that rewrites :dir() into :lang()", async () => {
    // Vite's default CSS target (Chrome 111) predates :dir(): the same probe loses it.
    const css = await emittedCss([probe], { cssTarget: ["chrome111"] });
    expect(css).not.toContain(":dir(");
    expect(css).toMatch(RTL_LANGUAGE_LIST);
  });

  it("emits every direction selector of the app's stylesheets", async () => {
    const sources = [
      "src/styles.css",
      "src/components/aiServices/aiServices.css",
      "src/components/inspector.css",
    ].map((file) => join(appRoot, file));
    const written = sources.flatMap((file) =>
      directionSelectors(
        readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
      ),
    );
    expect(written.length).toBeGreaterThan(0);
    const css = await emittedCss(sources);
    expect(directionSelectors(css)).toHaveLength(written.length);
    expect(css).not.toMatch(RTL_LANGUAGE_LIST);
  });
});
