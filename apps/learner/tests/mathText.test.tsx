import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { mathAlternative, mathText, parseTex, splitMath } from "../src/components/mathText";
import { MarkdownContent } from "../src/components/MarkdownContent";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

const he = createLearnerTranslator("he");

describe("math text alternatives", () => {
  it("speaks common notation in words and shows readable text instead of TeX", () => {
    expect(mathAlternative("x^2 + y^2 = r^2")).toEqual({
      text: "x² + y² = r²",
      spoken: "x squared plus y squared equals r squared",
    });
    expect(mathAlternative("\\frac{a}{b}")).toEqual({
      text: "a/b",
      spoken: "the fraction a over b, end fraction",
    });
    expect(mathAlternative("\\frac{x+1}{2}").text).toBe("(x + 1)/2");
    expect(mathAlternative("\\sqrt{n} \\le n")).toMatchObject({
      spoken: "the square root of n, end root is less than or equal to n",
    });
    expect(mathAlternative("w_{t+1} = w_t - \\eta \\nabla L").spoken).toBe(
      "w sub t plus 1 equals w sub t minus eta nabla L",
    );
    expect(mathAlternative("w_{t+1}").text).toBe("wₜ₊₁");
    expect(mathAlternative("e^{-\\lambda t}").text).toBe("e^(−λt)");
    expect(mathAlternative("\\sum_i x_i").spoken).toBe("the sum over i of x sub i");
    expect(mathAlternative("\\sum_{i=1}^{n} x_i").spoken).toBe("the sum from i equals 1 to n of x sub i");
    expect(mathAlternative("\\hat{y} = W^\\top x").spoken).toBe("y hat equals W transpose x");
  });

  it("reads \\text with escaped underscores, and sizing and \\left/\\right as plain delimiters", () => {
    // The live reply: \text{w\_new} showed "w\_new"; \big( showed "big(".
    const live = mathAlternative("\\text{w\\_new} = 2 - 0.1 \\times \\big( -6 \\big) = 2.6");
    expect(live.text).toBe("w_new = 2 − 0.1 × (−6) = 2.6");
    expect(live.text).not.toMatch(/\\|big/);
    expect(live.spoken).toBe("w_new equals 2 minus 0.1 times open paren minus 6 close paren equals 2.6");
    expect(mathAlternative("w_{\\text{new}}").text).toBe("w_new");
    const fenced = mathAlternative("\\left( \\frac{\\partial L}{\\partial w} \\right)^2");
    expect(fenced.text).toBe("((∂L)/(∂w))²");
    expect(fenced.spoken).not.toMatch(/left|right/);
    for (const sized of ["\\Big[", "\\bigl(", "\\Bigg\\{", "\\biggr)"]) expect(mathAlternative(`${sized} x`).text).not.toMatch(/big/i);
    expect(mathAlternative("\\left. x \\right|").text).toBe("x|");
  });

  it("reads matrices, cases and limits, and shows an unknown command by name without failing", () => {
    expect(mathAlternative("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}").spoken).toBe("matrix: row 1: a, b; row 2: c, d, end matrix");
    expect(mathAlternative("\\lim_{x \\to 0} x = 0").spoken).toBe("the limit as x to 0 of x equals 0");
    expect(mathAlternative("\\frobnicate{x}").text).toBe("frobnicatex");
    expect(mathAlternative("a } b").text).toBe("ab");
    // Deep nesting is bounded rather than overflowing the stack.
    expect(() => parseTex("{".repeat(5000) + "x")).not.toThrow();
    expect(mathText(parseTex("\\frac{\\frac{1}{2}}{3}"))).toBe("(1/2)/3");
  });

  it("speaks math in the learner's language", () => {
    expect(stripBidiControls(mathAlternative("x^2 + 1 = y", he.t).spoken)).toBe("x בריבוע ועוד 1 שווה y");
    expect(stripBidiControls(mathAlternative("\\frac{dL}{dw}", he.t).spoken)).toBe("השבר dL חלקי dw, סוף השבר");
    expect(stripBidiControls(mathAlternative("\\eta \\le \\sqrt{2}", he.t).spoken)).toBe("אטא קטן או שווה אל השורש הריבועי של 2, סוף השורש");
  });

  it("finds inline and display math but leaves prices and escaped dollars as prose", () => {
    expect(splitMath("Area $\\pi r^2$ here")).toEqual([
      { kind: "text", value: "Area " },
      { kind: "math", tex: "\\pi r^2", display: false },
      { kind: "text", value: " here" },
    ]);
    expect(splitMath("$$a+b$$")).toEqual([{ kind: "math", tex: "a+b", display: true }]);
    expect(splitMath("It costs $5 and $10 today.")).toEqual([{ kind: "text", value: "It costs $5 and $10 today." }]);
    expect(splitMath("Not \\$x\\$ math")).toEqual([{ kind: "text", value: "Not \\$x\\$ math" }]);
    expect(splitMath("so \\(x^2\\) and \\[y\\]")).toEqual([
      { kind: "text", value: "so " },
      { kind: "math", tex: "x^2", display: false },
      { kind: "text", value: " and " },
      { kind: "math", tex: "y", display: true },
    ]);
  });
});

describe("math on the web page", () => {
  it("draws MathML with a spoken label, left to right, and no raw TeX on screen", () => {
    const { container } = render(<MarkdownContent markdown={"The loss is $x^2$ and **bold** stays."} />);
    const math = screen.getByRole("math");
    expect(math).toHaveAttribute("aria-label", "x squared");
    expect(math).toHaveAttribute("dir", "ltr");
    expect(math.querySelector("math msup mi")).toHaveTextContent("x");
    expect(math.querySelector("math")!.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).not.toMatch(/[$\\^]/);
    expect(screen.getByText("bold")).toBeInTheDocument();
  });

  it("draws fractions, text subscripts and display formulas as real layout", () => {
    const { container } = render(
      <MarkdownContent markdown={"Update: $w_{\\text{new}} = w - \\eta \\big(\\frac{dL}{dw}\\big)$\n\n$$\\text{w\\_new} = 2.6$$"} />,
    );
    const [inline, display] = screen.getAllByRole("math");
    expect(inline!.querySelector("msub mtext")).toHaveTextContent("new");
    expect(inline!.querySelector("mfrac")).not.toBeNull();
    expect(inline!.textContent).not.toMatch(/big|\\/);
    expect(display).toHaveAttribute("data-math-display", "block");
    expect(display).toHaveAttribute("tabindex", "0");
    expect(display!.querySelector("mtext")).toHaveTextContent("w_new");
    expect(container.textContent).not.toContain("\\_");
  });

  it("labels math in the interface language and marks it with that language", () => {
    render(
      <I18nProvider value={he}>
        <MarkdownContent markdown={"הגרדיאנט הוא $x^2$ כאן"} />
      </I18nProvider>,
    );
    const math = screen.getByRole("math");
    expect(stripBidiControls(math.getAttribute("aria-label")!)).toBe("x בריבוע");
    expect(math).toHaveAttribute("lang", "he");
  });
});
