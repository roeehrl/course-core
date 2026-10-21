import { describe, expect, it } from "vitest";
import { decideGate, type CourseManifest, type VersionedProgressionGate } from "@course-core/sdk";
import { assertCourseRunnable, assertVersionedGateRules, recognitionOnlyLegacyGates } from "../src/publication.js";
import { evaluateGate, type AttemptSignal, type GateEvidence } from "../src/gates.js";
import { gradeDeterministic, numericAnswer, publicQuestion } from "../src/learning.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { gatedCourse, repairEvaluatorStub } from "./gated-fixture.js";
import { fixture } from "./fixture.js";
import type { LegacyProgressionGate } from "@course-core/sdk";

const digest = "d".repeat(64);
const items: Record<string, { family: string; objective: string }> = {
  "min-a": { family: "compare", objective: "minimum" }, "min-b": { family: "select", objective: "minimum" }, "min-predict": { family: "predict", objective: "minimum" },
  "min-trace": { family: "trace", objective: "minimum" }, "min-repair": { family: "repair", objective: "minimum" },
};
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 15, 10, 0, clock++)).toISOString();
interface Step { item: string; outcome: "correct" | "incorrect" | "abstained" | "pending_review"; misconception?: string }
/** One scenario in both Core's persisted shape and the SDK record shape. */
function scenario(steps: Step[]) {
  const evidence: GateEvidence[] = [], signals: AttemptSignal[] = [], sdk: unknown[] = [];
  steps.forEach((step, i) => {
    const time = at(), id = `e${i}`, { family, objective } = items[step.item]!;
    signals.push({ id: `a${i}`, assessment_id: step.item, course_digest: digest, mode: "independent", outcome: step.outcome, misconception_ids: step.misconception ? [step.misconception] : [], at: time });
    if (step.outcome === "correct" || step.outcome === "incorrect")
      evidence.push({ id, attempt_id: `a${i}`, objective_id: objective, family_id: family, assessment_id: step.item, independent: true, course_digest: digest, mode: "independent", result: { passed: step.outcome === "correct" }, created_at: time });
    sdk.push({ id, attemptId: `a${i}`, enrollmentId: "enrollment-1", courseDigest: digest, assessmentId: step.item, familyId: family, objectiveIds: [objective],
      mode: "deterministic_check", outcome: step.outcome, independence: "independent", author: "learner", assistance: { hintsUsed: 0, answerRevealed: false, tutorAuthoredContent: false },
      reattemptOf: null, misconceptionIds: step.misconception ? [step.misconception] : [], confidence: null, evaluator: { id: "deterministic", version: "1.0.0" }, issuedAt: time });
  });
  return { evidence, signals, sdk };
}
const course = () => gatedCourse("5.0.0");
const gate = (c: CourseManifest) => c.gates[0] as VersionedProgressionGate;

