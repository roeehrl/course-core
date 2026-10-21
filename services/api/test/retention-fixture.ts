import type { CourseManifest } from "@course-core/sdk";
import { RUBRIC_EVALUATOR_ID, RUBRIC_EVALUATOR_INTEGRITY, RUBRIC_EVALUATOR_VERSION } from "../src/rubric-evaluator.js";
import { fixture } from "./fixture.js";

/** Public ordering fixture with two held-out delayed checks for "minimum". `extra` adds more
 * numeric delayed checks (min-later-3 … answer 3, 4, …); `written` puts a reviewed written check first. */
export function retentionCourse(options: { extra?: number; written?: boolean } = {}): CourseManifest {
  const c = fixture() as CourseManifest & { retention?: unknown };
  c.assessments.push(
    { id: "min-later-1", type: "numeric", objectiveIds: ["minimum"], familyId: "delayed", prompt: "Minimum of 12 and 7?", grading: { expected: 7, absoluteTolerance: 0, explanation: "7 is below 12." } },
    { id: "min-later-2", type: "numeric", objectiveIds: ["minimum"], familyId: "delayed", prompt: "Minimum of -2 and 5?", grading: { expected: -2, absoluteTolerance: 0, explanation: "-2 is below 5." } },
  );
  const ids = ["min-later-1", "min-later-2"];
  for (let n = 3; n < 3 + (options.extra ?? 0); n++) {
    c.assessments.push({ id: `min-later-${n}`, type: "numeric", objectiveIds: ["minimum"], familyId: "delayed", prompt: `Minimum of ${n} and ${n + 5}?`,
      grading: { expected: n, absoluteTolerance: 0, explanation: `${n} is below ${n + 5}.` } });
    ids.push(`min-later-${n}`);
  }
  if (options.written) {
    c.extensions.push({ id: RUBRIC_EVALUATOR_ID, version: RUBRIC_EVALUATOR_VERSION, integrity: RUBRIC_EVALUATOR_INTEGRITY, platforms: ["web"], execution: "server",
      entrypoint: "evaluators/reviewed-rubric-v1.json", capabilities: ["assessment.evaluate"],
      accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Written explanation reviewed against a rubric." } });
    c.assessments.push({ id: "min-later-written", type: "rubric", objectiveIds: ["minimum"], familyId: "delayed-written",
      prompt: "Explain again, in your own words, why keeping the smaller value finds the minimum.",
      grading: { evaluatorId: RUBRIC_EVALUATOR_ID, rubric: [
        { id: "invariant", description: "States the invariant: the kept value is never greater than any element seen.", required: true },
      ] } });
    ids.unshift("min-later-written");
    // Issued first: retention picks the first fresh item in course order.
    c.assessments.splice(c.assessments.findIndex((a) => a.id === "min-later-1"), 0, c.assessments.pop()!);
  }
  c.retention = { intervalsDays: [1, 3, 7, 21], objectiveIds: ["minimum"], assessmentIds: ids };
  return c;
}
