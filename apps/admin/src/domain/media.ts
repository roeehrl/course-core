import { z } from "zod";

const text = (max: number) => z.string().max(max);
const iso = z.string().max(64);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MEDIA_STATES = [
  "requested",
  "admitted",
  "submitted",
  "polling",
  "generated",
  "under_review",
  "approved",
  "rejected",
  "attached",
  "expired",
  "failed",
  "cancelled",
  "uncertain",
] as const;
const settings = z.object({
  durationSeconds: z.number(),
  aspectRatio: text(16),
  resolution: text(128),
});
const pricing = z.object({
  microUsdPerOutputSecond: z.number(),
  source: text(300),
  reviewedAt: text(32),
});
export const mediaJobSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(MEDIA_STATES),
  failureCode: text(64).nullable(),
  title: text(200),
  objective: text(2000),
  script: text(8000).optional(),
  enrollmentId: z.string().uuid(),
  learnerName: text(300).nullable(),
  episodeId: text(128),
  providerRevision: z.number(),
  modelId: text(2048),
  settings,
  pricing: pricing.nullable(),
  estimateMicroUsd: z.number().nullable(),
  chargedMicroUsd: z.number(),
  providerOperationId: text(512).nullable(),
  remoteMayContinue: z.boolean(),
  submitAttempts: z.number(),
  pollAttempts: z.number(),
  deadlineAt: iso,
  createdAt: iso,
  updatedAt: iso,
  asset: z
    .object({
      sha256: digest,
      mimeType: text(40),
      byteLength: z.number(),
      createdAt: iso,
    })
    .nullable(),
  review: z
    .object({
      id: z.string().uuid(),
      decision: z.enum(["approved", "rejected"]),
      assetSha256: digest,
      rationale: text(2000),
      hasCaptions: z.boolean(),
      transcript: text(20000).nullable(),
      visualDescription: text(5000).nullable(),
      reviewedAt: iso,
    })
    .nullable(),
  attachment: z
    .object({
      id: z.string().uuid(),
      episodeId: text(128),
      expiresAt: iso,
      state: z.enum(["active", "expired", "revoked"]),
      revokedAt: iso.nullable(),
      revokeReason: text(1000).nullable(),
    })
    .nullable(),
  events: z
    .array(
      z.object({
        from: text(32).nullable(),
        to: text(32),
        code: text(64).nullable(),
        at: iso,
      }),
    )
    .max(200)
    .optional(),
  learnerVisible: z.boolean(),
  grantsCredit: z.literal(false),
});
export type MediaJob = z.infer<typeof mediaJobSchema>;
export const mediaLibrarySchema = z.object({
  release: z.object({ id: z.string().uuid(), version: text(100) }),
  episodes: z.array(z.object({ id: text(128), title: text(300) })).max(500),
  enrollments: z
    .array(
      z.object({ id: z.string().uuid(), name: text(300), status: text(40) }),
    )
    .max(100),
  provider: z
    .object({
      revision: z.number(),
      modelId: text(2048),
      settings,
      pricing: pricing.nullable(),
      availability: text(40),
      estimateMicroUsd: z.number().nullable(),
      perJobAllowanceMicroUsd: z.number(),
    })
    .nullable(),
  permissions: z.object({
    request: z.boolean(),
    review: z.boolean(),
    attach: z.boolean(),
  }),
  jobs: z.array(mediaJobSchema).max(100),
  liveGenerationVerified: z.boolean(),
});
export type MediaLibrary = z.infer<typeof mediaLibrarySchema>;
export const mediaEstimateSchema = z.object({
  estimateMicroUsd: z.number().nullable(),
  reserveMicroUsd: z.number(),
  availableMicroUsd: z.number(),
  admissible: z.boolean(),
  reason: text(64).nullable(),
});
export type MediaEstimate = z.infer<typeof mediaEstimateSchema>;
export const mediaReceiptSchema = z.record(z.string(), z.unknown());
export interface MediaRequestInput {
  episodeId: string;
  title: string;
  objective: string;
  script: string;
}
export interface MediaReviewInput {
  decision: "approved" | "rejected";
  assetSha256: string;
  captionsVtt?: string;
  transcript?: string;
  visualDescription?: string;
  findings: {
    factualAccuracy: boolean;
    labelsAndEquations: boolean;
    captionsMatchNarration: boolean;
    noMisleadingMotion: boolean;
  };
  rationale: string;
}
/** Staff media-job port. Every action is authorized again by the server. */
export interface MediaAdminPort {
  library(releaseId: string, signal?: AbortSignal): Promise<MediaLibrary>;
  detail(jobId: string, signal?: AbortSignal): Promise<MediaJob>;
  estimate(enrollmentId: string, episodeId: string): Promise<MediaEstimate>;
  request(
    enrollmentId: string,
    input: MediaRequestInput,
    idempotencyKey: string,
  ): Promise<MediaJob>;
  review(
    jobId: string,
    input: MediaReviewInput,
    idempotencyKey: string,
  ): Promise<unknown>;
  attach(
    jobId: string,
    expiresAt: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  cancel(jobId: string, idempotencyKey: string): Promise<unknown>;
  revoke(
    attachmentId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  assetUrl(jobId: string): string;
}
export class MediaActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MediaActionError";
  }
}
const messages: Record<string, string> = {
  FORBIDDEN: "Your role cannot do this. Nothing changed.",
  MEDIA_PROVIDER_UNCONFIGURED:
    "No media provider is configured for this workspace. Configure one under Providers first.",
  MEDIA_CAPABILITY_MISSING:
    "The configured provider has no video model assigned to the media role.",
  MEDIA_PROVIDER_UNAVAILABLE:
    "The media provider is not ready (for example, its key is missing). Nothing was charged.",
  MEDIA_PRICING_UNAVAILABLE:
    "The media role has no reviewed rate card, so no cost can be estimated. Nothing was charged.",
  MEDIA_EPISODE_OUT_OF_SCOPE:
    "That episode is not part of this learner's release.",
  MEDIA_CAPTIONS_REQUIRED:
    "Approval needs WebVTT captions with at least one cue.",
  MEDIA_TEXT_ALTERNATIVE_REQUIRED:
    "Approval needs a transcript and a description of what the video shows.",
  MEDIA_REVIEW_FINDINGS_INCOMPLETE:
    "Approval needs every review check confirmed. Reject the clip instead.",
  MEDIA_ASSET_CHANGED:
    "The stored clip changed since you opened it. Reload and review again.",
  MEDIA_NOT_UNDER_REVIEW: "This job is no longer waiting for review.",
  MEDIA_NOT_APPROVED: "Only an approved clip can be attached.",
  MEDIA_PUBLICATION_DENIED:
    "Current course policy does not allow publishing to this learner now (closed, past a deadline or no longer a member). Nothing was shown.",
  MEDIA_EXPIRY_INVALID: "Choose an expiry between now and 180 days.",
  MEDIA_NOT_CANCELLABLE: "This job has already finished.",
  MEDIA_ATTACHMENT_ALREADY_REVOKED: "This attachment was already revoked.",
  IDEMPOTENCY_CONFLICT:
    "A different request already used this retry key. Start again.",
  INVALID_INPUT: "Some fields are missing or out of range.",
};
export function mediaErrorMessage(error: unknown) {
  const code = error instanceof MediaActionError ? error.code : undefined;
  if (code && messages[code]) return messages[code];
  if (code?.startsWith("MEDIA_"))
    return `The media service refused this (${code.slice(6).replaceAll("_", " ").toLowerCase()}). Nothing was published.`;
  return "The media service is unavailable. Nothing was published.";
}
const refusals: Record<string, string> = {
  MEDIA_BUDGET_EXHAUSTED:
    "refused: the workspace or learner paid-work allowance cannot cover the per-job reservation",
  MEDIA_PER_JOB_LIMIT: "refused: the estimate exceeds the per-job allowance",
  MEDIA_POLICY_DENIED: "refused: current course policy does not allow new work",
  MEDIA_CAPACITY: "refused: too many media jobs are already running",
  MEDIA_OUTCOME_UNKNOWN:
    "the provider never confirmed the submission; it was not resent",
  MEDIA_DEADLINE_REACHED: "stopped at the job deadline",
  MEDIA_POLL_LIMIT: "stopped after the polling limit",
  MEDIA_PROVIDER_FAILED: "the provider reported a failed render",
  MEDIA_PROVIDER_REJECTED: "the provider rejected the request",
  MEDIA_ASSET_INVALID: "the returned file was not a supported video",
  MEDIA_ASSET_TOO_LARGE: "the returned file exceeded the size limit",
  MEDIA_REVIEW_REJECTED: "rejected in review",
  MEDIA_CANCELLED: "cancelled by staff",
  MEDIA_REVOKED: "revoked by staff",
  MEDIA_ATTACHMENT_EXPIRED: "the attachment expired",
};
export const failureText = (code: string | null) =>
  code ? (refusals[code] ?? code.replaceAll("_", " ").toLowerCase()) : null;
export const usd = (microUsd: number | null) =>
  microUsd === null
    ? "not available"
    : `$${(microUsd / 1_000_000).toFixed(microUsd % 10_000 === 0 ? 2 : 4)}`;
