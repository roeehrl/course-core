import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHttpError, classifyRetry } from '../dist/index.js';
import { parseRetryAfter } from '../dist/google-index.js';
import { config, harness, json, request, textResponse, KEY, PROMPT, code } from './helpers.mjs';

test('HTTP classifications distinguish authentication, throttling, rejection and transient uncertainty', () => {
  for (const [status, expected] of [[400, 'UPSTREAM_REJECTED'], [401, 'AUTHENTICATION'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [429, 'THROTTLED'], [408, 'UPSTREAM_UNAVAILABLE'], [503, 'UPSTREAM_UNAVAILABLE']]) {
    assert.equal(classifyHttpError(status).code, expected);
  }
  assert.deepEqual(classifyRetry(classifyHttpError(503), 'POST'), { transient: true, automaticRetryAllowed: false, mayDuplicateGeneration: true });
  assert.equal(classifyRetry(classifyHttpError(503), 'GET').automaticRetryAllowed, true);
  assert.equal(classifyRetry(classifyHttpError(429), 'POST').automaticRetryAllowed, true);
  assert.equal(classifyRetry(classifyHttpError(403), 'GET').automaticRetryAllowed, false);
});

test('throttling retries are bounded and accounted separately, with no secret-bearing telemetry', async () => {
  const h = harness([json({ error: { message: `${KEY} ${PROMPT}` } }, 429, { 'retry-after': '0.001' }), textResponse()]);
  const result = await h.client.tutor(request());
  assert.equal(h.calls.length, 2); assert.equal(result.usage.attempts.length, 2);
  assert.equal(result.usage.attempts[0].outcome, 'rejected');
  assert.equal(result.usage.attempts[0].tokens.input, null);
  assert.equal(result.usage.attempts[1].tokens.input, 11);
  assert.equal(h.events.filter(e => e.phase === 'retry').length, 1);
  const logged = JSON.stringify(h.events);
  for (const sensitive of [KEY, PROMPT, 'x-goog-api-key', 'accounting-1', 'admin-selected-text-model', 'https://']) assert.equal(logged.includes(sensitive), false);
  for (const event of h.events) assert.deepEqual(Object.keys(event).sort(), ['adapter', 'operation', 'attempt', 'phase', 'status', 'code', 'elapsedMs', 'retryDelayMs'].sort());
});

test('POST transient/network/timeout errors do not silently replay possibly billable generation', async () => {
  for (const step of [json({ error: KEY }, 503), new Error(`network ${KEY}`), () => new Promise(() => {})]) {
    const h = harness([step], { client: { settings: { attemptTimeoutMs: 15, totalTimeoutMs: 50, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 } } });
    await assert.rejects(h.client.tutor(request()), error => {
      assert.equal(error.submission, 'unknown'); assert.equal(error.usage.attempts.length, 1);
      assert.equal(JSON.stringify(error).includes(KEY), false); assert.equal(error.message.includes(KEY), false);
      return ['UPSTREAM_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code);
    });
    assert.equal(h.calls.length, 1);
  }
});

test('Retry-After supports dates and seconds; long hints prevent early retry instead of being truncated', async () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('Tue, 01 Jan 2030 00:00:05 GMT', now), 5000);
  assert.equal(parseRetryAfter('172800', now), 172800000);
  assert.equal(parseRetryAfter('nonsense', now), undefined);
  assert.equal(parseRetryAfter('-1', now), undefined);
  const h = harness([json({ error: 'rate limited' }, 429, { 'retry-after': '172800' })]);
  await assert.rejects(h.client.tutor(request()), error => error.code === 'THROTTLED' && error.retryAfterMs === 172800000);
  assert.equal(h.calls.length, 1);
});

test('retry count is finite even on persistent throttling', async () => {
  const h = harness([json({}, 429), json({}, 429), json({}, 429)]);
  await assert.rejects(h.client.tutor(request()), code('THROTTLED'));
  assert.equal(h.calls.length, 3);
});

test('missing or failed server credentials prevent HTTP and never leak resolver errors', async () => {
  for (const getApiKey of [() => '', () => 'bad\nheader', () => { throw new Error(`credential backend: ${KEY}`); }]) {
    const h = harness([], { client: { getApiKey } });
    await assert.rejects(h.client.tutor(request()), error => {
      assert.equal(error.code, 'MISSING_CREDENTIAL'); assert.equal(error.usage.attempts.length, 0);
      assert.equal(JSON.stringify(error).includes(KEY), false); return true;
    });
    assert.equal(h.calls.length, 0);
  }
});

