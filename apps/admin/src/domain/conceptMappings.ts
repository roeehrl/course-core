import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/** Staff-authored links between objectives of two course releases (server: concept-mappings.ts). */
export const mappingRelations = [
  "equivalent",
  "prerequisite_of",
  "overlaps",
] as const;
export type MappingRelation = (typeof mappingRelations)[number];
const objective = z.object({
  id: z.string().max(128),
  description: z.string().max(2000),
});
const end = z.object({
  releaseId: z.string().uuid(),
  objectiveId: z.string().max(128),
});
export const mappingLinkSchema = z.object({
  relation: z.enum(mappingRelations),
  from: end,
  to: end,
});
export type MappingLink = z.infer<typeof mappingLinkSchema>;
export const mappingCandidatesSchema = z.object({
  courses: z
    .array(
      z.object({
        catalogId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        workspaceTitle: z.string().max(200),
        courseKey: z.string().max(200),
        title: z.string().max(200),
        role: z.string().max(40),
        releases: z
          .array(
            z.object({
              releaseId: z.string().uuid(),
              version: z.string().max(100),
              status: z.string().max(40),
              title: z.string().max(200).nullable(),
              objectives: z.array(objective).max(500),
            }),
          )
          .max(200),
      }),
    )
    .max(500),
  maxLinks: z.number().int().positive(),
});
export type MappingCandidates = z.infer<typeof mappingCandidatesSchema>;
const course = z.object({
  releaseId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  courseKey: z.string().max(200),
  version: z.string().max(100),
  title: z.string().max(200).nullable(),
});
export const conceptMappingSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  state: z.enum(["active", "retired"]),
  updatedAt: z.string(),
  courses: z.object({ a: course, b: course }),
  links: z.array(mappingLinkSchema).max(200),
  linksDigest: z.string().nullable(),
  authoredBy: z.literal("staff"),
  inferred: z.literal(false),
  replayed: z.boolean().optional(),
  history: z
    .array(
      z.object({
        revision: z.number().int().positive(),
        action: z.enum(["created", "revised", "retired", "restored"]),
        linkCount: z.number().int().nonnegative(),
        linksDigest: z.string(),
        author: z.object({
          id: z.string().uuid(),
          displayName: z.string().max(200),
        }),
        roles: z.object({ a: z.string().max(40), b: z.string().max(40) }),
        note: z.string().max(500),
        createdAt: z.string(),
      }),
    )
    .max(50),
});
export type ConceptMapping = z.infer<typeof conceptMappingSchema>;
export const mappingPairSchema = z.object({
  courses: z.object({
    a: course.extend({ objectives: z.array(objective).max(500) }),
    b: course.extend({ objectives: z.array(objective).max(500) }),
  }),
  mapping: conceptMappingSchema.nullable(),
});
export type MappingPair = z.infer<typeof mappingPairSchema>;

export interface ConceptMappingPort {
  candidates(signal?: AbortSignal): Promise<MappingCandidates>;
  pair(
    first: string,
    second: string,
    signal?: AbortSignal,
  ): Promise<MappingPair>;
  save(input: {
    releaseIds: [string, string];
    expectedRevision: number;
    idempotencyKey: string;
    links: MappingLink[];
    note?: string;
  }): Promise<ConceptMapping>;
  retire(
    mappingId: string,
    input: { expectedRevision: number; idempotencyKey: string; note?: string },
  ): Promise<ConceptMapping>;
}
export class ConceptMappingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ConceptMappingError";
  }
}
const MAPPING_CODES = new Set([
  "FORBIDDEN",
  "RELEASE_NOT_FOUND",
  "CONCEPT_MAPPING_STALE",
  "CONCEPT_MAPPING_SAME_RELEASE",
  "CONCEPT_MAPPING_SAME_COURSE",
  "CONCEPT_MAPPING_DUPLICATE_LINK",
  "CONCEPT_MAPPING_LINK_SCOPE",
  "OBJECTIVE_OUT_OF_SCOPE",
  "CONCEPT_MAPPING_RETIRED",
  "RELEASE_NOT_PUBLISHED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST",
]);
export const conceptMappingErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) => {
  const code = error instanceof ConceptMappingError ? error.code : "";
  return MAPPING_CODES.has(code)
    ? t(`conceptMappings.error.${code}` as MessageKey)
    : t("conceptMappings.error.unavailable");
};
