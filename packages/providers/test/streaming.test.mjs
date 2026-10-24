import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, ProviderRouter, ProviderError } from '../dist/index.js';
import { AnthropicProvider } from '../dist/anthropic-index.js';
import { harness, request, json, code, body, KEY, PROMPT } from './helpers.mjs';

function anthropicConfig() {
  const providerConfig = { transport: 'messages', apiVersion: '2023-06-01', maxResponseBytes: 1_000_000, effort: 'low', thinking: 'disabled' };
  return { revision: 'anthropic-v1', models: [{ id: 'claude-text', providerId: 'anthropic-account', remoteModel: 'claude-haiku-5-5', providerConfig,
    enabled: true, capabilities: ['tutoring', 'structured_assessment'], tools: [], limits: { maxInputCharacters: 20_000, maxOutputTokens: 1024 } }] };
}
// Streams follow the documented shapes: Google streamGenerateContent?alt=sse (each `data:` a
// GenerateContentResponse) and Anthropic Messages with stream:true (named SSE events). Synthetic
// fixtures only: no live provider call is made by these tests.
function sse(frames, { split = false, delayMs = 0, status = 200, breakAfter } = {}) {
  const encoder = new TextEncoder();
  const text = frames.map(frame => typeof frame === 'string' ? frame : `${frame.event ? `event: ${frame.event}\n` : ''}data: ${JSON.stringify(frame.data)}\n\n`);
  return new Response(new ReadableStream({
    async start(controller) {
      for (let i = 0; i < text.length; i++) {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        if (breakAfter !== undefined && i === breakAfter) { controller.error(new Error('connection reset')); return; }
        const bytes = encoder.encode(text[i]);
        // Split frames mid-line (and mid-character) to prove the parser buffers across chunks.
        if (split) { const cut = Math.floor(bytes.length / 2); controller.enqueue(bytes.subarray(0, cut)); controller.enqueue(bytes.subarray(cut)); }
        else controller.enqueue(bytes);
      }
      controller.close();
    },
  }), { status, headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (text, extra = {}) => ({ data: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, ...extra }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 } } });
const last = (text) => chunk(text, { finishReason: 'STOP' });

test('Google stream: streamGenerateContent with alt=sse, the tutor body, deltas in order and the last usage', async () => {
  const h = harness([sse([chunk('Compare '), chunk('the números — '), { data: { candidates: [{ index: 0, content: { parts: [{ text: 'thinking', thought: true }] } }] } },
    { data: { candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'left is smaller.' }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 9, totalTokenCount: 20 } } }], { split: true })]);
  const deltas = [];
  const result = await h.client.tutorStream(request({ systemInstruction: 'Guide.' }), {}, text => deltas.push(text));
  assert.equal(h.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/admin-selected-text-model:streamGenerateContent?alt=sse');
  assert.equal(h.calls[0].init.headers['x-goog-api-key'], KEY);
  assert.equal(h.calls[0].init.headers.Accept, 'text/event-stream');
  assert.equal(h.calls[0].init.redirect, 'error');
  assert.deepEqual(body(h.calls[0]), { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], systemInstruction: { parts: [{ text: 'Guide.' }] },
    generationConfig: { candidateCount: 1, maxOutputTokens: 128 } });
  assert.deepEqual(deltas, ['Compare ', 'the números — ', 'left is smaller.']);
  assert.equal(result.output.text, 'Compare the números — left is smaller.');
  assert.equal(result.usage.attempts.length, 1);
  assert.deepEqual([result.usage.attempts[0].outcome, result.usage.attempts[0].tokens.total, result.usage.attempts[0].tokens.output], ['response', 20, 9]);
});

test('Google stream: a block in any chunk refuses the whole answer; an early stop is incomplete; neither is retried', async () => {
  const blocked = harness([sse([chunk('Partial '), { data: { candidates: [{ index: 0, finishReason: 'SAFETY' }] } }])]);
  await assert.rejects(blocked.client.tutorStream(request(), {}, () => {}), error => code('BLOCKED')(error) && error.submission === 'unknown' && error.usage.attempts.length === 1);
  const prompt = harness([sse([{ data: { promptFeedback: { blockReason: 'OTHER' } } }])]);
  await assert.rejects(prompt.client.tutorStream(request(), {}, () => {}), code('BLOCKED'));
  const capped = harness([sse([chunk('Half an'), chunk(' answer', { finishReason: 'MAX_TOKENS' })])]);
  await assert.rejects(capped.client.tutorStream(request(), {}, () => {}), code('INCOMPLETE_OUTPUT'));
  const unfinished = harness([sse([chunk('No finish')])]);
  await assert.rejects(unfinished.client.tutorStream(request(), {}, () => {}), code('INCOMPLETE_OUTPUT'));
  assert.equal(blocked.calls.length + prompt.calls.length + capped.calls.length + unfinished.calls.length, 4);
});

