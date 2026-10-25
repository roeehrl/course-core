import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelRegistry, ProviderError, priceUsage } from '../dist/index.js';
import { GoogleProvider } from '../dist/google-index.js';
import { AnthropicProvider } from '../dist/anthropic-index.js';
import { config, request, KEY, PROMPT } from './helpers.mjs';

// Stalled and stopped streams (first-byte, idle and caller bounds) against synthetic fixtures and a
// local HTTP stub server. No live provider is contacted: the stub stands in for the fixed origin.
const encoder = new TextEncoder();
const frame = data => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const named = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const googleChunk = (text, candidates = 3) => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: candidates, totalTokenCount: 11 + candidates } });
const code = expected => error => error instanceof ProviderError && error.code === expected;
const settings = { attemptTimeoutMs: 2_000, totalTimeoutMs: 5_000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 };
const pricing = { versionId: 'price-v1', currency: 'USD', inputMicroUsdPerMillionTokens: 750_000, outputMicroUsdPerMillionTokens: 3_750_000,
  cachedInputMicroUsdPerMillionTokens: null, microUsdPerRequest: null, microUsdPerOutputSecond: null };

function google(fetch) {
  const registry = new ModelRegistry(config());
  const client = new GoogleProvider({ providerId: 'google-account', registry, getApiKey: () => KEY, fetch, settings });
  registry.registerAdapter(client);
  return client;
}
function anthropic(fetch) {
  const registry = new ModelRegistry({ revision: 'a1', models: [{ id: 'claude-text', providerId: 'anthropic-account', remoteModel: 'claude-haiku-5-5',
    providerConfig: { transport: 'messages', apiVersion: '2023-06-01', maxResponseBytes: 1_000_000, effort: 'low', thinking: 'disabled' },
    enabled: true, capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20_000, maxOutputTokens: 1024 } }] });
  const client = new AnthropicProvider({ providerId: 'anthropic-account', registry, getApiKey: () => KEY, fetch, settings });
  registry.registerAdapter(client);
  return client;
}
const areq = () => ({ modelId: 'claude-text', accounting: { accountingKey: 'a' }, messages: [{ role: 'user', text: PROMPT }], maxOutputTokens: 128 });
/** A stream that sends `chunks` and then stays open without another byte until aborted. */
function openStream(chunks, signal) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const never = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));

test('first byte: nothing back (not even headers) ends at the first-byte bound as NO_RESPONSE, sent and unknown', async () => {
  const started = Date.now();
  await assert.rejects(google(never).tutorStream(request(), { firstByteTimeoutMs: 60, timeoutMs: 5_000 }, () => {}), error => code('NO_RESPONSE')(error)
    && error.submission === 'unknown' && error.usage.attempts.length === 1 && error.usage.attempts[0].status === null && error.usage.attempts[0].outcome === 'unknown');
  assert.ok(Date.now() - started < 1_500, 'ends at the first-byte bound, not the total');
});

test('first byte: headers without a first chunk still end as NO_RESPONSE (the bound runs to the first chunk)', async () => {
  const client = google((_url, init) => Promise.resolve(openStream([], init.signal)));
  await assert.rejects(client.tutorStream(request(), { firstByteTimeoutMs: 60, idleTimeoutMs: 2_000 }, () => {}), error => code('NO_RESPONSE')(error)
    && error.usage.attempts[0].status === 200 && error.usage.attempts[0].outcome === 'unknown');
});

test('idle: a Google stream stalled mid-reply ends as STREAM_STALLED with its cumulative usage (partial), priced at that usage', async () => {
  const seen = [];
  const client = google((_url, init) => Promise.resolve(openStream([frame(googleChunk('Half ', 2)), frame(googleChunk('an answer', 5))], init.signal)));
  const error = await client.tutorStream(request(), { firstByteTimeoutMs: 1_000, idleTimeoutMs: 60 }, text => seen.push(text)).then(() => null, e => e);
  assert.ok(code('STREAM_STALLED')(error));
  assert.equal(error.submission, 'unknown');
  assert.deepEqual(seen, ['Half ', 'an answer']);
  const [attempt] = error.usage.attempts;
  assert.equal(attempt.outcome, 'partial');
  assert.deepEqual([attempt.tokens.input, attempt.tokens.output, attempt.tokens.total], [11, 5, 16]);
  // 11 input x 0.75 + 5 output x 3.75 micro-USD = 27 (rounded up once).
  assert.deepEqual(priceUsage(error.usage, pricing).cost?.microUsd, 27);
});

