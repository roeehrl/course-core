import { z } from "zod";
import {
  englishTranslator,
  type AdminTranslator,
  type MessageKey,
  type Translate,
} from "../i18n";

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
  /** BCP 47 tag of the caption track's language. */
  captionsLanguage?: string;
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
const MEDIA_CODES = new Set([
  "FORBIDDEN",
  "MEDIA_PROVIDER_UNCONFIGURED",
  "MEDIA_CAPABILITY_MISSING",
  "MEDIA_PROVIDER_UNAVAILABLE",
  "MEDIA_PRICING_UNAVAILABLE",
  "MEDIA_EPISODE_OUT_OF_SCOPE",
  "MEDIA_CAPTIONS_REQUIRED",
  "MEDIA_TEXT_ALTERNATIVE_REQUIRED",
  "MEDIA_REVIEW_FINDINGS_INCOMPLETE",
  "MEDIA_ASSET_CHANGED",
  "MEDIA_NOT_UNDER_REVIEW",
  "MEDIA_NOT_APPROVED",
  "MEDIA_PUBLICATION_DENIED",
  "MEDIA_EXPIRY_INVALID",
  "MEDIA_NOT_CANCELLABLE",
  "MEDIA_ATTACHMENT_ALREADY_REVOKED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_INPUT",
]);
/** Words of an unknown machine code, shown only as a fallback ("MEDIA_X_Y" → "x y"). */
const codeWords = (code: string) => code.replaceAll("_", " ").toLowerCase();
export function mediaErrorMessage(
  error: unknown,
  t: Translate = englishTranslator().t,
) {
  const code = error instanceof MediaActionError ? error.code : undefined;
  if (code && MEDIA_CODES.has(code))
    return t(`media.error.${code}` as MessageKey);
  if (code?.startsWith("MEDIA_"))
    return t("media.error.refused", { reason: codeWords(code.slice(6)) });
  return t("media.error.unavailable");
}
const FAILURE_CODES = new Set([
  "MEDIA_BUDGET_EXHAUSTED",
  "MEDIA_PER_JOB_LIMIT",
  "MEDIA_POLICY_DENIED",
  "MEDIA_CAPACITY",
  "MEDIA_OUTCOME_UNKNOWN",
  "MEDIA_DEADLINE_REACHED",
  "MEDIA_POLL_LIMIT",
  "MEDIA_PROVIDER_FAILED",
  "MEDIA_PROVIDER_REJECTED",
  "MEDIA_ASSET_INVALID",
  "MEDIA_ASSET_TOO_LARGE",
  "MEDIA_REVIEW_REJECTED",
  "MEDIA_CANCELLED",
  "MEDIA_REVOKED",
  "MEDIA_ATTACHMENT_EXPIRED",
]);
export const failureText = (
  code: string | null,
  t: Translate = englishTranslator().t,
) =>
  code
    ? FAILURE_CODES.has(code)
      ? t(`media.failure.${code}` as MessageKey)
      : codeWords(code)
    : null;
/** A micro-dollar amount in the UI locale: 2 decimals for whole cents, else 4. */
export const usd = (
  microUsd: number | null,
  i18n: Pick<AdminTranslator, "t" | "currency"> = englishTranslator(),
) => {
  if (microUsd === null) return i18n.t("media.usd.unavailable");
  const digits = microUsd % 10_000 === 0 ? 2 : 4;
  return i18n.currency(microUsd / 1_000_000, "USD", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};
