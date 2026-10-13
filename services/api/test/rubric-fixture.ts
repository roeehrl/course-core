import type { CourseManifest } from "@course-core/sdk";
import { RUBRIC_EVALUATOR_ID, RUBRIC_EVALUATOR_INTEGRITY, RUBRIC_EVALUATOR_VERSION } from "../src/rubric-evaluator.js";
import { fixture } from "./fixture.js";

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
  const gate = c.gates.find((g) => g.id === "min-gate")!;
  gate.assessmentIds = ["min-a", "min-explain"];
  return c;
}
