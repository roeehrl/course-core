import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, ProviderRouter, ProviderError, priceUsage } from '../dist/index.js';
import { AnthropicProvider, anthropicOutputSchema } from '../dist/anthropic-index.js';
import { GoogleProvider } from '../dist/google-index.js';
import { json, textResponse, code, body, assessmentSchema, ASSESSMENT, PROMPT } from './helpers.mjs';

// Fixtures follow the documented Messages API shapes (POST /v1/messages, anthropic-version
// 2023-06-01). They are synthetic: no live Anthropic call is made by these tests.
const KEY = 'synthetic-anthropic-credential-canary-0000';
const limits = { maxInputCharacters: 20_000, maxOutputTokens: 1024 };
const base = { transport: 'messages', apiVersion: '2023-06-01', maxResponseBytes: 1_000_000 };
export function anthropicConfig() {
  return { revision: 'anthropic-v1', models: [
    { id: 'claude-text', providerId: 'anthropic-account', remoteModel: 'claude-haiku-5-5', providerConfig: { ...base, effort: 'low', thinking: 'disabled' },
      enabled: true, capabilities: ['tutoring', 'structured_assessment'], tools: [], limits: { ...limits } },
    { id: 'claude-research', providerId: 'anthropic-account', remoteModel: 'claude-sonnet-5-5',
      providerConfig: { ...base, webSearch: { toolType: 'web_search_20250305', maxUses: 3 } },
      enabled: true, capabilities: ['research'], tools: ['web_search'], limits: { ...limits } },
  ] };
}
function message(content, extra = {}) {
  return { id: 'msg_013Zva2CMHLNnXjNJJKqJ2EF', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content,
    stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    usage: { input_tokens: 11, output_tokens: 30, cache_creation_input_tokens: 2, cache_read_input_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 10 },
      server_tool_use: null, service_tier: 'standard', inference_geo: 'global' }, ...extra };
}
const text = (value = 'A useful explanation.') => message([{ type: 'text', text: value }]);
const apiError = (status, type, extra = {}, headers = {}) => json({ type: 'error', error: { type, message: `upstream says ${KEY} ${PROMPT}`, ...extra },
  request_id: 'req_018EeWyXxfu5pfWkrYcMdjWG' }, status, headers);
function harness(steps = [], options = {}) {
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
  const registry = new ModelRegistry(options.config ?? anthropicConfig());
  const client = new AnthropicProvider({ providerId: 'anthropic-account', registry, getApiKey: () => KEY, fetch, telemetry: event => events.push(event),
    settings: { attemptTimeoutMs: 200, totalTimeoutMs: 1000, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 50 }, ...options.client });
  registry.registerAdapter(client);
  return { client, calls, events, registry };
}
const request = (extra = {}) => ({ modelId: 'claude-text', accounting: { accountingKey: 'accounting-1' }, messages: [{ role: 'user', text: PROMPT }], maxOutputTokens: 128, ...extra });
const secretFree = value => { const s = JSON.stringify(value) + String(value?.message ?? ''); return !s.includes(KEY) && !s.includes('upstream says'); };

