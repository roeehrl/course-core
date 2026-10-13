import type { CourseManifest } from "@course-core/sdk";
import { fixture } from "./fixture.js";

/** Public ordering fixture with two held-out delayed checks for "minimum". */
export function retentionCourse(): CourseManifest {
  const c = fixture() as CourseManifest & { retention?: unknown };
  c.assessments.push(
    { id: "min-later-1", type: "numeric", objectiveIds: ["minimum"], familyId: "delayed", prompt: "Minimum of 12 and 7?", grading: { expected: 7, absoluteTolerance: 0, explanation: "7 is below 12." } },
    { id: "min-later-2", type: "numeric", objectiveIds: ["minimum"], familyId: "delayed", prompt: "Minimum of -2 and 5?", grading: { expected: -2, absoluteTolerance: 0, explanation: "-2 is below 5." } },
  );
  c.retention = { intervalsDays: [1, 3, 7, 21], objectiveIds: ["minimum"], assessmentIds: ["min-later-1", "min-later-2"] };
  return c;
}
