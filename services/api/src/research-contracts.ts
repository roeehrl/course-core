import { z } from "zod";
const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$(?![\s\S])/),
  hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
export const researchSelectionSchema = z.strictObject({
  requestId: z.string().uuid(),
  topicId: id,
  episodeId: id,
  permissionRevision: z.number().int().positive(),
  queryDigest: hash,
  courseDigest: hash,
  /** Digest of the structured, learner-free SDK ResearchRequest, when the course declares research tasks. */
  requestDigest: hash.optional(),
});
export type ResearchSelection = z.infer<typeof researchSelectionSchema>;
export const researchCandidateSchema = z
  .strictObject({
    kind: z.literal("research_candidate"),
    requestId: z.string().uuid(),
    topicId: id,
    queryDigest: hash,
    reviewState: z.literal("unreviewed"),
    text: z.string().min(1).max(32000),
    grounding: z.enum(["grounded", "not_grounded"]),
    parts: z
      .array(
        z.strictObject({
          partIndex: z.number().int().nonnegative(),
          text: z.string().max(32000),
        }),
      )
      .max(32),
    sources: z
      .array(
        z.strictObject({
          uri: z.string().max(2048),
          title: z.string().max(1000),
        }),
      )
      .max(50),
    citations: z
      .array(
        z.strictObject({
          partIndex: z.number().int().nonnegative(),
          startByte: z.number().int().nonnegative(),
          endByte: z.number().int().nonnegative(),
          sourceIndices: z.array(z.number().int().nonnegative()).max(50),
        }),
      )
      .max(128),
    searchQueries: z.array(z.string().max(2000)).max(20),
  })
  .refine(
    (v) => new Set(v.parts.map((p) => p.partIndex)).size === v.parts.length,
  );
export type ResearchCandidate = z.infer<typeof researchCandidateSchema>;
