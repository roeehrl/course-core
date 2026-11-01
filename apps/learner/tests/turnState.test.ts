import { describe, expect, it } from "vitest";
import type { CompanionMessage } from "../src/client/companionClient";
import { asksLearner, questionTurnsInARow, replyAsksLearner, turnState } from "../src/connected/companion/turnState";
import { message } from "./companionFixtures";

const reply = (content: string, context: CompanionMessage["context"] = {}, id = "a"): CompanionMessage =>
  ({ id, role: "assistant", content, context, created_at: "2026-01-02", job_id: id });

describe("whose turn it is (final design §3.3, G2)", () => {
  it("reads the server's flag, and the same rule on an older row stored without it", () => {
    expect(asksLearner(reply("Done.", { asksLearner: true }))).toBe(true);
    expect(asksLearner(reply("What do you get?", { asksLearner: false }))).toBe(false);
    expect(asksLearner(reply("What do you get?"))).toBe(true);
    expect(asksLearner(reply("You get 15."))).toBe(false);
    expect(asksLearner(reply("[deleted]", { asksLearner: true }))).toBe(false);
    expect(asksLearner({ ...message, content: "Why?" })).toBe(false);
    // Core's coaching for a withheld answer always asks the learner to try a step.
    expect(asksLearner(reply("Tell me your reasoning so far.", { checkAnswerWithheld: "check_answer_given" }))).toBe(true);
  });
  it("finds the closing question as the server does: outside code, past closing quotes and marks, Hebrew too", () => {
    expect(replyAsksLearner("Try it.\n\n**What happens to x first?**")).toBe(true);
    expect(replyAsksLearner("Which is right: “2” or “3”?”")).toBe(true);
    expect(replyAsksLearner("מה מקבלים כאן?")).toBe(true);
    expect(replyAsksLearner("لماذا؟")).toBe(true);
    expect(replyAsksLearner("Is it this?\n\n```js\nconsole.log(1)\n```")).toBe(true);
    expect(replyAsksLearner("Run this:\n\n```\nwhy?\n```")).toBe(false);
    expect(replyAsksLearner("")).toBe(false);
  });
  it("is the learner's turn only after the latest reply, and nobody's while a question is on its way", () => {
    const asking = reply("What do you get?", { asksLearner: true });
    expect(turnState([message, asking])).toMatchObject({ latestReplyId: "a", yourTurn: true, withheldHint: false, showMeHow: false });
    expect(turnState([message, asking], { inProgress: true }).yourTurn).toBe(false);
    expect(turnState([message, asking, { ...message, id: "m2" }]).yourTurn).toBe(false);
    expect(turnState([]).yourTurn).toBe(false);
    expect(turnState([message, reply("hint", { checkAnswerWithheld: "x" })]).withheldHint).toBe(true);
  });
  it("counts question turns in a row for 'Show me how' (TUT-3)", () => {
    const thread: CompanionMessage[] = [];
    for (const n of [1, 2, 3]) thread.push({ ...message, id: `q${n}` }, reply(`Step ${n}?`, { asksLearner: true }, `a${n}`));
    expect(questionTurnsInARow(thread)).toBe(3);
    expect(turnState(thread).showMeHow).toBe(true);
    expect(questionTurnsInARow([...thread.slice(0, 2), { ...message, id: "x" }, reply("Fine.", {}, "b"), ...thread.slice(2)])).toBe(2);
  });
});