test('Google stream: an explicit throttle before the stream is retried; a broken stream is never replayed', async () => {
  const throttled = harness([json({ error: { code: 429 } }, 429), sse([last('Done.')])]);
  assert.equal((await throttled.client.tutorStream(request(), {}, () => {})).output.text, 'Done.');
  assert.equal(throttled.calls.length, 2);
  const broken = harness([sse([chunk('Started '), last('never')], { breakAfter: 1, delayMs: 5 }), sse([last('replayed')])]);
  const seen = [];
  await assert.rejects(broken.client.tutorStream(request(), {}, text => seen.push(text)), error => error instanceof ProviderError && error.submission === 'unknown');
  assert.equal(broken.calls.length, 1); assert.deepEqual(seen, ['Started ']);
});

test('Google stream: a non-SSE answer, malformed data and an oversized body are refused', async () => {
  const plain = harness([json({ candidates: [] })]);
  await assert.rejects(plain.client.tutorStream(request(), {}, () => {}), code('INVALID_RESPONSE'));
  const bad = harness([sse(['data: {not json\n\n'])]);
  await assert.rejects(bad.client.tutorStream(request(), {}, () => {}), code('INVALID_RESPONSE'));
  const config = (await import('./helpers.mjs')).config();
  config.models[0].providerConfig.maxResponseBytes = 1024;
  const big = harness([sse([chunk('x'.repeat(600)), chunk('y'.repeat(600)), last('z')])], { config });
  await assert.rejects(big.client.tutorStream(request(), {}, () => {}), code('OUTPUT_TOO_LARGE'));
});

