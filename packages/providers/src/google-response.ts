import { z } from 'zod';
import { counter, type ImageOutput, type ResearchOutput } from './contracts.js';
import { type GoogleModelConfig, type GoogleResolvedModel, type GoogleVideoJob, type GoogleVideoOutput } from './google-contracts.js';
import { ensure, ProviderError } from './errors.js';
import { parse } from './validation.js';

const partSchema = z.strictObject({
  text: z.string().optional(), thought: z.boolean().optional(), thoughtSignature: z.string().optional(),
  inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
}).refine(p => Number(p.text !== undefined) + Number(p.inlineData !== undefined) === 1);
const candidateSchema = z.object({
  finishReason: z.string(), index: counter.optional(),
  content: z.object({ role: z.literal('model').optional(), parts: z.array(partSchema).min(1).max(256) }),
  groundingMetadata: z.unknown().optional(),
  safetyRatings: z.array(z.object({ blocked: z.boolean().optional() })).optional(),
});
/**
 * The `generationConfig` of a text request: output limit, the model's thinking setting and the
 * structured-output format. Shared by every generateContent call path (plain and streamed), so
 * thinking and limits are configured in one place.
 */
export function generationConfig(config: GoogleModelConfig, maxOutputTokens: number, format?: unknown) {
  return { candidateCount: 1, maxOutputTokens,
    ...(config.transport === 'generate_content' && config.thinking ? { thinkingConfig: 'level' in config.thinking
      ? { thinkingLevel: config.thinking.level } : { thinkingBudget: config.thinking.budget } } : {}),
    ...(format === undefined ? {} : { responseFormat: { text: { mimeType: 'application/json', schema: format } } }) };
}
/**
 * The single candidate of a finished response. Also the classifier for a streamed response:
 * apply it to the final aggregated candidate (its last finishReason and all its parts). A stop at the output limit (MAX_TOKENS) is
 * refused as INCOMPLETE_OUTPUT unless `allowCutShort` is set, in which case the candidate is
 * returned with `cutShort: true` for the caller to judge (a cut-off thinking turn may carry no
 * visible part at all, which then stays incomplete).
 */
export function candidate(data: Record<string, unknown>, allowCutShort = false) {
  const envelope = parse(z.object({
    promptFeedback: z.object({ blockReason: z.string().optional() }).optional(), candidates: z.array(z.unknown()).optional(),
  }), data, 'INVALID_RESPONSE');
  if (envelope.promptFeedback?.blockReason && envelope.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw new ProviderError('BLOCKED');
  ensure(envelope.candidates?.length === 1, 'INVALID_RESPONSE');
  const raw = parse(z.object({ finishReason: z.string(), safetyRatings: z.array(z.object({ blocked: z.boolean().optional() })).optional() }), envelope.candidates[0], 'INVALID_RESPONSE');
  if (raw.safetyRatings?.some(r => r.blocked) || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'RECITATION', 'SPII'].includes(raw.finishReason)) throw new ProviderError('BLOCKED');
  const cutShort = allowCutShort && raw.finishReason === 'MAX_TOKENS';
  ensure(raw.finishReason === 'STOP' || cutShort, 'INCOMPLETE_OUTPUT');
  const checked = candidateSchema.safeParse(envelope.candidates[0]);
  if (!checked.success) throw new ProviderError(cutShort ? 'INCOMPLETE_OUTPUT' : 'INVALID_RESPONSE');
  const result = checked.data;
  ensure(result.index === undefined || result.index === 0, 'INVALID_RESPONSE');
  return cutShort ? { ...result, cutShort: true as const } : result;
}
/** The visible text of a tutoring reply. A reply cut short at the output limit is delivered,
 * marked, only with at least `minimum` visible characters; otherwise it is incomplete. */
