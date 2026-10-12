import { z } from 'zod';
import { boundedJson } from './json.js';

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
});
export const imageRequestSchema = z.strictObject({ modelId, accounting: accountingSchema, prompt: text, maxOutputTokens: positive });
export const videoRequestSchema = z.strictObject({
  modelId, accounting: accountingSchema, prompt: text, durationSeconds: positive,
  aspectRatio: z.string().regex(/^\d{1,2}:\d{1,2}$/), resolution: id,
});
export const videoJobSchema = z.strictObject({
  kind: z.literal('video'), providerId: id, modelId, registryRevision: id,
  providerState: opaqueJsonSchema,
  accounting: accountingSchema, requestedDurationSeconds: positive,
});
export const modelSchema = z.strictObject({
  id: modelId, providerId: id, remoteModel: modelId,
  providerConfig: opaqueJsonSchema,
  enabled: z.boolean(), capabilities: z.array(capabilitySchema).min(1),
  tools: z.array(id).default([]),
  limits: z.strictObject({ maxInputCharacters: positive.max(1_000_000), maxOutputTokens: positive.optional() }),
});
export const registrySchema = z.strictObject({ revision: id, models: z.array(modelSchema) });
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
}
export interface AttemptAccounting {
  attempt: number; status: number | null; outcome: 'response' | 'rejected' | 'unknown'; tokens: TokenUsage;
}
export interface UsageReceipt {
  accounting: AccountingInput; providerId: string; modelId: string; operation: Operation;
  attempts: AttemptAccounting[]; inputCharacters: number;
  requestedMaxOutputTokens: number | null; requestedVideoSeconds: number | null;
  observedImageCount: number | null; observedVideoCount: number | null;
  // No built-in rate card or fabricated currency/actual video duration.
  cost: null;
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
export interface TutoringProvider { tutor(request: TextRequest, options?: CallOptions): Promise<ProviderResult<{ text: string }>> }
export interface StructuredAssessmentProvider { assess(request: AssessmentRequest, options?: CallOptions): Promise<ProviderResult<Json>> }
export interface ResearchProvider { research(request: TextRequest, options?: CallOptions): Promise<ProviderResult<ResearchOutput>> }
export interface ImageJobProvider { startImage(request: ImageRequest, options?: CallOptions): Promise<ProviderResult<ImageOutput>> }
export interface VideoJobProvider {
  startVideo(request: VideoRequest, options?: CallOptions): Promise<ProviderResult<VideoOutput>>;
  pollVideo(job: VideoJob, options?: CallOptions): Promise<ProviderResult<VideoOutput>>;
  /** Optional. A provider must explicitly implement and report cancellation semantics. */
  cancelVideo?(job: VideoJob, options?: CallOptions): Promise<ProviderResult<{
    job: VideoJob; state: 'requested' | 'cancelled' | 'unsupported'; remoteMayContinue: boolean;
  }>>;
}
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
}