describe("Core gate evaluator", () => {
  it.each([
    ["no evidence", [], false, "needs_evidence"],
    ["two families with production transfer", [{ item: "min-b", outcome: "correct" }, { item: "min-predict", outcome: "correct" }], false, "ready"],
    ["recognition and application only", [{ item: "min-a", outcome: "correct" }, { item: "min-trace", outcome: "correct" }], false, "needs_evidence"],
    ["unresolved critical misconception", [{ item: "min-a", outcome: "incorrect", misconception: "picks-larger" }, { item: "min-b", outcome: "correct" }, { item: "min-repair", outcome: "correct" }], false, "needs_evidence"],
    ["misconception later ruled out", [{ item: "min-a", outcome: "incorrect", misconception: "picks-larger" }, { item: "min-b", outcome: "correct" }, { item: "min-predict", outcome: "correct" }], false, "ready"],
    ["repeated failure", [{ item: "min-a", outcome: "incorrect" }, { item: "min-b", outcome: "incorrect" }], false, "needs_help"],
    ["cap reached", [{ item: "min-b", outcome: "correct" }], true, "closed_with_gaps"],
  ] as const)("%s: same status as the SDK reference evaluator", (_name, steps, capReached, expected) => {
    const c = course(), s = scenario([...steps]);
    const core = evaluateGate(c, gate(c), s.evidence, digest, { signals: s.signals, capReached, policyRevision: 3 });
    const reference = decideGate(c, "min-gate", s.sdk, { decisionId: "decision-1", enrollmentId: "enrollment-1", courseDigest: digest, policyRevision: 3, decidedAt: at(), capReached });
    expect(reference.valid).toBe(true);
    expect(core.status).toBe(expected);
    expect(core.status).toBe(reference.valid ? reference.decision.status : "invalid");
    expect(core.passed).toBe(expected === "ready");
  });
  it("counts a conversation only when it is reviewed, quoted and bound to the current rubric version", () => {
    const c = gatedCourse("5.0.0", { conversation: true }), g = gate(c), b = scenario([{ item: "min-b", outcome: "correct" }]);
    const conversation = (result: GateEvidence["result"]): GateEvidence => ({ id: "c1", attempt_id: "c1", objective_id: "minimum", family_id: "conversation:explain-minimum",
      assessment_id: "gate-conversation:min-gate", independent: true, course_digest: digest, mode: "independent", result, created_at: at() });
    const quoted = { passed: true, reviewed: true, conversation: { gateId: "min-gate", rubricId: "explain-minimum", rubricVersion: "1.0.0" }, citedSpans: [{ turnId: "c1", quote: "never greater" }] };
    const status = (row: GateEvidence) => evaluateGate(c, g, [...b.evidence, row], digest, { signals: b.signals }).status;
    expect(status(conversation(quoted))).toBe("ready");
    expect(status(conversation({ ...quoted, citedSpans: [] }))).toBe("needs_evidence");
    expect(status(conversation({ ...quoted, reviewed: false }))).toBe("needs_evidence");
    expect(status(conversation({ ...quoted, conversation: { ...quoted.conversation, rubricVersion: "0.9.0" } }))).toBe("needs_evidence");
    expect(status({ ...conversation(quoted), independent: false })).toBe("needs_evidence");
    expect(status({ ...conversation(quoted), course_digest: "e".repeat(64) })).toBe("needs_evidence");
  });
  it("treats an abstention as a neutral signal: no evidence, no misconception, but a prompt for help", () => {
    const c = course(), s = scenario([{ item: "min-predict", outcome: "abstained" }, { item: "min-b", outcome: "abstained" }]);
    const decision = evaluateGate(c, gate(c), s.evidence, digest, { signals: s.signals });
    expect(s.evidence).toEqual([]);
    expect(decision).toMatchObject({ status: "needs_help", unresolvedMisconceptionIds: [], evidenceRefs: [] });
  });
});

describe("publish-time assessment rules", () => {
  const installed = [reviewedRubricEvaluator(), repairEvaluatorStub()];
  it("publishes the versioned fixture with its installed evaluators", () => {
    expect(() => assertCourseRunnable(gatedCourse("5.0.0"), installed)).not.toThrow();
    expect(() => assertCourseRunnable(gatedCourse("5.0.0", { conversation: true }), installed)).not.toThrow();
    expect(() => assertCourseRunnable(gatedCourse("5.0.0"), [reviewedRubricEvaluator()])).toThrowError(/PUBLISH_CAPABILITY_MISSING/);
  });
  it("refuses gates that bypassed SDK validation: recognition only, unreachable transfer, unchecked misconceptions", () => {
    const c = course();
    expect(() => assertVersionedGateRules(c, { ...gate(c), interactiveCheckRefs: ["min-a"], practicalTaskRefs: [] })).toThrowError(/PUBLISH_RECOGNITION_ONLY_GATE/);
    expect(() => assertVersionedGateRules(c, { ...gate(c), interactiveCheckRefs: ["min-a", "min-b"], practicalTaskRefs: [] })).toThrowError(/PUBLISH_TRANSFER_EVIDENCE_REQUIRED/);
    expect(() => assertVersionedGateRules(c, { ...gate(c), readinessCriteria: gate(c).readinessCriteria.filter((r) => r.kind !== "transfer_success") })).toThrowError(/PUBLISH_TRANSFER_EVIDENCE_REQUIRED/);
    expect(() => assertVersionedGateRules(c, { ...gate(c), minimumIndependentEvidence: { families: 2, transferItems: 9 } })).toThrowError(/PUBLISH_TRANSFER_EVIDENCE_REQUIRED/);
    expect(() => assertVersionedGateRules(c, { ...gate(c), readinessCriteria: gate(c).readinessCriteria.filter((r) => r.kind !== "no_critical_misconception") })).toThrowError(/PUBLISH_MISCONCEPTION_CHECK_REQUIRED/);
    expect(() => assertVersionedGateRules(c, { ...gate(c), interactiveCheckRefs: ["min-b", "min-trace"], practicalTaskRefs: ["min-repair"] })).toThrowError(/PUBLISH_MISCONCEPTION_CHECK_REQUIRED/);
    expect(() => assertVersionedGateRules(c, gate(c))).not.toThrow();
  });
  it("never serves keys, misconception links or roles in a question", () => {
    const c = course();
    for (const item of c.assessments) {
      const question = JSON.stringify(publicQuestion(item, c));
      expect(question, item.id).not.toMatch(/grading|familyId|misconception|"role"|correctOptionId|expected|fixtureRef|rubricId/);
    }
  });
});

