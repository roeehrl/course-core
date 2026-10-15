import { digestTeachingArtifact } from "@course-core/sdk";
import type { ArtifactVerifierPort, TeachingArtifact } from "@course-core/sdk";
import {
  createAdaptationRuntime,
  type TrustedAdaptationAdapter,
} from "../src/adaptation-store.js";
import { digestJson } from "../src/repository.js";
import { supervisorSupportFixture } from "./supervisor-support-fixture.js";

/** This entire small grammar has an independently computed reference. It does
 * not purport to verify arbitrary explanatory prose using an LLM judge. */
export function correctMinimumExample(artifact: TeachingArtifact): boolean {
  // A generated lesson passes when every one of its blocks is a correct example.
  if (artifact.kind === "episode")
    return artifact.blocks.every((block) => correctMinimumExample({ ...artifact, kind: "explanation", markdown: block.markdown } as TeachingArtifact));
  if (artifact.kind !== "explanation") return false;
  const match = /^Minimum of \[(-?\d+(?:, -?\d+){1,7})\] is (-?\d+)\.$/.exec(
    artifact.markdown,
  );
  if (!match) return false;
  const values = match[1]!.split(", ").map(Number),
    answer = Number(match[2]);
  return (
    [...values, answer].every(
      (v) => Number.isSafeInteger(v) && Math.abs(v) <= 1000000,
    ) &&
    values.includes(answer) &&
    values.every((value) => answer <= value)
  );
}
export function supervisorGeneratedTeachingFixture() {
  const fixture = supervisorSupportFixture(),
    source = fixture.course.adaptation!.sourceRefs[0]!,
    stats = { verifications: 0, reject: false };
  const adapter: TrustedAdaptationAdapter = {
    id: "generated-ordering-v1",
    kind: "generated-teaching",
    implementationDigest: digestJson({
      protocol: "closed-minimum-reference-v1",
      reference: correctMinimumExample.toString(),
    }),
    validateProfile(course, profile) {
      if (
        profile.episodeId !== "min" ||
        course.adaptation?.verifiers
          .find((v) => v.id === profile.verifierId)
          ?.requiredCheckIds.join() !== "minimum-reference"
      )
        throw Error("Unsupported generated ordering profile");
    },
    async createPorts({ verifier }) {
      const port: ArtifactVerifierPort = {
        registration: verifier,
        async verify(input) {
          stats.verifications++;
          return {
            artifactDigest: await digestTeachingArtifact(input.artifact),
            checks: [
              {
                id: "minimum-reference",
                result:
                  !stats.reject && correctMinimumExample(input.artifact)
                    ? "passed"
                    : "failed",
              },
            ],
            evidenceRefs: [
              "ordering-reference:" +
                digestJson({ artifact: input.artifact.digest }),
            ],
          };
        },
      };
      return { verifier: port };
    },
  };
  fixture.course.extensions.push({
    id: "generated-ordering-extension",
    version: "1.0.0",
    integrity: "sha256-" + adapter.implementationDigest,
    execution: "server",
    entrypoint: "extensions/generated-ordering-v1.js",
    platforms: ["web"],
    capabilities: ["teaching.generate", "teaching.verify"],
    accessibility: {
      keyboard: true,
      reducedMotion: true,
      textAlternative: "Verified ordering examples.",
    },
  });
  fixture.course.adaptation!.generators.push({
    id: "generated-ordering-generator",
    version: "1.0.0",
    extensionId: "generated-ordering-extension",
    sourceRefs: [source],
    artifactKinds: ["explanation"],
  });
  fixture.course.adaptation!.verifiers.push({
    id: "generated-ordering-verifier",
    version: "1.0.0",
    extensionId: "generated-ordering-extension",
    sourceRefs: [source],
    artifactKinds: ["explanation"],
    requiredCheckIds: ["minimum-reference"],
  });
  fixture.config.verifiers.push({
    id: "generated-ordering-verifier",
    version: "1.0.0",
    implementationDigest: adapter.implementationDigest,
    sourceRefs: [source],
    artifactKinds: ["explanation"],
    checkIds: ["minimum-reference"],
  });
  fixture.config.profiles.push({
    id: "generated-ordering-profile",
    generationBrief:
      "Create a varied ordering example. Use exactly: Minimum of [a, b, ...] is m. Include signed integers and the actual member that is no greater than every other member. Additional prose is outside this verifier grammar.",
    episodeId: "min",
    operation: "append_teaching",
    generatorId: "generated-ordering-generator",
    verifierId: "generated-ordering-verifier",
    adapterId: adapter.id,
    adapterDigest: adapter.implementationDigest,
    classification: "required",
    plannedMinutes: 3,
    additionalEpisodes: 0,
  });
  return {
    ...fixture,
    runtime: createAdaptationRuntime([...fixture.runtime.adapters, adapter]),
    stats,
    source,
  };
}
