import type { CourseManifest, VersionedProgressionGate } from "@course-core/sdk";
import type { RuntimeExtension } from "../src/publication.js";
import { ApiError } from "../src/errors.js";
import { RUBRIC_EVALUATOR_ID, RUBRIC_EVALUATOR_INTEGRITY, RUBRIC_EVALUATOR_VERSION } from "../src/rubric-evaluator.js";
import { fixture } from "./fixture.js";

export const REPAIR_EVALUATOR_ID = "public-repair-stub";
export const REPAIR_EVALUATOR_INTEGRITY = "sha256-" + "c".repeat(64);
/** A data-only stand-in for the installed code evaluator: it compares the submitted source with a
 * known repaired line. It proves the routing and evidence path only; real execution is covered by
 * the sandbox qualification, never by this stub. */
export function repairEvaluatorStub(): RuntimeExtension {
  return { id: REPAIR_EVALUATOR_ID, version: "1.0.0", integrity: REPAIR_EVALUATOR_INTEGRITY, capabilities: ["assessment.evaluate"], platforms: ["web"], codeReady: true,
    validateCodeAssessment(assessment) { if (assessment.type !== "code" || assessment.grading.fixtureRef !== "minimum-repair") throw new ApiError(409, "CODE_FIXTURE_NOT_FOUND"); },
    async evaluateCode(_assessment, source) {
      const passed = typeof source === "string" && source.includes("if value < best:");
      return { passed, explanation: passed ? "All 3 hidden reference cases matched." : "1 of 3 reference cases matched.", evaluator: `${REPAIR_EVALUATOR_ID}@1.0.0`,
        execution: { status: "graded", sourceDigest: "0".repeat(64), durationMs: 1, passedCases: passed ? 3 : 1, totalCases: 3, runtime: { protocol: "python-json-v1", image: "stub" } } };
    } };
}

export const teachBackAnswer =
  "The kept value is never greater than any value seen so far, because each step keeps the smaller one. For example with 7, 3 and 9 I keep 7, then 3, and 9 never replaces it.";
export const conversationAnswer =
  "I keep the smallest value seen so far and compare every next value with it. The kept value is never greater than any value already seen. With 8, 2 and 5 my kept value goes 8, then 2, and stays 2.";

/** The public ordering fixture with a 0.5 versioned gate on its first episode (the second keeps
 * its 0.4 gate): two item families, a transfer task, a critical misconception check, six new item
 * types and a conversational rubric whose judgments a human must confirm with quotes. */
