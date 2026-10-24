import { z } from 'zod';
import { boundedJson } from './json.js';
import type { ReceiptCost } from './pricing.js';

export const capabilitySchema = z.enum(['tutoring', 'structured_assessment', 'research', 'image', 'video']);
export type Capability = z.infer<typeof capabilitySchema>;
export type Operation = 'tutor' | 'assess' | 'research' | 'image' | 'video_submit' | 'video_poll';
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
/** Opaque identifiers are not URL paths. Each adapter validates native identifiers. */
export const modelId = z.string().min(1).max(2048).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value));
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const opaqueJsonSchema = z.custom<Json>(value => {
  try { boundedJson(value, 'INVALID_INPUT', 24, 10_000); return JSON.stringify(value).length <= 65_536; }
  catch { return false; }
}).transform(value => structuredClone(value));
export const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positive = counter.refine(v => v > 0);
export const text = z.string().min(1).max(1_000_000);
export const accountingSchema = z.strictObject({
  accountingKey: id,
  estimatedInputTokens: counter.optional(),
});
export const messagesSchema = z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text })).min(1).max(256)
  .refine(messages => messages[0]?.role === 'user' && messages.at(-1)?.role === 'user'
    && messages.every((message, index) => index === 0 || message.role !== messages[index - 1]?.role));
export const textRequestSchema = z.strictObject({
  modelId, accounting: accountingSchema, messages: messagesSchema,
  systemInstruction: text.optional(), maxOutputTokens: positive,
  /** Tutoring only: a reply the provider stopped at the output limit is delivered, marked
   * `cutShort`, when it already has at least MIN_CUT_SHORT_CHARACTERS of visible text. Absent or
   * false (and for every other operation), such a reply is refused as INCOMPLETE_OUTPUT. */
  allowCutShort: z.boolean().optional(),
});
/** The least visible text a reply cut short at the output limit must have to be delivered. */
export const MIN_CUT_SHORT_CHARACTERS = 200;
export const imageRequestSchema = z.strictObject({ modelId, accounting: accountingSchema, prompt: text, maxOutputTokens: positive,
  /** Optional output settings; an adapter refuses values its configured model does not declare. */
  aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/).optional(), imageSize: z.string().regex(/^[0-9]{1,4}K?$/).optional() });
export const videoRequestSchema = z.strictObject({
  modelId, accounting: accountingSchema, prompt: text, durationSeconds: positive,
  aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/), resolution: id,
});
export const videoJobSchema = z.strictObject({
  kind: z.literal('video'), providerId: id, modelId, registryRevision: id,
  providerState: opaqueJsonSchema,
  accounting: accountingSchema, requestedDurationSeconds: positive,
  /** Routing metadata, never authorization. The host still owns this job. */
  accessRoute: z.strictObject({ kind: z.literal('subscription_adapter'), subscriptionRef: id,
    route: z.enum(['subscription', 'fallback']) }).optional(),
});
export const modelSchema = z.strictObject({
  id: modelId, providerId: id, remoteModel: modelId,
  providerConfig: opaqueJsonSchema,
  enabled: z.boolean(), capabilities: z.array(capabilitySchema).min(1),
  tools: z.array(id).default([]),
  limits: z.strictObject({ maxInputCharacters: positive.max(1_000_000), maxOutputTokens: positive.optional() }),
});
export const registrySchema = z.strictObject({ revision: id, models: z.array(modelSchema) });
/** Shared bounded HTTP transport settings for the REST adapters. */
export const transportSettingsSchema = z.strictObject({
  attemptTimeoutMs: positive.max(300_000).default(30_000), totalTimeoutMs: positive.max(300_000).default(60_000),
  maxAttempts: positive.max(5).default(3), baseDelayMs: positive.max(60_000).default(500), maxDelayMs: positive.max(60_000).default(10_000),
});
export type TransportSettings = z.infer<typeof transportSettingsSchema>;
export const callOptionsSchema = z.strictObject({
  signal: z.instanceof(AbortSignal).optional(),
  timeoutMs: positive.max(300_000).optional(),
});

export type ModelConfig = z.infer<typeof modelSchema>;
export type RegistryConfig = z.infer<typeof registrySchema>;
export type TextRequest = z.infer<typeof textRequestSchema>;
export type ImageRequest = z.infer<typeof imageRequestSchema>;
export type VideoRequest = z.infer<typeof videoRequestSchema>;
export type VideoJob = z.infer<typeof videoJobSchema>;
export type CallOptions = z.infer<typeof callOptionsSchema>;
export type AccountingInput = z.infer<typeof accountingSchema>;

