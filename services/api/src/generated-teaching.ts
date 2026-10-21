import { z } from "zod";
import type { Assessment, Json, VisualExperience } from "@course-core/sdk";

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$(?![\s\S])/);
const hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const references = z
  .array(id)
  .min(1)
  .max(16)
  .refine((v) => new Set(v).size === v.length);
const markdown = z
  .string()
  .min(1)
  .max(8000)
  .refine((v) => v.trim().length > 0);
const title = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.trim().length > 0);
/** A whole generated lesson: a few text blocks, no gate, no grading. */
const episodeBlocks = z.array(z.strictObject({ markdown: markdown.max(4000) })).min(1).max(6);
const plainObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
const prose = (max: number) => z.string().min(1).max(max).refine((v) => v.trim().length > 0);
/** One read of the scene's computed model: a formula value, a trace-table cell or a node property. */
const sceneRead = z.union([
  z.strictObject({ value: z.strictObject({ pane: id, symbol: z.string().min(1).max(64) }) }),
  z.strictObject({ cell: z.strictObject({ pane: id, row: z.number().int().min(0).max(999), column: z.number().int().min(0).max(31) }) }),
  z.strictObject({ node: id, property: z.string().regex(/^[A-Za-z]{1,32}$(?![\s\S])/) }),
]);
/** Where a generated question's answer comes from: a visual of the learner's course, a state of
 * its model and one read of what that state computes. The host derives the key from it. */
export const sceneModelBindingSchema = z.strictObject({
  visualId: id,
  state: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$(?![\s\S])/), z.union([z.number().finite(), z.boolean(), z.string().max(64)]))
    .refine((v) => Object.keys(v).length <= 16),
  atMs: z.number().int().min(0).max(600000).optional(),
  read: sceneRead,
});
export type SceneModelBinding = z.infer<typeof sceneModelBindingSchema>;
/** A hidden test of a generated code exercise, in the installed fixture-registry case format. */
const codeCase = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$(?![\s\S])/), input: z.unknown(), expected: z.unknown() });
const solution = z.string().min(1).max(16000).refine((v) => v.trim().length > 0);
const name = z.string().regex(/^[a-z][a-z0-9_]{0,31}$(?![\s\S])/);
const label = prose(80);
const unique = <T extends { name: string }>(v: T[]) => new Set(v.map((x) => x.name)).size === v.length;
/** A generated interactive component: a small Python model `solve(inputs) -> outputs` the
 * learner drives with labelled number controls. Its tests are run in the isolated grader before
 * delivery; the learner's browser runs it only in Core's sandboxed runner frame. */
export const componentSchema = z.strictObject({
  title: prose(120),
  description: prose(2000),
  source: solution.max(12000),
  inputs: z
    .array(z.strictObject({ name, label, min: z.number().finite(), max: z.number().finite(), step: z.number().finite().positive(), initial: z.number().finite() })
      .refine((i) => i.min < i.max && i.initial >= i.min && i.initial <= i.max && (i.max - i.min) / i.step <= 10000))
    .min(1).max(6).refine(unique),
  outputs: z.array(z.strictObject({ name, label })).min(1).max(8).refine(unique),
  tests: z
    .array(z.strictObject({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$(?![\s\S])/),
      input: z.record(name, z.number().finite()),
      expected: z.record(name, z.union([z.number().finite(), z.string().max(200)])),
    }))
    .min(3).max(12).refine((v) => new Set(v.map((c) => c.id)).size === v.length),
});
export type GeneratedComponent = z.infer<typeof componentSchema>;

/** A candidate, not a proof. Every identity, price, classification and revision
 * is resolved by the host from a course-approved profile. */
