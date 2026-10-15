import { describe, expect, it } from "vitest";
import { decideGate, type CourseManifest, type VersionedProgressionGate } from "@course-core/sdk";
import { assertCourseRunnable, assertVersionedGateRules } from "../src/publication.js";
import { evaluateGate, type AttemptSignal, type GateEvidence } from "../src/gates.js";
import { publicQuestion } from "../src/learning.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { gatedCourse, repairEvaluatorStub } from "./gated-fixture.js";

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
