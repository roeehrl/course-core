import test from 'node:test';
import assert from 'node:assert/strict';
import { definiteRejection, ProviderError } from '../dist/index.js';
import { googleRefusal } from '../dist/http.js';
import { ASSESSMENT, assessmentSchema, harness, json, KEY, PROMPT, request, textResponse } from './helpers.mjs';

const fast = { client: { settings: { attemptTimeoutMs: 50, totalTimeoutMs: 500, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 } } };
const info = (reason) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } });
const quota = (quotaId) => ({ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_requests', quotaId }] });
/** A Google error body as generateContent returns it; `message` carries echoed request data that must never be kept. */
const googleError = (code, status, details = []) => ({ error: { code, status, details,
  message: `Invalid value at 'generation_config' "${PROMPT}" key=${KEY}` } });
const failure = async (response) => {
  const h = harness([response], fast);
  const error = await h.client.assess({ ...request(), outputSchema: assessmentSchema }).then(() => assert.fail('expected a refusal'), e => e);
  return { error, calls: h.calls.length };
};

test('Google refusals keep the HTTP status and the documented reason code, never the body', async () => {
  const cases = [
    // A malformed request (the Gemini 3.x structured-output bug): not a key, quota or billing problem.
    [googleError(400, 'INVALID_ARGUMENT', [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'generation_config' }] }]), 400, 'UPSTREAM_REJECTED', 'INVALID_ARGUMENT'],
    [googleError(400, 'FAILED_PRECONDITION'), 400, 'UPSTREAM_REJECTED', 'FAILED_PRECONDITION'],
    [googleError(400, 'INVALID_ARGUMENT', [info('API_KEY_INVALID')]), 400, 'UPSTREAM_REJECTED', 'API_KEY_INVALID'],
    [googleError(403, 'PERMISSION_DENIED', [info('SERVICE_DISABLED')]), 403, 'PERMISSION_DENIED', 'SERVICE_DISABLED'],
    [googleError(403, 'PERMISSION_DENIED'), 403, 'PERMISSION_DENIED', 'PERMISSION_DENIED'],
    // Billing only for the documented reasons.
    [googleError(403, 'PERMISSION_DENIED', [info('BILLING_DISABLED')]), 403, 'BILLING_REQUIRED', 'BILLING_DISABLED'],
    [googleError(402, 'PAYMENT_REQUIRED'), 402, 'BILLING_REQUIRED', 'PAYMENT_REQUIRED'],
    // A daily quota is used up until it resets; a per-minute limit is a rate limit.
    [googleError(429, 'RESOURCE_EXHAUSTED', [quota('GenerateRequestsPerDayPerProjectPerModel')]), 429, 'QUOTA_EXHAUSTED', 'RESOURCE_EXHAUSTED'],
    [googleError(429, 'RESOURCE_EXHAUSTED', [quota('GenerateContentInputTokensPerModelPerMinute-PaidTier')]), 429, 'THROTTLED', 'RESOURCE_EXHAUSTED'],
    [googleError(429, 'RESOURCE_EXHAUSTED'), 429, 'THROTTLED', 'RESOURCE_EXHAUSTED'],
  ];
  for (const [payload, status, code, reason] of cases) {
    const { error, calls } = await failure(json(payload, status));
    assert.equal(calls, 1, `${code} ${reason}`);
    assert.ok(error instanceof ProviderError);
    assert.deepEqual([error.code, error.status, error.reason, error.submission], [code, status, reason, 'rejected']);
    assert.ok(definiteRejection(error), 'a refused call is certified as not run');
    const serialized = JSON.stringify(error) + String(error.message) + String(error.stack);
    assert.ok(!serialized.includes(PROMPT) && !serialized.includes(KEY) && !serialized.includes('Invalid value'), 'no body text is kept');
  }
});

test('a daily quota and billing refusal are not retried; a rate limit is', async () => {
  const retrying = { client: { settings: { attemptTimeoutMs: 200, totalTimeoutMs: 1000, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 } } };
  const daily = harness([json(googleError(429, 'RESOURCE_EXHAUSTED', [quota('GenerateRequestsPerDayPerProjectPerModel')]), 429)], retrying);
  await assert.rejects(daily.client.tutor(request()), e => e.code === 'QUOTA_EXHAUSTED' && definiteRejection(e)?.retryable === false);
  assert.equal(daily.calls.length, 1);
  const billing = harness([json(googleError(403, 'PERMISSION_DENIED', [info('BILLING_DISABLED')]), 403)], retrying);
  await assert.rejects(billing.client.tutor(request()), e => e.code === 'BILLING_REQUIRED');
  assert.equal(billing.calls.length, 1);
  const limited = harness([json(googleError(429, 'RESOURCE_EXHAUSTED'), 429), textResponse()], retrying);
  assert.equal((await limited.client.tutor(request())).output.text, 'A useful explanation.');
  assert.equal(limited.calls.length, 2);
});

test('an unreadable or hostile error body falls back to the status class with no reason', () => {
  for (const body of [undefined, 'text', { error: { status: 'not a code; see https://x' } }, { error: { status: 'A'.repeat(65) } },
    { error: { status: 'INVALID_ARGUMENT', details: [info('lower_case')] } }]) {
    const error = googleRefusal(400, body, undefined);
    assert.equal(error.code, 'UPSTREAM_REJECTED');
    assert.ok(error.reason === null || error.reason === 'INVALID_ARGUMENT', String(error.reason));
  }
  assert.equal(googleRefusal(503, googleError(503, 'UNAVAILABLE'), undefined).submission, 'unknown');
});

test('a streamed tutor reply keeps the refusal reason too', async () => {
  const h = harness([json(googleError(400, 'INVALID_ARGUMENT'), 400)], fast);
  await assert.rejects(h.client.tutorStream(request(), {}, () => {}), e => e.code === 'UPSTREAM_REJECTED' && e.reason === 'INVALID_ARGUMENT' && e.status === 400);
});

test('structured output still decodes after the request fix', async () => {
  const h = harness([textResponse(JSON.stringify(ASSESSMENT))]);
  assert.deepEqual((await h.client.assess({ ...request(), outputSchema: assessmentSchema })).output, ASSESSMENT);
});
