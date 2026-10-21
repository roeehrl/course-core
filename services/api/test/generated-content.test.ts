import { describe, it, expect } from "vitest";
import type { Assessment, CourseManifest } from "@course-core/sdk";
import { parseScene, RENDERER_ID, SUPPORTED_FEATURES, toVisualExperience } from "@course-core/visuals/headless";
import { checkVisual } from "../src/visual-check.js";
import { generatedFixtureRef } from "../src/code-evaluator.js";
import { generatedTeachingInputSchema } from "../src/generated-teaching.js";
import { checkItemDraft, codeExerciseDraft, generatedContentChecks, modelAnswer, sceneModels, simulationDraft } from "../src/generated-content.js";
import type { RuntimeExtension } from "../src/publication.js";
import { lineScene } from "./generated-content-fixture.js";

const common = { id: "artifact-one", objectiveIds: ["minimum"], sourceRefs: ["source"], generator: { id: "gen", version: "1.0.0" } };
const renderer: RuntimeExtension = { id: RENDERER_ID, version: "0.4.0", integrity: "sha256-" + "a".repeat(64), capabilities: ["visual.render"], platforms: ["web"],
  validateVisual: (visual) => { checkVisual(visual); }, visualFeatures: (visual) => checkVisual(visual), renderFeatures: () => SUPPORTED_FEATURES };
