/** A small public scene whose one model drives a drawn point, a formula and a trace table:
 * y = slope * x + intercept. Its invariants tie the three together. */
export function lineScene(id = "line-model") {
  const y = { op: "add", args: [{ op: "mul", args: [{ state: "slope" }, { state: "x" }] }, { state: "intercept" }] };
  const traced = { cell: { pane: "trace", row: 0, column: 1 } };
  return {
    version: 1,
    id,
    title: "A straight line",
    description: "Change the slope, input or intercept and watch y follow.",
    state: {
      slope: { kind: "number", label: "Slope", initial: 2, min: -5, max: 5, step: 1 },
      x: { kind: "number", label: "Input x", initial: 3, min: 0, max: 10, step: 1 },
      intercept: { kind: "number", label: "Intercept", initial: 1, min: -10, max: 10, step: 1 },
    },
    controls: ["slope", "x", "intercept"],
    nodes: [
      { kind: "circle", id: "point", x: { op: "mul", args: [{ state: "x" }, 20] }, y: { op: "sub", args: [200, { op: "mul", args: [y, 2] }] }, radius: 6, fill: "#263655" },
      { kind: "text", id: "readout", text: { op: "concat", args: ["y = ", y] }, x: 20, y: 30, fontSize: 16, fill: "#263655" },
    ],
    panes: [
      { id: "rule", kind: "formula", title: "Rule", tex: "y = m x + b", label: "y equals m times x plus b",
        values: [{ symbol: "y", value: y }, { symbol: "m", value: { state: "slope" } }] },
      { id: "trace", kind: "table", title: "Trace", columns: ["x", "y"], rows: [[{ state: "x" }, y]] },
    ],
    invariants: [
      { id: "formula-matches-trace", description: "The formula's y equals the traced y",
        assert: { op: "eq", args: [{ value: { pane: "rule", symbol: "y" } }, traced] } },
      { id: "point-at-traced-y", description: "The point is drawn at the traced y",
        assert: { op: "lt", args: [{ op: "abs", args: [{ op: "sub", args: [{ node: "point", property: "y" }, { op: "sub", args: [200, { op: "mul", args: [traced, 2] }] }] }] }, 0.001] } },
    ],
    layouts: { compact: { width: 320, height: 240 }, expanded: { width: 640, height: 320 } },
    timeline: { durationMs: 1000, tracks: [], cues: [] },
    accessibility: {
      text: "A point on a straight line. Its height is the slope times x plus the intercept, also shown in a formula and a trace table.",
      reducedMotion: { atMs: 0, description: "The line is shown at rest." },
    },
  };
}

import { digestTeachingArtifact, type ArtifactVerifierPort, type CourseManifest } from "@course-core/sdk";
import { parseScene, RENDERER_ID, toVisualExperience } from "@course-core/visuals/headless";
import { createAdaptationRuntime, type AdaptationConfiguration, type TrustedAdaptationAdapter } from "../src/adaptation-store.js";
import { generatedFixtureRef } from "../src/code-evaluator.js";
import { digestJson } from "../src/repository.js";
import type { RuntimeExtension } from "../src/publication.js";
import { fixture } from "./fixture.js";

export const CODE_EVALUATOR_ID = "synthetic-code";
/** A stand-in for the installed Docker-backed code evaluator: a program "passes" when it uses
 * min(values). Real Python runs in the networkless sandbox (qualification/practical-flow.ts). */
export function syntheticCodeEvaluator(runs: string[] = []): RuntimeExtension {
  const grade = (source: unknown, total: number) => {
    runs.push(String(source));
    const passed = typeof source === "string" && source.includes("min(values)");
    return { passed, explanation: passed ? `All ${total} hidden reference cases matched.` : `0 of ${total} reference cases matched.`, evaluator: "synthetic-code@1.0.0",
      execution: { status: "graded", sourceDigest: digestJson(String(source)), durationMs: 1, passedCases: passed ? total : 0, totalCases: total,
        runtime: { protocol: "python-json-v1" as const, image: "synthetic" } } };
  };
  return { id: CODE_EVALUATOR_ID, version: "1.0.0", integrity: "sha256-" + "c".repeat(64), capabilities: ["assessment.evaluate"], platforms: ["web"], codeReady: true,
    validateCodeAssessment(assessment) { if (assessment.type !== "code" || assessment.grading.fixtureRef !== "min-fixture") throw new Error("unknown fixture"); },
    async evaluateCode(_assessment, source) { return grade(source, 3); },
    async evaluateGeneratedCode(assessment, cases, source) {
      if (assessment.type !== "code" || assessment.grading.fixtureRef !== generatedFixtureRef(cases)) throw new Error("fixture mismatch");
      return grade(source, cases.length);
    } };
}
/**
 * The ordering course with generated simulations, check questions and code exercises enabled for
 * the "min" lesson: an author-declared generator and verifier for visuals and variants, the scene
 * renderer and a code evaluator declared, and an approved profile per kind. The course's own
 * verifier here passes everything unless told to reject; the host's checks do the real work.
 */