export function tutoringText(c: Candidate, minimum: number): { text: string; cutShort?: true } {
  if (!('cutShort' in c)) return { text: responseText(c) };
  const visible = c.content.parts.filter(p => !p.thought && p.text !== undefined).map(p => p.text).join('');
  ensure(visible.trim().length >= minimum, 'INCOMPLETE_OUTPUT');
  return { text: visible, cutShort: true };
}
export type Candidate = ReturnType<typeof candidate>;
export function responseText(c: Candidate): string {
  const visible = c.content.parts.filter(p => !p.thought);
  ensure(visible.every(p => p.text !== undefined), 'INVALID_RESPONSE');
  const answer = visible.map(p => p.text).join('');
  ensure(answer.trim().length > 0, 'INVALID_RESPONSE');
  return answer;
}

export function httpsUrl(value: string): URL {
  ensure(value.length <= 8192 && !/[\u0000-\u0020\\]/.test(value), 'INVALID_RESPONSE');
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('INVALID_RESPONSE'); }
  ensure(url.protocol === 'https:' && url.username === '' && url.password === '' && (url.port === '' || url.port === '443'), 'INVALID_RESPONSE');
  return url;
}

const groundingSchema = z.object({
  groundingChunks: z.array(z.object({ web: z.object({ uri: z.string(), title: z.string() }) })).max(512).default([]),
  groundingSupports: z.array(z.object({
    segment: z.object({ partIndex: counter.default(0), startIndex: counter.default(0), endIndex: counter, text: z.string().optional() }),
    groundingChunkIndices: z.array(counter).min(1).max(512),
  })).max(2048).default([]),
  webSearchQueries: z.array(z.string()).max(128).default([]),
  searchEntryPoint: z.object({ renderedContent: z.string() }).optional(),
});
export function researchOutput(c: Candidate): ResearchOutput {
  const text = responseText(c);
  const metadata = c.groundingMetadata === undefined ? undefined : parse(groundingSchema, c.groundingMetadata, 'INVALID_RESPONSE');
  const sources = metadata?.groundingChunks.map(chunk => { httpsUrl(chunk.web.uri); return chunk.web; }) ?? [];
  const citations = metadata?.groundingSupports.map(support => {
    const segment = support.segment, part = c.content.parts[segment.partIndex];
    ensure(part?.text !== undefined && !part.thought, 'INVALID_RESPONSE');
    const bytes = Buffer.from(part.text, 'utf8');
    ensure(segment.startIndex < segment.endIndex && segment.endIndex <= bytes.length
      && support.groundingChunkIndices.every(i => i < sources.length), 'INVALID_RESPONSE');
    let quote: string;
    try { quote = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(segment.startIndex, segment.endIndex)); }
    catch { throw new ProviderError('INVALID_RESPONSE'); }
    ensure(segment.text === undefined || quote === segment.text, 'INVALID_RESPONSE');
    // Preserve provider part indices and byte offsets; callers must not treat
    // these offsets as JavaScript UTF-16 offsets in the concatenated text.
    return { partIndex: segment.partIndex, startByte: segment.startIndex, endByte: segment.endIndex, sourceIndices: support.groundingChunkIndices };
  }) ?? [];
  return { text, parts: c.content.parts.flatMap((p, partIndex) => p.thought || p.text === undefined ? [] : [{ partIndex, text: p.text }]),
    grounding: sources.length > 0 && citations.length > 0 ? 'grounded' : 'not_grounded', sources, citations,
    searchQueries: metadata?.webSearchQueries ?? [], searchSuggestionsHtml: metadata?.searchEntryPoint?.renderedContent ?? null };
}

