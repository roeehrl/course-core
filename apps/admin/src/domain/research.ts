import { z } from "zod";

const text = (max: number) => z.string().max(max);
const iso = z.string().max(64);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const attribution = z.object({
  providerName: text(200),
  authorName: text(300).optional(),
  requiredNotice: text(1000).optional(),
});
const youtube = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  watchUrl: text(2048),
  embed: z.object({ src: text(2048), title: text(300) }),
  fallback: z.object({ text: text(10000) }),
});
/** A stored YouTube Data API search: metadata-only, unreviewed leads. */
export const youtubeSearchSchema = z.object({
  id: z.string().uuid(),
  topicId: text(128),
  createdAt: iso,
  sent: z.object({
    q: text(500),
    relevanceLanguage: text(20).nullable(),
    maxResults: z.number(),
  }),
  hits: z
    .array(
      z.object({
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
        watchUrl: text(2048),
        title: text(300),
        channelTitle: text(300),
        publishedAt: iso.nullable(),
        durationSeconds: z.number().nullable(),
        embeddable: z.boolean().nullable(),
        captions: z.enum(["creator_captions", "unknown"]),
        reviewStatus: z.literal("unreviewed"),
      }),
    )
    .max(10),
  reviewStatus: z.literal("unreviewed"),
});
export type YouTubeSearch = z.infer<typeof youtubeSearchSchema>;
export const youtubeSearchReceiptSchema = z.object({
  search: youtubeSearchSchema,
  contentUse: z.literal("not_reviewed"),
  grantsCredit: z.literal(false),
});
export const inspectionViewSchema = z.object({
  id: digest,
  createdAt: iso,
  title: text(300),
  kind: z.enum(["web", "youtube"]),
  basis: z.enum(["page", "transcript", "author_fallback", "metadata_only"]),
  truncated: z.boolean(),
  contentDigest: digest,
  text: text(64000),
  finalUrl: text(2048),
  metadataAvailability: z.enum(["available", "unavailable"]),
  fetchedAt: iso,
  hops: z.array(z.object({ url: text(2048), status: z.number() })).max(8),
  attributions: z.array(attribution).max(3),
  youtube: youtube.optional(),
});
export const reviewViewSchema = z.object({
  id: digest,
  inspectionId: digest,
  decision: z.enum(["approved", "rejected", "needs_review"]),
  rationale: text(2000),
  evidence: z
    .array(
      z.object({ start: z.number(), quote: text(800), relevance: text(1000) }),
    )
    .max(5),
  suitability: z.object({
    topicRelevant: z.boolean(),
    accurateEnoughForUse: z.boolean(),
    safeForAudience: z.boolean(),
  }),
  rights: z.object({ use: text(40), basis: text(40), reference: text(1000) }),
  segment: z
    .object({ startSeconds: z.number(), endSeconds: z.number() })
    .nullable()
    .optional(),
  reviewedBy: text(128),
  reviewedAt: iso,
});
export const researchLibrarySchema = z.object({
  release: z.object({ id: z.string(), version: text(100), status: text(40) }),
  topics: z
    .array(
      z.object({
        id: text(128),
        objectiveIds: z.array(text(128)),
        queryText: text(2000),
        allowedDomains: z.array(text(253)),
        episodes: z.array(z.object({ id: text(128), title: text(300) })),
      }),
    )
    .max(100),
  sources: z
    .array(
      z.object({
        id: z.string().uuid(),
        topicId: text(128),
        kind: z.enum(["web", "youtube"]),
        url: text(2048),
        fallbackText: text(10000).nullable(),
        candidateId: z.string().uuid().nullable(),
        searchId: z.string().uuid().nullable().optional(),
        durationSeconds: z.number().nullable().optional(),
        captions: z.enum(["creator_captions", "unknown"]).nullable().optional(),
        embeddable: z.boolean().nullable().optional(),
        expiresAt: iso,
        createdAt: iso,
        expired: z.boolean(),
        inspections: z.array(inspectionViewSchema).max(3),
        failures: z.array(z.object({ code: text(64), createdAt: iso })).max(3),
        reviews: z.array(reviewViewSchema).max(300),
      }),
    )
    .max(100),
  attachments: z
    .array(
      z.object({
        id: z.string().uuid(),
        reviewId: digest,
        sourceId: z.string().uuid(),
        episodeId: text(128),
        topicId: text(128),
        expiresAt: iso,
        createdAt: iso,
        state: z.enum(["active", "expired", "revoked"]),
        revokedAt: iso.nullable(),
        revokeReason: text(1000).nullable(),
      }),
    )
    .max(300),
  searches: z.array(youtubeSearchSchema).max(5).optional(),
  grantsCredit: z.literal(false),
});
export type ResearchLibrary = z.infer<typeof researchLibrarySchema>;
export type ResearchSource = ResearchLibrary["sources"][number];
export type InspectionView = z.infer<typeof inspectionViewSchema>;
export const researchQueueSchema = z.object({
  requests: z
    .array(
      z.object({
        id: z.string(),
        topicId: text(128),
        episodeId: text(128),
        state: text(40),
        candidateId: z.string().nullable(),
        reviewState: text(40).nullable(),
        content: z
          .object({
            sources: z
              .array(z.object({ uri: text(2048), title: text(1000) }))
              .max(50)
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      }),
    )
    .max(50),
});
export type ResearchQueue = z.infer<typeof researchQueueSchema>;
export const researchReceiptSchema = z.record(z.string(), z.unknown());
export interface AddSourceInput {
  topicId: string;
  kind: "web" | "youtube";
  url: string;
  fallbackText?: string;
  candidateId?: string;
  /** The stored search that returned this video; its metadata is copied by the server. */
  searchId?: string;
  expiresAt: string;
}
export interface ReviewInput {
  decision: "approved" | "rejected" | "needs_review";
  contentDigest: string;
  rationale: string;
  evidence: { quote: string; relevance: string }[];
  suitability: {
    topicRelevant: boolean;
    accurateEnoughForUse: boolean;
    safeForAudience: boolean;
  };
  rights: {
    use: "link_only" | "excerpt" | "embed";
    basis:
      "link_only" | "owned" | "licensed" | "public_domain" | "provider_embed";
    reference: string;
  };
  acknowledgesTruncation: boolean;
  /** The part of a video the reviewer watched. */
  segment?: { startSeconds: number; endSeconds: number };
}
/** Every mutation carries a caller-retained idempotency key so a retried
 * request after a lost response cannot create a second record. */
export interface ResearchAdminPort {
  library(releaseId: string, signal?: AbortSignal): Promise<ResearchLibrary>;
  queue(releaseId: string, signal?: AbortSignal): Promise<ResearchQueue>;
  addSource(
    releaseId: string,
    input: AddSourceInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  inspect(sourceId: string): Promise<unknown>;
  /** Sends only the topic's approved query to the YouTube Data API (workspace key). */
  youtubeSearch?(releaseId: string, topicId: string): Promise<unknown>;
  review(
    inspectionId: string,
    input: ReviewInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  attach(
    reviewId: string,
    input: { episodeId: string; expiresAt: string },
    idempotencyKey: string,
  ): Promise<unknown>;
  revoke(
    attachmentId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<unknown>;
}
const researchMessages: Record<string, string> = {
  RESEARCH_DOMAIN_NOT_ALLOWED:
    "This topic only allows sources from its author-approved domains.",
  RESEARCH_URL_REJECTED:
    "Use a public HTTPS address without credentials, ports, fragments or query text.",
  RESEARCH_SOURCE_EXISTS: "This source is already in the topic's catalog.",
  RESEARCH_EXPIRY_INVALID:
    "Choose an expiry in the future and no later than the source approval's expiry (at most one year).",
  RESEARCH_SOURCE_EXPIRED:
    "This source approval has expired. Add it again with a new expiry to re-inspect it.",
  RESEARCH_REVIEW_EVIDENCE_REQUIRED:
    "Approval needs at least one exact quote from the inspected text, all suitability checks, readable content and acknowledgement of truncation.",
  RESEARCH_RIGHTS_REQUIRED:
    "The selected use needs a matching rights basis: excerpts need owned, licensed or public-domain rights; embeds need a video with provider metadata.",
  RESEARCH_INSPECTION_CHANGED:
    "The inspection changed since you opened it. Refresh and review the current text.",
  RESEARCH_REVIEW_SUPERSEDED:
    "A newer review of this source exists. Attach only the latest approved review.",
  RESEARCH_REVIEW_NOT_APPROVED: "Only approved reviews can be attached.",
  RESEARCH_EPISODE_OUT_OF_SCOPE:
    "That episode does not teach every objective of this research topic.",
  RESEARCH_ATTACHMENT_EXISTS:
    "This reviewed source is already attached to that episode.",
  RESEARCH_ATTACHMENT_ALREADY_REVOKED: "This attachment was already revoked.",
  PUBLISHED_RELEASE_REQUIRED:
    "Resources can only be attached to a published release.",
  IDEMPOTENCY_CONFLICT:
    "A previous request with this retry key had different content. Refresh and try again.",
  FORBIDDEN: "Your role cannot perform this research action.",
  YOUTUBE_SEARCH_NOT_CONFIGURED:
    "YouTube search needs a YouTube Data API key. An owner or admin adds it in AI services, under Advanced (for developers) → YouTube search key.",
  YOUTUBE_SEARCH_UNAUTHORIZED:
    "YouTube refused the workspace key. Check it in Provider setup.",
  YOUTUBE_SEARCH_QUOTA:
    "The YouTube Data API quota is used up for now. Try again later.",
  YOUTUBE_SEARCH_FAILED: "YouTube search did not answer. Nothing was saved.",
  RESEARCH_SEARCH_MISMATCH:
    "That video is not in the stored search for this topic.",
  RESEARCH_SEGMENT_OUT_OF_RANGE:
    "The reviewed segment ends after the video does.",
  RESEARCH_SEGMENT_NOT_APPLICABLE: "Only videos have a reviewed segment.",
};
export class ResearchActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ResearchActionError";
  }
}
export function researchErrorMessage(error: unknown): string {
  const code = error instanceof ResearchActionError ? error.code : undefined;
  if (code && researchMessages[code]) return researchMessages[code];
  if (code?.startsWith("YOUTUBE_"))
    return "YouTube search failed. Nothing was saved.";
  if (code?.startsWith("RESEARCH_"))
    return `Inspection or review was refused (${code
      .slice("RESEARCH_".length)
      .replaceAll("_", " ")
      .toLowerCase()}). Nothing was approved or delivered.`;
  return "The research service is unavailable. Nothing was approved or delivered.";
}
