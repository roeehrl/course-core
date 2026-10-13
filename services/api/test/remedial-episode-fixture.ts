import { randomUUID } from "node:crypto";
import type { TrustedAdaptationAdapter, AdaptationConfiguration } from "../src/adaptation-store.js";
import { fixture } from "./fixture.js";

/** A course whose author permits one reviewed remedial episode after "min". */
export const source = "ordering-remedial-reference";
export const entry = {
  id: "minimum-step-by-step",
  kind: "episode" as const,
  title: "Minimum, one comparison at a time",
  blocks: [
    { id: "walk", markdown: "Keep the smallest value seen so far. Compare it with each next value and keep whichever is smaller." },
    { id: "check", markdown: "When every value has been compared once, the kept value is the minimum." },
  ],
  objectiveIds: ["minimum"],
  sourceRefs: [source],
};

export function remedialCourse(adapter: TrustedAdaptationAdapter) {
  const course = fixture();
  course.id = "ordering-" + randomUUID().slice(0, 8);
  course.policy.work = { additionalMinutes: 20, additionalEpisodes: 2, remediationCyclesPerConcept: 4 };
  course.sources.push({ id: source, title: "Reviewed ordering walkthrough", url: "urn:example:ordering-remedial", reviewedAt: "2026-01-01T00:00:00Z" });
  course.extensions.push({ id: "remedial-extension", version: "1.0.0", integrity: "sha256-" + adapter.implementationDigest, execution: "server",
    entrypoint: "extensions/authored-teaching-bank-v1.js", platforms: ["web"], capabilities: ["teaching.generate", "teaching.verify"],
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Readable remedial text." } });
  course.adaptation = { schemaVersion: 1, sourceRefs: [source], profileFieldIds: [],
    targets: [{ episodeId: "min", objectiveIds: ["minimum"], allowedOperations: ["insert_episode"], replaceableBlockIds: [] }], families: [],
    generators: [{ id: "remedial-generator", version: "1.0.0", extensionId: "remedial-extension", sourceRefs: [source], artifactKinds: ["episode"] }],
    verifiers: [{ id: "remedial-verifier", version: "1.0.0", extensionId: "remedial-extension", sourceRefs: [source], artifactKinds: ["episode"], requiredCheckIds: ["reviewed-teaching-match"] }],
    numericalRecipes: [],
    limits: { maxOperations: 1, maxArtifacts: 1, maxArtifactBytes: 20000, maxPlannedMinutesPerAssignment: 10, maxAdditionalEpisodesPerAssignment: 1, allowedClassifications: ["required", "optional"] } };
  return course;
}
export function remedialRegistry(adapter: TrustedAdaptationAdapter, classification: "required" | "optional", additionalEpisodes = 1): AdaptationConfiguration {
  return { authorizationMinutes: 30,
    verifiers: [{ id: "remedial-verifier", version: "1.0.0", implementationDigest: adapter.implementationDigest, sourceRefs: [source], artifactKinds: ["episode"], checkIds: ["reviewed-teaching-match"] }],
    profiles: [{ id: "remedial-profile", episodeId: "min", operation: "insert_episode", generatorId: "remedial-generator", verifierId: "remedial-verifier",
      adapterId: adapter.id, adapterDigest: adapter.implementationDigest, classification, plannedMinutes: 6, additionalEpisodes, teachingBank: [structuredClone(entry)] }] };
}
