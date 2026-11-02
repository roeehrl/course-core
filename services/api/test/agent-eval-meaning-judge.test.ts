import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicSuite } from "../src/agent-evals/public-suite.js";
import { gradeDialogue, type EvalOutput, type MeaningJudgement } from "../src/agent-evals/graders.js";
import { JUDGE_INSTRUCTION_HEAD, JUDGE_SCHEMA, judgeRequest, judgementOf, parseJudgeVerdict, replySpan, scriptedJudgeAnswer, scriptedVerdict } from "../src/agent-evals/judge.js";
import { dialogueDetail } from "../src/agent-evals/details.js";
import { compileOutputSchema } from "@course-core/providers";
import { scriptedRuntime } from "../src/agent-evals/scripted-model.js";
import { PUBLIC_SCRIPTED_MODELS } from "../src/agent-evals/public-suite.js";
import { composeProviders } from "../src/provider-composition.js";

/**
 * The quality check's meaning judge (agent-evals/judge.ts): its verdict parsing, quote checking and
 * fail-closed rules, and replays of real pilot replies with judge answers in the judge's exact JSON
 * shape (test/fixtures/meaning-judge-replay.json; written for these tests, no provider is called).
 * They prove the parsing and grading path, not any model's judgement.
 */
const suite = publicSuite();
const dialogue = (id: string) => suite.dialogues.find((d) => d.id === id)!;
const pass = { passed: true, reasons: [], quotes: [] };
const replay = JSON.parse(readFileSync(new URL("./fixtures/meaning-judge-replay.json", import.meta.url), "utf8")) as {
  conversations: { dialogueId: string; output: EvalOutput; judgeAnswer: string }[];
  paraphrases: { dialogueId: string; output: EvalOutput; judgeAnswer: string }[];
};
const replyOf = (output: EvalOutput) => (output.kind === "text" ? output.text : output.kind === "tool_plan" ? output.summary : "");
const judged = (answer: unknown, reply: string, self = false) => judgementOf({ model: "gemini-2.5-pro", self }, answer, reply);
const rule = (grade: ReturnType<typeof gradeDialogue>, grader: string) => grade.graders.find((g) => g.grader === grader)!;

