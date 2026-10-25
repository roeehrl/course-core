import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { inlines, latinRuns, parseMarkdown, textDirection } from "../src/components/markdown";
import { MarkdownContent } from "../src/components/MarkdownContent";

// Synthetic prose shaped like the live companion replies and lesson text (lists with bold lead-ins,
// a pipe table, inline TeX, mixed Hebrew and English); no course content.
const reply = [
  "No, the backward pass only computes the gradient.",
  "",
  "* **After backward:** the weight $w$ is still $2$.",
  "* **After update:** the optimizer applies $\\text{w\\_new} = 2 - 0.1 \\times (-6) = 2.6$.",
  "  * a *nested* note with `forward_done`",
  "",
  "1. First",
  "2. Second",
].join("\n");
const table = "| Boundary | Weight | Values just produced |\n| --- | :---: | ---: |\n| Before forward | 2 | Input 3, target 8 |\n| After forward | 2 | Prediction 6, loss 2 |";

describe("Markdown reading", () => {
  it("reads lists with nesting, emphasis, code and math", () => {
    const [paragraph, bullets, numbers] = parseMarkdown(reply);
    expect(paragraph).toMatchObject({ kind: "paragraph" });
    expect(bullets).toMatchObject({ kind: "list", ordered: false });
    const items = (bullets as Extract<typeof bullets, { kind: "list" }>).items;
    expect(items).toHaveLength(2);
    expect(items[0]![0]).toMatchObject({ kind: "paragraph", inline: [{ kind: "strong", children: [{ kind: "text", text: "After backward:" }] }, { kind: "text", text: " the weight " }, { kind: "math", tex: "w" }, { kind: "text", text: " is still " }, { kind: "math", tex: "2" }, { kind: "text", text: "." }] });
    expect(items[1]![1]).toMatchObject({ kind: "list", items: [[{ kind: "paragraph", inline: [{ kind: "text", text: "a " }, { kind: "em" }, { kind: "text", text: " note with " }, { kind: "code", text: "forward_done" }] }]] });
    expect(numbers).toMatchObject({ kind: "list", ordered: true, start: 1, items: [[{ kind: "paragraph" }], [{ kind: "paragraph" }]] });
  });

  it("reads a pipe table with its column alignment", () => {
    const [block] = parseMarkdown(table);
    expect(block).toMatchObject({ kind: "table", align: [null, "center", "end"] });
    const t = block as Extract<typeof block, { kind: "table" }>;
    expect(t.header.map((cell) => cell[0])).toEqual([{ kind: "text", text: "Boundary" }, { kind: "text", text: "Weight" }, { kind: "text", text: "Values just produced" }]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]![2]).toEqual([{ kind: "text", text: "Prediction 6, loss 2" }]);
  });

  it("keeps identifiers, products, escapes and prices as written", () => {
    expect(inlines("snake_case_name stays")).toEqual([{ kind: "text", text: "snake_case_name stays" }]);
    expect(inlines("2*3*4 and a * b * c and 0.1*(-6)")).toEqual([{ kind: "text", text: "2*3*4 and a * b * c and 0.1*(-6)" }]);
    expect(inlines("\\*not emphasis\\* and \\$5")).toEqual([{ kind: "text", text: "*not emphasis* and $5" }]);
    expect(inlines("Costs $5 and $10.")).toEqual([{ kind: "text", text: "Costs $5 and $10." }]);
    expect(inlines("***both*** and ~~gone~~ and __strong__ and _em_")).toEqual([
      { kind: "em", children: [{ kind: "strong", children: [{ kind: "text", text: "both" }] }] },
      { kind: "text", text: " and " },
      { kind: "del", children: [{ kind: "text", text: "gone" }] },
      { kind: "text", text: " and " },
      { kind: "strong", children: [{ kind: "text", text: "strong" }] },
      { kind: "text", text: " and " },
      { kind: "em", children: [{ kind: "text", text: "em" }] },
    ]);
    expect(inlines("an **unclosed bold")).toEqual([{ kind: "text", text: "an **unclosed bold" }]);
  });

  it("reads headings, quotes, rules, display math and code fences", () => {
    expect(parseMarkdown("## Title\n\n> quoted **text**\n\n---\n\n$$\n\\frac{a}{b}\n$$\n\n```py\nprint(1)\n```")).toEqual([
      { kind: "heading", level: 2, inline: [{ kind: "text", text: "Title" }] },
      { kind: "quote", blocks: [{ kind: "paragraph", inline: [{ kind: "text", text: "quoted " }, { kind: "strong", children: [{ kind: "text", text: "text" }] }] }] },
      { kind: "rule" },
      { kind: "math", tex: "\\frac{a}{b}" },
      { kind: "code", language: "py", code: "print(1)" },
    ]);
  });

  it("closes or holds back what a streaming reply has not finished", () => {
    expect(parseMarkdown("but **fine-tun", { streaming: true })).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "but " }, { kind: "strong", children: [{ kind: "text", text: "fine-tun" }] }] },
    ]);
    expect(parseMarkdown("The gradient $\\frac{dL", { streaming: true })).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "The gradient " }, { kind: "pending" }] },
    ]);
    expect(parseMarkdown("Rows:\n| a | b |", { streaming: true })).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "Rows:" }] },
      { kind: "pending" },
    ]);
    expect(parseMarkdown("$$\n\\sum_i", { streaming: true })).toEqual([{ kind: "pending" }]);
    expect(parseMarkdown("```js\nlet x", { streaming: true })).toEqual([{ kind: "code", language: "js", code: "let x" }]);
    expect(parseMarkdown("use `code", { streaming: true })).toEqual([{ kind: "paragraph", inline: [{ kind: "text", text: "use " }, { kind: "code", text: "code" }] }]);
    // The same text, finished, is ordinary prose: a price is not a formula.
    expect(parseMarkdown("It costs $5", { streaming: true })).toEqual([{ kind: "paragraph", inline: [{ kind: "text", text: "It costs $5" }] }]);
  });

  it("finds Latin runs to isolate inside Hebrew", () => {
    // A bracketed term is isolated with its brackets, which it closes.
    expect(latinRuns("אלא כוונון עדין (fine-tuning), והחלק")).toEqual([
      { text: "אלא כוונון עדין ", latin: false },
      { text: "(fine-tuning)", latin: true },
      { text: ", והחלק", latin: false },
    ]);
    expect(latinRuns("עובר ב-forward pass.")).toEqual([
      { text: "עובר ב-", latin: false },
      { text: "forward pass", latin: true },
      { text: ".", latin: false },
    ]);
    // A pasted English formula and sentence stay one run (live 0.1.58: it read
    // "2=x ,3=use w ,x*w=For prediction"), with its own question mark; the Hebrew colon and full
    // stop stay with the Hebrew.
    const pasted = "השאלה היא: For prediction=w*x, use w=3, x=2, target=4 and L=(prediction-target)^2/2. What is the current value of w? תענה רק במספר.";
    expect(latinRuns(pasted).filter((run) => run.latin).map((run) => run.text)).toEqual([
      "For prediction=w*x, use w=3, x=2, target=4 and L=(prediction-target)^2/2. What is the current value of w?",
    ]);
    expect(latinRuns(pasted).map((run) => run.text).join("")).toBe(pasted);
    // A calculation without letters, quoted course text, and terms after a Hebrew prefix.
    expect(latinRuns("כמה זה 2+2=4?").filter((run) => run.latin).map((run) => run.text)).toEqual(["2+2=4"]);
    expect(latinRuns("על “Find a minimum” (עד עכשיו 0)").filter((run) => run.latin).map((run) => run.text)).toEqual(["“Find a minimum”"]);
    expect(latinRuns("w=3 ו-x=2, וגם C++.").filter((run) => run.latin).map((run) => run.text)).toEqual(["w=3", "x=2", "C++"]);
    // Plain numbers between Hebrew words are not runs.
    expect(latinRuns("0 מתוך 2 משפחות").filter((run) => run.latin)).toEqual([]);
    expect(textDirection("  (2) לא")).toBe("rtl");
    expect(textDirection("No, לא")).toBe("ltr");
  });
});

