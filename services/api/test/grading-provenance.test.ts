import { describe, expect, it } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { DETERMINISTIC_GRADER_DIGEST, gradingProvenance, provenanceChanges } from "../src/grading-provenance.js";
import { gatedCourse, repairEvaluatorStub } from "./gated-fixture.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";

const clone = (c: CourseManifest) => structuredClone(c);
const item = (c: CourseManifest, id: string) => c.assessments.find((a) => a.id === id)!;

describe("grading provenance (M03)", () => {
  it("binds a deterministic item, its key without the teaching explanation, and Core's deployed grader", () => {
    const c = gatedCourse("5.0.0"), base = gradingProvenance(c, "min-a");
    expect(base.evaluatorDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(DETERMINISTIC_GRADER_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(base.codeImage).toBeNull();
    // A reworded explanation changes the item but not the key.
    const reworded = clone(c), choice = item(reworded, "min-a");
    if (choice.type === "choice") choice.grading.explanation = "Two is the smaller value.";
    const r = gradingProvenance(reworded, "min-a");
    expect(r.itemDigest).not.toBe(base.itemDigest);
    expect(r.answerKeyDigest).toBe(base.answerKeyDigest);
    // A changed key changes the key digest; the grader stays the same.
    const rekeyed = clone(c), keyed = item(rekeyed, "min-a");
    if (keyed.type === "choice") keyed.grading.correctOptionId = "five";
    const k = gradingProvenance(rekeyed, "min-a");
    expect(k.answerKeyDigest).not.toBe(base.answerKeyDigest);
    expect(k.evaluatorDigest).toBe(base.evaluatorDigest);
    expect(provenanceChanges({ item_digest: base.itemDigest, answer_key_digest: base.answerKeyDigest, evaluator_digest: base.evaluatorDigest }, k))
      .toEqual({ item: true, answerKey: true, evaluator: false });
    expect(provenanceChanges({ item_digest: null, answer_key_digest: null, evaluator_digest: null }, k)).toBeNull();
  });
  it("binds a code item to the evaluator build that holds its hidden cases and the image it ran in", () => {
    const c = gatedCourse("5.0.0"), installed = [repairEvaluatorStub()];
    const graded = gradingProvenance(c, "min-repair", installed, { execution: { runtime: { image: "sandbox@sha256:" + "a".repeat(64) } } });
    expect(graded.codeImage).toBe("sandbox@sha256:" + "a".repeat(64));
    // Another build of the evaluator (new hidden cases) is another key and another evaluator.
    const other = gradingProvenance(c, "min-repair", [{ ...installed[0]!, integrity: "sha256-" + "b".repeat(64) }]);
    expect(other.answerKeyDigest).not.toBe(graded.answerKeyDigest);
    expect(other.evaluatorDigest).not.toBe(graded.evaluatorDigest);
    expect(other.itemDigest).toBe(graded.itemDigest);
  });
  it("binds a reviewed item to its rubric and the reviewer build", () => {
    const c = gatedCourse("5.0.0"), installed = [reviewedRubricEvaluator()];
    const base = gradingProvenance(c, "min-teach", installed);
    const changed = clone(c);
    changed.rubrics![0]!.criteria[0]!.description = "States the invariant in other words.";
    expect(gradingProvenance(changed, "min-teach", installed).answerKeyDigest).not.toBe(base.answerKeyDigest);
    expect(gradingProvenance(c, "min-teach", installed).evaluatorDigest).toBe(base.evaluatorDigest);
    expect(() => gradingProvenance(c, "missing-item")).toThrow();
  });
});
