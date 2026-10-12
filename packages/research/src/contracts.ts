import { z } from 'zod';
import { requireResearch } from './errors.js';
import { safeDisplayUrl } from './urls.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const plain = (max: number) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
export const attributionSchema = z.strictObject({
  trust: z.literal('untrusted_provider_metadata'), providerName: plain(200).min(1), providerUrl: z.string().max(2048).optional(),
  authorName: plain(300).optional(), authorUrl: z.string().max(2048).optional(), requiredNotice: plain(1000).optional(),
  licenseLabel: plain(300).optional(), licenseUrl: z.string().max(2048).optional(), searchRank: z.number().int().min(1).max(10000).optional(),
});
export type SourceAttribution = z.infer<typeof attributionSchema>;
export function validateAttribution(value: unknown): SourceAttribution {
  const parsed = parse(attributionSchema, value);
  for (const url of [parsed.providerUrl, parsed.authorUrl, parsed.licenseUrl]) if (url) safeDisplayUrl(url);
  return parsed;
}
export const transcriptSchema = z.strictObject({
  text: plain(50000).min(1), language: z.string().regex(/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/),
  obtainedVia: z.enum(['author_supplied', 'authorized_api']),
  rights: z.strictObject({ basis: z.enum(['owned', 'licensed', 'public_domain']), reference: plain(1000).min(1), attribution: plain(1000).min(1) }),
});
export type AuthorizedTranscript = z.infer<typeof transcriptSchema>;
export const catalogSourceSchema = z.strictObject({
  id, kind: z.enum(['web', 'youtube']), url: z.string().max(2048), topicIds: z.array(id).min(1).max(20),
  attribution: attributionSchema.optional(), transcript: transcriptSchema.optional(),
  fallback: z.strictObject({ text: plain(10000).min(1), authorId: id, reference: plain(500).min(1) }).optional(),
});
export const policySchema = z.strictObject({
  id, revision: z.number().int().positive(), approvedBy: id, approvalId: id, expiresAt: timestamp,
  topics: z.array(z.strictObject({ id, description: plain(1000).min(1) })).min(1).max(50),
  allowedHosts: z.array(z.string().max(253)).min(1).max(20),
  sources: z.array(catalogSourceSchema).min(1).max(100),
});
export type ResearchPolicy = z.infer<typeof policySchema>;
export type CatalogSource = z.infer<typeof catalogSourceSchema>;
export const requestSchema = z.strictObject({ policyId: id, topicId: id, sourceId: id });
export type InspectionRequest = z.infer<typeof requestSchema>;
export interface ResearchPrincipal { actorId: string; role: 'author' | 'service'; policy: ResearchPolicy }
export type AuthorizeResearch<Credential> = (credential: Credential,
  request: InspectionRequest & { operation: 'inspect' | 'review' }) => Promise<ResearchPrincipal>;
export interface SourceInspection {
  formatVersion: 1;
  inspectionId: string;
  state: 'unreviewed';
  trust: 'untrusted_external_content';
  policy: { id: string; revision: number; approvalId: string; approvedBy: string };
  sourceId: string;
  topicId: string;
  kind: 'web' | 'youtube';
  title: string;
  content: { text: string; digest: string; truncated: boolean; basis: 'page' | 'transcript' | 'author_fallback' | 'metadata_only' };
  provenance: { requestedUrl: string; finalUrl: string; fetchedAt: string; bodyDigest: string | null; bytes: number;
    mediaType: string | null; hops: { url: string; address: string; family: 4 | 6; status: number }[];
    extractionVersion: 'readable-text-v1'; metadataAvailability: 'available' | 'unavailable'; failureCode?: string };
  attributions: SourceAttribution[];
  youtube?: YouTubeDescriptor;
}
export interface YouTubeDescriptor {
  videoId: string;
  watchUrl: string;
  embed: { src: string; title: string; aspectRatio: '16:9'; requiresUserActivation: true;
    referrerPolicy: 'strict-origin-when-cross-origin'; allow: 'fullscreen; encrypted-media; picture-in-picture'; loading: 'lazy' };
  attribution: SourceAttribution | null;
  transcript: { status: 'provided_with_rights'; language: string; obtainedVia: AuthorizedTranscript['obtainedVia']; rights: AuthorizedTranscript['rights'] } | { status: 'not_provided' };
  fallback: { text: string; source: 'author' | 'default'; reference: string | null };
}
export const reviewSchema = z.strictObject({
  ...requestSchema.shape, inspectionId: digest, decision: z.enum(['approved', 'rejected', 'needs_review']),
  rationale: plain(2000).min(20), contentDigest: digest,
  evidence: z.array(z.strictObject({ start: z.number().int().min(0), quote: plain(800).min(20), relevance: plain(1000).min(20) })).max(5),
  suitability: z.strictObject({ topicRelevant: z.boolean(), accurateEnoughForUse: z.boolean(), safeForAudience: z.boolean() }),
  rights: z.strictObject({ use: z.enum(['link_only', 'excerpt', 'embed']), basis: z.enum(['link_only', 'owned', 'licensed', 'public_domain', 'provider_embed']), reference: plain(1000).min(1) }),
  acknowledgesTruncation: z.boolean(),
});
export type SourceReviewInput = z.infer<typeof reviewSchema>;
export interface ReviewedSource {
  formatVersion: 1;
  reviewId: string;
  sourceId: string;
  topicId: string;
  inspectionId: string;
  status: SourceReviewInput['decision'];
  title: string;
  url: string;
  contentDigest: string;
  bodyDigest: string | null;
  reviewedBy: string;
  reviewedAt: string;
  policy: SourceInspection['policy'];
  rationale: string;
  evidence: SourceReviewInput['evidence'];
  suitability: SourceReviewInput['suitability'];
  rights: SourceReviewInput['rights'];
  attributions: SourceAttribution[];
  /** Display as escaped text, never HTML. Full inspected text is not a UI field. */
  display: { title: string; url: string; excerpts: string[]; youtube?: YouTubeDescriptor };
  qualification: 'author_content_review_not_truth_certification';
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input); requireResearch(result.success, 'INVALID_INPUT'); return result.data;
}