test('idle: an Anthropic stream stalled mid-reply has no cumulative output count yet, so its usage stays unknown', async () => {
  const start = named('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5',
    stop_reason: null, usage: { input_tokens: 25, output_tokens: 1 } } });
  const block = named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const delta = named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
  const client = anthropic((_url, init) => Promise.resolve(openStream([start, block, delta], init.signal)));
  const error = await client.tutorStream(areq(), { idleTimeoutMs: 60 }, () => {}).then(() => null, e => e);
  assert.ok(code('STREAM_STALLED')(error));
  const [attempt] = error.usage.attempts;
  assert.equal(attempt.outcome, 'unknown');
  assert.deepEqual([attempt.tokens.input, attempt.tokens.output, attempt.tokens.total], [25, null, null]);
  assert.equal(priceUsage(error.usage, pricing).cost, null);
});

test('caller abort mid-stream: CANCELLED with the usage reported up to the stop; an abort before any byte is unknown', async () => {
  const controller = new AbortController();
  const client = google((_url, init) => Promise.resolve(openStream([frame(googleChunk('Started', 4))], init.signal)));
  const stopped = client.tutorStream(request(), { signal: controller.signal, idleTimeoutMs: 5_000 }, () => controller.abort()).then(() => null, e => e);
  const error = await stopped;
  assert.ok(code('CANCELLED')(error));
  assert.equal(error.usage.attempts[0].outcome, 'partial');
  assert.equal(error.usage.attempts[0].tokens.output, 4);
  const early = new AbortController();
  const pending = google(never).tutorStream(request(), { signal: early.signal }, () => {}).then(() => null, e => e);
  setTimeout(() => early.abort(), 20);
  const before = await pending;
  assert.ok(code('CANCELLED')(before));
  assert.equal(before.usage.attempts[0].outcome, 'unknown');
  assert.equal(before.submission, 'unknown');
});

test('connection never opened: refused, unknown host, connect timeout and TLS failures are not sent; a reset is unknown', async () => {
  const failing = cause => async () => { throw new TypeError('fetch failed', { cause }); };
  for (const cause of [Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), Object.assign(new Error('dns'), { code: 'ENOTFOUND' }),
    Object.assign(new Error('slow'), { code: 'UND_ERR_CONNECT_TIMEOUT' }), Object.assign(new Error('tls'), { code: 'CERT_HAS_EXPIRED' }),
    new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'EHOSTUNREACH' })])]) {
    for (const call of [c => c.tutorStream(request(), {}, () => {}), c => c.tutor(request())]) {
      const error = await call(google(failing(cause))).then(() => null, e => e);
      assert.ok(code('NETWORK_ERROR')(error));
      assert.equal(error.submission, 'not_sent', cause.code ?? 'aggregate');
      assert.deepEqual(error.usage.attempts.map(a => a.outcome), ['not_sent']);
    }
  }
  for (const cause of [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), new Error('no code'),
    new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNRESET' })])]) {
    const error = await google(failing(cause)).tutorStream(request(), {}, () => {}).then(() => null, e => e);
    assert.equal(error.submission, 'unknown');
    assert.deepEqual(error.usage.attempts.map(a => a.outcome), ['unknown']);
  }
  // A plain (non-fetch) error is never read as "not sent".
  const thrown = await google(async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }).tutorStream(request(), {}, () => {}).then(() => null, e => e);
  assert.equal(thrown.submission, 'unknown');
});