test('credential resolution is also bounded by the total timeout', async () => {
  const h = harness([], { client: { getApiKey: () => new Promise(() => {}) } });
  await assert.rejects(h.client.tutor(request(), { timeoutMs: 10 }), code('TIMEOUT'));
  assert.equal(h.calls.length, 0);
});

test('already aborted and in-flight aborts preserve caller cancellation without exposing reasons', async () => {
  const before = new AbortController(); before.abort(`secret ${KEY}`);
  const noCall = harness();
  await assert.rejects(noCall.client.tutor(request(), { signal: before.signal }), code('CANCELLED'));
  assert.equal(noCall.calls.length, 0);
  const controller = new AbortController();
  const h = harness([(_url, init) => {
    setTimeout(() => controller.abort(`do not log ${KEY}`), 5);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true }));
  }]);
  await assert.rejects(h.client.tutor(request(), { signal: controller.signal }), error => {
    assert.equal(error.code, 'CANCELLED'); assert.equal(JSON.stringify(error).includes(KEY), false); return true;
  });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].init.signal.aborted, true);
});

test('aborting during throttling backoff prevents the next submission', async () => {
  const controller = new AbortController();
  const h = harness([json({}, 429)], { client: { settings: { baseDelayMs: 100, maxDelayMs: 100, totalTimeoutMs: 1000, attemptTimeoutMs: 200, maxAttempts: 3 },
    telemetry: event => { if (event.phase === 'retry') controller.abort(KEY); } } });
  await assert.rejects(h.client.tutor(request(), { signal: controller.signal }), code('CANCELLED'));
  assert.equal(h.calls.length, 1);
});

test('untrusted error bodies, status text and transport causes are never exposed', async () => {
  const response = new Response(`${KEY} ${PROMPT} <script>`, { status: 403, statusText: KEY, headers: { 'content-type': 'text/html', 'x-request-id': KEY } });
  const h = harness([response]);
  await assert.rejects(h.client.tutor(request()), error => {
    assert.equal(error.code, 'PERMISSION_DENIED'); assert.equal(error.cause, undefined);
    const serialized = JSON.stringify(error); assert.equal(serialized.includes(KEY), false); assert.equal(serialized.includes(PROMPT), false);
    return true;
  });
  assert.equal(JSON.stringify(h.events).includes(KEY), false);
});

test('telemetry callback throws or rejects without failing or replaying generation', async () => {
  for (const telemetry of [() => { throw new Error(KEY); }, async () => { throw new Error(KEY); }]) {
    const h = harness([textResponse()], { client: { telemetry } });
    const result = await h.client.tutor(request());
    assert.equal(result.output.text, 'A useful explanation.'); assert.equal(h.calls.length, 1);
  }
});

test('malformed JSON, wrong media types and excessive response bodies fail closed', async () => {
  for (const response of [new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
    new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }),
    json({ candidates: [] }, 200, { 'content-length': '999999999' })]) {
    const h = harness([response]);
    await assert.rejects(h.client.tutor(request()), error => ['INVALID_RESPONSE', 'OUTPUT_TOO_LARGE'].includes(error.code));
    assert.equal(h.calls.length, 1);
  }
  const cfg = config(); cfg.models[0].providerConfig.maxResponseBytes = 32;
  const h = harness([textResponse()], { config: cfg });
  await assert.rejects(h.client.tutor(request()), code('OUTPUT_TOO_LARGE'));
});

test('hanging response streams are timed out and cancelled, including fetch implementations ignoring signals', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const h = harness([new Response(stream, { headers: { 'content-type': 'application/json' } })]);
  await assert.rejects(h.client.tutor(request(), { timeoutMs: 15 }), code('TIMEOUT'));
  assert.equal(cancelled, true); assert.equal(h.calls.length, 1);
});

test('response validation failures retain observed usage for reconciliation', async () => {
  const raw = textResponse(); raw.candidates[0].finishReason = 'MAX_TOKENS';
  await assert.rejects(harness([raw]).client.tutor(request()), error => {
    assert.equal(error.code, 'INCOMPLETE_OUTPUT'); assert.equal(error.usage.attempts[0].tokens.total, 21);
    assert.equal(error.submission, 'unknown'); return true;
  });
});
