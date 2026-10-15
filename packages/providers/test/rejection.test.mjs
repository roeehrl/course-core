import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHttpError, definiteRejection, DEFINITE_REJECTION_STATUSES, ProviderError } from '../dist/index.js';
import { harness, json, request, textResponse } from './helpers.mjs';

const fast = { client: { settings: { attemptTimeoutMs: 50, totalTimeoutMs: 500, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 } } };
const failure = async (steps, options = fast) => {
  const h = harness(steps, options);
  const error = await h.client.tutor(request()).then(() => assert.fail('expected a provider failure'), e => e);
  return { error, calls: h.calls.length };
};

test('only documented refusals are marked rejected; every other status after sending is unknown', () => {
  assert.deepEqual([...DEFINITE_REJECTION_STATUSES], [400, 401, 402, 403, 404, 413, 429]);
  for (const status of DEFINITE_REJECTION_STATUSES) assert.equal(classifyHttpError(status).submission, 'rejected', String(status));
  for (const status of [408, 409, 410, 416, 422, 499, 500, 502, 503, 504, 529]) assert.equal(classifyHttpError(status).submission, 'unknown', String(status));
});

test('a refused generateContent call is a definite rejection with the provider hint for rate limits only', async () => {
  for (const [status, code] of [[400, 'UPSTREAM_REJECTED'], [401, 'AUTHENTICATION'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [413, 'UPSTREAM_REJECTED']]) {
    const { error, calls } = await failure([json({ error: { code: status } }, status, { 'retry-after': '5' })]);
    assert.equal(calls, 1); assert.equal(error.code, code);
    assert.deepEqual(definiteRejection(error), { status, retryable: false, retryAfterMs: null });
  }
  const limited = await failure([json({ error: { code: 429 } }, 429, { 'retry-after': '12' })]);
  assert.deepEqual(definiteRejection(limited.error), { status: 429, retryable: true, retryAfterMs: 12_000 });
  const bare = await failure([json({ error: { code: 429 } }, 429)]);
  assert.deepEqual(definiteRejection(bare.error), { status: 429, retryable: true, retryAfterMs: null });
});

test('server errors, timeouts, resets and broken bodies are never certified as non-execution', async () => {
  const broken = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"candidates":')); c.error(new Error('reset')); } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  for (const step of [json({}, 500), json({}, 503), json({}, 504), json({}, 529), json({}, 408), json({}, 409), json({}, 422),
    new TypeError('socket hang up'), () => new Promise(() => {}), broken]) {
    const { error, calls } = await failure([step]);
    assert.equal(calls, 1); assert.equal(error.submission, 'unknown', error.code);
    assert.equal(definiteRejection(error), null, error.code);
  }
});

test('every attempt must be a refusal: a throttle followed by an unknown outcome stays uncertain', async () => {
  const retrying = { client: { settings: { attemptTimeoutMs: 50, totalTimeoutMs: 1000, maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 } } };
  const mixed = await failure([json({}, 429, { 'retry-after': '0.001' }), json({}, 503)], retrying);
  assert.deepEqual(mixed.error.usage.attempts.map(a => [a.status, a.outcome]), [[429, 'rejected'], [503, 'unknown']]);
  assert.equal(definiteRejection(mixed.error), null);
  const refused = await failure([json({}, 429, { 'retry-after': '0.001' }), json({}, 401)], retrying);
  assert.deepEqual(definiteRejection(refused.error), { status: 401, retryable: false, retryAfterMs: null });
  // A forged or unaccounted rejection is not trusted.
  assert.equal(definiteRejection(new ProviderError('AUTHENTICATION', { status: 401, submission: 'rejected' })), null);
  const forged = new ProviderError('AUTHENTICATION', { status: 401, submission: 'rejected' });
  forged.usage = { attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: {} }] };
  assert.equal(definiteRejection(forged), null);
  assert.equal(definiteRejection(new Error('401')), null);
  // Sanity: a success is unaffected.
  const ok = harness([json(textResponse())], fast);
  assert.equal((await ok.client.tutor(request())).output.text, 'A useful explanation.');
});
