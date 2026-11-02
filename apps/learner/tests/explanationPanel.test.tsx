import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCompanionBridge } from "../src/connected/companion/bridge";
import { Card, cardProps, question } from "./checkCardFixtures";

// "Show explanation" (§4.3): asked once on a counted question, then the explanation expands in
// place under the feedback, in Markdown with math, never in the page notice; "Solution viewed"
// says what the record now holds.
beforeEach(() => resetCompanionBridge());

describe("the explanation in the check", () => {
  it("asks first on a counted question: Keep it counted is focused and Esc keeps it, Show as practice asks the server", async () => {
    const open = question();
    const p = cardProps(open);
    const { rerender } = render(<Card {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    fireEvent.click(screen.getByRole("button", { name: "Show explanation" }));
    const confirm = screen.getByRole("group", { name: "Opening the explanation makes question 1 practice." });
    expect(within(confirm).getByRole("button", { name: "Keep it counted" })).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: /Opening the explanation/ })).toBeNull();
    expect(p.check.onSolution).not.toHaveBeenCalled();
    // Keeping it counted puts the learner back at the answer.
    expect(screen.getByRole("textbox", { name: "Your numeric answer" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Show explanation" }));
    fireEvent.click(screen.getByRole("button", { name: "Show as practice" }));
    expect(p.check.onSolution).toHaveBeenCalledWith(open);
    // While it is fetched, the button that will hide it takes the focus and keeps it (never lost
    // to the page with the confirm that held it).
    rerender(<Card {...p} check={{ ...p.check, explaining: "c1" }} />);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const waiting = screen.getByRole("button", { name: "Hide explanation" });
    expect(waiting).toHaveFocus();
    expect(waiting).toHaveAttribute("aria-disabled", "true");
    expect(waiting).toBeEnabled();
    // The server answers with the explanation, and the question is practice from then on.
    const after = cardProps({ ...open, independentEligible: false }, { ...p.check, explanations: { c1: "**Multiply first**: $2 \\cdot 6 = 12$." } });
    rerender(<Card {...after} />);
    const panel = screen.getByRole("region", { name: "Explanation" });
    // Markdown and math render: no raw asterisks or dollar signs.
    expect(panel).toHaveTextContent("Multiply first");
    expect(panel.textContent).not.toMatch(/\*\*|\$/);
    expect(panel.querySelector("math, [role='math'], [aria-label*='times'], [aria-label*='cdot']")).not.toBeNull();
    const hide = screen.getByRole("button", { name: "Hide explanation" });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    expect(hide).toHaveAttribute("aria-controls", panel.id);
    expect(screen.getByText("Solution viewed")).toBeVisible();
    expect(screen.getByTestId("question-kind")).toHaveTextContent("Practice.");
    fireEvent.click(hide);
    expect(screen.queryByRole("region", { name: "Explanation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show explanation" })).toHaveAttribute("aria-expanded", "false");
  });

  it("opens at once on a practice question", () => {
    const open = question({}, { independentEligible: false });
    const p = cardProps(open);
    render(<Card {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    expect(screen.getByRole("group", { name: "Help with question 1" })).not.toHaveTextContent("Help turns this question into practice.");
    fireEvent.click(screen.getByRole("button", { name: "Show explanation" }));
    expect(screen.queryByRole("group", { name: /Opening the explanation/ })).toBeNull();
    expect(p.check.onSolution).toHaveBeenCalledWith(open);
  });

  it("is not offered where the server has no explanation to show before an answer", () => {
    render(<Card {...cardProps(question({ type: "teach_back", criteria: [] } as never))} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    expect(screen.queryByRole("button", { name: "Show explanation" })).toBeNull();
  });
});