export function gatedCourse(version = "5.0.0", options: { conversation?: boolean } = {}): CourseManifest {
  const c = fixture();
  c.version = version;
  c.extensions.push(
    { id: RUBRIC_EVALUATOR_ID, version: RUBRIC_EVALUATOR_VERSION, integrity: RUBRIC_EVALUATOR_INTEGRITY, platforms: ["web"], execution: "server",
      entrypoint: "evaluators/reviewed-rubric-v1.json", capabilities: ["assessment.evaluate"],
      accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Written explanation reviewed against a rubric." } },
    { id: REPAIR_EVALUATOR_ID, version: "1.0.0", integrity: REPAIR_EVALUATOR_INTEGRITY, platforms: ["web"], execution: "server",
      entrypoint: "evaluators/repair.json", capabilities: ["assessment.evaluate"],
      accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Repair a short Python function." } },
  );
  c.hypotheses = [{ id: "picks-larger", kind: "misconception", statement: "Keeps the larger value when asked for the smaller one.", objectiveIds: ["minimum"], critical: true },
    { id: "misread", kind: "slip", statement: "Misread one of the values.", objectiveIds: ["minimum"] }];
  // A diagnostic probe separates the two explanations; probes never count toward the gate.
  c.probes = [{ id: "larger-or-slip", objectiveId: "minimum", assessmentId: "min-probe", distinguishes: ["picks-larger", "misread"],
    signals: [{ hypothesisId: "picks-larger", optionIds: ["nine"] }, { hypothesisId: "misread", optionIds: ["six"] }] }];
  c.rubrics = [{ id: "explain-minimum", version: "1.0.0", title: "Explaining a running minimum", requiresCitedEvidence: true, uncertain: "pending_review", criteria: [
    { id: "invariant", description: "States that the kept value is never greater than any value already seen.", required: true, evidence: "cited_learner_span" },
    { id: "own-example", description: "Works through an example of their own.", required: true, evidence: "cited_learner_span" },
  ] }];
  c.evaluators = [
    { id: "reviewed-explanations", version: "1.0.0", extensionId: RUBRIC_EVALUATOR_ID, method: "rubric_model_assisted", itemTypes: ["teach_back", "counterexample", "experiment_design"],
      rubricIds: ["explain-minimum"], humanConfirmation: "required", outputs: { uncertainty: true, provenance: true },
      tests: { fixtureRef: "fixtures/explanations.json", acceptsValidVariants: true, rejectsMisconceptions: true } },
    { id: "repair-tests", version: "1.0.0", extensionId: REPAIR_EVALUATOR_ID, method: "code_tests", itemTypes: ["code_repair"], humanConfirmation: "none",
      outputs: { uncertainty: true, provenance: true }, tests: { fixtureRef: "fixtures/repair.json", acceptsValidVariants: true, rejectsMisconceptions: true } },
  ];
  c.adaptationPolicies = [{ id: "remediate", version: "1.0.0", maxCyclesPerConcept: 2, strategies: ["worked_example", "contrast_case"], onExhausted: "close_with_gaps", autoApply: "never", learnerUndo: true }];
  const choice = c.assessments.find((a) => a.id === "min-a")!;
  if (choice.type === "choice") choice.options[1]!.misconceptionId = "picks-larger";
  c.assessments.push(
    { id: "min-probe", type: "choice", objectiveIds: ["minimum"], familyId: "probe", role: "diagnostic_probe", prompt: "Which is the minimum of 3 and 9?",
      options: [{ id: "three", text: "3" }, { id: "nine", text: "9" }, { id: "six", text: "6" }], grading: { correctOptionId: "three", explanation: "3 is below 9." } },
    { id: "min-predict", type: "prediction", objectiveIds: ["minimum"], familyId: "predict", role: "transfer", misconceptionIds: ["picks-larger"],
      prompt: "Predict the running minimum after reading 12.5, 40 and 18.", confidence: { capture: "optional", scale: { minimum: 1, maximum: 5 } },
      grading: { expected: 12.5, absoluteTolerance: 0, relativeTolerance: 0.01, unit: "cm", explanation: "12.5 is never replaced by a larger value." } },
    { id: "min-trace", type: "trace", objectiveIds: ["minimum"], familyId: "trace", role: "application", prompt: "Trace the kept value while reading 6, 4, 9.",
      steps: [{ id: "s1", prompt: "After 6" }, { id: "s2", prompt: "After 4" }, { id: "s3", prompt: "After 9" }],
      grading: { expected: [{ stepId: "s1", answer: "6" }, { stepId: "s2", answer: "4" }, { stepId: "s3", answer: "4" }], match: "normalized_whitespace", explanation: "9 is larger, so 4 stays." } },
    { id: "min-repair", type: "code_repair", objectiveIds: ["minimum"], familyId: "repair", role: "transfer", language: "python",
      starterCode: "def solve(values):\n    best = values[0]\n    for value in values:\n        if value > best:\n            best = value\n    return best\n",
      prompt: "Repair solve(values) so that it returns the minimum.", grading: { evaluatorId: "repair-tests", fixtureRef: "minimum-repair" } },
    { id: "min-teach", type: "teach_back", objectiveIds: ["minimum"], familyId: "explain", role: "transfer", allowAbstain: false,
      prompt: "Teach a friend how to find the minimum of a list, with an example of your own.", grading: { evaluatorId: "reviewed-explanations", rubricId: "explain-minimum" } },
    { id: "min-counter", type: "counterexample", objectiveIds: ["minimum"], familyId: "counter", role: "transfer",
      prompt: "Give a list for which keeping the larger value returns the wrong minimum, and explain why.", grading: { evaluatorId: "reviewed-explanations", rubricId: "explain-minimum" } },
    { id: "min-design", type: "experiment_design", objectiveIds: ["minimum"], familyId: "design", role: "transfer",
      prompt: "Design a check that would reveal a program keeping the larger value.", grading: { evaluatorId: "reviewed-explanations", rubricId: "explain-minimum" } },
  );
  const gate: VersionedProgressionGate = {
    id: "min-gate", version: "1.0.0", scope: { kind: "episode", episodeId: "min" }, requiredObjectives: ["minimum"],
    readinessCriteria: [
      { id: "families", kind: "independent_success", description: "Independent success in two item families.", objectiveIds: [] },
      { id: "transfer", kind: "transfer_success", description: "Independent success on a new transfer task.", objectiveIds: [] },
      { id: "no-mix-up", kind: "no_critical_misconception", description: "No unresolved critical misconception.", objectiveIds: [] },
    ],
    eligibleEvidenceKinds: ["deterministic_interactive_check", "verified_practical_task", ...(options.conversation ? ["rubric_backed_conversation" as const] : [])],
    minimumIndependentEvidence: { families: 2, transferItems: 1 },
    interactiveCheckRefs: ["min-a", "min-b", "min-predict", "min-trace"], practicalTaskRefs: ["min-repair", "min-teach", "min-counter", "min-design"],
    ...(options.conversation ? { conversationalRubricRef: "explain-minimum" } : {}),
    assistancePolicy: { assistedEvidence: "recorded_not_counted", revealRequiresFreshEvidence: true, agentAuthoredAnswers: "rejected", reattemptsOfSameItem: "not_independent" },
    nextActivityId: "max", remediationPolicyRef: "remediate", capPolicyRef: "course", appealPolicy: { allowed: true, windowDays: 14, reviewer: "staff" },
  };
  c.gates[0] = gate;
  return c;
}
