import { describe, expect, it } from "vitest";
import { colors as webColors } from "../src/theme/colors.web";
import { TOKENS, palette } from "../src/theme/palette";

// One palette, two renderings: web styles name the CSS custom property (so they follow the page's
// theme), React Native styles get the hex value.
describe("theme colours", () => {
  it("are CSS variables on the web, one per token", () => {
    expect(Object.keys(webColors).sort()).toEqual(Object.keys(TOKENS).sort());
    for (const [key, value] of Object.entries(webColors))
      expect(value).toBe(`var(${TOKENS[key as keyof typeof TOKENS]})`);
  });

  it("are the palette's hex values in React Native", async () => {
    // The web project resolves `colors` to `colors.web`; load the native module by its file.
    const nativePath = "../src/theme/colors.ts";
    const { colors } = (await import(/* @vite-ignore */ nativePath)) as { colors: Record<string, string> };
    expect(colors).toEqual(palette.light);
    for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9A-F]{6}([0-9A-F]{2})?$/);
  });
});
