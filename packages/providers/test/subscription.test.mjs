import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, ProviderRouter, ProviderError, subscriptionAdapter } from '../dist/index.js';

const now = Date.parse('2026-01-01T00:00:00Z'), later = '2026-01-01T00:01:00Z';
const request = () => ({ modelId: 'teacher', accounting: { accountingKey: 'op-1' }, messages: [{ role: 'user', text: 'Explain ordering.' }], maxOutputTokens: 100 });
function fixture({ fallback = false } = {}) {
  const calls = [], state = { status: { providerId: 'vendor', subscriptionRef: 'connection-1', entitlementRevision: 'rev-1', state: 'active',
    observedAt: '2026-01-01T00:00:00Z', expiresAt: later, quotas: [{ id: 'weekly', unit: 'credits', remaining: 2.5, resetsAt: later }] },
    disposition: 'included', configured: true, fallbackApproved: true };
  const usage = (r, operation) => ({ accounting: r.accounting, providerId: 'vendor', modelId: r.modelId, operation,
    attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 5, output: 3, total: 8, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
    inputCharacters: 17, requestedMaxOutputTokens: r.maxOutputTokens ?? null, requestedVideoSeconds: r.durationSeconds ?? null,
    observedImageCount: null, observedVideoCount: null, cost: null });
  function native(route) {
    const result = (r, op, output) => { calls.push([route, op]); return { output, usage: usage(r, op) }; };
    return { providerId: 'vendor', validateModel(m) { assert.equal(m.remoteModel, 'native/teacher'); }, ports: {
      tutoring: { async tutor(r) { return result(r, 'tutor', { text: route }); } },
      structured_assessment: { async assess(r) { return result(r, 'assess', { explanation: route }); } },
      research: { async research(r) { return result(r, 'research', { text: route, grounding: 'not_grounded', parts: [], sources: [], citations: [], searchQueries: [], searchSuggestionsHtml: null }); } },
      image: { async startImage(r) { return result(r, 'image', { state: 'completed', images: [], text: route }); } },
      video: {
        async startVideo(r) { return result(r, 'video_submit', { state: 'pending', job: { kind: 'video', providerId: 'vendor', modelId: r.modelId,
          registryRevision: 'r1', providerState: { ticket: route + '-ticket' }, accounting: r.accounting, requestedDurationSeconds: r.durationSeconds } }); },
        async pollVideo(job) { assert.equal(job.accessRoute, undefined); assert.equal(job.providerState.ticket, route + '-ticket');
          return result(job, 'video_poll', { state: 'completed', job, videos: [{ uri: 'https://example.invalid/result.webm', mimeType: 'video/webm' }] }); },
        async cancelVideo(job) { assert.equal(job.providerState.ticket, route + '-ticket'); return result(job, 'video_poll', { state: 'cancelled', job, remoteMayContinue: false }); },
      },
    } };
  }
  const primary = native('subscription'), paid = native('paid');
  const options = { adapter: primary, subscriptionRef: 'connection-1', now: () => now,
    applicationAccess: { supported: true, documentationUrl: 'https://provider.example.invalid/subscription-api', reviewedAt: '2026-01-01T00:00:00Z' },
    isConfigured: () => state.configured,
    async getStatus() { return structuredClone(state.status); },
    async authorize(call) { calls.push(['authorize', call]); return { providerId: call.providerId, subscriptionRef: call.subscriptionRef,
      entitlementRevision: call.entitlementRevision, accountingKey: call.accounting.accountingKey, operation: call.operation, modelId: call.modelId,
      disposition: state.disposition, validUntil: later }; },
    ...(fallback ? { automaticFallback: { enabled: true, adapter: paid, async authorize(call) {
      calls.push(['fallback_authorize', call]); return { authorizationId: 'host-reservation-1', providerId: call.providerId, subscriptionRef: call.subscriptionRef,
        modelId: call.modelId, accountingKey: call.accounting.accountingKey, operation: call.operation, approved: state.fallbackApproved, validUntil: later };
    } } } : {}),
  };
  const adapter = subscriptionAdapter(options), registry = new ModelRegistry({ revision: 'r1', models: [{ id: 'teacher', providerId: 'vendor', remoteModel: 'native/teacher',
    providerConfig: {}, enabled: true, capabilities: ['tutoring', 'structured_assessment', 'research', 'image', 'video'], tools: [],
    limits: { maxInputCharacters: 10000, maxOutputTokens: 1000 } }] });
  registry.registerAdapter(adapter);
  return { state, calls, options, adapter, primary, paid, router: new ProviderRouter(registry) };
}
const code = expected => error => error.code === expected;