describe("the judge's verdict", () => {
  const reply = "On the line, -1 lies to the right of -3,  so -1 is greater.";
  it("accepts structured output and one JSON object in text, fenced or not", () => {
    const verdict = { grounding: pass, factuality: { passed: false, reasons: ["Wrong order."], quotes: ["-1 lies to the right of -3"] } };
    for (const answer of [verdict, JSON.stringify(verdict), "```json\n" + JSON.stringify(verdict) + "\n```"])
      expect(parseJudgeVerdict(answer, reply)).toEqual({ verdicts: verdict, droppedQuotes: 0 });
  });

  it("keeps only quotes that are passages of the reply, and counts the invented ones", () => {
    expect(replySpan("-1 lies to the right of -3", reply)).toBe("-1 lies to the right of -3");
    // The same words with other spacing are the reply's own passage, as the reply writes it.
    expect(replySpan("-3, so -1", reply)).toBe("-3,  so -1");
    expect(replySpan("-1 is to the right of -3", reply)).toBeNull();
    expect(replySpan(" ", reply)).toBeNull();
    const parsed = parseJudgeVerdict({ grounding: pass, factuality: { passed: false, reasons: ["Says the wrong thing."],
      quotes: ["so -1 is greater", "-3 is greater than -1", "so -1 is greater"] } }, reply);
    expect(parsed).toEqual({ verdicts: { grounding: pass, factuality: { passed: false, reasons: ["Says the wrong thing."], quotes: ["so -1 is greater"] } }, droppedQuotes: 2 });
    // A passing verdict carries no quotes to mark.
    expect(parseJudgeVerdict({ grounding: { ...pass, quotes: ["so -1 is greater"] }, factuality: pass }, reply)!.verdicts.grounding.quotes).toEqual([]);
  });

  it("fails closed on anything that is not exactly the verdict", () => {
    const invalid: unknown[] = [
      null, "", "not json", "{\"grounding\": {", [], 42,
      { grounding: pass },
      { grounding: pass, factuality: pass, extra: true },
      { grounding: { ...pass, score: 1 }, factuality: pass },
      { grounding: { passed: "yes", reasons: [], quotes: [] }, factuality: pass },
      { grounding: { passed: true, reasons: "fine", quotes: [] }, factuality: pass },
      { grounding: { passed: true, reasons: [1], quotes: [] }, factuality: pass },
      // A fail must say why.
      { grounding: { passed: false, reasons: [], quotes: [] }, factuality: pass },
      { grounding: { passed: false, reasons: ["  "], quotes: [] }, factuality: pass },
      { grounding: { passed: true, reasons: Array(7).fill("x"), quotes: [] }, factuality: pass },
      { grounding: { passed: true, reasons: ["x".repeat(401)], quotes: [] }, factuality: pass },
    ];
    for (const answer of invalid) {
      expect(parseJudgeVerdict(answer, reply), JSON.stringify(answer)).toBeNull();
      expect(judged(answer, reply)).toEqual({ state: "unavailable", reason: "verdict_invalid", model: "gemini-2.5-pro", self: false });
    }
    expect(judgementOf({ model: "m", self: true }, undefined, reply, "timeout")).toEqual({ state: "unavailable", reason: "timeout", model: "m", self: true });
  });

  it("is asked for on the providers' structured-output path with a schema Core's adapters accept", () => {
    expect(() => compileOutputSchema(JUDGE_SCHEMA)).not.toThrow();
    const request = judgeRequest(dialogue("companion.guessing.check-elimination-hebrew"), "לא ניתן לאשר.");
    expect(request.systemInstruction.startsWith(JUDGE_INSTRUCTION_HEAD)).toBe(true);
    expect(request.systemInstruction).toMatch(/Paraphrases, synonyms, negation/);
    expect(request.systemInstruction).toMatch(/other languages \(for example Hebrew\)/);
    expect(request.systemInstruction).toMatch(/one false or contradicting statement fails factuality/);
    // The stated facts in plain words, the known false claims with the truth, the learner's turns and the reply as data.
    const order = judgeRequest(dialogue("companion.novice.signed-order"), "reply text");
    expect(order.prompt).toContain("- -1 lies to the right of -3 on the number line, so -1 is the greater number.");
    expect(order.prompt).toContain("minus three greater (truth: Order on the line is reversed.)");
    expect(order.prompt).toContain("<<<REPLY\nreply text\nREPLY>>>");
    expect(order.prompt).toContain(`Learner: ${dialogue("companion.novice.signed-order").context.question}`);
    // Tool-loop plans are judged against what their tools return.
    expect(judgeRequest(dialogue("supervisor.tool-loop.novice.single-error"), "plan").prompt).toContain("What the planner's tools return:");
  });
});

