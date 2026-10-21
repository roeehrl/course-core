import type { CourseManifest } from "@course-core/sdk";
import { retentionCourse } from "./retention-fixture.js";

/** The ordering fixture with matched pre/post items, a declared transfer item and held-out delayed checks. */
export function studyCourse(): CourseManifest {
  const c = retentionCourse();
  c.assessments.push(
    { id: "pre-min", type: "numeric", objectiveIds: ["minimum"], familyId: "pre", prompt: "Minimum of 3 and 8?", grading: { expected: 3, absoluteTolerance: 0, explanation: "3 is below 8." } },
    { id: "post-min", type: "numeric", objectiveIds: ["minimum"], familyId: "post", prompt: "Minimum of 6 and 2?", grading: { expected: 2, absoluteTolerance: 0, explanation: "2 is below 6." } },
    { id: "xfer-min", type: "numeric", objectiveIds: ["minimum"], familyId: "transfer", role: "transfer", prompt: "Lowest temperature of -4 and 1?", grading: { expected: -4, absoluteTolerance: 0, explanation: "-4 is below 1." } },
    { id: "recog-min", type: "choice", objectiveIds: ["minimum"], familyId: "recog", role: "recognition", prompt: "Pick the smaller.", options: [{ id: "a", text: "1" }, { id: "b", text: "9" }], grading: { correctOptionId: "a", explanation: "1 is below 9." } },
  );
  const min = c.chapters[0]!.episodes[0]!;
  for (const id of ["pre-min", "post-min", "xfer-min"]) min.blocks.push({ id: "block-" + id, type: "assessment", assessmentId: id });
  return c;
}
