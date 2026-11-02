import { describe, expect, it } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { answerFeedback, answerResult } from "../src/connected/answerFeedback";
import { createLearnerTranslator } from "../src/i18n";

// The check's feedback reads the server's receipt into a verdict and what explains it (§4.1, TUT-7);
// the host's notice for a recovered submission still words it as one sentence run.
const receipt = (result: Record<string, unknown>) => ({ result });
const hebrew = createLearnerTranslator("he").t;
const he = ((...args: Parameters<typeof hebrew>) => stripBidiControls(hebrew(...args))) as typeof hebrew;

describe("structured answer feedback", () => {
  it("reads a correct, a wrong and a practice answer", () => {
    expect(answerResult(receipt({ passed: true, independent: true, explanation: "2 is below 5." }))).toEqual({
      verdict: "correct", passed: true, independent: true, explanation: "2 is below 5.", coded: false,
    });
    expect(answerResult(receipt({ passed: false, independent: true, explanation: "Multiply first: $w \\cdot x$." }))).toMatchObject({
      verdict: "revisit", explanation: "Multiply first: $w \\cdot x$.", coded: false,
    });
    expect(answerResult(receipt({ passed: false, independent: false, explanation: "Not yet." }))).toMatchObject({ verdict: "revisit", independent: false });
  });

  it("reads a written answer, a code check and an abstention, with Core's coded lines worded", () => {
    expect(answerResult(receipt({ passed: false, pendingReview: true, independent: true, message: { code: "pending_review" } }))).toMatchObject({
      verdict: "submitted", coded: true, explanation: expect.stringMatching(/^It is checked against the rubric/),
    });
    const limit = receipt({ passed: false, independent: true, message: { code: "code_limit", params: { limit: "time" } }, execution: { status: "timeout" } });
    expect(answerResult(limit)).toMatchObject({ verdict: "codeFailed", coded: true });
    expect(answerResult(receipt({ passed: true, independent: true, message: { code: "code_all_matched", params: { total: 3 } }, execution: { status: "graded" } })))
      .toMatchObject({ verdict: "codePassed", explanation: "All 3 hidden reference cases matched." });
    expect(answerResult(receipt({ passed: false, abstained: true, independent: true, explanation: "12.5 stays." }))).toMatchObject({
      verdict: "abstained", explanation: "12.5 stays.", coded: false,
    });
    expect(answerResult(receipt({ passed: true, independent: true, explanation: "Ran." }), true).verdict).toBe("codePassed");
  });

  it("refuses a malformed receipt instead of guessing a grade", () => {
    for (const bad of [null, {}, receipt({ passed: "yes", independent: true, explanation: "x" }), receipt({ passed: true, explanation: "x" }),
      receipt({ passed: true, independent: true, explanation: "x", execution: { status: "timeout" } }), receipt({ passed: false, independent: true, message: { code: "Made up" } })])
      expect(() => answerResult(bad)).toThrow();
  });

  it("words the one-line form for a recovered submission, in English and Hebrew", () => {
    expect(answerFeedback(receipt({ passed: true, independent: true, explanation: "2 is below 5." }))).toBe("Correct. 2 is below 5.");
    expect(answerFeedback(receipt({ passed: false, independent: false, explanation: "Not yet." }))).toBe("Let's revisit this. Not yet. This counts as practice.");
    expect(answerFeedback(receipt({ passed: false, abstained: true, independent: false, explanation: "12.5 stays." }))).toBe("Noted. This doesn't count against you. 12.5 stays.");
    expect(answerFeedback(receipt({ passed: true, independent: true, explanation: "2 is below 5." }), false, he)).toBe("נכון. 2 is below 5.");
    expect(answerFeedback(receipt({ passed: false, pendingReview: true, independent: true, message: { code: "pending_review" } }), false, he)).toMatch(/^נשלח לבדיקה\./);
  });
});