describe("Markdown on the page", () => {
  it("draws lists, emphasis and code without raw markers", () => {
    const { container } = render(<MarkdownContent markdown={reply} />);
    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(3);
    expect(within(lists[0]!).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText("After backward:")).toHaveStyle({ fontWeight: "700" });
    expect(screen.getByText("nested")).toHaveStyle({ fontStyle: "italic" });
    expect(screen.getByText("forward_done")).toHaveAttribute("dir", "ltr");
    expect(container.textContent).not.toMatch(/\*|\$|\\text/);
    expect(container.textContent).toContain("1.");
  });

  it("draws a table with column headers and a keyboard-reachable scrolling frame", () => {
    render(<MarkdownContent markdown={`Before.\n\n${table}`} />);
    const frame = screen.getByRole("region", { name: "Table, scrollable" });
    expect(frame).toHaveAttribute("tabindex", "0");
    const grid = within(frame).getByRole("table");
    expect(within(grid).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Boundary", "Weight", "Values just produced"]);
    expect(within(grid).getAllByRole("row")).toHaveLength(3);
    expect(within(grid).getByRole("cell", { name: "Prediction 6, loss 2" })).toHaveStyle({ textAlign: "end" });
    expect(frame.textContent).not.toContain("|");
  });

  it("isolates Latin runs and formulas inside Hebrew, and leaves English prose alone", () => {
    const { container, unmount } = render(<MarkdownContent markdown={"לא, זו אינה הסקה אלא **כוונון עדין (fine-tuning)**, והחלק עובר ב-forward."} />);
    const isolated = [...container.querySelectorAll('[dir="ltr"]')].map((node) => node.textContent);
    expect(isolated).toEqual(["(fine-tuning)", "forward"]);
    unmount();
    const english = render(<MarkdownContent markdown={"Plain (fine-tuning) English."} />);
    expect(english.container.querySelectorAll('[dir="ltr"]')).toHaveLength(0);
  });

  it("keeps HTML as text and draws a streaming draft like the finished reply", () => {
    const { container, rerender } = render(<MarkdownContent markdown={"<b>not bold</b> and <script>x()</script>"} />);
    expect(container.querySelector("b, script")).toBeNull();
    expect(container.textContent).toContain("<b>not bold</b>");
    rerender(<MarkdownContent streaming markdown={"* **Point:** the value $\\frac{a"} />);
    expect(screen.getByRole("listitem")).toBeInTheDocument();
    expect(screen.getByText("Point:")).toHaveStyle({ fontWeight: "700" });
    expect(container.textContent).not.toMatch(/\*|\$|\\frac/);
    rerender(<MarkdownContent markdown={"* **Point:** the value $\\frac{a}{b}$"} />);
    expect(screen.getByRole("math")).toHaveAttribute("aria-label", "the fraction a over b, end fraction");
  });
});