describe("numeric answers with units and relative tolerance", () => {
  const predict = () => course().assessments.find((a) => a.id === "min-predict")!;
  const error = (work: () => unknown) => { try { work(); } catch (cause) { return cause as { code: string; statusCode: number; details?: unknown }; } throw new Error("expected a refusal"); };
  it("reads a number in the declared unit, or a value with its unit stated", () => {
    expect(numericAnswer(12.5, "cm")).toBe(12.5);
    expect(numericAnswer({ value: 12.5, unit: "cm" }, "cm")).toBe(12.5);
    expect(numericAnswer({ value: -3, unit: " km / h " }, "km  /  h")).toBe(-3);
    expect(numericAnswer(4, undefined)).toBe(4);
  });
  it("refuses another unit, or a unit where none is declared, before grading and without a verdict", () => {
    expect(error(() => numericAnswer({ value: 125, unit: "mm" }, "cm"))).toMatchObject({ statusCode: 400, code: "UNIT_MISMATCH", details: { expectedUnit: "cm" } });
    expect(error(() => numericAnswer({ value: 4, unit: "cm" }, undefined))).toMatchObject({ code: "UNIT_MISMATCH", details: { expectedUnit: null } });
    expect(error(() => numericAnswer({ value: 12.5, unit: "CM" }, "cm"))).toMatchObject({ code: "UNIT_MISMATCH" });
    expect(error(() => gradeDeterministic(predict(), { value: 126, unit: "mm" }))).toMatchObject({ code: "UNIT_MISMATCH" });
    // Numeric text stays refused: numbers are sent as numbers.
    for (const bad of ["12.5", "12.5 cm", Number.NaN, Number.POSITIVE_INFINITY, null, [12.5], { value: 12.5 }, { value: "12.5", unit: "cm" },
      { value: Number.NaN, unit: "cm" }, { value: 12.5, unit: "cm", extra: 1 }, { value: 12.5, unit: "c".repeat(51) }])
      expect(error(() => numericAnswer(bad, "cm")).code, JSON.stringify(bad)).toBe("INVALID_ANSWER");
  });
  it("grades within the larger of the absolute and relative tolerance", () => {
    // 12.5 with 1% relative tolerance: within 0.125 either way.
    expect(gradeDeterministic(predict(), { value: 12.6, unit: "cm" }).passed).toBe(true);
    expect(gradeDeterministic(predict(), 12.375).passed).toBe(true);
    expect(gradeDeterministic(predict(), { value: 12.7, unit: "cm" }).passed).toBe(false);
    expect(gradeDeterministic(predict(), 12.3).passed).toBe(false);
  });
});

/** The 0.4 fixture gate, with optional critical misconceptions declared on its objective. */
function legacyCourse(options: { critical?: boolean; items?: string[] } = {}) {
  const c = fixture();
  const g = c.gates.find((x) => x.id === "min-gate") as LegacyProgressionGate;
  if (options.items) g.assessmentIds = options.items;
  if (options.critical) {
    c.hypotheses = [{ id: "picks-larger", kind: "misconception", statement: "Keeps the larger value when asked for the smaller one.", objectiveIds: ["minimum"], critical: true }];
    const choice = c.assessments.find((a) => a.id === "min-a")!;
    if (choice.type === "choice") choice.options[1]!.misconceptionId = "picks-larger";
  }
  return { c, g };
}
const row = (id: string, item: string, family: string, passed = true): GateEvidence =>
  ({ id, attempt_id: `a-${id}`, objective_id: "minimum", family_id: family, assessment_id: item, independent: true, course_digest: digest, mode: "independent", result: { passed }, created_at: at() });

