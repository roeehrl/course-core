import { isVersionedGate, type LegacyProgressionGate, type ProgressionGate } from "@course-core/sdk";

/**
 * The public test fixtures author 0.4-shape gates (`assessmentIds`, `minimumIndependentFamilies`).
 * `ProgressionGate` is a union with the versioned 0.5 gate, so a test that reads or edits those
 * fields narrows here and fails loudly if the fixture ever moves to the versioned shape.
 */
export function legacyGate(gate: ProgressionGate | undefined): LegacyProgressionGate {
  if (!gate) throw new Error("Expected the fixture gate to exist.");
  if (isVersionedGate(gate)) throw new Error(`Gate ${gate.id} uses the versioned shape; this test expects a 0.4 fixture gate.`);
  return gate;
}