export function generatedContentFixture(renderer: Pick<RuntimeExtension, "version" | "integrity">) {
  const course = fixture() as CourseManifest, source = "ordering-author-reference", stats = { verifications: 0, reject: false };
  course.id = "generated-content";
  course.policy.work = { additionalMinutes: 60, additionalEpisodes: 4, remediationCyclesPerConcept: 8 };
  course.sources.push({ id: source, title: "Reviewed public ordering explanation", url: "urn:example:ordering-support", reviewedAt: "2026-01-01T00:00:00Z" });
  const authored = toVisualExperience(parseScene(lineScene("authored-line")));
  course.visuals.push(authored);
  course.chapters[0]!.episodes[0]!.blocks.splice(1, 0, { id: "line-visual", type: "visual", visualId: authored.id });
  course.assessments.push({ id: "min-code", type: "code", objectiveIds: ["minimum"], familyId: "code", prompt: "Write solve(values) returning the smallest value.",
    language: "python", starterCode: "def solve(values):\n    return values[0]\n", grading: { evaluatorId: CODE_EVALUATOR_ID, fixtureRef: "min-fixture" } });
  const adapter: TrustedAdaptationAdapter = {
    id: "generated-content-v1", kind: "generated-teaching", implementationDigest: digestJson({ protocol: "synthetic-course-review-v1" }),
    validateProfile() {},
    async createPorts({ verifier }) {
      const port: ArtifactVerifierPort = { registration: verifier, async verify(input) {
        stats.verifications++;
        return { artifactDigest: await digestTeachingArtifact(input.artifact), checks: [{ id: "course-review", result: stats.reject ? "failed" : "passed" }],
          evidenceRefs: ["course-review:" + digestJson({ artifact: input.artifact.digest })] };
      } };
      return { verifier: port };
    },
  };
  const kinds = ["visual", "assessment_variant"] as const;
  course.extensions.push(
    { id: "generated-content-extension", version: "1.0.0", integrity: "sha256-" + adapter.implementationDigest, execution: "server", entrypoint: "extensions/generated-content-v1.js",
      platforms: ["web"], capabilities: ["teaching.generate", "teaching.verify"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Generated practice." } },
    { id: RENDERER_ID, version: renderer.version, integrity: renderer.integrity, execution: "declarative", entrypoint: "renderers/svg-v1.js", platforms: ["web"],
      capabilities: ["visual.render"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Scenes with text equivalents." } },
    { id: CODE_EVALUATOR_ID, version: "1.0.0", integrity: "sha256-" + "c".repeat(64), execution: "server", entrypoint: "evaluators/code.js", platforms: ["web"],
      capabilities: ["assessment.evaluate"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Code checks." } },
  );
  course.adaptation = { schemaVersion: 1, sourceRefs: [source], profileFieldIds: [],
    targets: [{ episodeId: "min", objectiveIds: ["minimum"], allowedOperations: ["attach_visual", "add_assessment_variant"], replaceableBlockIds: [] }],
    families: [
      { familyId: "select", canonicalAssessmentId: "min-b", generatorIds: ["content-generator"], verifierIds: ["content-verifier"], numericalRecipeIds: [], maxVariantsPerPlan: 4 },
      { familyId: "code", canonicalAssessmentId: "min-code", generatorIds: ["content-generator"], verifierIds: ["content-verifier"], numericalRecipeIds: [], maxVariantsPerPlan: 4 },
    ],
    generators: [{ id: "content-generator", version: "1.0.0", extensionId: "generated-content-extension", sourceRefs: [source], artifactKinds: [...kinds] }],
    verifiers: [{ id: "content-verifier", version: "1.0.0", extensionId: "generated-content-extension", sourceRefs: [source], artifactKinds: [...kinds], requiredCheckIds: ["course-review"] }],
    numericalRecipes: [],
    limits: { maxOperations: 1, maxArtifacts: 1, maxArtifactBytes: 20000, maxPlannedMinutesPerAssignment: 5, maxAdditionalEpisodesPerAssignment: 1, allowedClassifications: ["required", "optional"] } };
  const profile = { episodeId: "min", generatorId: "content-generator", verifierId: "content-verifier", adapterId: adapter.id, adapterDigest: adapter.implementationDigest,
    classification: "optional" as const, plannedMinutes: 2, additionalEpisodes: 0 };
  const config: AdaptationConfiguration = { authorizationMinutes: 30,
    verifiers: [{ id: "content-verifier", version: "1.0.0", implementationDigest: adapter.implementationDigest, sourceRefs: [source], artifactKinds: [...kinds], checkIds: ["course-review"] }],
    profiles: [
      { ...profile, id: "simulation-profile", operation: "attach_visual" },
      { ...profile, id: "check-profile", operation: "add_assessment_variant", canonicalAssessmentId: "min-b", classification: "required" },
      { ...profile, id: "code-profile", operation: "add_assessment_variant", canonicalAssessmentId: "min-code" },
    ] };
  return { course, config, source, stats, adapter, runtime: createAdaptationRuntime([adapter]), authoredVisualId: authored.id };
}
