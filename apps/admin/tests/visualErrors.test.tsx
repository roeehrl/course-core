import React from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  catalogText,
  englishErrorMessages,
} from "@course-core/visuals/headless";
import { useVisualMessages } from "../src/components/visualMessages";
import { I18nProvider, createAdminTranslator } from "../src/i18n";
import en from "../src/i18n/messages/en/visualErrors.json";

const inLocale = (locale: Parameters<typeof createAdminTranslator>[0]) =>
  renderHook(() => useVisualMessages(), {
    wrapper: ({ children }) => (
      <I18nProvider value={createAdminTranslator(locale)}>
        {children}
      </I18nProvider>
    ),
  }).result.current.messages.describeError!;

describe("visuals errors in the UI language (visuals 0.5.2 catalog keys)", () => {
  it("has every visuals error key, and its English matches the visuals' own English", () => {
    const keys = Object.keys(englishErrorMessages);
    expect(Object.keys(en).sort()).toEqual(
      keys.map((k) => `error.${k}`).sort(),
    );
    const describe = inLocale("en");
    for (const key of keys) {
      const message = (en as Record<string, string>)[`error.${key}`]!;
      // Each parameter stands in as its own name, so the two texts must line up exactly.
      const params = Object.fromEntries(
        [...message.replace(/'[{}<]'/g, "").matchAll(/(?<!')\{(\w+)\}/g)].map(
          (m) => [m[1]!, `<${m[1]}>`],
        ),
      );
      const english = (
        englishErrorMessages as Record<string, (p: object) => string>
      )[key]!(params);
      expect(describe({ message: english, key, params }), key).toBe(english);
    }
  });

  it("words a catalog error in Hebrew with its parameters, and falls back to the English message", () => {
    const describe = inLocale("he");
    expect(describe(catalogText("imageUnknown", { image: "tile" }))).toMatch(
      /^תמונה לא מוכרת: \u2068?tile\u2069?$/,
    );
    expect(describe(catalogText("equationExpectedBrace"))).toBe(
      "משוואה: נדרש {",
    );
    expect(describe({ message: "Older error text" })).toBe("Older error text");
    expect(describe({ message: "Newer error", key: "notInThisApp" })).toBe(
      "Newer error",
    );
  });
});
