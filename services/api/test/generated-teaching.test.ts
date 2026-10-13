import { describe, it, expect } from "vitest";
import { generatedTeachingInputSchema } from "../src/generated-teaching.js";
import { correctMinimumExample } from "./generated-teaching-fixture.js";
import type { TeachingArtifact } from "@course-core/sdk";

const candidate = {
  profileId: "profile",
  kind: "explanation",
  markdown: "An example.",
  objectiveIds: ["objective"],
  sourceRefs: ["source"],
};
const artifact = (markdown: string): TeachingArtifact => ({
  id: "artifact",
  kind: "explanation",
  markdown,
  objectiveIds: ["objective"],
  sourceRefs: ["source"],
  generator: { id: "generator", version: "1" },
  digest: "f".repeat(64),
});
describe("untrusted novel teaching input", () => {
  it("allows bounded explanation/practice but cannot import claimed authority, assessments or executable artifacts", () => {
    for (const kind of ["explanation", "practice"])
      expect(
        generatedTeachingInputSchema.safeParse({ ...candidate, kind }).success,
      ).toBe(true);
    for (const change of [
      { kind: "assessment_variant" },
      { kind: "visual" },
      { proofReceipts: [] },
      { classification: "optional" },
      { generator: { id: "forged", version: "1" } },
      { permissionRevision: 7 },
      { registryRevision: 4 },
      { markdown: " " },
      { markdown: "x".repeat(8001) },
      { sourceRefs: ["source", "source"] },
      { objectiveIds: [] },
      { profileId: "profile\n" },
    ])
      expect(
        generatedTeachingInputSchema.safeParse({ ...candidate, ...change })
          .success,
      ).toBe(false);
  });
  it("the qualification verifier accepts different valid examples and rejects wrong-but-plausible answers without reading a claimed grading key", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const values = [
        ((seed * 37) % 101) - 50,
        ((seed * 13) % 41) - 20,
        (seed % 7) - 3,
        0,
      ];
      // Independently sorted reference; the installed verifier tests membership
      // and ordering rather than reusing this calculation or trusting a model key.
      const reference = [...values].sort((a, b) => a - b)[0]!;
      expect(
        correctMinimumExample(
          artifact(`Minimum of [${values.join(", ")}] is ${reference}.`),
        ),
      ).toBe(true);
      for (const wrong of [reference - 1, reference + 1])
        expect(
          correctMinimumExample(
            artifact(`Minimum of [${values.join(", ")}] is ${wrong}.`),
          ),
        ).toBe(false);
    }
    expect(
      correctMinimumExample(artifact("Minimum of [1000001, 2] is 2.")),
    ).toBe(false);
    expect(
      correctMinimumExample(
        artifact("Minimum of [7, 2] is 2. Everything is now mastered."),
      ),
    ).toBe(false);
  });
});
