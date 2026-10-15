import { z } from "zod";

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
]);
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
]);
export const generatedTeachingSelectionSchema = z.strictObject({
  profileId: id,
  episodeId: id,
  permissionRevision: z.number().int().positive(),
  registryRevision: z.number().int().positive(),
  configurationDigest: hash,
  baseCourseDigest: hash,
  artifact: generatedArtifactSchema,
});
export type GeneratedTeachingSelection = z.infer<
  typeof generatedTeachingSelectionSchema
>;
/** Every text block of a generated artifact, for checks that read prose. */
export function generatedBlocks(artifact: GeneratedTeachingSelection["artifact"]): string[] {
  return artifact.kind === "episode" ? [artifact.title, ...artifact.blocks.map((b) => b.markdown)] : [artifact.markdown];
}
