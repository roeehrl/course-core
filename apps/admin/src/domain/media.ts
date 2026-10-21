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
/** Video settings ({durationSeconds, aspectRatio, resolution}), image settings
 * ({aspectRatio?, imageSize?}) or an exact clip's render settings, by job kind. */
const settings = z.record(z.string(), z.unknown());
export const MEDIA_KINDS = [
  "generated_short_video",
  "generated_image",
  "scene_clip",
  "composed_video",
] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
const finding = z.object({
  code: text(64),
  source: text(32),
  subject: text(400),
  expected: text(1000).nullable(),
  found: text(1000),
});
export type CheckFinding = z.infer<typeof finding>;
const capabilities = z
  .object({
    kind: z.enum(["video", "image"]),
    billing: text(40),
    cancellation: text(40),
    maxPromptCharacters: z.number(),
    retention: z.object({
      outputHours: z.number().nullable(),
      providerStoresRequest: z.boolean(),
    }),
  })
  .nullable();
const units = z
  .object({
    outputSeconds: z.number(),
    images: z.number(),
    requests: z.number(),
  })
  .nullable();
const pricing = z.object({
  microUsdPerOutputSecond: z.number(),
  microUsdPerRequest: z.number().optional(),
  source: text(300),
  reviewedAt: text(32),
});
export const mediaJobSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(MEDIA_STATES),
  failureCode: text(64).nullable(),
  kind: z.enum(MEDIA_KINDS),
  paid: z.boolean(),
  storyboardId: z.string().uuid().nullable(),
  shotId: text(32).nullable(),
  referenceVisualId: text(128).nullable(),
  source: z.record(z.string(), z.unknown()).nullable(),
  title: text(200),
  objective: text(2000),
  script: text(8000).optional(),
  enrollmentId: z.string().uuid(),
  learnerName: text(300).nullable(),
  episodeId: text(128),
  providerRevision: z.number().nullable(),
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
      provenance: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .nullable(),
  checks: z
    .array(
      z.object({
        id: z.string().uuid(),
        assetSha256: digest,
        verifier: z.enum(["rules", "model"]),
        verdict: z.enum(["consistent", "contradicted", "unverified"]),
        findings: z.array(finding).max(40),
        at: iso,
      }),
    )
    .max(20)
    .optional(),
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
  visuals: z
    .array(
      z.object({ id: text(128), title: text(300), durationMs: z.number() }),
    )
    .max(200),
  clipRendering: z.enum(["ready", "toolchain_missing"]),
  enrollments: z
    .array(
      z.object({ id: z.string().uuid(), name: text(300), status: text(40) }),
    )
    .max(100),
  provider: z
    .object({
      revision: z.number(),
      kind: z.enum(["video", "image"]),
      modelId: text(2048),
      settings,
      pricing: pricing.nullable(),
      availability: text(40),
      estimateMicroUsd: z.number().nullable(),
      units,
      capabilities,
      perJobAllowanceMicroUsd: z.number(),
    })
    .nullable(),
  /** An image model bound beside the video model (absent from older servers). */
  imageProvider: z
    .object({
      revision: z.number(),
      kind: z.enum(["video", "image"]),
      modelId: text(2048),
      settings,
      pricing: pricing.nullable(),
      availability: text(40),
      estimateMicroUsd: z.number().nullable(),
      units,
      capabilities,
      perJobAllowanceMicroUsd: z.number(),
    })
    .nullable()
    .optional(),
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
  kind: z.enum(["video", "image"]).optional(),
  estimateMicroUsd: z.number().nullable(),
  reserveMicroUsd: z.number(),
  availableMicroUsd: z.number(),
  admissible: z.boolean(),
  reason: text(64).nullable(),
});
export type MediaEstimate = z.infer<typeof mediaEstimateSchema>;
export const mediaReceiptSchema = z.record(z.string(), z.unknown());
const shot = z.object({
  id: text(32),
  kind: z.enum(["generated", "scene"]),
  description: text(1000),
  narration: text(2000),
  durationSeconds: z.number().optional(),
  visualId: text(128).optional(),
  fromMs: z.number().optional(),
  toMs: z.number().optional(),
});
export type StoryboardShot = z.infer<typeof shot>;
export const storyboardSchema = z.object({
  id: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  episodeId: text(128),
  title: text(200),
  objective: text(2000),
  script: text(8000),
  shots: z.array(shot).min(1).max(8),
  referenceVisualId: text(128).nullable(),
  draftedBy: z.enum(["model", "staff"]),
  draftStatus: z.enum(["pending", "ready", "failed"]),
  draftFailure: text(64).optional(),
  state: z.enum(["draft", "approved", "rejected"]),
  revision: z.number(),
  reviewNote: text(2000).nullable(),
  updatedAt: iso,
  jobs: z
    .array(
      z.object({
        id: z.string().uuid(),
        shotId: text(32).nullable(),
        kind: z.enum(MEDIA_KINDS),
        state: z.enum(MEDIA_STATES),
      }),
    )
    .max(500)
    .optional(),
});
export type Storyboard = z.infer<typeof storyboardSchema>;
export const storyboardListSchema = z.object({
  storyboards: z.array(storyboardSchema).max(50),
});
const checkView = z.object({
  verifier: z.enum(["rules", "model"]),
  verdict: z.enum(["consistent", "contradicted", "unverified"]),
  findings: z.array(finding).max(40),
  failure: text(64).optional(),
});
export const mediaCheckSchema = z.object({
  rules: checkView,
  model: checkView.nullable(),
});
export type MediaCheck = z.infer<typeof mediaCheckSchema>;
export interface MediaRequestInput {
  episodeId: string;
  title: string;
  objective: string;
  script: string;
  storyboardId?: string;
  shotId?: string;
  referenceVisualId?: string;
}
export interface MediaClipInput {
  episodeId: string;
  title: string;
  objective: string;
  script: string;
  visualId: string;
  fromMs: number;
  toMs: number;
  format: "mp4" | "webm";
  storyboardId?: string;
  shotId?: string;
}
export interface StoryboardInput {
  episodeId: string;
  title: string;
  objective: string;
  script: string;
  referenceVisualId?: string;
  draftWith: "model" | "staff";
  shots?: StoryboardShot[];
}
export interface MediaCheckInput {
  transcript?: string;
  visualDescription: string;
  captionsVtt?: string;
  useModel: boolean;
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
  /** `kind` picks the image or the video model when both are bound. */
  estimate(
    enrollmentId: string,
    episodeId: string,
    kind?: "video" | "image",
  ): Promise<MediaEstimate>;
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
  /** A generated image: the prompt is sent to the image model (the media role's image binding). */
  requestImage(
    enrollmentId: string,
    input: Omit<MediaRequestInput, "script"> & { prompt: string },
    idempotencyKey: string,
  ): Promise<MediaJob>;
  /** An exact clip rendered from a verified course visual. Free; no provider. */
  requestClip(
    enrollmentId: string,
    input: MediaClipInput,
    idempotencyKey: string,
  ): Promise<MediaJob>;
  compose(storyboardId: string, idempotencyKey: string): Promise<MediaJob>;
  storyboards(releaseId: string, signal?: AbortSignal): Promise<Storyboard[]>;
  createStoryboard(
    enrollmentId: string,
    input: StoryboardInput,
    idempotencyKey: string,
  ): Promise<Storyboard>;
  editStoryboard(
    storyboardId: string,
    expectedRevision: number,
    shots: StoryboardShot[],
    idempotencyKey: string,
  ): Promise<Storyboard>;
  reviewStoryboard(
    storyboardId: string,
    expectedRevision: number,
    decision: "approved" | "rejected",
    idempotencyKey: string,
  ): Promise<Storyboard>;
  check(
    jobId: string,
    input: MediaCheckInput,
    idempotencyKey: string,
  ): Promise<MediaCheck>;
  revoke(
    attachmentId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  assetUrl(jobId: string): string;
}
export class MediaActionError extends Error {
  /** Contradictions the automated check found, when the server refused an approval for them. */
  readonly findings: CheckFinding[];
  constructor(
    readonly code: string,
    details?: unknown,
  ) {
    super(code);
    this.name = "MediaActionError";
    const parsed = z
      .object({ findings: z.array(finding).max(40) })
      .safeParse(details);
    this.findings = parsed.success ? parsed.data.findings : [];
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
  "MEDIA_FACTUAL_CHECK_FAILED",
  "MEDIA_REFERENCE_NOT_FOUND",
  "MEDIA_CLIP_TOOLCHAIN_MISSING",
  "MEDIA_CLIP_RANGE_INVALID",
  "MEDIA_STORYBOARD_NOT_FOUND",
  "MEDIA_STORYBOARD_NOT_APPROVED",
  "MEDIA_STORYBOARD_SHOT_MISMATCH",
  "MEDIA_STORYBOARD_NOT_DRAFT",
  "MEDIA_STORYBOARD_REVISION_CONFLICT",
  "MEDIA_STORYBOARD_DRAFT_PENDING",
  "MEDIA_SHOT_DURATION_UNSUPPORTED",
  "MEDIA_COMPOSITION_INCOMPLETE",
  "MEDIA_ASSISTANT_UNAVAILABLE",
  "MEDIA_BUDGET_EXHAUSTED",
  "MEDIA_POLICY_DENIED",
  "MEDIA_PROMPT_TOO_LONG",
  "MEDIA_CHECK_IN_PROGRESS",
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
  "MEDIA_CLIP_TOOLCHAIN_MISSING",
  "MEDIA_CLIP_TOOLCHAIN_UNAVAILABLE",
  "MEDIA_CLIP_SCENE_INVALID",
  "MEDIA_CLIP_RANGE_INVALID",
  "MEDIA_CLIP_TOO_LARGE",
  "MEDIA_CLIP_ENCODER_FAILED",
  "MEDIA_CLIP_TIMEOUT",
  "MEDIA_CLIP_BUSY",
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
/** One automated-check finding in plain words. */
export function findingText(
  f: CheckFinding,
  t: Translate = englishTranslator().t,
) {
  switch (f.code) {
    case "QUANTITY_CONTRADICTED":
      return t(
        f.source === "reference"
          ? "media.finding.quantityReference"
          : "media.finding.quantityScript",
        { subject: f.subject, found: f.found, expected: f.expected ?? "" },
      );
    case "QUANTITY_UNSUPPORTED":
      return t("media.finding.quantityUnsupported", {
        subject: f.subject,
        found: f.found,
      });
    case "CLAIM_CONTRADICTED":
      return t("media.finding.claimContradicted", {
        claim: f.found,
        quote: f.expected ?? "",
      });
    case "CLAIM_UNSUPPORTED":
      return t("media.finding.claimUnsupported", { claim: f.found });
    case "MODEL_QUOTE_NOT_FOUND":
      return t("media.finding.quoteNotFound", { claim: f.found });
    default:
      return codeWords(f.code);
  }
}
