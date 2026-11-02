import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companionFocus } from "../src/client/companionFocus";
import { companionBridge, resetCompanionBridge } from "../src/connected/companion/bridge";
import { HINT_WAIT_MS, hintLevels, nextHint } from "../src/connected/checks/HintLadder.web";
import { Card, answered, cardProps, question } from "./checkCardFixtures";

// The help row of a check (§4.1, Q11): collapsed behind "Get help" until an attempt or "I don't
// know yet"; without hint content it offers no hint button; the hint ladder, when a question has
// hints, opens level by level and never gives the answer away.
const HINTS = ["Which operation joins w and x?", "Multiply first: w · x.", "With w = 3 and x = 5: 3 · 5 = 15.", "The answer is 12."];

beforeEach(() => {
  resetCompanionBridge();
  companionFocus.clear();
  companionBridge.setAvailable(true);
});
afterEach(() => vi.useRealTimers());

describe("the help row", () => {
  it("opens from Get help with the counted line, Ask the companion and Show explanation, and no hint without hint content", () => {
    const p = cardProps(question());
    render(<Card {...p} />);
    const getHelp = screen.getByRole("button", { name: "Get help" });
    expect(getHelp).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Help with question 1" })).toBeNull();
    // After "Check" in the Tab order: the answer bar, then "I don't know yet" and "Get help".
    const order = Array.from(document.querySelectorAll("input, button")).map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(order.indexOf("Check")).toBeLessThan(order.indexOf("I don't know yet: record no answer and get help"));
    fireEvent.click(getHelp);
    expect(getHelp).toHaveAttribute("aria-expanded", "true");
    const row = screen.getByRole("group", { name: "Help with question 1" });
    expect(getHelp).toHaveAttribute("aria-controls", row.id);
    expect(row).toHaveTextContent("Help turns this question into practice.");
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Ask the companion", "Show explanation"]);
    expect(within(row).queryByRole("button", { name: /Hint/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("hides Ask the companion when the study offers no companion", () => {
    companionBridge.setAvailable(false);
    render(<Card {...cardProps(question())} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    const row = screen.getByRole("group", { name: "Help with question 1" });
    expect(within(row).queryByRole("button", { name: "Ask the companion" })).toBeNull();
    expect(within(row).getByRole("button", { name: "Show explanation" })).toBeVisible();
  });

  it("Ask the companion attaches the open question and opens the companion, sending nothing", () => {
    const requests: unknown[] = [];
    companionBridge.onCompose((request) => requests.push(request));
    const p = cardProps(question());
    render(<Card {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask the companion" }));
    expect(companionFocus.get().check).toEqual({ challengeId: "c1", ordinal: 1 });
    expect(requests).toEqual([{ source: "check" }]);
    expect(p.check.onAnswer).not.toHaveBeenCalled();
  });

  it("opens by itself after a wrong answer with Try again first, which starts the next question", () => {
    const open = question();
    const p = cardProps(undefined, { attempts: answered(open, { passed: false, explanation: "9 is x + b." }) });
    render(<Card {...p} />);
    const feedback = document.querySelector(".connected-answer-feedback")!;
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveTextContent("Let's revisit this.9 is x + b.");
    // The answer given stays in its field, read only, under the question.
    expect(screen.getByRole("textbox", { name: "Your numeric answer" })).toHaveValue("9");
    expect(screen.getByRole("textbox", { name: "Your numeric answer" })).toHaveAttribute("readonly");
    const row = screen.getByRole("group", { name: "Help with question 1" });
    // Answered: help no longer changes how it counted, so the counted line is not said.
    expect(row).not.toHaveTextContent("Help turns this question into practice.");
    const buttons = within(row).getAllByRole("button");
    expect(buttons[0]).toHaveTextContent("Try again");
    expect(buttons[0]).toHaveClass("cc-ui-pill-accent");
    fireEvent.click(buttons[0]!);
    expect(p.check.onStart).toHaveBeenCalled();
    // The explanation is already in the feedback: no second "Show explanation".
    expect(within(row).queryByRole("button", { name: "Show explanation" })).toBeNull();
  });

  it("after I don't know yet says Noted, opens the help row and puts focus on its first control", async () => {
    const open = question();
    const p = cardProps(open);
    const { rerender } = render(<Card {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "I don't know yet: record no answer and get help" }));
    expect(p.check.onAbstain).toHaveBeenCalledWith(open);
    const after = cardProps(undefined, { ...p.check, attempts: answered(open, { passed: false, abstained: true, explanation: "**12**: multiply first." }, "") });
    rerender(<Card {...after} />);
    await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
    expect(document.querySelector(".connected-answer-feedback")).toHaveTextContent("Noted. This doesn't count against you. Here's a way in:");
    const row = screen.getByRole("group", { name: "Help with question 1" });
    expect(within(row).getAllByRole("button")[0]).toHaveFocus();
    // The author's explanation that came with "I don't know yet" opens in place, with no request.
    fireEvent.click(within(row).getByRole("button", { name: "Show explanation" }));
    expect(screen.getByRole("region", { name: "Explanation" })).toHaveTextContent("12: multiply first.");
    expect(after.check.onSolution).not.toHaveBeenCalled();
  });

  it("says an attempt is required and a copied answer in place under the field, linked to it", () => {
    const open = question({ type: "teach_back", criteria: [{ id: "c", description: "States the rule.", required: true }] } as never);
    const p = cardProps(open, { fieldErrors: { c1: "copied" } });
    render(<Card {...p} />);
    const field = screen.getByRole("textbox", { name: "Your explanation, as you would teach it" });
    const error = screen.getByText("This repeats your companion's words. Write it in your own words; nothing was recorded.");
    expect(field.getAttribute("aria-describedby")).toBe(error.parentElement!.id);
    render(<Card {...cardProps(question(), { fieldErrors: { c1: "attemptRequired" } })} />);
    expect(screen.getByText("This question needs an attempt. A partial answer is fine.")).toBeVisible();
    // The help bar stays.
    expect(screen.getAllByRole("button", { name: "Get help" })).toHaveLength(2);
  });
});

describe("the hint ladder", () => {
  it("offers three levels at most, opens them in order, and holds the third for one more try or 20 s", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const p = cardProps(question({ hints: HINTS }, { independentEligible: false }));
    render(<Card {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    fireEvent.click(screen.getByRole("button", { name: "Hint 1 of 3" }));
    const hints = screen.getByRole("group", { name: "Hints" });
    expect(hints).toHaveTextContent("Hint 1 of 3 · A nudge");
    expect(hints).toHaveTextContent(HINTS[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Hint 2 of 3" }));
    expect(hints).toHaveTextContent("Hint 2 of 3 · Next step");
    const third = screen.getByRole("button", { name: "Hint 3 of 3" });
    expect(third).toHaveAttribute("aria-disabled", "true");
    expect(document.getElementById(third.getAttribute("aria-describedby")!)).toHaveTextContent("Opens after one more try.");
    fireEvent.click(third);
    expect(hints).not.toHaveTextContent("Hint 3 of 3");
    act(() => {
      vi.advanceTimersByTime(HINT_WAIT_MS);
    });
    expect(screen.getByRole("button", { name: "Hint 3 of 3" })).not.toHaveAttribute("aria-disabled");
    fireEvent.click(screen.getByRole("button", { name: "Hint 3 of 3" }));
    expect(hints).toHaveTextContent("Hint 3 of 3 · A similar example");
    // No bottom-out hint: the fourth (the answer) is never offered.
    expect(hints).not.toHaveTextContent(HINTS[3]!);
    expect(screen.queryByRole("button", { name: /^Hint/ })).toBeNull();
  });

  it("opens the third level after one more try", () => {
    expect(hintLevels(HINTS)).toHaveLength(3);
    expect(nextHint(hintLevels(HINTS), { shown: 2, secondShownAt: 1000, triesAfterSecond: 0 }, 2000)).toEqual({ level: 3, count: 3, locked: true });
    expect(nextHint(hintLevels(HINTS), { shown: 2, secondShownAt: 1000, triesAfterSecond: 1 }, 2000)).toEqual({ level: 3, count: 3, locked: false });
    expect(nextHint(hintLevels(HINTS), { shown: 0, triesAfterSecond: 0 }, 0)).toEqual({ level: 1, count: 3, locked: false });
    expect(nextHint(hintLevels(HINTS), { shown: 3, triesAfterSecond: 0 }, 0)).toBeNull();
    expect(hintLevels(undefined)).toEqual([]);
  });

  it("asks before the first hint on a counted question: Keep it counted is focused and Esc keeps it", async () => {
    const onHint = vi.fn(() => Promise.resolve());
    const p = cardProps(question({ hints: HINTS }), { onHint });
    render(<Card {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    fireEvent.click(screen.getByRole("button", { name: "Hint 1 of 3" }));
    const confirm = screen.getByRole("group", { name: "A hint makes question 1 practice." });
    expect(within(confirm).getByRole("button", { name: "Keep it counted" })).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "A hint makes question 1 practice." })).toBeNull();
    expect(onHint).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hint 1 of 3" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show hint as practice" }));
    });
    expect(onHint).toHaveBeenCalledWith(p.challenge);
    expect(screen.getByRole("group", { name: "Hints" })).toHaveTextContent(HINTS[0]!);
  });

  it("offers no hint on a counted question while the server cannot record one", () => {
    render(<Card {...cardProps(question({ hints: HINTS }))} />);
    fireEvent.click(screen.getByRole("button", { name: "Get help" }));
    expect(screen.queryByRole("button", { name: /^Hint/ })).toBeNull();
  });
});
