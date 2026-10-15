import type { CourseManifest } from "@course-core/sdk";
import { RUBRIC_EVALUATOR_ID, RUBRIC_EVALUATOR_INTEGRITY, RUBRIC_EVALUATOR_VERSION } from "../src/rubric-evaluator.js";
import { fixture } from "./fixture.js";
import { legacyGate } from "./legacy-gate.js";

export const rubricExplanation =
  "To find the minimum I keep the smallest value seen so far and compare every next element with it. Because each comparison keeps the smaller value, the kept value is never greater than any element.";
/** The public ordering fixture with a reviewed written explanation in its first gate. */
export function rubricCourse(version = "2.0.0"): CourseManifest {
  const c = fixture();
  c.version = version;
  c.extensions.push({
    id: RUBRIC_EVALUATOR_ID, version: RUBRIC_EVALUATOR_VERSION, integrity: RUBRIC_EVALUATOR_INTEGRITY, platforms: ["web"], execution: "server",
    entrypoint: "evaluators/reviewed-rubric-v1.json", capabilities: ["assessment.evaluate"],
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Written explanation reviewed against a rubric." },
  });
  c.assessments.push({
    id: "min-explain", type: "rubric", objectiveIds: ["minimum"], familyId: "explain",
    prompt: "Explain why keeping the smaller value at each comparison finds the minimum.",
    grading: { evaluatorId: RUBRIC_EVALUATOR_ID, rubric: [
      { id: "invariant", description: "States the invariant: the kept value is never greater than any element seen.", required: true },
      { id: "every-element", description: "Explains that every element is compared once.", required: true },
      { id: "edge", description: "Mentions the empty-list case.", required: false },
    ] },
  });
  const gate = legacyGate(c.gates.find((g) => g.id === "min-gate"));
  gate.assessmentIds = ["min-a", "min-explain"];
  return c;
}

export const maximumExplanation =
  "To find the maximum I keep the largest value seen so far and compare every next element with it, keeping the larger value each time.";
/** Placement reaches a reviewed written explanation in the SECOND episode, which
 * stays locked during placement: its first placement question is the written one. */
export function placementWrittenCourse(version = "3.0.0"): CourseManifest {
  const c = rubricCourse(version);
  legacyGate(c.gates.find((g) => g.id === "min-gate")).assessmentIds = ["min-a", "min-b"];
  c.assessments = c.assessments.filter((a) => a.id !== "min-explain");
  c.assessments.push({
    id: "max-explain", type: "rubric", objectiveIds: ["maximum"], familyId: "explain",
    prompt: "Explain why keeping the larger value at each comparison finds the maximum.",
    grading: { evaluatorId: RUBRIC_EVALUATOR_ID, rubric: [
      { id: "invariant", description: "States the invariant: the kept value is never less than any element seen.", required: true },
      { id: "every-element", description: "Explains that every element is compared once.", required: true },
    ] },
  });
  legacyGate(c.gates.find((g) => g.id === "max-gate")).assessmentIds = ["max-explain", "max-a", "max-b"];
  c.placement!.assessmentIds = ["min-a", "min-b", "max-explain", "max-a", "max-b"];
  c.placement!.maxItems = 4;
  return c;
}
