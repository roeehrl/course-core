import { ModelRegistry, ProviderError } from '../dist/index.js';
import { GoogleProvider } from '../dist/google-index.js';

export const KEY = 'server-only-test-credential';
export const PROMPT = 'private-test-message';
export function config() {
  const limits = { maxInputCharacters: 20_000, maxOutputTokens: 1024 };
  return { revision: 'config-v1', models: [
    { id: 'text', providerId: 'google-account', remoteModel: 'admin-selected-text-model',
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000 },
      enabled: true, capabilities: ['tutoring', 'structured_assessment', 'research', 'image'], tools: ['web_search'], limits },
    { id: 'video', providerId: 'google-account', remoteModel: 'admin-selected-video-model',
      enabled: true, capabilities: ['video'], tools: [], limits,
      providerConfig: { transport: 'video_lro', apiVersion: 'v1beta', maxResponseBytes: 1_000_000,
        video: { durationSeconds: [4, 6], aspectRatios: ['16:9', '9:16'], resolutions: ['720p'], downloadHosts: ['storage.googleapis.com'] } } },
  ] };
}
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export function textResponse(text = 'A useful explanation.', extra = {}) {
  return { candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 21, thoughtsTokenCount: 3, cachedContentTokenCount: 4 }, ...extra };
}
export function request(extra = {}) { return { modelId: 'text', accounting: { accountingKey: 'accounting-1', estimatedInputTokens: 10 },
  messages: [{ role: 'user', text: PROMPT }], maxOutputTokens: 128, ...extra }; }
export function videoRequest(extra = {}) { return { modelId: 'video', accounting: { accountingKey: 'video-accounting' }, prompt: PROMPT,
  durationSeconds: 4, aspectRatio: '16:9', resolution: '720p', ...extra }; }
export const NAME = 'models/admin-selected-video-model/operations/job_123';
export function job(extra = {}) { return { kind: 'video', providerId: 'google-account', modelId: 'video', registryRevision: 'config-v1',
  providerState: { adapter: 'google_video_lro', remoteModel: 'admin-selected-video-model', apiVersion: 'v1beta', operationName: NAME },
  accounting: { accountingKey: 'video-accounting' }, requestedDurationSeconds: 4, ...extra }; }
export function completed(extra = {}) { return { name: NAME, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://storage.googleapis.com/synthetic-output/clip.mp4' } }] } }, ...extra }; }
export function harness(steps = [], options = {}) {
  const calls = [], events = []; let position = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[position++];
    if (typeof step === 'function') return step(url, init);
    if (step instanceof Error) throw step;
    if (step instanceof Response) return step;
    if (step === undefined) throw new Error('Unexpected mock request');
    return json(step);
  };
  const registry = new ModelRegistry(options.config ?? config());
  const client = new GoogleProvider({ providerId: 'google-account', registry,
    getApiKey: () => KEY, fetch, telemetry: event => events.push(event),
    settings: { attemptTimeoutMs: 200, totalTimeoutMs: 1000, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }, ...options.client });
  registry.registerAdapter(client);
  return { client, calls, events, registry };
}
export function code(expected) { return error => error instanceof ProviderError && error.code === expected; }
export function body(call) { return JSON.parse(call.init.body); }
export const assessmentSchema = { type: 'object', properties: {
  score: { type: 'integer', minimum: 0, maximum: 3 }, feedback: { type: 'string' },
  requiresReview: { type: 'boolean' }, labels: { type: 'array', minItems: 0, maxItems: 2, items: { type: 'string', enum: ['clear', 'gap'] } },
}, required: ['score', 'feedback', 'requiresReview', 'labels'] };
export const ASSESSMENT = { score: 2, feedback: 'Explain the missing step.', requiresReview: true, labels: ['gap'] };