/** One image as returned inline: allowlisted type, canonical base64, matching file signature. */
function inlineImage(data: string, mimeType: string, maxBytes = Infinity) {
  ensure(['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) && data.length > 0
    && data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data), 'INVALID_RESPONSE');
  ensure(data.length / 4 * 3 <= maxBytes + 2, 'OUTPUT_TOO_LARGE');
  const bytes = Buffer.from(data, 'base64');
  ensure(bytes.toString('base64') === data, 'INVALID_RESPONSE');
  ensure(bytes.byteLength <= maxBytes, 'OUTPUT_TOO_LARGE');
  const signature = mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mimeType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  ensure(signature, 'INVALID_RESPONSE');
  return { mimeType, base64: data, byteLength: bytes.byteLength };
}
const interactionSchema = z.object({
  status: z.string().max(64),
  steps: z.array(z.object({ type: z.string().max(64), content: z.array(z.object({ type: z.string().max(64) }).passthrough()).max(64).optional() }).passthrough()).max(256).default([]),
});
/** Images of a finished Interactions API call. Only `model_output` steps count; thoughts and tool steps are ignored. */
export function interactionImageOutput(raw: Record<string, unknown>, maxImageBytes: number): ImageOutput {
  const interaction = parse(interactionSchema, raw, 'INVALID_RESPONSE');
  if (interaction.status === 'failed' || interaction.status === 'cancelled') throw new ProviderError('OPERATION_FAILED', { submission: 'unknown' });
  ensure(interaction.status === 'completed', 'INVALID_RESPONSE');
  const blocks = interaction.steps.filter(step => step.type === 'model_output').flatMap(step => step.content ?? []);
  const images = blocks.filter(block => block.type === 'image').map(block => {
    const image = parse(z.object({ data: z.string().max(32 * 1024 * 1024), mime_type: z.string().max(64) }), block, 'INVALID_RESPONSE');
    return inlineImage(image.data, image.mime_type, maxImageBytes);
  });
  ensure(images.length > 0 && images.length <= 4, 'INVALID_RESPONSE');
  const text = blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('').slice(0, 10_000);
  return { state: 'completed', images, text };
}

export function imageOutput(c: Candidate): ImageOutput {
  const visible = c.content.parts.filter(p => !p.thought);
  const images = visible.flatMap(p => {
    if (!p.inlineData) return [];
    return [inlineImage(p.inlineData.data, p.inlineData.mimeType)];
  });
  ensure(images.length > 0, 'INVALID_RESPONSE');
  return { state: 'completed', images, text: visible.flatMap(p => p.text === undefined ? [] : [p.text]).join('') };
}

export function validateOperationName(name: string, remoteModel: string) {
  ensure(/^(?:models\/[a-zA-Z0-9._-]+\/)?operations\/[a-zA-Z0-9_-]+$/.test(name), 'INVALID_RESPONSE');
  ensure(!name.startsWith('models/') || name.startsWith(`models/${remoteModel}/operations/`), 'INVALID_RESPONSE');
}
const operationSchema = z.object({
  name: z.string(), done: z.boolean().default(false),
  error: z.object({ code: z.number().int(), message: z.string().optional() }).optional(),
  response: z.unknown().optional(),
});
export function operationOutput(data: Record<string, unknown>, job: GoogleVideoJob, model: GoogleResolvedModel): GoogleVideoOutput {
  const operation = parse(operationSchema, data, 'INVALID_RESPONSE');
  validateOperationName(operation.name, model.remoteModel);
  ensure(operation.name === job.providerState.operationName, 'INVALID_RESPONSE');
  ensure(!(operation.error !== undefined && operation.response !== undefined), 'INVALID_RESPONSE');
  if (!operation.done) { ensure(operation.error === undefined && operation.response === undefined, 'INVALID_RESPONSE'); return { state: 'pending', job }; }
  if (operation.error) throw new ProviderError('OPERATION_FAILED', { submission: 'unknown' });
  const response = parse(z.object({ generateVideoResponse: z.object({
    generatedSamples: z.array(z.object({ video: z.object({ uri: z.string() }) })).min(1).max(16),
  }) }), operation.response, 'INVALID_RESPONSE');
  const videos = response.generateVideoResponse.generatedSamples.map(sample => {
    const url = httpsUrl(sample.video.uri);
    ensure(model.providerConfig.transport === 'video_lro' && model.providerConfig.video.downloadHosts.includes(url.hostname), 'INVALID_RESPONSE');
    return { uri: sample.video.uri, mimeType: 'video/mp4' as const };
  });
  return { state: 'completed', job, videos };
}
