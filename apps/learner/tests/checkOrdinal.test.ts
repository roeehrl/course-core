import { describe, expect, it } from "vitest";
import { checkOrdinal, questionOrdinal } from "../src/connected/checkOrdinal";

// The same example as services/api/test/check-ordinal.test.ts: both sides number questions alike.
const ORDINAL_EXAMPLE = [
  { families: ["a"], required: 2 },
  { families: ["x", "y", "z"], required: 1 },
  { families: [], required: 1 },
];

describe("check ordinal", () => {
  it("is one more than the counted successes, objective by objective, capped at the total", () => {
    expect(checkOrdinal(ORDINAL_EXAMPLE)).toBe(3);
    expect(checkOrdinal([{ families: [], required: 2 }])).toBe(1);
    expect(checkOrdinal([{ families: ["a", "b"], required: 2 }])).toBe(2);
    expect(checkOrdinal([])).toBe(1);
  });

  it("reads the lesson's gate from the snapshot", () => {
    const server = { lessons: [{ id: "min", status: "available" as const, completedBlockIds: [], gate: { passed: false, objectives: ORDINAL_EXAMPLE.map((o, i) => ({ id: `o${i}`, passed: false, ...o })) } }] };
    expect(questionOrdinal(server, "min")).toBe(3);
    expect(questionOrdinal(server, "max")).toBe(1);
  });
});
