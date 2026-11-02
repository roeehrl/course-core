import { describe, expect, it } from "vitest";
import { clipPrompt } from "../src/placement.js";

// A long question prompt in a placement result: shortened on a word boundary, never mid-word.
describe("placement prompt clipping", () => {
  it("keeps a short prompt whole, with its spaces tidied", () => {
    expect(clipPrompt("  Which   is\nsmaller? ")).toBe("Which is smaller?");
  });
  it("cuts a long prompt after its last whole word, with an ellipsis", () => {
    const prompt = "Explain why a binary search needs a sorted list and what goes wrong when it is not";
    const clipped = clipPrompt(prompt, 40);
    expect(clipped).toBe("Explain why a binary search needs a…");
    expect(clipped.length).toBeLessThanOrEqual(40);
    expect(prompt.startsWith(clipped.slice(0, -1))).toBe(true);
  });
  it("drops punctuation left at the cut", () => {
    expect(clipPrompt("First, compare the two numbers; then, pick the smaller one of them", 23)).toBe("First, compare the two…");
    expect(clipPrompt("Compare these, then pick the smaller one", 16)).toBe("Compare these…");
  });
  it("cuts Hebrew on a word boundary too", () => {
    const clipped = clipPrompt("הסבירו מדוע חיפוש בינארי דורש רשימה ממוינת ומה קורה כשהיא אינה ממוינת", 30);
    expect(clipped).toBe("הסבירו מדוע חיפוש בינארי דורש…");
  });
  it("cuts a single very long token where it must", () => {
    const clipped = clipPrompt(`See ${"x".repeat(200)}`, 40);
    expect(clipped).toHaveLength(40);
    expect(clipped.endsWith("…")).toBe(true);
  });
  it("leaves a prompt of exactly the limit alone", () => {
    expect(clipPrompt("a".repeat(140))).toHaveLength(140);
  });
});