test('whole reply: a first-byte bound, when set, ends as NO_RESPONSE; without one the attempt bound still says TIMEOUT', async () => {
  await assert.rejects(google(never).tutor(request(), { firstByteTimeoutMs: 50 }), error => code('NO_RESPONSE')(error) && error.submission === 'unknown');
  const registry = new ModelRegistry(config());
  const slow = new GoogleProvider({ providerId: 'google-account', registry, getApiKey: () => KEY, fetch: never, settings: { ...settings, attemptTimeoutMs: 50 } });
  registry.registerAdapter(slow);
  await assert.rejects(slow.tutor(request()), code('TIMEOUT'));
});

// A real HTTP exchange with a local stub server standing in for the provider origin: the adapter's
// fixed HTTPS origin is rewritten to the stub, nothing else about the request changes.
async function stub(handler) {
  const sockets = new Set(), closed = [];
  // A response closed before it finished means the client dropped the connection.
  const server = createServer((req, res) => {
    res.on('close', () => { if (!res.writableFinished) closed.push(Date.now()); });
    handler(req, res);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetch = (url, init) => globalThis.fetch(String(url).replace('https://generativelanguage.googleapis.com', origin), init);
  return { fetch, closed, origin, close: async () => { for (const socket of sockets) socket.destroy(); server.close(); await once(server, 'close'); } };
}

test('stub server: a request it accepts but never answers ends as NO_RESPONSE at the first-byte bound, and the connection is closed', async () => {
  const server = await stub(() => { /* reads the request, never answers */ });
  try {
    const started = Date.now();
    await assert.rejects(google(server.fetch).tutorStream(request(), { firstByteTimeoutMs: 150, timeoutMs: 5_000 }, () => {}),
      error => code('NO_RESPONSE')(error) && error.submission === 'unknown' && error.usage.attempts[0].status === null);
    assert.ok(Date.now() - started < 2_000);
    for (let i = 0; i < 50 && !server.closed.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.closed.length, 1, 'the abandoned request was closed, not left running');
  } finally { await server.close(); }
});

test('stub server: a stream that stalls mid-reply ends as STREAM_STALLED with the reported usage, and the connection is closed', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame(googleChunk('Partial ', 3)));
  });
  try {
    const error = await google(server.fetch).tutorStream(request(), { firstByteTimeoutMs: 1_000, idleTimeoutMs: 120 }, () => {}).then(() => null, e => e);
    assert.ok(code('STREAM_STALLED')(error));
    assert.equal(error.usage.attempts[0].outcome, 'partial');
    assert.equal(error.usage.attempts[0].tokens.output, 3);
    for (let i = 0; i < 50 && !server.closed.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.closed.length, 1);
  } finally { await server.close(); }
});

test('stub server: the caller aborting a stream closes the provider connection at once', async () => {
  const server = await stub((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame(googleChunk('One ', 2)));
    const timer = setInterval(() => res.write(frame(googleChunk('more ', 3))), 30);
    res.on('close', () => clearInterval(timer));
  });
  try {
    const controller = new AbortController();
    let pieces = 0;
    const result = google(server.fetch).tutorStream(request(), { signal: controller.signal, idleTimeoutMs: 2_000 }, () => { if (++pieces === 3) controller.abort(); });
    const error = await result.then(() => null, e => e);
    const stoppedAt = Date.now();
    assert.ok(code('CANCELLED')(error));
    assert.equal(error.usage.attempts[0].outcome, 'partial');
    for (let i = 0; i < 50 && !server.closed.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(server.closed.length, 1);
    assert.ok(server.closed[0] - stoppedAt < 1_000, 'the stub saw the connection close right after the stop');
  } finally { await server.close(); }
});

test('stub server: a port nothing listens on is a connection that never opened (not sent)', async () => {
  const server = await stub(() => {});
  const { fetch } = server; await server.close();
  const error = await google(fetch).tutorStream(request(), {}, () => {}).then(() => null, e => e);
  assert.ok(code('NETWORK_ERROR')(error));
  assert.equal(error.submission, 'not_sent');
  assert.deepEqual(error.usage.attempts.map(a => a.outcome), ['not_sent']);
});