/** Deliberately bounded schema subset; no executable validators or remote refs. */
export type OutputSchema =
  | { type: 'string'; enum?: string[] | undefined }
  | { type: 'number' | 'integer'; minimum?: number | undefined; maximum?: number | undefined }
  | { type: 'boolean' | 'null' }
  | { type: 'array'; items: OutputSchema; minItems: number; maxItems: number }
  | { type: 'object'; properties: Record<string, OutputSchema>; required: string[] };
export interface AssessmentRequest extends TextRequest { outputSchema: OutputSchema }

export interface TokenUsage {
  input: number | null; output: number | null; total: number | null;
  cachedInput: number | null; thoughts: number | null; toolInput: number | null;
  /** Input tokens written to a provider prompt cache, included in `input`. Absent when the
   * provider reports no such counter. Some providers bill these above the input rate. */
  cacheWriteInput?: number | null;
  /** Provider-run server tool requests (for example web searches) billed per request,
   * separately from tokens. Absent when the provider reports no such counter. */
  serverToolRequests?: number | null;
}
export interface AttemptAccounting {
  attempt: number; status: number | null; outcome: 'response' | 'rejected' | 'unknown'; tokens: TokenUsage;
}
export interface UsageReceipt {
  accounting: AccountingInput; providerId: string; modelId: string; operation: Operation;
  attempts: AttemptAccounting[]; inputCharacters: number;
  requestedMaxOutputTokens: number | null; requestedVideoSeconds: number | null;
  observedImageCount: number | null; observedVideoCount: number | null;
  // Adapters never price a call: there is no built-in rate card or fabricated actual video
  // duration. Only a host applying an operator-entered pricing version sets this.
  cost: ReceiptCost | null;
  /** Access authorization, not a price or proof of zero incremental cost. */
  access?: { kind: 'subscription'; subscriptionRef: string; entitlementRevision: string; overageAllowed: false }
    | { kind: 'api_key_fallback'; subscriptionRef: string; authorizationId: string; reason: string };
}
export interface ProviderResult<T> { output: T; usage: UsageReceipt }
export interface ResearchOutput {
  text: string; grounding: 'grounded' | 'not_grounded';
  parts: { partIndex: number; text: string }[];
  sources: { uri: string; title: string }[];
  citations: { partIndex: number; startByte: number; endByte: number; sourceIndices: number[] }[];
  searchQueries: string[];
  searchSuggestionsHtml: string | null;
}
export interface ImageOutput { state: 'completed'; images: { mimeType: string; base64: string; byteLength: number }[]; text: string }
export type VideoOutput<Job extends VideoJob = VideoJob> = { state: 'pending'; job: Job }
  | { state: 'completed'; job: Job; videos: { uri: string; mimeType: string }[] };
export type TelemetryEvent = Readonly<{
  adapter: string; operation: Operation; attempt: number;
  phase: 'response' | 'error' | 'retry'; status: number | null;
  code: string | null; elapsedMs: number; retryDelayMs: number | null;
}>;
/** Router-level call metadata for tracing/metrics. An allowlist: no prompts, outputs, keys,
 * accounting keys, URLs, provider bodies or messages. Model IDs are trusted registry configuration. */
export type ProviderCallStart = Readonly<{ operation: Operation | 'video_cancel'; modelId: string }>;
export type ProviderCallEnd = Readonly<{
  outcome: 'response' | 'error'; code: string | null; providerId: string | null; attempts: number;
  /** Sums over attempts; null when any attempt did not report that counter. */
  tokens: Readonly<{ input: number | null; output: number | null; total: number | null }> | null;
  access: 'subscription' | 'api_key_fallback' | null; elapsedMs: number;
}>;
/** Called before dispatch; the returned function (if any) is called once when the call settles.
 * Observer failures are ignored: they can neither fail nor replay a paid call. */
export type ProviderCallObserver = (call: ProviderCallStart) => ((end: ProviderCallEnd) => void) | void;
/** A tutoring reply. `cutShort`: the provider stopped at the output limit (only when the request allowed it). */
export interface TutoringOutput { text: string; cutShort?: true }
export interface TutoringProvider { tutor(request: TextRequest, options?: CallOptions): Promise<ProviderResult<TutoringOutput>> }
export interface StructuredAssessmentProvider { assess(request: AssessmentRequest, options?: CallOptions): Promise<ProviderResult<Json>> }
export interface ResearchProvider { research(request: TextRequest, options?: CallOptions): Promise<ProviderResult<ResearchOutput>> }
export interface ImageJobProvider {
  discoverCapabilities(modelId: string): MediaCapabilities;
  estimateCost(request: ImageRequest, price: MediaPrice | null): CostEstimate;
  startImage(request: ImageRequest, options?: CallOptions): Promise<ProviderResult<ImageOutput>>;
}
/**
 * What one configured media model can do, as its adapter reads it from trusted registry
 * configuration (and the provider's documented behaviour). Configured capability only: it is
 * not proof of a working key, model access or a live account.
 */
