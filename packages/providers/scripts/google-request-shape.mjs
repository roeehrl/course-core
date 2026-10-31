#!/usr/bin/env node
/**
 * Optional, keyless check of the generateContent request shapes the Google adapter sends. Not part
 * of the required tests: it calls Google's public endpoint.
 *
 * The adapter builds each request (tutor, streamed tutor, structured assessment, research) against
 * a captured fetch; the captured bodies are then sent to Google WITHOUT any API key. Google
 * validates the request body before it checks the caller, so a well-formed body is refused with
 * 403 PERMISSION_DENIED (no caller identity) and a malformed one with 400 INVALID_ARGUMENT. No
 * model runs and nothing is billed. Prints one line per call path with the status and reason.
 *
 *   npm run build && node scripts/google-request-shape.mjs [remote-model] [thinking-level]
 *   e.g. node scripts/google-request-shape.mjs gemini-3.8-flash medium
 */
import { ModelRegistry } from '../dist/index.js';
import { GoogleProvider } from '../dist/google-index.js';

const remoteModel = process.argv[2] ?? 'gemini-3.8-flash', level = process.argv[3];
const ORIGIN = 'https://generativelanguage.googleapis.com';
const limits = { maxInputCharacters: 20_000, maxOutputTokens: 8192 };
const providerConfig = { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000, ...(level ? { thinking: { level } } : {}) };
const registry = new ModelRegistry({ revision: 'shape-check', models: [
  { id: 'text', providerId: 'google', remoteModel, providerConfig, enabled: true,
    capabilities: ['tutoring', 'structured_assessment', 'research'], tools: ['web_search'], limits },
] });
const captured = [];
// Captures the request and ends the call; the placeholder credential never leaves this process.
const fetch = async (url, init) => { captured.push({ url: String(url), body: init.body }); throw new TypeError('captured', { cause: { code: 'ECONNREFUSED' } }); };
const client = new GoogleProvider({ providerId: 'google', registry, getApiKey: () => 'placeholder-not-sent', fetch,
  settings: { attemptTimeoutMs: 1000, totalTimeoutMs: 2000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 } });
registry.registerAdapter(client);
const request = { modelId: 'text', accounting: { accountingKey: 'shape-check' }, systemInstruction: 'Answer briefly.',
  messages: [{ role: 'user', text: 'Say hello.' }], maxOutputTokens: 4096 };
const schema = { type: 'object', required: ['summary', 'items', 'count'], properties: { summary: { type: 'string' }, count: { type: 'integer' },
  items: { type: 'array', minItems: 0, maxItems: 6, items: { type: 'object', required: ['id', 'kind'], properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] } } } } } };
const paths = {
  tutor: () => client.tutor(request), tutorStream: () => client.tutorStream(request, {}, () => {}),
  assess: () => client.assess({ ...request, outputSchema: schema }), research: () => client.research(request),
};
let bad = 0;
for (const [name, call] of Object.entries(paths)) {
  captured.length = 0;
  await call().catch(() => undefined);
  const sent = captured[0];
  if (!sent) { console.log(`${name}: no request was built`); bad++; continue; }
  const path = sent.url.slice(ORIGIN.length);
  const response = await globalThis.fetch(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent.body });
  const payload = await response.json().catch(() => ({}));
  const status = typeof payload?.error?.status === 'string' ? payload.error.status : '';
  const ok = response.status === 403 && status === 'PERMISSION_DENIED';
  if (!ok) bad++;
  console.log(`${name}: HTTP ${response.status} ${status} -> ${ok ? 'shape accepted' : 'SHAPE REFUSED'}`);
}
process.exitCode = bad ? 1 : 0;