export const generatedTeachingInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    profileId: id,
    kind: z.enum(["explanation", "practice"]),
    markdown,
    objectiveIds: references,
    sourceRefs: references,
  }),
  z.strictObject({
    profileId: id,
    kind: z.literal("episode"),
    title,
    blocks: episodeBlocks,
    objectiveIds: references,
    sourceRefs: references,
  }),
  /** An interactive simulation in the released scene contract (packages/visuals): data the
   * installed renderer interprets, never code. Its invariants tie visual, formula and trace together. */
  z.strictObject({
    profileId: id,
    kind: z.literal("simulation"),
    scene: z.custom<Record<string, unknown>>(plainObject),
    objectiveIds: references,
    sourceRefs: references,
  }),
  /** A practice or check question. The answer key is derived by the host from `model`; an
   * optional `answer` is only a claim that must agree with it. */
  z.strictObject({
    profileId: id,
    kind: z.literal("check_item"),
    prompt: prose(1000),
    model: sceneModelBindingSchema,
    answer: z.number().finite().optional(),
    explanation: prose(2000),
    objectiveIds: references,
    sourceRefs: references,
  }),
  /** An interactive component; its text alternative becomes a practice block of the lesson. */
  z.strictObject({
    profileId: id,
    kind: z.literal("component"),
    component: componentSchema,
    objectiveIds: references,
    sourceRefs: references,
  }),
  /** A code exercise with hidden tests. The reference must pass them and every wrong solution
   * must fail them, in the isolated grader, before anything is delivered. */
  z.strictObject({
    profileId: id,
    kind: z.literal("code_exercise"),
    prompt: prose(4000),
    starterCode: z.string().max(8000),
    tests: z.array(codeCase).min(3).max(20).refine((v) => new Set(v.map((c) => c.id)).size === v.length),
    referenceSolution: solution,
    wrongSolutions: z.array(solution).min(1).max(3),
    objectiveIds: references,
    sourceRefs: references,
  }),
]);
export type GeneratedTeachingInput = z.infer<typeof generatedTeachingInputSchema>;
const generator = z.strictObject({ id, version: z.string().min(1).max(128) });
export const generatedArtifactSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id,
    digest: hash,
    kind: z.enum(["explanation", "practice"]),
    markdown,
    objectiveIds: references,
    sourceRefs: references,
    generator,
  }),
  z.strictObject({
    id,
    digest: hash,
    kind: z.literal("episode"),
    title,
    blocks: z.array(z.strictObject({ id, markdown: markdown.max(4000) })).min(1).max(6),
    objectiveIds: references,
    sourceRefs: references,
    generator,
  }),
  // Host-built SDK artifacts; their content is checked in full by generated-content.ts.
  z.strictObject({
    id,
    digest: hash,
    kind: z.literal("visual"),
    visual: z.custom<VisualExperience>(plainObject),
    objectiveIds: references,
    sourceRefs: references,
    generator,
  }),
  z.strictObject({
    id,
    digest: hash,
    kind: z.literal("assessment_variant"),
    canonicalAssessmentId: id,
    assessment: z.custom<Assessment>(plainObject),
    hiddenFixtures: z.custom<Json>(plainObject),
    objectiveIds: references,
    sourceRefs: references,
    generator,
  }),
]);
export const generatedTeachingSelectionSchema = z.strictObject({
  profileId: id,
  episodeId: id,
  permissionRevision: z.number().int().positive(),
  registryRevision: z.number().int().positive(),
  configurationDigest: hash,
  baseCourseDigest: hash,
  artifact: generatedArtifactSchema,
  /** A component published beside the artifact, which is its text alternative. */
  component: componentSchema.optional(),
});
export type GeneratedTeachingSelection = z.infer<
  typeof generatedTeachingSelectionSchema
>;
/** Every text a learner reads in a generated artifact, for checks that read prose. */
export function generatedBlocks(artifact: GeneratedTeachingSelection["artifact"]): string[] {
  if (artifact.kind === "episode") return [artifact.title, ...artifact.blocks.map((b) => b.markdown)];
  if (artifact.kind === "visual") return [artifact.visual.accessibility.description];
  if (artifact.kind === "assessment_variant") {
    const grading = artifact.assessment.grading as { explanation?: unknown };
    return [artifact.assessment.prompt, ...(typeof grading.explanation === "string" ? [grading.explanation] : [])];
  }
  return [artifact.markdown];
}
/** The SDK operation that delivers each generated artifact kind. */
export function generatedOperation(kind: GeneratedTeachingSelection["artifact"]["kind"]) {
  return kind === "episode" ? "insert_episode" as const : kind === "visual" ? "attach_visual" as const
    : kind === "assessment_variant" ? "add_assessment_variant" as const : "append_teaching" as const;
}
