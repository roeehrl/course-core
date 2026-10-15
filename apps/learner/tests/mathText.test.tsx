import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mathAlternative, splitMath } from "../src/components/mathText";
import { MarkdownContent } from "../src/components/MarkdownContent";

describe("math text alternatives", () => {
  it("speaks common notation in words and shows readable text instead of TeX", () => {
    expect(mathAlternative("x^2 + y^2 = r^2")).toEqual({
      text: "x² + y² = r²",
      spoken: "x squared plus y squared equals r squared",
    });
    expect(mathAlternative("\\frac{a}{b}")).toEqual({
      text: "(a)/(b)",
      spoken: "the fraction a over b, end fraction",
    });
    expect(mathAlternative("\\sqrt{n} \\le n")).toMatchObject({
      spoken: "the square root of n, end root is less than or equal to n",
    });
    expect(mathAlternative("w_{t+1} = w_t - \\eta \\nabla L").spoken).toBe(
      "w sub t plus 1 equals w sub t minus eta nabla L",
    );
    expect(mathAlternative("w_{t+1}").text).toBe("wₜ₊₁");
    expect(mathAlternative("e^{-\\lambda t}").text).toBe("e^(−λt)");
    expect(mathAlternative("\\sum_i x_i").spoken).toBe(
      "the sum of sub i x sub i",
    );
  });
  it("finds inline and display math but leaves prices and escaped dollars as prose", () => {
    expect(splitMath("Area $\\pi r^2$ here")).toEqual([
      { kind: "text", value: "Area " },
      { kind: "math", tex: "\\pi r^2", display: false },
      { kind: "text", value: " here" },
    ]);
    expect(splitMath("$$a+b$$")).toEqual([
      { kind: "math", tex: "a+b", display: true },
    ]);
    expect(splitMath("It costs $5 and $10 today.")).toEqual([
      { kind: "text", value: "It costs $5 and $10 today." },
    ]);
  });
  it("renders math with role math and a spoken label, with no raw TeX on screen", () => {
    render(
      <MarkdownContent markdown={"The loss is $x^2$ and **bold** stays."} />,
    );
    const math = screen.getByRole("math");
    expect(math).toHaveAttribute("aria-label", "x squared");
    expect(math).toHaveTextContent("x²");
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
  });
});
