import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$(?![\s\S])/);
const hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const references = z
  .array(id)
  .min(1)
  .max(16)
  .refine((v) => new Set(v).size === v.length);

/** A candidate, not a proof. Every identity, price, classification and revision
 * is resolved by the host from a course-approved profile. */
export const generatedTeachingInputSchema = z.strictObject({
  profileId: id,
  kind: z.enum(["explanation", "practice"]),
  markdown: z
    .string()
    .min(1)
    .max(8000)
    .refine((v) => v.trim().length > 0),
  objectiveIds: references,
  sourceRefs: references,
});
export const generatedTeachingSelectionSchema = z.strictObject({
  profileId: id,
  episodeId: id,
  permissionRevision: z.number().int().positive(),
  registryRevision: z.number().int().positive(),
  configurationDigest: hash,
  baseCourseDigest: hash,
  artifact: z.strictObject({
    id,
    digest: hash,
    kind: z.enum(["explanation", "practice"]),
    markdown: generatedTeachingInputSchema.shape.markdown,
    objectiveIds: references,
    sourceRefs: references,
    generator: z.strictObject({ id, version: z.string().min(1).max(128) }),
  }),
});
export type GeneratedTeachingSelection = z.infer<
  typeof generatedTeachingSelectionSchema
>;
