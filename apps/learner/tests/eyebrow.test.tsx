import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Eyebrow } from "../src/components/ui";
import { createLearnerTranslator, I18nProvider } from "../src/i18n";

/** The label above a heading: sentence case and no tracking in every script (final design §1.2,
 * COPY-9), with the 14 px Hebrew floor for text that carries meaning. */
const inLocale = (locale: "en" | "he" | "en-XA", node: React.ReactNode) =>
  render(
    <I18nProvider value={createLearnerTranslator(locale)}>{node}</I18nProvider>,
  );
const tracking = (style: CSSStyleDeclaration) =>
  style.letterSpacing === "" || style.letterSpacing === "normal" ? 0 : parseFloat(style.letterSpacing);

describe("Eyebrow", () => {
  it("sets an English label in sentence case without tracking, also under the pseudo-locale", () => {
    inLocale("en", <Eyebrow>Your place in the course</Eyebrow>);
    inLocale("en-XA", <Eyebrow>Pseudo label</Eyebrow>);
    for (const text of ["Your place in the course", "Pseudo label"]) {
      const style = getComputedStyle(screen.getByText(text));
      expect(tracking(style), text).toBe(0);
      expect(style.textTransform, text).not.toBe("uppercase");
      expect(style.fontSize, text).toBe("13px");
    }
  });

  it("keeps a Hebrew interface's labels untracked at the 14 px floor, even for Latin course text", () => {
    inLocale("he", <Eyebrow>המקום שלך בקורס</Eyebrow>);
    inLocale("he", <Eyebrow>Sorting basics</Eyebrow>);
    for (const text of ["המקום שלך בקורס", "Sorting basics"]) {
      const style = getComputedStyle(screen.getByText(text));
      expect(tracking(style), text).toBe(0);
      expect(style.textTransform, text).not.toBe("uppercase");
      expect(style.fontSize, text).toBe("14px");
    }
  });

  it("keeps a Hebrew label (course text) untracked at the 14 px floor in an English interface", () => {
    inLocale("en", <Eyebrow>חלק {1} מתוך 3</Eyebrow>);
    const style = getComputedStyle(screen.getByText("חלק 1 מתוך 3"));
    expect(tracking(style)).toBe(0);
    expect(style.textTransform).not.toBe("uppercase");
    expect(style.fontSize).toBe("14px");
  });

  it("keeps the caller's own style on top", () => {
    inLocale(
      "en",
      <Eyebrow style={{ color: "rgb(1, 2, 3)", fontSize: 15 }}>Diagram</Eyebrow>,
    );
    const style = getComputedStyle(screen.getByText("Diagram"));
    expect(style.color).toBe("rgb(1, 2, 3)");
    expect(style.fontSize).toBe("15px");
    expect(style.textTransform).not.toBe("uppercase");
  });
});
