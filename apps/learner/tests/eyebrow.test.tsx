import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Eyebrow } from "../src/components/ui";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";

/** The label above a heading: tracked capitals in Latin script, normal spacing in Hebrew. */
const inLocale = (locale: "en" | "he" | "en-XA", node: React.ReactNode) =>
  render(
    <I18nProvider value={createLearnerTranslator(locale)}>{node}</I18nProvider>,
  );

describe("Eyebrow", () => {
  it("sets an English label in tracked capitals, also under the pseudo-locale", () => {
    inLocale("en", <Eyebrow>Your place in the course</Eyebrow>);
    inLocale("en-XA", <Eyebrow>Pseudo label</Eyebrow>);
    for (const text of ["Your place in the course", "Pseudo label"]) {
      const style = getComputedStyle(screen.getByText(text));
      expect(style.letterSpacing, text).toBe("1.7px");
      expect(style.textTransform, text).toBe("uppercase");
    }
  });

  it("keeps a Hebrew interface's labels untracked, even for Latin course text", () => {
    inLocale("he", <Eyebrow>המקום שלך בקורס</Eyebrow>);
    inLocale("he", <Eyebrow>Sorting basics</Eyebrow>);
    for (const text of ["המקום שלך בקורס", "Sorting basics"]) {
      const style = getComputedStyle(screen.getByText(text));
      expect(style.letterSpacing, text).not.toBe("1.7px");
      expect(style.textTransform, text).not.toBe("uppercase");
    }
  });

  it("keeps a Hebrew label (course text) untracked in an English interface", () => {
    inLocale("en", <Eyebrow>חלק {1} מתוך 3</Eyebrow>);
    const style = getComputedStyle(screen.getByText("חלק 1 מתוך 3"));
    expect(style.letterSpacing).not.toBe("1.7px");
    expect(style.textTransform).not.toBe("uppercase");
  });

  it("keeps the caller's own style on top", () => {
    inLocale(
      "en",
      <Eyebrow style={{ color: "rgb(1, 2, 3)" }}>Diagram</Eyebrow>,
    );
    const style = getComputedStyle(screen.getByText("Diagram"));
    expect(style.color).toBe("rgb(1, 2, 3)");
    expect(style.textTransform).toBe("uppercase");
  });
});