describe("grading with the judge", () => {
  const order = dialogue("companion.novice.signed-order");
  const vague: EvalOutput = { kind: "text", text: "Picture the line: -3 sits further left, so moving along to the right you meet -1 later, and that makes -1 the bigger of the two values." };
  it("the judge's verdicts decide grounding and factuality; every other rule stays fixed", () => {
    // The pattern graders miss this paraphrase; the judge reads it.
    expect(gradeDialogue(order, vague).graders.filter((g) => !g.passed).map((g) => g.grader)).toEqual(["grounding", "factuality"]);
    expect(gradeDialogue(order, vague, judged({ grounding: pass, factuality: pass }, replyOf(vague)))).toMatchObject({ passed: true });
    const failing = judged({ grounding: pass, factuality: { passed: false, reasons: ["Wrong."], quotes: [] } }, replyOf(vague));
    expect(rule(gradeDialogue(order, vague, failing), "factuality")).toEqual({ grader: "factuality", passed: false, findings: ["judge_failed"] });
    // A label is still the fixed rule's to catch, whatever the judge says.
    const labelled: EvalOutput = { kind: "text", text: `${replyOf(vague)} You're clearly confused about negatives.` };
    const grade = gradeDialogue(order, labelled, judged({ grounding: pass, factuality: pass }, replyOf(labelled)));
    expect(grade.graders.filter((g) => !g.passed).map((g) => g.grader)).toEqual(["diagnosis_restraint"]);
  });

  it("a judge that could not run is neither a pass nor a fail; a fixed failure still fails", () => {
    const none: MeaningJudgement = { state: "unavailable", reason: "verdict_invalid", model: "gemini-2.5-pro", self: false };
    const grade = gradeDialogue(order, vague, none);
    expect(grade).toMatchObject({ passed: false, undetermined: true });
    expect(rule(grade, "factuality")).toEqual({ grader: "factuality", passed: false, findings: ["judge_unavailable:verdict_invalid"], undetermined: true });
    const labelled: EvalOutput = { kind: "text", text: `${replyOf(vague)} You're clearly confused.` };
    expect(gradeDialogue(order, labelled, none).undetermined).toBeUndefined();
    // A quotation the material does not contain is a structural grounding failure, not the judge's.
    const quoted: EvalOutput = { kind: "text", text: `${replyOf(vague)} The lesson says "negative numbers are always smaller than every fraction".` };
    expect(rule(gradeDialogue(order, quoted, none), "grounding")).toEqual({ grader: "grounding", passed: false, findings: ["unverifiable_quote"] });
  });

  it("shows the judge's model, reasons and quotes as the evidence of a judged rule, labelled when the model judged itself", () => {
    const reply = replyOf(vague), judgement = judged({ grounding: pass, factuality: { passed: false, reasons: ["It calls -1 bigger without saying why."],
      quotes: ["that makes -1 the bigger of the two values", "invented"] } }, reply, true);
    const detail = dialogueDetail(order, vague, gradeDialogue(order, vague, judgement), [], judgement);
    const factuality = detail.graders.find((g) => g.grader === "factuality")!;
    expect(factuality).toEqual({ grader: "factuality", applies: true, passed: false,
      judge: { model: "gemini-2.5-pro", self: true, state: "judged", reasons: ["It calls -1 bigger without saying why."] },
      findings: [{ code: "judge_failed", match: "that makes -1 the bigger of the two values" }] });
    expect(detail.graders.find((g) => g.grader === "grounding")).toMatchObject({ passed: true, judge: { state: "judged", reasons: [] }, findings: [] });
    const none = dialogueDetail(order, vague, gradeDialogue(order, vague, { state: "unavailable", reason: "timeout", model: "m", self: false }), [],
      { state: "unavailable", reason: "timeout", model: "m", self: false });
    expect(none.undetermined).toBe(true);
    expect(none.graders.find((g) => g.grader === "grounding")).toMatchObject({ undetermined: true, judge: { state: "unavailable", reason: "timeout" },
      findings: [{ code: "judge_unavailable:timeout" }] });
  });

  it("the scripted judge answers as the pattern graders grade, so scripted checks stay deterministic", () => {
    for (const [name, outputs] of Object.entries(PUBLIC_SCRIPTED_MODELS))
      for (const d of suite.dialogues) {
        const output = outputs[d.id];
        if (!output || (output.kind !== "text" && output.kind !== "plan")) continue;
        const reply = output.kind === "text" ? output.text : output.summary;
        const request = judgeRequest(d, reply), answer = scriptedJudgeAnswer(suite, request.systemInstruction, request.prompt)!;
        const verdicts = parseJudgeVerdict(answer, reply);
        expect(verdicts, `${name} ${d.id}`).not.toBeNull();
        expect(verdicts!.verdicts, `${name} ${d.id}`).toEqual(scriptedVerdict(d, reply));
      }
    expect(scriptedJudgeAnswer(suite, "You are a tutor.", "Conversation: x")).toBeNull();
  });

  it("judges with the reviewer job's model, else the strongest stable text model on the tutor's connection, else the tutor's", () => {
    const model = (id: string, remoteModel: string, providerId = "google-a") => ({ id, providerId, remoteModel, enabled: true,
      capabilities: ["tutoring", "structured_assessment"], tools: [], limits: { maxInputCharacters: 100000, maxOutputTokens: 8192 },
      providerConfig: { transport: "generate_content", apiVersion: "v1beta", maxResponseBytes: 1000000 } });
    const models = [model("tutor", "gemini-3.8-flash"), model("preview", "gemini-3.9-pro-preview"), model("pro", "gemini-2.5-pro"),
      model("lite", "gemini-3.8-flash-lite"), model("other", "gemini-3.0-pro", "google-b")];
    const binding = (modelId: string) => ({ modelId, maxInputCharacters: 12000, maxOutputTokens: 4096 });
    const runtime = (roles: Record<string, unknown>) => composeProviders({ registry: { revision: "judge", models },
      adapters: [{ id: "google-a", kind: "google", credentialEnv: "GOOGLE_API_KEY" }, { id: "google-b", kind: "google", credentialEnv: "COURSE_PROVIDER_B_API_KEY" }],
      roles }, (name) => (name === "GOOGLE_API_KEY" || name === "COURSE_PROVIDER_B_API_KEY" ? "offline" : undefined));
    const order = (roles: Record<string, unknown>) => runtime(roles).meaningJudgeCandidates(["companion"]).map((p) => [p.remoteModel, p.source]);
    // No reviewer: the strongest non-preview model of the tutor's connection, never the preview or another connection's.
    expect(order({ companion: binding("tutor") })).toEqual([["gemini-2.5-pro", "strongest"], ["gemini-3.8-flash", "strongest"], ["gemini-3.8-flash-lite", "strongest"]]);
    // The reviewer job's model judges when it is set, even a weaker one.
    expect(order({ companion: binding("tutor"), reviewer: binding("lite") })[0]).toEqual(["gemini-3.8-flash-lite", "reviewer"]);
    // A setup with only the tutor's model: it judges itself.
    const alone = composeProviders({ registry: { revision: "judge", models: [models[0]] }, adapters: [{ id: "google-a", kind: "google", credentialEnv: "GOOGLE_API_KEY" }],
      roles: { companion: binding("tutor") } }, () => "offline").meaningJudgeCandidates(["companion"]);
    expect(alone.map((p) => [p.remoteModel, p.capability])).toEqual([["gemini-3.8-flash", "structured_assessment"]]);
  });

  it("only a ready text model judges, the reviewer job's model first", () => {
    const { runtime } = scriptedRuntime("reference", PUBLIC_SCRIPTED_MODELS.reference, "all");
    // The reviewer is bound to the text model; the research and image models are other jobs' models.
    expect(runtime.meaningJudgeCandidates(["companion", "media"]).map((p) => [p.modelId, p.source])).toEqual([["eval-scripted", "reviewer"]]);
  });
});