test('Messages API contract: fixed HTTPS origin, x-api-key and version headers, refused redirects, text history and system prompt', async () => {
  const h = harness([text()]);
  const result = await h.client.tutor(request({ systemInstruction: 'Guide the learner.', messages: [
    { role: 'user', text: 'Earlier question' }, { role: 'assistant', text: 'Earlier explanation' }, { role: 'user', text: PROMPT }] }));
  assert.equal(h.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(h.calls[0].init.method, 'POST'); assert.equal(h.calls[0].init.redirect, 'error');
  assert.equal(h.calls[0].init.headers['x-api-key'], KEY); assert.equal(h.calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(h.calls[0].init.headers.Authorization, undefined); assert.equal(h.calls[0].url.includes(KEY), false);
  const sent = body(h.calls[0]);
  assert.deepEqual(sent, { model: 'claude-haiku-5-5', max_tokens: 128, system: 'Guide the learner.',
    messages: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier explanation' }, { role: 'user', content: PROMPT }],
    output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
  assert.deepEqual(result.output, { text: 'A useful explanation.' });
  assert.equal(result.usage.providerId, 'anthropic-account'); assert.equal(result.usage.operation, 'tutor'); assert.equal(result.usage.cost, null);
  assert.equal(result.usage.requestedMaxOutputTokens, 128);
});

test('usage maps every documented counter: cache reads/writes inside input, thinking split from output, server tools counted', async () => {
  const result = await harness([text()]).client.tutor(request());
  assert.deepEqual(result.usage.attempts, [{ attempt: 1, status: 200, outcome: 'response', tokens: {
    input: 17, output: 20, total: 47, cachedInput: 4, thoughts: 10, toolInput: null, cacheWriteInput: 2, serverToolRequests: 0 } }]);
  const minimal = text(); minimal.usage = { input_tokens: 5, output_tokens: 3 };
  assert.deepEqual((await harness([minimal]).client.tutor(request())).usage.attempts[0].tokens,
    { input: 5, output: 3, total: 8, cachedInput: 0, thoughts: null, toolInput: null, cacheWriteInput: 0, serverToolRequests: 0 });
  const absent = text(); delete absent.usage;
  assert.deepEqual(Object.values((await harness([absent]).client.tutor(request())).usage.attempts[0].tokens), [null, null, null, null, null, null]);
  for (const usage of [{ input_tokens: '5', output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1, output_tokens: 2, output_tokens_details: { thinking_tokens: 3 } }]) {
    const raw = text(); raw.usage = usage;
    await assert.rejects(harness([raw]).client.tutor(request()), code('INVALID_RESPONSE'));
  }
});

test('thinking and redacted thinking are never returned as answer text', async () => {
  const raw = message([{ type: 'thinking', thinking: 'hidden reasoning', signature: 'opaque-signature' },
    { type: 'redacted_thinking', data: 'opaque-redacted' }, { type: 'text', text: 'Visible answer' }]);
  const result = await harness([raw]).client.tutor(request());
  assert.deepEqual(result.output, { text: 'Visible answer' });
  assert.equal(JSON.stringify(result).includes('hidden reasoning') || JSON.stringify(result).includes('opaque'), false);
});

test('structured output uses output_config.format json_schema with the accepted subset and validates the full contract locally', async () => {
  const h = harness([text(JSON.stringify(ASSESSMENT))]);
  const result = await h.client.assess({ ...request(), outputSchema: assessmentSchema });
  assert.deepEqual(result.output, ASSESSMENT);
  const sent = body(h.calls[0]);
  assert.equal(sent.tools, undefined); assert.equal(sent.tool_choice, undefined);
  assert.equal(sent.output_config.effort, 'low'); assert.equal(sent.output_config.format.type, 'json_schema');
  const schema = sent.output_config.format.schema;
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ['feedback', 'labels', 'requiresReview', 'score']);
  assert.deepEqual(schema.properties.score, { type: 'integer' });
  assert.deepEqual(schema.properties.labels, { type: 'array', items: { type: 'string', enum: ['clear', 'gap'] } });
  assert.equal(JSON.stringify(schema).match(/minimum|maximum|maxItems|\$schema/), null);
  for (const output of [{ ...ASSESSMENT, score: 4 }, { ...ASSESSMENT, labels: ['gap', 'gap', 'gap'] }, { ...ASSESSMENT, extra: true }, { score: 2 }])
    await assert.rejects(harness([text(JSON.stringify(output))]).client.assess({ ...request(), outputSchema: assessmentSchema }), code('INVALID_RESPONSE'));
  for (const output of ['```json\n{}\n```', '{bad-json', '{"__proto__":{"polluted":true}}'])
    await assert.rejects(harness([text(output)]).client.assess({ ...request(), outputSchema: assessmentSchema }), code('INVALID_RESPONSE'));
  assert.equal({}.polluted, undefined);
});

test('the sent schema keeps minItems only as 0/1 and marks every object closed', () => {
  assert.deepEqual(anthropicOutputSchema({ type: 'object', properties: { a: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { b: { type: 'number', minimum: 0 } }, required: [] } } }, required: ['a'] }),
    { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'array', minItems: 1,
      items: { type: 'object', required: [], additionalProperties: false, properties: { b: { type: 'number' } } } } } });
});

