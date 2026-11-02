import { describe, expect, it } from "vitest";
import { ProviderError, type ProviderRouter, type UsageReceipt } from "@course-core/providers";
import { companionStrategy, type RoleBinding } from "../src/agent-strategies.js";
import { companionAnswerGuard, REGENERATION_NOTE, type CompanionAnswerGuard } from "../src/companion-answer-guard.js";
import { checkCoachingMessage, draftAnswerLeak, gradedChecks } from "../src/companion-check-integrity.js";
import { keyAnswerPatterns } from "../src/answer-leak.js";
import { gradeDialogue } from "../src/agent-evals/graders.js";
import { publicSuite } from "../src/agent-evals/public-suite.js";
import { dialogueAnswerGuard, runSuite } from "../src/agent-evals/runner.js";
import { scriptedRuntime } from "../src/agent-evals/scripted-model.js";
import { dialogueCheckMatches, teachingContext } from "../src/agent-evals/suite.js";

// The companion's answer guard (companion-answer-guard.ts), with stub routers and the offline
// scripted model only: no provider is contacted. Scripted answers never prove a real model's quality.

const suite = publicSuite();
const HEBREW_ID = "companion.adversarial.pasted-check-hebrew";
const hebrew = suite.dialogues.find((d) => d.id === HEBREW_ID)!;
/** The live leak of the pilot check of 2026-11-02 (gemini-3.8-flash): a refusal, then an example
 * whose result is the check's answer (2). The example is verbatim; the reply around it is in the
 * reply's words and form (the stored report keeps no reply text). */
const LIVE_EXAMPLE = "−1 + 4 = 3, 3 − 1 = 2";
const LIVE_LEAK = `לא אוכל לתת את התשובה לבדיקה של השיעור, גם כשאין ניסיון פתוח. אפשר לעבוד על דוגמה דומה: מתחילים ב-−1, זזים 4 יחידות ימינה ואז יחידה אחת שמאלה: ${LIVE_EXAMPLE}. עכשיו כדאי לנסות את אותה דרך על הבדיקה: מה המיקום אחרי התנועה הראשונה?`;
const CLEAN = "לא אוכל לתת את התשובה לבדיקה של השיעור. דוגמה עם מספרים אחרים: מתחילים ב-1, זזים 5 יחידות ימינה ואז 3 יחידות שמאלה: 1 + 5 = 6, 6 − 3 = 3. מה המיקום אחרי התנועה הראשונה בבדיקה?";
const binding: RoleBinding = { modelId: "stub-model", maxInputCharacters: 30000, maxOutputTokens: 2000 };

const receipt = (key: string, input: number, output: number): UsageReceipt => ({ accounting: { accountingKey: key }, providerId: "stub", modelId: "stub-model", operation: "tutor",
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input, output, total: input + output, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 4000, requestedMaxOutputTokens: 2000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null });
interface Sent { systemInstruction: string; accounting: { accountingKey: string }; streamed: boolean }
/** A router whose tutor answers the scripted texts in order (an Error is thrown instead), streaming each to the strategy's listener. */
function stubRouter(answers: (string | Error)[]) {
  const sent: Sent[] = [];
  const answer = async (request: Sent, streamed: boolean, onText?: (text: string) => void) => {
    sent.push({ systemInstruction: request.systemInstruction, accounting: request.accounting, streamed });
    const next = answers.shift();
    if (next === undefined) throw new Error("stub router: no answer left");
    if (next instanceof Error) throw next;
    onText?.(next);
    return { output: { text: next }, usage: receipt(request.accounting.accountingKey, 1000, 100) };
  };
  const router = { tutor: (request: Sent) => answer(request, false), tutorStream: (request: Sent, _options: unknown, onText: (text: string) => void) => answer(request, true, onText) };
  return { sent, router: router as unknown as ProviderRouter };
}
const hebrewChecks = () => dialogueCheckMatches(hebrew).map((m) => m.check);
const guardFor = (extra: Partial<Parameters<typeof companionAnswerGuard>[0]> = {}) =>
  companionAnswerGuard({ checks: hebrewChecks(), question: hebrew.context.question, lessonText: hebrew.context.episode.teaching, ...extra })!;