test('subscription dispatch uses existing neutral ports and preserves usage rather than inventing free costs', async () => {
  const f = fixture(), r = request(), result = await f.router.tutor(r);
  assert.equal(result.output.text, 'subscription'); assert.equal(result.usage.cost, null); assert.equal(result.usage.attempts[0].tokens.total, 8);
  assert.deepEqual(result.usage.access, { kind: 'subscription', subscriptionRef: 'connection-1', entitlementRevision: 'rev-1', overageAllowed: false });
  assert.equal(f.calls[0][1].overageAllowed, false); assert.deepEqual(f.calls[0][1].accounting, r.accounting);
  assert.equal(f.adapter.access.automaticFallbackEnabled, false);
  await f.router.assess({ ...r, outputSchema: { type: 'object', properties: { explanation: { type: 'string' } }, required: ['explanation'] } });
  await f.router.research(r); await f.router.startImage({ modelId: r.modelId, accounting: r.accounting, prompt: 'A diagram', maxOutputTokens: 100 });
  assert.deepEqual(f.calls.filter(c => c[0] === 'subscription').map(c => c[1]), ['tutor', 'assess', 'research', 'image']);
});

for (const [state, expected] of [['expired', 'SUBSCRIPTION_EXPIRED'], ['revoked', 'AUTHENTICATION'], ['sign_in_required', 'AUTHENTICATION'],
  ['quota_exhausted', 'SUBSCRIPTION_QUOTA_EXHAUSTED'], ['unavailable', 'UPSTREAM_UNAVAILABLE']]) {
  test(`default-off fallback stops ${state} before a native generation`, async () => {
    const f = fixture(); f.state.status.state = state;
    await assert.rejects(f.router.tutor(request()), code(expected)); assert.equal(f.calls.length, 0);
  });
}
test('stale, future, crossed and secret-bearing status/authorization are rejected before dispatch', async () => {
  for (const patch of [{ observedAt: '2025-12-31T23:58:00Z' }, { observedAt: later }, { subscriptionRef: 'other-account' },
    { providerId: 'other-provider' }, { credential: 'SECRET_CANARY' }, { quotas: [{ id: 'q', unit: 'tokens', remaining: -1, resetsAt: null }] }]) {
    const f = fixture({ fallback: true }); Object.assign(f.state.status, patch);
    await assert.rejects(f.router.tutor(request()), code('INVALID_RESPONSE')); assert.equal(f.calls.length, 0);
  }
  for (const field of ['accountingKey', 'entitlementRevision', 'modelId', 'operation']) {
    const f = fixture(), native = f.options.authorize;
    f.options.authorize = async call => ({ ...await native(call), [field]: 'different' });
    // New instance snapshots the callbacks; this is provider fixture corruption.
    const bad = subscriptionAdapter(f.options);
    await assert.rejects(bad.ports.tutoring.tutor(request()), code('INVALID_RESPONSE'));
    assert.equal(f.calls.filter(c => c[0] === 'subscription').length, 0);
  }
});
test('known expiry and additional-charge admission stop even when reported state remains active', async () => {
  const f = fixture(); f.state.status.expiresAt = f.state.status.observedAt;
  await assert.rejects(f.router.tutor(request()), code('SUBSCRIPTION_EXPIRED'));
  f.state.status.expiresAt = later; f.state.disposition = 'overage_required';
  await assert.rejects(f.router.tutor(request()), code('SUBSCRIPTION_OVERAGE_REQUIRED'));
  assert.equal(f.calls.filter(c => c[0] === 'subscription').length, 0);
});
test('explicit opt-in uses paid fallback only after a fresh host consent/budget authorization', async () => {
  const f = fixture({ fallback: true }); f.state.status.state = 'quota_exhausted';
  const result = await f.router.tutor(request()); assert.equal(result.output.text, 'paid');
  assert.equal(result.usage.access.kind, 'api_key_fallback'); assert.equal(result.usage.access.reason, 'SUBSCRIPTION_QUOTA_EXHAUSTED');
  assert.equal(result.usage.access.authorizationId, 'host-reservation-1'); assert.equal(result.usage.cost, null);
  assert.deepEqual(f.calls.map(c => c[0]), ['fallback_authorize', 'paid']);
  f.state.fallbackApproved = false;
  await assert.rejects(f.router.tutor(request()), code('PERMISSION_DENIED'));
  assert.equal(f.calls.filter(c => c[0] === 'paid').length, 1);
});
test('fallback authorization errors are sanitized and cannot spend through a stale or crossed grant', async () => {
  for (const patch of [{validUntil:'2025-12-31T23:59:00Z'},{accountingKey:'other-operation'},{modelId:'other-model'},{subscriptionRef:'other-subscription'}]) {
    const f=fixture({fallback:true});f.state.status.state='quota_exhausted';const authorize=f.options.automaticFallback.authorize;
    f.options.automaticFallback.authorize=async(call,options)=>({...await authorize(call,options),...patch});
    await assert.rejects(subscriptionAdapter(f.options).ports.tutoring.tutor(request()),code('INVALID_RESPONSE'));
    assert.equal(f.calls.filter(c=>c[0]==='paid').length,0);
  }
  const f=fixture({fallback:true});f.state.status.state='quota_exhausted';
  f.options.automaticFallback.authorize=async()=>{throw Error('FALLBACK_SECRET_CANARY');};
  await assert.rejects(subscriptionAdapter(f.options).ports.tutoring.tutor(request()),e=>{assert.equal(e.code,'NETWORK_ERROR');assert(!JSON.stringify(e).includes('FALLBACK_SECRET_CANARY'));return true;});
  assert.equal(f.calls.filter(c=>c[0]==='paid').length,0);
});
test('submitted failures preserve uncertain usage and never fall back or retry', async () => {
  const f = fixture({ fallback: true }); let attempts = 0;
  f.options.adapter = { ...f.primary, ports: { ...f.primary.ports, tutoring: { async tutor(r) {
    attempts++; const error = new ProviderError('UPSTREAM_UNAVAILABLE', { submission: 'unknown' });
    error.usage = (await f.primary.ports.tutoring.tutor(r)).usage; throw error;
  } } } };
  const adapter = subscriptionAdapter(f.options);
  await assert.rejects(adapter.ports.tutoring.tutor(request()), e => { assert.equal(e.submission, 'unknown'); assert.equal(e.usage.access.kind, 'subscription'); return true; });
  assert.equal(attempts, 1); assert.equal(f.calls.filter(c => c[0] === 'paid' || c[0] === 'fallback_authorize').length, 0);
});
test('authorization owns atomic quota admission, not a cached positive remaining count', async () => {
  const f = fixture(); let remaining = 1;
  f.options.authorize = async call => { if (remaining-- <= 0) throw new ProviderError('SUBSCRIPTION_QUOTA_EXHAUSTED');
    return { providerId: call.providerId, subscriptionRef: call.subscriptionRef, entitlementRevision: call.entitlementRevision,
      accountingKey: call.accounting.accountingKey, modelId: call.modelId, operation: call.operation, disposition: 'included', validUntil: later }; };
  const adapter = subscriptionAdapter(f.options), outcomes = await Promise.allSettled([adapter.ports.tutoring.tutor(request()), adapter.ports.tutoring.tutor({ ...request(), accounting: { accountingKey: 'op-2' } })]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.calls.filter(c => c[0] === 'subscription').length, 1);
});
test('pre-abort and stalled admission honor the deadline without dispatch, fallback or secret leakage', async () => {
  const f = fixture({ fallback: true }), c = new AbortController(); c.abort('SECRET_ABORT_REASON');
  await assert.rejects(f.router.tutor(request(), { signal: c.signal }), code('CANCELLED')); assert.equal(f.calls.length, 0);
  f.options.getStatus = async () => new Promise(() => {});
  const slow = subscriptionAdapter(f.options);
  await assert.rejects(slow.ports.tutoring.tutor(request(), { timeoutMs: 10 }), e => { assert.equal(e.code, 'TIMEOUT'); assert.equal(e.submission, 'not_sent'); return true; });
  f.options.getStatus = async () => { throw Error('SECRET_CANARY'); };
  await assert.rejects(subscriptionAdapter(f.options).status(), e => { assert(!JSON.stringify(e).includes('SECRET_CANARY')); return true; });
});
test('pending video route survives polling/cancellation and never changes the backend of an existing job', async () => {
  for (const fallback of [false, true]) {
    const f = fixture({ fallback }); if (fallback) f.state.status.state = 'quota_exhausted';
    const r = request(), result = await f.router.startVideo({ modelId: r.modelId, accounting: r.accounting, prompt: 'A diagram', durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' });
    assert.equal(result.output.state, 'pending'); const job = result.output.job;
    assert.equal(job.accessRoute.route, fallback ? 'fallback' : 'subscription');
    if (fallback) f.state.status.state = 'active';
    assert.equal((await f.router.pollVideo(job)).output.state, 'completed');
    assert.equal((await f.router.cancelVideo(job)).output.state, 'cancelled');
    assert.equal(f.calls.filter(c => c[0] === (fallback ? 'subscription' : 'paid')).length, 0);
    await assert.rejects(f.router.pollVideo({ ...job, accessRoute: { ...job.accessRoute, subscriptionRef: 'wrong' } }), code('INVALID_INPUT'));
  }
  const f = fixture({ fallback: true }), r = request(), result = await f.router.startVideo({ modelId: r.modelId, accounting: r.accounting, prompt: 'A diagram', durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' });
  f.state.status.state = 'quota_exhausted'; await assert.rejects(f.router.pollVideo(result.output.job), code('SUBSCRIPTION_QUOTA_EXHAUSTED'));
  assert.equal(f.calls.filter(c => c[0] === 'paid').length, 0);
});
test('unsupported application access and mismatched fallback provider cannot register', () => {
  const f = fixture(); assert.throws(() => subscriptionAdapter({ ...f.options, applicationAccess: { ...f.options.applicationAccess, supported: false } }), code('INVALID_CONFIG'));
  assert.throws(() => subscriptionAdapter({ ...f.options, automaticFallback: { enabled: true, adapter: { ...f.paid, providerId: 'other' }, authorize: async () => {} } }), code('INVALID_CONFIG'));
});