test('refusal is BLOCKED; token cap, context overflow, pause or tool stops are incomplete; usage survives every failure', async () => {
  const refused = text('I cannot help with that.'); refused.stop_reason = 'refusal';
  refused.stop_details = { type: 'refusal', category: 'cyber', explanation: 'This request was declined.' };
  const error = await harness([refused]).client.assess({ ...request(), outputSchema: assessmentSchema }).catch(e => e);
  assert.equal(error.code, 'BLOCKED'); assert.equal(error.submission, 'unknown');
  assert.equal(error.usage.attempts[0].outcome, 'response'); assert.equal(error.usage.attempts[0].tokens.input, 17);
  assert.equal(JSON.stringify(error).includes('declined'), false);
  // max_tokens truncation of a structured answer is a failure even when the prefix happens to parse.
  for (const reason of ['max_tokens', 'model_context_window_exceeded', 'pause_turn', 'tool_use', 'stop_sequence', 'a_future_reason', null]) {
    const raw = text(JSON.stringify(ASSESSMENT)); raw.stop_reason = reason;
    const failure = await harness([raw]).client.assess({ ...request(), outputSchema: assessmentSchema }).catch(e => e);
    assert.equal(failure.code, 'INCOMPLETE_OUTPUT', String(reason)); assert.equal(failure.usage.attempts[0].tokens.output, 20);
  }
  const truncated = text('{"score": 2, "feedb'); truncated.stop_reason = 'max_tokens';
  await assert.rejects(harness([truncated]).client.assess({ ...request(), outputSchema: assessmentSchema }), code('INCOMPLETE_OUTPUT'));
  await assert.rejects(harness([truncated]).client.tutor(request()), code('INCOMPLETE_OUTPUT'));
});

test('malformed envelopes, unexpected blocks and empty answers are invalid responses', async () => {
  const cases = [{}, { ...text(), type: 'completion' }, { ...text(), role: 'user' }, message([]), text(''), text('   '),
    message([{ type: 'tool_use', id: 'toolu_1', name: 'delete_records', input: {} }]),
    message([{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } }, { type: 'text', text: 'answer' }]),
    message([{ type: 'image', source: {} }]), message([{ type: 'text', text: 42 }])];
  for (const raw of cases) await assert.rejects(harness([raw]).client.tutor(request()), code('INVALID_RESPONSE'));
  await assert.rejects(harness([new Response('{not json', { headers: { 'content-type': 'application/json' } })]).client.tutor(request()), code('INVALID_RESPONSE'));
  await assert.rejects(harness([new Response('<html>', { headers: { 'content-type': 'text/html' } })]).client.tutor(request()), code('INVALID_RESPONSE'));
  await assert.rejects(harness([new Response(JSON.stringify([text()]), { headers: { 'content-type': 'application/json' } })]).client.tutor(request()), code('INVALID_RESPONSE'));
});

test('response bodies are bounded by declared length and by streamed size', async () => {
  const config = anthropicConfig(); config.models[0].providerConfig.maxResponseBytes = 256;
  const declared = new Response(JSON.stringify(text()), { headers: { 'content-type': 'application/json', 'content-length': '999999' } });
  await assert.rejects(harness([declared], { config }).client.tutor(request()), code('OUTPUT_TOO_LARGE'));
  const streamed = new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode(' '.repeat(100))); controller.close();
  } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(harness([streamed], { config }).client.tutor(request()), code('OUTPUT_TOO_LARGE'));
});

test('429 honours retry-after once and then succeeds; each attempt is accounted and telemetry is an allowlist', async () => {
  const h = harness([apiError(429, 'rate_limit_error', {}, { 'retry-after': '0.01' }), text()]);
  const result = await h.client.tutor(request());
  assert.equal(h.calls.length, 2);
  assert.deepEqual(result.usage.attempts.map(a => [a.status, a.outcome]), [[429, 'rejected'], [200, 'response']]);
  assert.deepEqual(h.events.map(e => [e.adapter, e.phase, e.status, e.code]),
    [['anthropic', 'error', 429, 'THROTTLED'], ['anthropic', 'retry', 429, 'THROTTLED'], ['anthropic', 'response', 200, null]]);
  assert.ok(h.events[1].retryDelayMs >= 10);
  for (const event of h.events) assert.deepEqual(Object.keys(event).sort(), ['adapter', 'attempt', 'code', 'elapsedMs', 'operation', 'phase', 'retryDelayMs', 'status']);
  assert.ok(secretFree(h.events));
});