const sceneVisual = (scene: unknown = lineScene()) => toVisualExperience(parseScene(scene));
function course(visuals = [sceneVisual()], extra: Partial<CourseManifest> = {}): CourseManifest {
  return { extensions: [{ id: RENDERER_ID, version: "0.4.0", integrity: renderer.integrity, execution: "declarative", entrypoint: "r.js", platforms: ["web"],
    capabilities: ["visual.render"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Scenes." } }],
    visuals, chapters: [{ id: "c", title: "C", episodes: [{ id: "min", title: "Min", objectiveIds: ["minimum"], blocks: [{ id: "v", type: "visual", visualId: "line-model" }] }] }],
    assessments: [], ...extra } as unknown as CourseManifest;
}
const numeric = { id: "min-b", type: "numeric", objectiveIds: ["minimum"], familyId: "select", prompt: "Minimum of 4 and 9?",
  misconceptionIds: ["m"], grading: { expected: 4, absoluteTolerance: 0, explanation: "4 is below 9." } } as Assessment;
const item = (over: Record<string, unknown> = {}) => ({ profileId: "p", kind: "check_item" as const, prompt: "With slope 3 and x = 4 (intercept 1), what is y?",
  model: { visualId: "line-model", state: { slope: 3, x: 4 }, read: { value: { pane: "rule", symbol: "y" } } }, explanation: "y is 3 times 4 plus 1.",
  objectiveIds: ["minimum"], sourceRefs: ["source"], ...over });

describe("one computational model keys generated questions (E04)", () => {
  it("derives the key from the scene's formula, trace table or drawn node at the stated model state", () => {
    const at = { visualId: "line-model", state: { slope: 3, x: 4 } };
    for (const read of [{ value: { pane: "rule", symbol: "y" } }, { cell: { pane: "trace", row: 0, column: 1 } }]) {
      expect(modelAnswer(course(), { ...at, read })).toMatchObject({ value: 13 });
    }
    expect(modelAnswer(course(), { ...at, state: { slope: -2, x: 10, intercept: -4 }, read: { value: { pane: "rule", symbol: "y" } } })).toMatchObject({ value: -24 });
    // y = 13 is drawn at 200 - 2 * 13.
    expect(modelAnswer(course(), { ...at, read: { node: "point", property: "y" } })).toMatchObject({ value: 174 });
  });
  it("refuses states outside the model's bounds, unknown reads and scenes that cannot vouch for their representations", () => {
    const read = { value: { pane: "rule", symbol: "y" } };
    expect(modelAnswer(course(), { visualId: "line-model", state: { slope: 6 }, read })).toEqual({ problem: "model_state_invalid" });
    expect(modelAnswer(course(), { visualId: "line-model", state: { gravity: 1 }, read })).toEqual({ problem: "model_state_invalid" });
    expect(modelAnswer(course(), { visualId: "line-model", state: { slope: true }, read })).toEqual({ problem: "model_state_invalid" });
    expect(modelAnswer(course(), { visualId: "elsewhere", state: {}, read })).toEqual({ problem: "model_unknown_visual" });
    expect(modelAnswer(course(), { visualId: "line-model", state: {}, read: { value: { pane: "rule", symbol: "q" } } })).toEqual({ problem: "model_read_invalid" });
    expect(modelAnswer(course(), { visualId: "line-model", state: {}, atMs: 5000, read })).toEqual({ problem: "model_read_invalid" });
    const silent = lineScene();
    delete (silent as { invariants?: unknown }).invariants;
    expect(modelAnswer(course([sceneVisual(silent)]), { visualId: "line-model", state: {}, read })).toEqual({ problem: "no_model_invariant" });
  });
  it("divergence: a formula changed without its trace and visual is caught, at the question's own state", () => {
    const contradictory = lineScene();
    // The formula now says y = m x + b + 1 while the trace and the point still say y = m x + b.
    contradictory.panes[0]!.values![0]!.value = { op: "add", args: [contradictory.panes[0]!.values![0]!.value, 1] } as never;
    expect(modelAnswer(course([sceneVisual(contradictory)]), item().model)).toEqual({ problem: "model_invariant_failed" });
    expect(checkItemDraft(item(), common, course([sceneVisual(contradictory)]), numeric)).toEqual({ problems: ["model_invariant_failed"] });
  });
  it("builds a variant of the canonical item keyed by the model, never by the model's claim", () => {
    const built = checkItemDraft(item(), common, course(), numeric);
    if (!("draft" in built) || built.draft.kind !== "assessment_variant") throw new Error("expected a draft");
    expect(built.draft.assessment).toMatchObject({ id: "artifact-one--item", type: "numeric", familyId: "select", objectiveIds: ["minimum"],
      prompt: item().prompt, grading: { expected: 13, absoluteTolerance: 0, explanation: "y is 3 times 4 plus 1." } });
    // The author's declared misconceptions describe the author's item, not a generated one.
    expect(built.draft.assessment).not.toHaveProperty("misconceptionIds");
    expect(built.draft.hiddenFixtures).toMatchObject({ protocol: "scene-model-v1", model: item().model });
    expect(checkItemDraft(item({ answer: 13 }), common, course(), numeric)).toHaveProperty("draft");
    // Wrong-but-plausible claimed keys (forgot the intercept, off by one) are refused.
    for (const answer of [12, 14, 7]) expect(checkItemDraft(item({ answer }), common, course(), numeric)).toEqual({ problems: ["answer_key_diverges"] });
    expect(checkItemDraft(item({ prompt: "What is y for this line?" }), common, course(), numeric)).toEqual({ problems: ["prompt_missing_inputs"] });
    expect(checkItemDraft(item({ objectiveIds: ["maximum"] }), common, course(), numeric)).toEqual({ problems: ["objective_scope"] });
    expect(checkItemDraft(item(), common, course(), { ...numeric, type: "choice" } as unknown as Assessment)).toEqual({ problems: ["canonical_mismatch"] });
  });
  it("rechecks a stored key against the course as it is at delivery", async () => {
    const built = checkItemDraft(item(), common, course(), numeric);
    if (!("draft" in built)) throw new Error("expected a draft");
    const artifact = { ...built.draft, digest: "0".repeat(64) } as never;
    expect(await generatedContentChecks(artifact, { course: course(), installed: [] })).toEqual({ failedCheckIds: [], problems: [] });
    // The model the key came from changed meanwhile (another intercept): the stored key no longer holds.
    const changed = lineScene();
    changed.state.intercept.initial = 2;
    expect(await generatedContentChecks(artifact, { course: course([sceneVisual(changed)]), installed: [] }))
      .toEqual({ failedCheckIds: ["host-answer-key"], problems: ["answer_key_diverges"] });
    // A tampered key fails too.
    const tampered = structuredClone(artifact) as { assessment: { grading: { expected: number } } };
    tampered.assessment.grading.expected = 12;
    expect((await generatedContentChecks(tampered as never, { course: course(), installed: [] })).problems).toEqual(["answer_key_diverges"]);
  });
  it("lists a lesson's scene models by structure only, never values or keys", () => {
    const [model] = sceneModels(course(), "min");
    expect(model).toMatchObject({ visualId: "line-model", formulas: [{ pane: "rule", symbols: ["y", "m"] }], tables: [{ pane: "trace", columns: ["x", "y"], rows: 1 }] });
    expect(model!.state).toEqual(expect.arrayContaining([{ name: "slope", label: "Slope", type: "number", min: -5, max: 5 }]));
  });
});

describe("generated simulations are scene data checked by the installed renderer", () => {
  it("builds the SDK visual under a host-chosen identity and refuses invalid scenes", () => {
    const built = simulationDraft({ profileId: "p", kind: "simulation", scene: { ...lineScene("course-visual"), extra: 1 }, objectiveIds: ["minimum"], sourceRefs: ["source"] }, common);
    expect(built).toEqual({ problems: ["scene_invalid"] });
    const ok = simulationDraft({ profileId: "p", kind: "simulation", scene: lineScene("course-visual"), objectiveIds: ["minimum"], sourceRefs: ["source"] }, common);
    if (!("draft" in ok) || ok.draft.kind !== "visual") throw new Error("expected a visual");
    expect(ok.draft.visual).toMatchObject({ id: "artifact-one--scene", rendererId: RENDERER_ID });
  });
  it("needs an installed matching renderer, an invariant and passing scene checks", async () => {
    const visual = (scene: unknown) => {
      const built = simulationDraft({ profileId: "p", kind: "simulation", scene: scene as Record<string, unknown>, objectiveIds: ["minimum"], sourceRefs: ["source"] }, common);
      if (!("draft" in built)) throw new Error("expected a draft");
      return { ...built.draft, digest: "0".repeat(64) } as never;
    };
    expect(await generatedContentChecks(visual(lineScene()), { course: course(), installed: [renderer] })).toEqual({ failedCheckIds: [], problems: [] });
    expect((await generatedContentChecks(visual(lineScene()), { course: course(), installed: [] })).problems).toEqual(["renderer_unavailable"]);
    expect((await generatedContentChecks(visual(lineScene()), { course: course(), installed: [{ ...renderer, integrity: "sha256-" + "b".repeat(64) }] })).problems)
      .toEqual(["renderer_unavailable"]);
    const silent = lineScene();
    delete (silent as { invariants?: unknown }).invariants;
    expect((await generatedContentChecks(visual(silent), { course: course(), installed: [renderer] })).problems).toEqual(["no_model_invariant"]);
    const contradictory = lineScene();
    contradictory.panes[1]!.rows![0]![1] = { op: "mul", args: [{ state: "slope" }, { state: "x" }] } as never;
    expect(await generatedContentChecks(visual(contradictory), { course: course(), installed: [renderer] }))
      .toEqual({ failedCheckIds: ["host-model-agreement"], problems: ["model_invariant_failed"] });
    expect((await generatedContentChecks(visual(lineScene()), { course: course(), installed: [{ ...renderer, renderFeatures: () => [] }] })).problems)
      .toEqual(["render_feature_unsupported"]);
  });
});

describe("generated code exercises are proven by their hidden tests in the isolated grader", () => {
  const canonical = { id: "min-code", type: "code", objectiveIds: ["minimum"], familyId: "code", prompt: "Return the minimum.", language: "python", starterCode: "",
    grading: { evaluatorId: "synthetic-code", fixtureRef: "fixture" } } as Assessment;
  const tests = [{ id: "a", input: [3, 1, 2], expected: 1 }, { id: "b", input: [-4, 0], expected: -4 }, { id: "c", input: [7], expected: 7 }];
  const exercise = (over: Record<string, unknown> = {}) => ({ profileId: "p", kind: "code_exercise" as const, prompt: "Write solve(values) returning the smallest value.",
    starterCode: "def solve(values):\n    return values[0]\n", tests, referenceSolution: "def solve(values):\n    return min(values)\n",
    wrongSolutions: ["def solve(values):\n    return max(values)\n"], objectiveIds: ["minimum"], sourceRefs: ["source"], ...over });
  // A stand-in for the sandbox: the real one runs Python in the networkless Docker broker.
  const runs: string[] = [];
  const evaluator = (passes: (source: string) => boolean): RuntimeExtension => ({ id: "synthetic-code", version: "1.0.0", integrity: "sha256-" + "c".repeat(64),
    capabilities: ["assessment.evaluate"], platforms: ["web"], codeReady: true,
    async evaluateGeneratedCode(assessment, cases, source) {
      runs.push(String(source));
      expect(assessment.type === "code" && assessment.grading.fixtureRef).toBe(generatedFixtureRef(cases));
      const passed = passes(String(source));
      return { passed, explanation: "", evaluator: "synthetic", execution: { status: "graded", sourceDigest: "", durationMs: 1, passedCases: passed ? cases.length : 0,
        totalCases: cases.length, runtime: { protocol: "python-json-v1", image: "synthetic" } } };
    } });
  const codeCourse = course([], { extensions: [{ id: "synthetic-code", version: "1.0.0", integrity: "sha256-" + "c".repeat(64), execution: "server", entrypoint: "e.js",
    platforms: ["web"], capabilities: ["assessment.evaluate"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Code." } }] as never });
  const artifact = (over: Record<string, unknown> = {}) => {
    const built = codeExerciseDraft(exercise(over), common, canonical);
    if (!("draft" in built)) throw new Error("expected a draft");
    return { ...built.draft, digest: "0".repeat(64) } as never;
  };
  const correct = (source: string) => source.includes("min(values)");
  it("keeps tests and solutions in server data and names the tests by digest", () => {
    const built = artifact() as { assessment: Assessment; hiddenFixtures: { cases: unknown[] } };
    expect(built.assessment).toMatchObject({ type: "code", language: "python", grading: { evaluatorId: "synthetic-code", fixtureRef: generatedFixtureRef(tests) } });
    expect(JSON.stringify(built.assessment)).not.toContain("min(values)");
    expect(built.hiddenFixtures.cases).toEqual(tests);
  });
  it("passes only when the reference passes and the starter and every wrong solution fail", async () => {
    runs.length = 0;
    expect(await generatedContentChecks(artifact(), { course: codeCourse, installed: [evaluator(correct)] })).toEqual({ failedCheckIds: [], problems: [] });
    expect(runs).toHaveLength(3);
    expect((await generatedContentChecks(artifact({ referenceSolution: "def solve(values):\n    return sorted(values)[1]\n" }),
      { course: codeCourse, installed: [evaluator(correct)] })).problems).toEqual(["reference_failed"]);
    expect((await generatedContentChecks(artifact({ starterCode: "def solve(values):\n    return min(values)\n" }),
      { course: codeCourse, installed: [evaluator(correct)] })).problems).toEqual(["starter_passes"]);
    // Tests so weak that a plausible wrong program passes them grade nothing.
    expect((await generatedContentChecks(artifact(), { course: codeCourse, installed: [evaluator(() => true)] })).problems).toEqual(["starter_passes", "wrong_solution_passes"]);
  });
  it("never runs anything without the canonical item's installed evaluator, and refuses tests that do not match their digest", async () => {
    expect((await generatedContentChecks(artifact(), { course: codeCourse, installed: [] })).problems).toEqual(["code_runner_unavailable"]);
    expect((await generatedContentChecks(artifact(), { course: codeCourse, installed: [(({ evaluateGeneratedCode: _omitted, ...rest }) => rest)(evaluator(correct))] })).problems)
      .toEqual(["code_runner_unavailable"]);
    const swapped = structuredClone(artifact()) as { hiddenFixtures: { cases: { expected: number }[] } };
    swapped.hiddenFixtures.cases[0]!.expected = 99;
    expect((await generatedContentChecks(swapped as never, { course: codeCourse, installed: [evaluator(correct)] })).problems).toEqual(["code_fixture_mismatch"]);
  });
  it("refuses an exercise for an item that is not code, or for other objectives", () => {
    expect(codeExerciseDraft(exercise(), common, numeric)).toEqual({ problems: ["canonical_mismatch"] });
    expect(codeExerciseDraft(exercise({ objectiveIds: ["maximum"] }), common, canonical)).toEqual({ problems: ["objective_scope"] });
  });
});

describe("candidate grammar", () => {
  it("accepts the new kinds and still refuses SDK artifacts, keys and claimed authority from a model", () => {
    expect(generatedTeachingInputSchema.safeParse({ profileId: "p", kind: "simulation", scene: lineScene(), objectiveIds: ["minimum"], sourceRefs: ["source"] }).success).toBe(true);
    expect(generatedTeachingInputSchema.safeParse(item()).success).toBe(true);
    expect(generatedTeachingInputSchema.safeParse(item({ grading: { expected: 13 } })).success).toBe(false);
    expect(generatedTeachingInputSchema.safeParse(item({ answer: Number.NaN })).success).toBe(false);
    expect(generatedTeachingInputSchema.safeParse({ ...item(), kind: "assessment_variant" }).success).toBe(false);
    expect(generatedTeachingInputSchema.safeParse({ profileId: "p", kind: "code_exercise", prompt: "x", starterCode: "", tests: [], referenceSolution: "x",
      wrongSolutions: ["y"], objectiveIds: ["minimum"], sourceRefs: ["source"] }).success).toBe(false);
  });
});

describe("generated components' text alternative", () => {
  it("is written by the host from the labels, so a model cannot inject links, images or HTML into the lesson", async () => {
    const { componentText } = await import("../src/generated-content.js");
    const { accessibilityProblems } = await import("../src/teaching-accessibility.js");
    const text = componentText({ title: "Click [here](https://example.test) <b>now</b>", description: "![x](y) A line.", source: "def solve(inputs):\n    return {}\n",
      inputs: [{ name: "x", label: "Input x", min: -1, max: 1, step: 0.5, initial: 0 }], outputs: [{ name: "y", label: "Output y" }],
      tests: [{ id: "a", input: { x: 0 }, expected: { y: 0 } }, { id: "b", input: { x: 1 }, expected: { y: 1 } }, { id: "c", input: { x: -1 }, expected: { y: 1 } }] });
    expect(text).not.toMatch(/(?<!\\)\[here\]\(/);
    expect(text).not.toMatch(/(?<!\\)<b>/);
    expect(text).toContain("- Input x: -1 – 1 (0; ±0.5)");
    expect(accessibilityProblems([text])).toEqual([]);
  });
  const ramp = (over: Record<string, unknown> = {}) => ({ title: "Ramp", description: "A ball rolls down a ramp.", source: "def solve(inputs):\n    return {}\n",
    inputs: [{ name: "angle", label: "Angle", min: 0, max: 60, step: 5, initial: 30 }, { name: "mass", label: "Mass", min: 1, max: 10, step: 1, initial: 2 }],
    outputs: [{ name: "speed", label: "Speed" }, { name: "note", label: "Note" }],
    tests: [{ id: "start", input: { angle: 30, mass: 2 }, expected: { speed: 4.4, note: "rolls" } },
      { id: "lower", input: { angle: 10, mass: 2 }, expected: { speed: 2.6, note: "rolls" } },
      { id: "both", input: { angle: 60, mass: 9 }, expected: { speed: 5.8, note: "[fast](https://example.test)" } },
      { id: "heavier", input: { angle: 30, mass: 8 }, expected: { speed: 4.4, note: "rolls" } }], ...over });
  it("describes steps, the verified starting values and one-control changes from the grader's tests, in the course's language", async () => {
    const { componentText } = await import("../src/generated-content.js");
    const { accessibilityProblems } = await import("../src/teaching-accessibility.js");
    const text = componentText(ramp(), "en-US");
    expect(text).toContain("Controls:\n- Angle: from 0 to 60 in steps of 5, starting at 30\n- Mass: from 1 to 10 in steps of 1, starting at 2");
    expect(text).toContain("Shows:\n- Speed\n- Note");
    expect(text).toContain("At the start (Angle = 30, Mass = 2): Speed = 4.4, Note = rolls.");
    // A control moved down is described going up; an output that did not move "stays".
    expect(text).toContain("- When Angle goes from 10 to 30 (other controls unchanged): Speed goes from 2.6 to 4.4; Note stays rolls.");
    expect(text).toContain("- When Mass goes from 2 to 8 (other controls unchanged): Speed stays 4.4; Note stays rolls.");
    // A test that moved two controls at once is never described; its values stay server-side.
    expect(text).not.toContain("5.8");
    expect(text).not.toContain("fast");
    expect(accessibilityProblems([text])).toEqual([]);
    const hebrew = componentText(ramp(), "he");
    expect(hebrew).toContain("- Angle: מ־0 עד 60 בצעדים של 5, ערך התחלתי 30");
    expect(hebrew).toContain("בהתחלה (Angle = 30, Mass = 2): Speed = 4.4, Note = rolls.");
    expect(hebrew).not.toMatch(/\b(from|when|start)\b/i);
    // Another course language gets symbols, never English words.
    const other = componentText(ramp(), "fr");
    expect(other).toContain("- Angle: 0 – 60 (30; ±5)");
    expect(other).toContain("- Angle: 10 → 30 ⇒ Speed: 2.6 → 4.4; Note: rolls");
    expect(other).not.toMatch(/\b(from|when|start|steps)\b/i);
  });
  it("escapes verified text values like labels, and leaves out changes when no test moves a single control", async () => {
    const { componentText } = await import("../src/generated-content.js");
    const tests = [{ id: "start", input: { angle: 30, mass: 2 }, expected: { speed: 1, note: "*bold* <i>x</i>" } },
      { id: "both", input: { angle: 40, mass: 3 }, expected: { speed: 2, note: "y" } }, { id: "both2", input: { angle: 50, mass: 4 }, expected: { speed: 3, note: "z" } }];
    const text = componentText(ramp({ tests }), "en");
    expect(text).toContain("Note = \\*bold\\* \\<i\\>x\\</i\\>");
    expect(text).not.toContain("Checked before this was added");
    expect(text).not.toContain("When ");
  });
});