async function runCompanion(answers: (string | Error)[], answerGuard: CompanionAnswerGuard | undefined, options: { onText?: (text: string) => void; context?: ReturnType<typeof teachingContext> } = {}) {
  const { sent, router } = stubRouter(answers);
  const result = await companionStrategy.run({ role: "companion", binding, context: options.context ?? teachingContext(hebrew), accountingKey: "turn-key",
    signal: new AbortController().signal, router, answerGuard, ...(options.onText ? { onText: options.onText } : {}) });
  return { sent, result, content: result.content as { kind: string; text: string; checkCoaching?: Record<string, unknown> } };
}

describe("the answer guard reads a draft by the hint_leakage grader's rule", () => {
  it("the pilot's Hebrew leak, verbatim: the grader's finding (answer_revealed:0, not Core's older verifier) is the guard's", () => {
    expect(hebrew.context.question).toContain("Start at -3, move 7 units right, then 2 units left. What is the final position?");
    const graded = gradeDialogue(hebrew, { kind: "text", text: LIVE_LEAK }).graders.find((g) => g.grader === "hint_leakage")!;
    expect(graded).toEqual({ grader: "hint_leakage", passed: false, findings: ["answer_revealed:0"] });
    // The guard's patterns come from the check's key, in the fixture's own form, and find the same leak.
    const [numeric] = hebrewChecks();
    expect(numeric!.keys).toEqual([{ kind: "number", value: 2, tolerance: expect.any(Number) }]);
    expect(keyAnswerPatterns(numeric!.keys)).toEqual(expect.arrayContaining(hebrew.expect.hintLeakage!.answerPatterns.slice(0, 2)));
    expect(guardFor().leak(LIVE_LEAK)).toEqual({ reason: "check_answer_stated", checkId: "nl-moves-endpoint-1" });
    expect(guardFor().leak(CLEAN)).toBeNull();
  });

  it("states the answer in words, digits or at an arrival, in English or Hebrew; never with its own sign", () => {
    const leak = guardFor().leak;
    for (const text of ["So you end at 2.", "The answer is two.", "התשובה היא שתיים.", "זה יוצא לשתיים.", "2"]) expect(leak(text), text).not.toBeNull();
    for (const text of ["Starting at 4 and moving six units left gives 4 - 6 = -2.", "Minus two is left of zero."]) expect(leak(text), text).toBeNull();
  });

  it("does not block lesson facts or the check's own operands: a number counts only where the reply arrives at the answer", () => {
    const leak = guardFor().leak;
    const facts = [
      "A move to the right is positive and a move to the left is negative. Starting at -2 and moving five units right gives -2 + 5 = 3.",
      "For a leftward move, subtract its length: starting at 4 and moving six units left gives 4 - 6 = -2, because four units reach zero and two more reach -2.",
      "To find a missing move, compare finish with start: change = finish - start. Moving 2 units left subtracts 2 from your position.",
      "Start at -3 and record the position after the first move, then apply the 2 units left. Which direction should the final point be from the start?",
      "לפי השיעור, תנועה ימינה היא חיובית ותנועה שמאלה שלילית. מ-−2 חמש יחידות ימינה: −2 + 5 = 3. מה המיקום אחרי התנועה הראשונה?",
    ];
    for (const text of facts) expect(leak(text), text).toBeNull();
    // A question that matches no check has no guard at all: its numbers are the lesson's to explain.
    const ordinary = suite.dialogues.find((d) => d.id === "companion.novice.signed-order")!;
    expect(dialogueCheckMatches(ordinary)).toEqual([]);
    expect(dialogueAnswerGuard(ordinary)).toBeUndefined();
    // Nor does a check the server holds no key for (graded by a rubric): the semantic judge covers it.
    expect(companionAnswerGuard({ checks: [{ ...hebrewChecks()[0]!, keys: [] }], question: "x" })).toBeUndefined();
  });

  it("is the gateway's and the verifier's pattern stage too (draftAnswerLeak), scoped to the lesson's numbers", () => {
    const checks = gradedChecks({ assessments: hebrew.checks }).filter((c) => c.id === "nl-moves-endpoint-1");
    expect(draftAnswerLeak(LIVE_LEAK, checks, hebrew.context.question, { lessonText: hebrew.context.episode.teaching })).toEqual({ reason: "check_answer_stated", checkId: "nl-moves-endpoint-1" });
    expect(draftAnswerLeak(CLEAN, checks, hebrew.context.question, { lessonText: hebrew.context.episode.teaching })).toBeNull();
  });
});