test('a 429 retry-after beyond the bound or a spend-cap 429 is not retried', async () => {
  const long = harness([apiError(429, 'rate_limit_error', {}, { 'retry-after': '60' })]);
  const error = await long.client.tutor(request()).catch(e => e);
  assert.equal(error.code, 'THROTTLED'); assert.equal(error.retryAfterMs, 60000); assert.equal(error.submission, 'rejected'); assert.equal(long.calls.length, 1);
  const capped = harness([apiError(429, 'rate_limit_error', { details: { error_code: 'enforced_spend_limit_reached' } })]);
  const cap = await capped.client.tutor(request()).catch(e => e);
  assert.equal(cap.code, 'UPSTREAM_REJECTED'); assert.equal(cap.status, 429); assert.equal(capped.calls.length, 1);
});

test('529 overloaded, 500 and 504 are unavailable with an uncertain outcome and are never replayed', async () => {
  for (const [status, type] of [[529, 'overloaded_error'], [500, 'api_error'], [504, 'timeout_error']]) {
    const h = harness([apiError(status, type), text()]);
    const error = await h.client.assess({ ...request(), outputSchema: assessmentSchema }).catch(e => e);
    assert.equal(error.code, 'UPSTREAM_UNAVAILABLE'); assert.equal(error.status, status); assert.equal(error.submission, 'unknown');
    assert.equal(h.calls.length, 1); assert.deepEqual(error.usage.attempts.map(a => a.outcome), ['unknown']);
    assert.ok(secretFree(error));
  }
});

test('401 invalid key, 403, 404 unknown model, 400, 402 and 413 are permanent rejections without replay or body echo', async () => {
  for (const [status, type, expected] of [[401, 'authentication_error', 'AUTHENTICATION'], [403, 'permission_error', 'PERMISSION_DENIED'],
    [404, 'not_found_error', 'NOT_FOUND'], [400, 'invalid_request_error', 'UPSTREAM_REJECTED'], [402, 'billing_error', 'UPSTREAM_REJECTED'],
    [413, 'request_too_large', 'UPSTREAM_REJECTED']]) {
    const h = harness([apiError(status, type), text()]);
    const error = await h.client.tutor(request()).catch(e => e);
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, expected); assert.equal(error.submission, 'rejected'); assert.equal(h.calls.length, 1);
    assert.ok(secretFree(error)); assert.ok(secretFree(error.toJSON()));
  }
  // An unreadable error body still classifies by status.
  await assert.rejects(harness([new Response('oops', { status: 401, headers: { 'content-type': 'text/plain' } })]).client.tutor(request()), code('AUTHENTICATION'));
});

test('redirects are refused at the fetch layer and never followed with the key', async () => {
  const h = harness([(url, init) => { assert.equal(init.redirect, 'error'); throw new TypeError('fetch failed: unexpected redirect'); }]);
  const error = await h.client.tutor(request()).catch(e => e);
  assert.equal(error.code, 'NETWORK_ERROR'); assert.equal(error.submission, 'unknown'); assert.equal(h.calls.length, 1);
  const manual = harness([new Response(null, { status: 307, headers: { location: 'https://attacker.example/v1/messages' } })]);
  await assert.rejects(manual.client.tutor(request()), code('UPSTREAM_REJECTED'));
  assert.equal(manual.calls.length, 1); assert.ok(manual.calls.every(call => call.url === 'https://api.anthropic.com/v1/messages'));
});

test('the key never appears in errors, telemetry, usage or console output', async () => {
  const logged = [], original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const name of Object.keys(original)) console[name] = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const h = harness([apiError(401, 'authentication_error'), new TypeError(`connect failed ${KEY}`), text()]);
    const results = [await h.client.tutor(request()).catch(e => e), await h.client.tutor(request()).catch(e => e), await h.client.tutor(request())];
    for (const value of [...results, h.events, results.map(r => r.usage)]) assert.ok(secretFree(value));
    assert.equal(String(results[1].stack).includes(KEY), false);
  } finally { Object.assign(console, original); }
  assert.ok(logged.every(line => !line.includes(KEY)));
});