describe("false-mastery rules on unversioned 0.4 gates", () => {
  it("keeps the 0.4 family rule when a produced answer is among the families", () => {
    const { c, g } = legacyCourse();
    const decision = evaluateGate(c, g, [row("e1", "min-a", "compare"), row("e2", "min-b", "select")], digest);
    expect(decision).toMatchObject({ status: "ready", passed: true, gateVersion: "legacy-0.4" });
    expect(decision.criterionResults).toHaveLength(1);
  });
  it("never demonstrates an objective on recognition alone when the gate offers a task beyond choosing", () => {
    const { c, g } = legacyCourse();
    // A second recognition family (a choice item added to the gate) is not enough on its own.
    c.assessments.push({ id: "min-c", type: "choice", objectiveIds: ["minimum"], familyId: "pick", prompt: "Which is smaller, 7 or 3?", options: [{ id: "three", text: "3" }, { id: "seven", text: "7" }],
      grading: { correctOptionId: "three", explanation: "3 is below 7." } });
    g.assessmentIds.push("min-c");
    const decision = evaluateGate(c, g, [row("e1", "min-a", "compare"), row("e2", "min-c", "pick")], digest);
    expect(decision.status).toBe("needs_evidence");
    expect(decision.objectives[0]).toMatchObject({ passed: false, families: ["compare", "pick"] });
    expect(decision.criterionResults[0]!.reason).toMatch(/beyond choosing among given answers/);
    expect(decision.messages.criteria["independent_families:minimum"]).toEqual({ code: "criterion.familiesFor.needsProduction", params: { required: 2, objectives: ["Find a minimum"] } });
    // The next step offers the produced-answer item, not another choice.
    expect(decision.nextActions[0]).toMatchObject({ kind: "attempt_check", targetId: "min-b" });
  });
  it("blocks readiness while a declared critical misconception the learner showed is not ruled out", () => {
    const { c, g } = legacyCourse({ critical: true });
    const signal = (id: string, item: string, outcome: AttemptSignal["outcome"], misconception?: string): AttemptSignal =>
      ({ id, assessment_id: item, course_digest: digest, mode: "independent", outcome, misconception_ids: misconception ? [misconception] : [], at: at() });
    const wrong = signal("s0", "min-a", "incorrect", "picks-larger");
    const b = row("e1", "min-b", "select");
    // min-b is not an item that can expose the mix-up, so it does not rule it out.
    const blocked = evaluateGate(c, g, [b, row("e2", "min-a", "compare")].map((r, i) => ({ ...r, created_at: new Date(Date.parse(wrong.at as string) - 1000 * (i + 1)).toISOString() })), digest, { signals: [wrong] });
    expect(blocked.status).toBe("needs_evidence");
    expect(blocked.unresolvedMisconceptionIds).toEqual(["picks-larger"]);
    expect(blocked.criterionResults.find((r) => r.criterionId === "no_critical_misconception")).toMatchObject({ met: false });
    expect(blocked.messages.criteria["no_critical_misconception"]).toMatchObject({ code: "criterion.misconception.open" });
    // A later independent success on an item that exposes it rules it out.
    const cleared = evaluateGate(c, g, [b, row("e3", "min-a", "compare")], digest, { signals: [wrong] });
    expect(cleared).toMatchObject({ status: "ready", unresolvedMisconceptionIds: [] });
  });
  it("keeps a 0.4 gate of recognition items only publishable (SDK compatibility) but names it for a staff warning", () => {
    const { c } = legacyCourse({ items: ["min-a"] });
    expect(recognitionOnlyLegacyGates(c)).toEqual(["min-gate"]);
    expect(() => assertCourseRunnable(c, [])).not.toThrow();
    expect(recognitionOnlyLegacyGates(legacyCourse().c)).toEqual([]);
    // Such a gate keeps its 0.4 rule: two recognition families pass it, as SDK 0.4 promised.
    const { c: only, g } = legacyCourse({ items: ["min-a"] });
    only.assessments.push({ id: "min-c", type: "choice", objectiveIds: ["minimum"], familyId: "pick", prompt: "Which is smaller, 7 or 3?", options: [{ id: "three", text: "3" }, { id: "seven", text: "7" }],
      grading: { correctOptionId: "three", explanation: "3 is below 7." } });
    g.assessmentIds.push("min-c");
    expect(evaluateGate(only, g, [row("e1", "min-a", "compare"), row("e2", "min-c", "pick")], digest).status).toBe("ready");
  });
});

describe("decision text as message codes", () => {
  it("gives every criterion, next action and the reason a code beside the English text", () => {
    const c = course(), s = scenario([{ item: "min-a", outcome: "correct" }]);
    const decision = evaluateGate(c, gate(c), s.evidence, digest, { signals: s.signals });
    expect(Object.keys(decision.messages.criteria).sort()).toEqual(decision.criterionResults.map((r) => r.criterionId).sort());
    expect(decision.messages.actions).toHaveLength(decision.nextActions.length);
    expect(decision.messages.actions.every((m) => m && /^action\./.test(m.code))).toBe(true);
    expect(decision.messages.reason).toMatchObject({ code: "reason.needs_evidence.detail", params: { more: 1 }, detail: { code: "criterion.families.unmet" } });
    // The SDK record shape is unchanged: no codes inside criteria or actions.
    expect(JSON.stringify(decision.nextActions)).not.toMatch(/"message"/);
    expect(JSON.stringify(decision.criterionResults)).not.toMatch(/"message"/);
    const ready = evaluateGate(c, gate(c), scenario([{ item: "min-b", outcome: "correct" }, { item: "min-predict", outcome: "correct" }]).evidence, digest);
    expect(ready.messages.reason).toEqual({ code: "reason.ready" });
    expect(ready.messages.actions[0]).toMatchObject({ code: "action.continueTo", params: { title: "Maximum" } });
  });
});