export interface MediaCapabilities {
  modelId: string; providerId: string; kind: 'video' | 'image';
  maxPromptCharacters: number;
  video?: { durationSeconds: number[]; aspectRatios: string[]; resolutions: string[] };
  image?: { aspectRatios: string[]; imageSizes: string[]; mimeTypes: string[]; maxImagesPerRequest: number };
  /** How remote work can be stopped once submitted. */
  cancellation: 'remote' | 'local_abort_only' | 'not_applicable';
  /** How long the provider keeps a generated output before deleting it (null: not documented or
   * not stored). A host must download and store the output itself before this ends. */
  retention: { outputHours: number | null; providerStoresRequest: boolean };
  /** The units the provider bills this kind of call by. */
  billing: 'per_output_second' | 'per_image' | 'per_request';
}
/** Operator-entered media prices (integer micro-USD). Adapters ship no rate card. */
export interface MediaPrice {
  microUsdPerOutputSecond?: number | null; microUsdPerImage?: number | null; microUsdPerRequest?: number | null;
  pricingVersionId?: string | null;
}
/** A pre-dispatch estimate: the billable units the adapter predicts for a request, priced with
 * the host's operator price. `microUsd` is null when the price does not cover every unit. */
export interface CostEstimate {
  currency: 'USD'; microUsd: number | null; pricingVersionId: string | null;
  units: { outputSeconds: number; images: number; requests: number };
  basis: 'operator_price'; reason: null | 'pricing_incomplete';
}
/** Prices predicted units with an operator price. Shared so every adapter prices the same way. */
export function priceMediaUnits(units: CostEstimate['units'], price: MediaPrice | null): CostEstimate {
  const perSecond = price?.microUsdPerOutputSecond ?? null, perImage = price?.microUsdPerImage ?? null, perRequest = price?.microUsdPerRequest ?? null;
  // A per-request price adds to per-unit prices; on its own it is the whole price.
  let total = (perRequest ?? 0) * units.requests, covered = true;
  if (units.outputSeconds > 0) { if (perSecond === null) covered = false; else total += units.outputSeconds * perSecond; }
  if (units.images > 0) { if (perImage === null) covered = false; else total += units.images * perImage; }
  if (!covered && perRequest !== null && perSecond === null && perImage === null) { covered = true; total = perRequest * units.requests; }
  const microUsd = covered && Number.isSafeInteger(total) && total >= 0 ? total : null;
  return { currency: 'USD', microUsd, pricingVersionId: price?.pricingVersionId ?? null, units: { ...units }, basis: 'operator_price',
    reason: microUsd === null ? 'pricing_incomplete' : null };
}
export interface VideoJobProvider {
  /** The configured video settings, limits, cancellation and retention of one model. */
  discoverCapabilities(modelId: string): MediaCapabilities;
  /** Billable units of one request priced with an operator price; never contacts the provider. */
  estimateCost(request: VideoRequest, price: MediaPrice | null): CostEstimate;
  startVideo(request: VideoRequest, options?: CallOptions): Promise<ProviderResult<VideoOutput>>;
  pollVideo(job: VideoJob, options?: CallOptions): Promise<ProviderResult<VideoOutput>>;
  /** Optional. A provider must explicitly implement and report cancellation semantics. */
  cancelVideo?(job: VideoJob, options?: CallOptions): Promise<ProviderResult<{
    job: VideoJob; state: 'requested' | 'cancelled' | 'unsupported'; remoteMayContinue: boolean;
  }>>;
  /** Optional bounded retrieval of a completed clip returned by this adapter's own poll.
   * Only hosts in the model's approved download list are contacted; no redirect leaves them. */
  downloadVideo?(job: VideoJob, uri: string, options: DownloadOptions): Promise<VideoAsset>;
}
/** Hard ceiling for one downloaded clip; hosts choose a smaller bound. */
export const MAX_VIDEO_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export interface DownloadOptions extends CallOptions { maxBytes: number }
export interface VideoAsset { bytes: Uint8Array; mimeType: 'video/mp4' | 'video/webm'; byteLength: number }
export interface CapabilityPorts {
  tutoring: TutoringProvider;
  structured_assessment: StructuredAssessmentProvider;
  research: ResearchProvider;
  image: ImageJobProvider;
  video: VideoJobProvider;
}
export interface ProviderAdapter {
  readonly providerId: string;
  readonly ports: Partial<CapabilityPorts>;
  /** Synchronous trusted adapter validation; throw on invalid native model/config. */
  validateModel(model: ModelConfig): void;
  /** Trusted host readiness only; fresh entitlement is checked before each call. */
  readonly access?: { kind: 'subscription'; subscriptionRef: string; automaticFallbackEnabled: boolean; isConfigured(): boolean };
}
