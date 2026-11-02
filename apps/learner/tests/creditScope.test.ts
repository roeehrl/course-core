import { describe, expect, it } from "vitest";
import type { Challenge, ServerSnapshot } from "../src/client/apiClient";
import { creditScope, scopedQuestion } from "../src/connected/credit/creditScope";

const question = { id: "q", type: "choice", objectiveIds: [], prompt: "Which?" } as unknown as Challenge["question"];
const challenge = (challengeId: string, episodeId: string, extra: Partial<Challenge> = {}): Challenge => ({
  challengeId, episodeId, question, independentEligible: true, mode: "independent", ...extra,
});
const lessons = [
  { id: "a", status: "available", completedBlockIds: [], gate: { passed: false, objectives: [{ id: "o", families: ["f"], required: 2, passed: false }] } },
  { id: "b", status: "available", completedBlockIds: [], gate: { passed: false, objectives: [{ id: "p", families: [], required: 2, passed: false }] } },
] as ServerSnapshot["lessons"];
const now = Date.parse("2026-11-01T12:00:00Z");
const server = (activeChallenges: Challenge[]) => ({ activeChallenges, lessons });

// The client previews the server's rule (companion-ask-route.ts, companionCreditScope): the lesson's
// open counted questions and the attached one, never another lesson's.
describe("credit scope", () => {
  it("is the lesson's open counted question, not another lesson's", () => {
    const open = server([challenge("in-a", "a"), challenge("in-b", "b")]);
    expect(creditScope(open, "a", now)).toEqual(["in-a"]);
    expect(creditScope(open, "b", now)).toEqual(["in-b"]);
    expect(creditScope(open, undefined, now)).toEqual([]);
    expect(creditScope(undefined, "a", now)).toEqual([]);
  });

  it("adds the attached question from another lesson", () => {
    const open = server([challenge("in-a", "a"), challenge("in-b", "b")]);
    expect(creditScope(open, "a", now, "in-b")).toEqual(["in-a", "in-b"]);
    expect(creditScope(open, undefined, now, "in-b")).toEqual(["in-b"]);
  });

  it("leaves out practice and expired questions", () => {
    const open = server([
      challenge("practice", "a", { independentEligible: false }),
      challenge("expired", "a", { expiresAt: "2026-11-01T11:59:00Z" }),
      challenge("later", "a", { expiresAt: "2026-11-01T12:30:00Z" }),
    ]);
    expect(creditScope(open, "a", now)).toEqual(["later"]);
  });

  it("names the attached question when it is in scope, else the lesson's, by its number in its lesson", () => {
    const open = server([challenge("in-a", "a"), challenge("in-b", "b")]);
    // Lesson a has one family of two counted: its open question is question 2.
    expect(scopedQuestion(open, "a", now)).toEqual({ challengeIds: ["in-a"], ordinal: 2, count: 1 });
    expect(scopedQuestion(open, "a", now, "in-b")).toEqual({ challengeIds: ["in-a", "in-b"], ordinal: 1, count: 2 });
    expect(scopedQuestion(server([challenge("practice", "a", { independentEligible: false })]), "a", now)).toBeUndefined();
  });

  it("counts every open counted question of the lesson, since the server makes all of them practice", () => {
    // The lesson's check and a retention item of the same lesson share the lesson's number.
    const open = server([challenge("check", "a"), challenge("retention", "a", { mode: "retention" } as Partial<Challenge>), challenge("in-b", "b")]);
    expect(scopedQuestion(open, "a", now)).toEqual({ challengeIds: ["check", "retention"], ordinal: 2, count: 2 });
  });
});