test('Google stream: a stalled stream times out at the attempt bound', async () => {
  const stalled = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk('Hi').data)}\n\n`)); } }),
    { headers: { 'content-type': 'text/event-stream' } });
  const h = harness([stalled]);
  await assert.rejects(h.client.tutorStream(request(), {}, () => {}), error => code('TIMEOUT')(error) && error.submission === 'unknown');
});

function anthropic(steps) {
  const calls = []; let position = 0;
  const fetch = async (url, init) => { calls.push({ url, init }); const step = steps[position++]; if (!step) throw new Error('Unexpected mock request'); return step; };
  const registry = new ModelRegistry(anthropicConfig());
  const client = new AnthropicProvider({ providerId: 'anthropic-account', registry, getApiKey: () => KEY, fetch,
    settings: { attemptTimeoutMs: 200, totalTimeoutMs: 1000, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 50 } });
  registry.registerAdapter(client);
  return { client, calls, registry };
}
const areq = (extra = {}) => ({ modelId: 'claude-text', accounting: { accountingKey: 'accounting-1' }, messages: [{ role: 'user', text: PROMPT }], maxOutputTokens: 128, ...extra });
const start = { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5',
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 } } } };
const block = (index, type = 'text') => ({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: type === 'text' ? { type, text: '' } : { type, thinking: '' } } });
const delta = (index, text, type = 'text_delta') => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: type === 'text_delta' ? { type, text } : { type, thinking: text } } });
const stopBlock = index => ({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
const messageDelta = (stop_reason, output_tokens = 15) => ({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens } } });
const messageStop = { event: 'message_stop', data: { type: 'message_stop' } };
const ping = { event: 'ping', data: { type: 'ping' } };

test('Anthropic stream: stream:true on the Messages body, text deltas only, cumulative usage and the end_turn rule', async () => {
  const h = anthropic([sse([start, block(0, 'thinking'), delta(0, 'private reasoning', 'thinking_delta'), stopBlock(0), block(1), ping, delta(1, 'Hello'), delta(1, ' שלום'),
    { event: 'future_event', data: { type: 'future_event' } }, stopBlock(1), messageDelta('end_turn', 15), messageStop], { split: true })]);
  const deltas = [];
  const result = await h.client.tutorStream(areq({ systemInstruction: 'Guide.' }), {}, text => deltas.push(text));
  assert.equal(h.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(h.calls[0].init.headers['x-api-key'], KEY); assert.equal(h.calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(body(h.calls[0]), { model: 'claude-haiku-5-5', max_tokens: 128, stream: true, system: 'Guide.', messages: [{ role: 'user', content: PROMPT }],
    output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
  assert.deepEqual(deltas, ['Hello', ' שלום']);
  assert.equal(result.output.text, 'Hello שלום');
  const tokens = result.usage.attempts[0].tokens;
  assert.deepEqual([tokens.input, tokens.output, tokens.total, tokens.cachedInput], [29, 15, 44, 4]);
});

test('Anthropic stream: refusal is BLOCKED, another stop is incomplete, an error event is unknown, a missing message_stop is incomplete', async () => {
  const refused = anthropic([sse([start, block(0), delta(0, 'I will'), stopBlock(0), messageDelta('refusal'), messageStop])]);
  await assert.rejects(refused.client.tutorStream(areq(), {}, () => {}), error => code('BLOCKED')(error) && error.submission === 'unknown');
  const capped = anthropic([sse([start, block(0), delta(0, 'Half'), stopBlock(0), messageDelta('max_tokens'), messageStop])]);
  await assert.rejects(capped.client.tutorStream(areq(), {}, () => {}), code('INCOMPLETE_OUTPUT'));
  const overloaded = anthropic([sse([start, block(0), delta(0, 'Hi'), { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: `secret ${KEY}` } } }])]);
  await assert.rejects(overloaded.client.tutorStream(areq(), {}, () => {}), error => code('UPSTREAM_UNAVAILABLE')(error) && error.submission === 'unknown'
    && !JSON.stringify(error).includes(KEY) && error.usage.attempts[0].outcome === 'unknown');
  const cut = anthropic([sse([start, block(0), delta(0, 'Hi'), stopBlock(0), messageDelta('end_turn')])]);
  await assert.rejects(cut.client.tutorStream(areq(), {}, () => {}), code('INCOMPLETE_OUTPUT'));
  const tool = anthropic([sse([start, { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'y', input: {} } } }])]);
  await assert.rejects(tool.client.tutorStream(areq(), {}, () => {}), code('INVALID_RESPONSE'));
});

test('Anthropic stream: a 529 before the stream is unknown and not retried; a spend-cap 429 is a definite rejection', async () => {
  const busy = anthropic([json({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 529)]);
  await assert.rejects(busy.client.tutorStream(areq(), {}, () => {}), error => code('UPSTREAM_UNAVAILABLE')(error) && error.submission === 'unknown');
  assert.equal(busy.calls.length, 1);
  const capped = anthropic([json({ type: 'error', error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }, 429)]);
  await assert.rejects(capped.client.tutorStream(areq(), {}, () => {}), error => code('UPSTREAM_REJECTED')(error) && error.submission === 'rejected');
  assert.equal(capped.calls.length, 1);
});

test('router: tutorStream streams through a streaming port, falls back to tutor otherwise, and a throwing listener cannot fail the call', async () => {
  const h = harness([sse([chunk('One '), last('two.')])]);
  const router = new ProviderRouter(h.registry), seen = [];
  const streamed = await router.tutorStream(request(), {}, text => { seen.push(text); throw new Error('display failed'); });
  assert.equal(streamed.output.text, 'One two.'); assert.deepEqual(seen, ['One ', 'two.']);
  const registry = new ModelRegistry({ revision: 'r', models: [{ id: 'plain', providerId: 'plain', remoteModel: 'plain', providerConfig: {}, enabled: true,
    capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 1000, maxOutputTokens: 100 } }] });
  const usage = { accounting: { accountingKey: 'k' }, providerId: 'plain', modelId: 'plain', operation: 'tutor', attempts: [], inputCharacters: 1,
    requestedMaxOutputTokens: 1, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
  registry.registerAdapter({ providerId: 'plain', validateModel() {}, ports: { tutoring: { async tutor() { return { output: { text: 'Whole.' }, usage }; } } } });
  const calls = [];
  const fallback = await new ProviderRouter(registry).tutorStream({ ...request(), modelId: 'plain' }, {}, text => calls.push(text));
  assert.equal(fallback.output.text, 'Whole.'); assert.deepEqual(calls, []);
  assert.throws(() => registry.registerAdapter({ providerId: 'other', validateModel() {}, ports: { tutoring: { tutor() {}, tutorStream: 'not a function' } } }), code('INVALID_CONFIG'));
});

test('stream: a response that never begins times out at the attempt bound, unknown and not replayed', async () => {
  const h = harness([(_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))]);
  const started = Date.now();
  await assert.rejects(h.client.tutorStream(request(), { timeoutMs: 60_000 }, () => {}), error => code('TIMEOUT')(error) && error.submission === 'unknown');
  assert.ok(Date.now() - started < 1_000); assert.equal(h.calls.length, 1);
});

// The streamed path is judged by the same helpers as a whole reply (#210): generationConfig /
// messagesRequestBody build the body, candidate + tutoringText / anthropicMessage +
// anthropicTutoring classify the assembled answer, and a refused answer keeps a read response
// with its token total so the gateway can settle it at that usage.
const LONG = 'A careful explanation that keeps going. '.repeat(8);
test('Google stream: the thinking setting is sent, and a MAX_TOKENS reply is cut short only when allowed and long enough', async () => {
  const config = (await import('./helpers.mjs')).config();
  config.models[0].providerConfig.thinking = { level: 'low' };
  const capped = () => sse([chunk(LONG.slice(0, 150)), { data: { candidates: [{ index: 0, content: { parts: [{ text: 'plan', thought: true }] } }] } },
    chunk(LONG.slice(150), { finishReason: 'MAX_TOKENS' })]);
  const allowed = harness([capped()], { config });
  const result = await allowed.client.tutorStream(request({ allowCutShort: true }), {}, () => {});
  assert.deepEqual(body(allowed.calls[0]).generationConfig, { candidateCount: 1, maxOutputTokens: 128, thinkingConfig: { thinkingLevel: 'low' } });
  assert.equal(result.output.text, LONG); assert.equal(result.output.cutShort, true);
  const refused = harness([capped()], { config });
  await assert.rejects(refused.client.tutorStream(request(), {}, () => {}), error => code('INCOMPLETE_OUTPUT')(error)
    && error.usage.attempts[0].outcome === 'response' && error.usage.attempts[0].tokens.total === 14);
  const short = harness([sse([chunk('Too short', { finishReason: 'MAX_TOKENS' })])], { config });
  await assert.rejects(short.client.tutorStream(request({ allowCutShort: true }), {}, () => {}), code('INCOMPLETE_OUTPUT'));
});

test('Google stream: a refusal keeps the read response and its token total for settlement', async () => {
  const h = harness([sse([chunk('Partial '), { data: { candidates: [{ index: 0, finishReason: 'SAFETY' }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 } } }])]);
  await assert.rejects(h.client.tutorStream(request(), {}, () => {}), error => code('BLOCKED')(error)
    && error.usage.attempts.length === 1 && error.usage.attempts[0].outcome === 'response' && error.usage.attempts[0].tokens.total === 16);
});

test('Anthropic stream: a max_tokens reply is cut short only when allowed, and a refusal keeps its usage for settlement', async () => {
  const capped = text => sse([start, block(0), delta(0, text), stopBlock(0), messageDelta('max_tokens', 128), messageStop]);
  const allowed = anthropic([capped(LONG)]);
  const result = await allowed.client.tutorStream(areq({ allowCutShort: true }), {}, () => {});
  assert.equal(body(allowed.calls[0]).stream, true);
  assert.deepEqual([result.output.text, result.output.cutShort], [LONG, true]);
  const short = anthropic([capped('Too short')]);
  await assert.rejects(short.client.tutorStream(areq({ allowCutShort: true }), {}, () => {}), code('INCOMPLETE_OUTPUT'));
  const refused = anthropic([sse([start, block(0), delta(0, 'I will'), stopBlock(0), messageDelta('refusal', 7), messageStop])]);
  await assert.rejects(refused.client.tutorStream(areq(), {}, () => {}), error => code('BLOCKED')(error)
    && error.usage.attempts[0].outcome === 'response' && error.usage.attempts[0].tokens.total === 36);
});