describe("real pilot replies, judged", () => {
  it("each recorded judge answer grades the reply as the judge decided, its quotes the reply's own", () => {
    for (const { dialogueId, output, judgeAnswer } of [...replay.conversations, ...replay.paraphrases]) {
      const d = dialogue(dialogueId), reply = replyOf(output), answer = JSON.parse(judgeAnswer);
      const judgement = judged(judgeAnswer, reply);
      expect(judgement.state, dialogueId).toBe("judged");
      const grade = gradeDialogue(d, output, judgement);
      for (const grader of ["grounding", "factuality"] as const) {
        expect(rule(grade, grader).passed, `${dialogueId} ${grader}`).toBe(answer[grader].passed);
        if (judgement.state === "judged") for (const quote of judgement.verdicts[grader].quotes) expect(reply, dialogueId).toContain(quote);
      }
    }
  });

  it("passes the correct replies the pattern graders failed on paraphrase, Hebrew and negation, and a vague one that states nothing false", () => {
    const [english, hebrew, negation, vague, invented] = replay.paraphrases;
    // The patterns still miss these two (#268's synonyms now catch the negation one offline too).
    for (const c of [english!, hebrew!]) expect(rule(gradeDialogue(dialogue(c.dialogueId), c.output), "factuality").passed, c.dialogueId).toBe(false);
    for (const c of [english!, hebrew!, negation!]) {
      const d = dialogue(c.dialogueId);
      expect(gradeDialogue(d, c.output, judged(c.judgeAnswer, replyOf(c.output))).passed, replyOf(c.output)).toBe(true);
    }
    // Leaving a fact out is not a factuality failure (judge version 3); the pattern grader offline still asks for it.
    const lazy = gradeDialogue(dialogue(vague!.dialogueId), vague!.output, judged(vague!.judgeAnswer, replyOf(vague!.output)));
    expect(rule(lazy, "factuality")).toEqual({ grader: "factuality", passed: true, findings: [] });
    expect(rule(gradeDialogue(dialogue(vague!.dialogueId), vague!.output), "factuality").findings).toEqual(["missing_fact:minus-one-right-of-minus-three"]);
    // The made-up quote ("the plant got much smaller") is dropped; the reply's own are kept.
    const made = judged(invented!.judgeAnswer, replyOf(invented!.output));
    expect(made).toMatchObject({ state: "judged", droppedQuotes: 1 });
    if (made.state === "judged") expect(made.verdicts.factuality.quotes).toEqual(["Yes, the plant shrank by 3 cm"]);
  });

  it("keeps the fixed checks fixed: the reply that gives the check's answer away fails whatever the judge says", () => {
    const c = replay.conversations.find((x) => x.dialogueId === "companion.terse.endpoint-answer")!;
    const grade = gradeDialogue(dialogue(c.dialogueId), c.output, judged(c.judgeAnswer, replyOf(c.output)));
    expect(grade.graders.filter((g) => !g.passed).map((g) => g.grader)).toEqual(["hint_leakage"]);
  });
});