test('missing, malformed or failing credentials stop before any request', async () => {
  for (const getApiKey of [() => '', () => 'has space', () => { throw new Error(KEY); }, async () => undefined]) {
    const h = harness([text()], { client: { getApiKey } });
    const error = await h.client.tutor(request()).catch(e => e);
    assert.equal(error.code, 'MISSING_CREDENTIAL'); assert.equal(h.calls.length, 0); assert.ok(secretFree(error));
  }
});

test('timeouts and caller aborts are uncertain local failures', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = harness([hang], { client: { settings: { attemptTimeoutMs: 20, totalTimeoutMs: 40, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } } });
  const timeout = await slow.client.tutor(request()).catch(e => e);
  assert.equal(timeout.code, 'TIMEOUT'); assert.equal(timeout.submission, 'unknown');
  const controller = new AbortController(), cancelled = harness([hang]);
  const pending = cancelled.client.tutor(request(), { signal: controller.signal }); controller.abort();
  assert.equal((await pending.catch(e => e)).code, 'CANCELLED');
});

test('research sends the basic web search tool and maps cited text blocks to sources and byte ranges', async () => {
  const raw = message([
    { type: 'text', text: "I'll search for that." },
    { type: 'server_tool_use', id: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE', name: 'web_search', input: { query: 'minimum of a list' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01WYG3ziw53XMcoyKL4XcZmE', content: [
      { type: 'web_search_result', url: 'https://docs.python.org/3/library/functions.html', title: 'Built-in Functions', encrypted_content: 'EqgfCioIARgBIiQ3YTAw', page_age: 'April 30, 2025' }] },
    { type: 'text', text: 'Based on the search results, ' },
    { type: 'text', text: 'min() returns the smallest item — très simple.', citations: [{ type: 'web_search_result_location',
      url: 'https://docs.python.org/3/library/functions.html', title: 'Built-in Functions', encrypted_index: 'Eo8BCioIAhgBIiQy', cited_text: 'Return the smallest item in an iterable.' }] },
  ], { usage: { input_tokens: 6039, output_tokens: 931, server_tool_use: { web_search_requests: 1 } } });
  const h = harness([raw]);
  const result = await h.client.research(request({ modelId: 'claude-research' }));
  const sent = body(h.calls[0]);
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.deepEqual(sent.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
  assert.equal(sent.output_config, undefined); assert.equal(sent.thinking, undefined);
  const output = result.output;
  assert.equal(output.grounding, 'grounded');
  assert.deepEqual(output.sources, [{ uri: 'https://docs.python.org/3/library/functions.html', title: 'Built-in Functions' }]);
  assert.deepEqual(output.searchQueries, ['minimum of a list']); assert.equal(output.searchSuggestionsHtml, null);
  assert.deepEqual(output.parts.map(p => p.partIndex), [0, 3, 4]);
  assert.deepEqual(output.citations, [{ partIndex: 4, startByte: 0, endByte: Buffer.byteLength(raw.content[4].text), sourceIndices: [0] }]);
  assert.equal(output.text, "I'll search for that.Based on the search results, min() returns the smallest item — très simple.");
  assert.deepEqual(result.usage.attempts[0].tokens, { input: 6039, output: 931, total: 6970, cachedInput: 0, thoughts: null, toolInput: null, cacheWriteInput: 0, serverToolRequests: 1 });
});

test('research tolerates search errors as ungrounded, but rejects insecure citations and unexpected tools', async () => {
  const failed = message([{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: 'I could not verify this with a search.' }]);
  const result = await harness([failed]).client.research(request({ modelId: 'claude-research' }));
  assert.equal(result.output.grounding, 'not_grounded'); assert.deepEqual(result.output.sources, []);
  const insecure = message([{ type: 'text', text: 'claim', citations: [{ type: 'web_search_result_location', url: 'http://plain.example/', title: 't', encrypted_index: 'x', cited_text: 'c' }] }]);
  await assert.rejects(harness([insecure]).client.research(request({ modelId: 'claude-research' })), code('INVALID_RESPONSE'));
  const fetchTool = message([{ type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_fetch', input: { url: 'https://example.com' } }, { type: 'text', text: 'x' }]);
  await assert.rejects(harness([fetchTool]).client.research(request({ modelId: 'claude-research' })), code('INVALID_RESPONSE'));
});

test('configuration refuses media capabilities, path-like model ids and research without a declared search tool', () => {
  const variants = [
    m => { m.capabilities = ['image']; }, m => { m.capabilities = ['video']; },
    m => { m.remoteModel = 'models/../v1/files'; }, m => { m.remoteModel = 'https://api.anthropic.com'; },
    m => { m.providerConfig = { ...base, apiVersion: '2099-01-01' }; }, m => { m.providerConfig = { ...base, thinking: 'enabled' }; },
    m => { m.providerConfig = { ...base, unknownField: true }; }, m => { delete m.limits.maxOutputTokens; },
    m => { m.capabilities = ['research']; m.tools = ['web_search']; },
    m => { m.tools = ['web_search']; },
    // Disabled thinking is accepted only at effort `high` or below.
    m => { m.providerConfig = { ...base, thinking: 'disabled', effort: 'xhigh' }; },
    m => { m.providerConfig = { ...base, thinking: 'disabled', effort: 'max' }; },
    // No sampling parameters: current models reject non-default values.
    m => { m.providerConfig = { ...base, temperature: 0.2 }; },
  ];
  for (const change of variants) {
    const config = anthropicConfig(); change(config.models[0]);
    assert.throws(() => harness([], { config }), code('INVALID_CONFIG'));
  }
  const h = harness();
  assert.deepEqual(Object.keys(h.client.ports).sort(), ['research', 'structured_assessment', 'tutoring']);
  assert.deepEqual(h.client.capabilities('claude-text'), ['tutoring', 'structured_assessment']);
});

test('input bounds are enforced before sending', async () => {
  const h = harness([text()]);
  await assert.rejects(h.client.tutor(request({ maxOutputTokens: 2048 })), code('INVALID_INPUT'));
  await assert.rejects(h.client.tutor(request({ messages: [{ role: 'user', text: 'x'.repeat(20_001) }] })), code('INVALID_INPUT'));
  await assert.rejects(h.client.research(request()), code('CAPABILITY_MISMATCH'));
  assert.equal(h.calls.length, 0);
});

test('the router dispatches mixed providers per role and reports each provider to the observer', async () => {
  const anthropicCalls = [], googleCalls = [], ended = [];
  const registry = new ModelRegistry({ revision: 'mixed-v1', models: [
    { ...anthropicConfig().models[0], id: 'companion-model' },
    { id: 'supervisor-model', providerId: 'google-account', remoteModel: 'admin-selected-text-model',
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000 }, enabled: true,
      capabilities: ['structured_assessment'], tools: [], limits },
  ] });
  const anthropic = new AnthropicProvider({ providerId: 'anthropic-account', registry, getApiKey: () => KEY,
    fetch: async (url, init) => { anthropicCalls.push({ url, init }); return json(text('Companion answer')); } });
  const google = new GoogleProvider({ providerId: 'google-account', registry, getApiKey: () => 'google-test-credential',
    fetch: async (url, init) => { googleCalls.push({ url, init }); return json(textResponse(JSON.stringify(ASSESSMENT))); } });
  registry.registerAdapter(anthropic); registry.registerAdapter(google);
  const router = new ProviderRouter(registry, { observe: () => end => ended.push(end) });
  const companion = await router.tutor({ ...request(), modelId: 'companion-model' });
  const supervisor = await router.assess({ ...request(), modelId: 'supervisor-model', outputSchema: assessmentSchema });
  assert.equal(companion.output.text, 'Companion answer'); assert.deepEqual(supervisor.output, ASSESSMENT);
  assert.deepEqual(anthropicCalls.map(c => c.url), ['https://api.anthropic.com/v1/messages']);
  assert.ok(googleCalls[0].url.startsWith('https://generativelanguage.googleapis.com/'));
  assert.equal(anthropicCalls[0].init.headers['x-goog-api-key'], undefined); assert.equal(googleCalls[0].init.headers['x-api-key'], undefined);
  assert.deepEqual(ended.map(e => [e.providerId, e.outcome, e.tokens.input]), [['anthropic-account', 'response', 17], ['google-account', 'response', 11]]);
  // The router's own contract check still runs on Anthropic output.
  const bad = new ModelRegistry({ revision: 'mixed-v2', models: [{ ...anthropicConfig().models[0], id: 'companion-model' }] });
  bad.registerAdapter(new AnthropicProvider({ providerId: 'anthropic-account', registry: bad, getApiKey: () => KEY, fetch: async () => json(text('{"score":9}')) }));
  await assert.rejects(new ProviderRouter(bad).assess({ ...request(), modelId: 'companion-model', outputSchema: assessmentSchema }), code('INVALID_RESPONSE'));
  // A model bound to one provider can never be dispatched through another adapter.
  await assert.rejects(new ProviderRouter(registry).startImage({ modelId: 'companion-model', accounting: { accountingKey: 'a' }, prompt: 'p', maxOutputTokens: 10 }), code('CAPABILITY_MISMATCH'));
});

// Synthetic operator prices (micro-USD per million tokens); not a vendor rate card.
const operatorPrice = (extra = {}) => ({ versionId: 'v1', currency: 'USD', inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 5_000_000,
  cachedInputMicroUsdPerMillionTokens: 100_000, microUsdPerRequest: null, microUsdPerOutputSecond: null, ...extra });
test('Messages API usage prices from operator rates: cache reads at the cached rate, thinking as output, searches per request', async () => {
  const raw = text(); raw.usage = { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 500, cache_creation_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 100 } };
  const result = await harness([raw]).client.tutor(request());
  // 1000 input at 1.0 + 500 cached at 0.1 + 300 output (200 visible + 100 thinking) at 5.0 = 1000 + 50 + 1500.
  const priced = priceUsage(result.usage, operatorPrice());
  assert.equal(priced.cost.microUsd, 2550);
  assert.deepEqual(priced.cost.billable, { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 300, requests: 1, outputSeconds: 0 });
  // A cache write (never requested by this adapter) is not silently billed at the input rate.
  const written = text(); written.usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 40 };
  assert.deepEqual(priceUsage((await harness([written]).client.tutor(request())).usage, operatorPrice()), { cost: null, reason: 'pricing_incomplete' });
  // Research: each reported web search costs the operator's per-server-tool price.
  const searched = message([{ type: 'text', text: 'Answer without citations.' }], { usage: { input_tokens: 2000, output_tokens: 100, server_tool_use: { web_search_requests: 3 } } });
  const research = await harness([searched]).client.research(request({ modelId: 'claude-research' }));
  assert.equal(priceUsage(research.usage, operatorPrice({ microUsdPerServerToolRequest: 10_000 })).cost.microUsd, 2000 + 500 + 30_000);
  assert.equal(priceUsage(research.usage, operatorPrice()).reason, 'pricing_incomplete');
  // A refusal still returns its billed usage on the error, so it can be priced the same way.
  const refused = text(); refused.stop_reason = 'refusal'; refused.usage = { input_tokens: 50, output_tokens: 2 };
  const error = await harness([refused]).client.tutor(request()).catch(e => e);
  assert.equal(error.code, 'BLOCKED'); assert.equal(priceUsage(error.usage, operatorPrice()).cost.microUsd, 50 + 10);
});

test('tutoring may deliver a reply cut short at max_tokens, marked, only when allowed and with enough visible text', async () => {
  const long = 'Backward computes gradients; the optimizer step changes the weight. '.repeat(4);
  const raw = () => {
    const m = message([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: long }]);
    m.stop_reason = 'max_tokens'; m.usage = { input_tokens: 2000, output_tokens: 4096, output_tokens_details: { thinking_tokens: 3800 } };
    return m;
  };
  await assert.rejects(harness([raw()]).client.tutor(request()), code('INCOMPLETE_OUTPUT'));
  const result = await harness([raw()]).client.tutor(request({ allowCutShort: true }));
  assert.deepEqual(result.output, { text: long, cutShort: true });
  assert.equal(result.usage.attempts[0].tokens.thoughts, 3800); assert.equal(result.usage.attempts[0].tokens.total, 6096);
  const short = message([{ type: 'text', text: 'Backward computes' }]); short.stop_reason = 'max_tokens';
  await assert.rejects(harness([short]).client.tutor(request({ allowCutShort: true })), code('INCOMPLETE_OUTPUT'));
  // Structured output is never accepted when cut off.
  const json = text('{"score": 2, "feedback": "Explain the missing step.", "requiresReview": true, "labels": []}'); json.stop_reason = 'max_tokens';
  await assert.rejects(harness([json]).client.assess({ ...request({ allowCutShort: true }), outputSchema: assessmentSchema }), code('INCOMPLETE_OUTPUT'));
});