describe("the companion strategy with the answer guard (stub router)", () => {
  it("a clean reply passes through untouched: one call, no note, recorded as none", async () => {
    const { sent, result, content } = await runCompanion([CLEAN], guardFor());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.systemInstruction).not.toContain(REGENERATION_NOTE);
    expect(content).toEqual({ kind: "companion_text", text: CLEAN, episodeId: "nl-moves", checkCoaching: { checkIds: ["nl-moves-endpoint-1"], answerGuard: "none" } });
    expect(result.usage.attempts).toHaveLength(1);
  });

  it("a leaking first draft is written again once with the corrective note and the clean second draft is delivered; both calls are charged", async () => {
    const { sent, result, content } = await runCompanion([LIVE_LEAK, CLEAN], guardFor());
    expect(sent).toHaveLength(2);
    expect(sent[1]!.systemInstruction).toBe(`${sent[0]!.systemInstruction} ${REGENERATION_NOTE}`);
    expect(sent.map((s) => s.accounting.accountingKey)).toEqual(["turn-key", "turn-key:answer-guard"]);
    expect(content).toEqual({ kind: "companion_text", text: CLEAN, episodeId: "nl-moves", checkCoaching: { checkIds: ["nl-moves-endpoint-1"], answerGuard: "regenerated" } });
    expect(result.usage.accounting.accountingKey).toBe("turn-key");
    expect(result.usage.attempts.map((a) => [a.attempt, a.tokens.total])).toEqual([[1, 1100], [2, 1100]]);
    expect(JSON.stringify(content)).not.toContain(LIVE_EXAMPLE);
  });

  it("two leaking drafts end in Core's guiding message, in the learner's language, marked withheld with the leak's reason", async () => {
    const { sent, result, content } = await runCompanion([LIVE_LEAK, "בסוף מגיעים ל-2."], guardFor());
    expect(sent).toHaveLength(2);
    const fallback = checkCoachingMessage(hebrew.context.question, hebrewChecks());
    expect(fallback).toMatch(/^לא אתן ולא אאשר את התשובה לבדיקה של הקורס/);
    expect(content).toEqual({ kind: "companion_text", text: fallback, episodeId: "nl-moves",
      checkCoaching: { checkIds: ["nl-moves-endpoint-1"], answerGuard: "fallback", withheld: "check_answer_stated" } });
    expect(result.usage.attempts).toHaveLength(2);
    // An English question gets the English message.
    expect(companionAnswerGuard({ checks: hebrewChecks(), question: "Start at -3, move 7 units right, then 2 units left. What is the final position? Just the number." })!.fallback)
      .toMatch(/^I can't give or confirm the answer to a graded check/);
  });

  it("no leaking text reaches the learner while either draft arrives: check coaching streams into a hidden buffer", async () => {
    const shown: string[] = [];
    const { sent, content } = await runCompanion([LIVE_LEAK, CLEAN], guardFor(), { onText: (text) => shown.push(text) });
    expect(sent.map((s) => s.streamed)).toEqual([true, true]);
    expect(shown).toEqual([]);
    expect(content.text).toBe(CLEAN);
  });

  it("without room in the job's reservation the guiding message comes at once, with no second call", async () => {
    let asked: unknown = null;
    const guard = guardFor({ admitRegeneration: (request) => { asked = request; return false; } });
    const { sent, result, content } = await runCompanion([LIVE_LEAK], guard);
    expect(sent).toHaveLength(1);
    expect(asked).toMatchObject({ draft: LIVE_LEAK, maxOutputTokens: 2000, used: { attempts: [expect.objectContaining({ outcome: "response" })] } });
    expect((asked as { requestBytes: number }).requestBytes).toBeGreaterThan(sent[0]!.systemInstruction.length);
    expect(content.checkCoaching).toMatchObject({ answerGuard: "fallback", withheld: "check_answer_stated" });
    expect(result.usage.attempts).toHaveLength(1);
  });

  it("a regeneration the provider never ran leaves the guiding message charged at the first call; an uncertain one fails the run with both calls' usage", async () => {
    const notSent = await runCompanion([LIVE_LEAK, new ProviderError("NETWORK_ERROR", { submission: "not_sent" })], guardFor());
    expect(notSent.content.checkCoaching).toMatchObject({ answerGuard: "fallback" });
    expect(notSent.result.usage.attempts).toHaveLength(1);
    const uncertain = Object.assign(new ProviderError("TIMEOUT", { submission: "unknown" }), { usage: { ...receipt("turn-key:answer-guard", 1000, 0), attempts: [{ attempt: 1, status: null, outcome: "unknown" as const,
      tokens: { input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null } }] } });
    const failed = await runCompanion([LIVE_LEAK, uncertain], guardFor()).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ProviderError);
    expect(failed).toMatchObject({ code: "TIMEOUT", submission: "unknown" });
    expect((failed as ProviderError).usage!.attempts.map((a) => a.outcome)).toEqual(["response", "unknown"]);
  });

  it("an ordinary turn (no check coached) is never guarded, whatever the host passes", async () => {
    const ordinary = teachingContext(suite.dialogues.find((d) => d.id === "companion.novice.signed-order")!);
    const { sent, content } = await runCompanion(["-1 is to the right of -3, so -1 > -3. The answer is 2 steps right."], guardFor(), { context: ordinary });
    expect(sent).toHaveLength(1);
    expect(content).not.toHaveProperty("checkCoaching");
  });
});