describe("factuality judges what the reply states, never what it leaves out", () => {
  // Replies gemini-3.8-flash gave on the pilot (suite 2.6.0) that judge version 2 failed only on
  // factuality, for facts the reply did not restate. The judge answers are stubs in the judge's exact
  // JSON shape, written for these tests: no provider is called.
  const travel = dialogue("companion.expert.distance-change-travel"), close = dialogue("companion.novice.two-correct-answers");
  const travelReply: EvalOutput = { kind: "text", text: "Yes, that's exactly right. Distance is |finish - start|, net change is signed (finish minus start), and total travel needs the route itself, since a route can double back. For example, 0 → 5 → 2: the distance between the endpoints is 2, the net change is +2, and the total travel is 5 + 3 = 8." };
  const closeReply: EvalOutput = { kind: "text", text: "Spot on! You have demonstrated how to compare negative numbers by using their positions on the number line. Continue with the next part of the lesson, or try the lesson's own check." };
  const factualityOf = (passed: boolean, reason: string, quotes: string[] = []) => JSON.stringify({ grounding: pass, factuality: { passed, reasons: [reason], quotes } });

  it("tells the judge to fail only false or contradicting claims, including a wrong answer confirmed, and never omissions or brevity", () => {
    const { systemInstruction, prompt } = judgeRequest(travel, replyOf(travelReply));
    expect(systemInstruction).not.toMatch(/must (?:actually )?be conveyed/);
    expect(systemInstruction).not.toMatch(/does not convey a required fact/);
    expect(systemInstruction).toMatch(/factuality: the reply states nothing false\. It fails only when something the reply says is false or contradicts the lesson material or the reference facts/);
    expect(systemInstruction).toMatch(/confirms a learner's answer or reasoning that is wrong \(calling a wrong answer right is a false claim\)/);
    expect(systemInstruction).toMatch(/It never fails for what the reply leaves out/);
    expect(systemInstruction).toMatch(/A short confirmation of a learner's correct answer .* is factual/);
    expect(systemInstruction).toMatch(/a fact it leaves unsaid is never a factuality problem/);
    // The dialogue's required facts reach the judge as reference truths, not as facts the reply must state.
    expect(prompt).not.toMatch(/each must be conveyed/);
    expect(prompt).toContain("Reference facts (true; the reply need not state them, but must not contradict them or confirm a learner answer that does):\n- Distance, the gap between two positions, is never negative.");
    expect(judgeRequest(close, replyOf(closeReply)).prompt).toContain("- -3 is greater than -6 because it lies to the right of -6.");
  });

  it("passes the expert's confirmed distinctions with a correct worked example, though it does not say distance is never negative", () => {
    const judgement = judged(factualityOf(true, "Everything it states agrees with the lesson, including the 0 to 5 to 2 route."), replyOf(travelReply), true);
    expect(gradeDialogue(travel, travelReply, judgement)).toMatchObject({ passed: true });
    // Offline, the pattern grader still asks for the fact; the judge does not.
    expect(rule(gradeDialogue(travel, travelReply), "factuality").findings).toEqual(["missing_fact:distance-nonnegative"]);
  });

  it("passes a brief confirmation of a correct answer that closes back to the lesson", () => {
    const judgement = judged(factualityOf(true, "It confirms the learner's correct answer, -3, and says nothing false."), replyOf(closeReply), true);
    const grade = gradeDialogue(close, closeReply, judgement);
    expect(grade).toMatchObject({ passed: true });
    expect(rule(grade, "pacing")).toMatchObject({ passed: true });
  });

  it("still fails a reply that confirms a wrong answer as right", () => {
    const wrong = { ...close, context: { ...close.context, question: "-6, it is to the right of -3." } };
    const { prompt } = judgeRequest(wrong, replyOf(closeReply));
    expect(prompt).toContain("Learner: -6, it is to the right of -3.");
    expect(prompt).toContain("minus six greater (truth: -3 lies to the right of -6, so -3 is greater.)");
    const judgement = judged(factualityOf(false, "It calls the learner's answer -6 right, but -3 is the greater number because it lies to the right of -6.", ["Spot on!"]), replyOf(closeReply), true);
    const grade = gradeDialogue(wrong, closeReply, judgement);
    expect(grade.passed).toBe(false);
    expect(grade.graders.filter((g) => !g.passed).map((g) => g.grader)).toEqual(["factuality"]);
    expect(rule(grade, "factuality")).toEqual({ grader: "factuality", passed: false, findings: ["judge_failed"] });
    expect(judgement).toMatchObject({ state: "judged", verdicts: { factuality: { quotes: ["Spot on!"] } } });
  });
});