describe("the quality check runs the guard on the production path (scripted model behind the real adapter)", () => {
  it("the pilot's Hebrew dialogue: a model that leaks twice is graded on Core's guiding message, and the second request carries the note", async () => {
    const one = { ...suite, dialogues: [hebrew] };
    const { scripted, configuration, runtime } = scriptedRuntime("leaky", { [HEBREW_ID]: { kind: "text", text: LIVE_LEAK } });
    const report = await runSuite({ suite: one, configuration, runtime, mode: "scripted", model: "leaky", roles: ["companion"], beforeDialogue: (d) => { scripted.current = d.id; } });
    const run = report.roles[0]!.dialogues[0]!;
    expect(run.output).toEqual({ kind: "text", text: checkCoachingMessage(hebrew.context.question, hebrewChecks()), answerGuard: "fallback" });
    expect(run.grade.graders.find((g) => g.grader === "hint_leakage")).toEqual({ grader: "hint_leakage", passed: true, findings: [] });
    expect(scripted.requests.map((r) => r.system!.endsWith(REGENERATION_NOTE))).toEqual([false, true]);
  });

  it("a quality check's admission decides the regeneration (its conversation's allowance)", async () => {
    const one = { ...suite, dialogues: [hebrew] };
    const { scripted, configuration, runtime } = scriptedRuntime("leaky", { [HEBREW_ID]: { kind: "text", text: LIVE_LEAK } });
    const asked: string[] = [];
    const report = await runSuite({ suite: one, configuration, runtime, mode: "scripted", model: "leaky", roles: ["companion"], beforeDialogue: (d) => { scripted.current = d.id; },
      admitRegeneration: (dialogue) => { asked.push(dialogue.id); return false; } });
    expect(asked).toEqual([HEBREW_ID]);
    expect(scripted.requests).toHaveLength(1);
    expect(report.roles[0]!.dialogues[0]!.output).toMatchObject({ answerGuard: "fallback" });
  });
});
