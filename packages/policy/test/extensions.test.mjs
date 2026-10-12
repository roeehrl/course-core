import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/index.js';
import { state, proposed, proposal, acceptance, grant, cmd, authority, hard, at, errorCode, deepFreeze, migration } from './helpers.mjs';

test('proposal contains complete exact disclosures and consumes no allowance', () => {
  const original = deepFreeze(state());
  const after = p.proposeExtension(original, proposal(original));
  const offer = after.state.offers[0];
  assert.equal(offer.terms.currentEffectiveDeadline, at(10));
  assert.equal(offer.terms.proposedEffectiveDeadline, '2030-01-12T12:00:00Z');
  assert.deepEqual(offer.terms.balanceBefore, [{ poolId: 'shared-days', remaining: 4, grantsRemaining: 2 }]);
  assert.deepEqual(offer.terms.balanceAfter, [{ poolId: 'shared-days', remaining: 2, grantsRemaining: 1 }]);
  assert.deepEqual(offer.terms.bindingAncestorCaps, [{ scopeId: 'course', kind: 'absolute', at: at(20) }]);
  assert.equal(offer.termsDigest.length, 64);
  assert.deepEqual(p.poolBalances(after.state), p.poolBalances(original));
  assert.equal(after.state.policyRevision, original.policyRevision);
  assert.equal(after.state.audit.length, 1);
});

test('child requests beyond parent are rejected without debit; clipped terms need new consent', () => {
  const s = state(i => { i.scopes[0].hardDeadline = hard(11); });
  assert.throws(() => p.proposeExtension(s, proposal(s)), errorCode('PARENT_CAP_CONFLICT'));
  const clipped = proposed(s, 'clipped', { change: { deadline: { kind: 'absolute', calendarDays: 1 } }, poolDebits: [{ poolId: 'shared-days', amount: 1 }] });
  const granted = p.grantExtension(clipped, grant(clipped, 'clipped')).state;
  assert.equal(p.resolveConstraints(granted, 'chapter').effectiveDeadline, '2030-01-11T12:00:00Z');
  assert.equal(p.resolveConstraints(granted, 'course').effectiveDeadline, at(11));
  assert.equal(p.poolBalances(granted).find(b => b.poolId === 'course-days').remaining, 6);
});

test('another local cap and ultimate ceiling also prohibit ineffective or excessive extensions', () => {
  const s = state(i => { i.scopes[1].ultimateDeadline = at(11); });
  assert.throws(() => p.proposeExtension(s, proposal(s)), errorCode('PARENT_CAP_CONFLICT'));
  const capped = state(i => {
    i.scopes[1].window = p.resolveCalendarWindow({ anchorId: 'clock', anchor: 'scope_assigned', anchorInstant: at(2), calendarDays: 8,
      timeZone: 'UTC', disambiguation: 'reject', pauseRule: 'never' });
  });
  assert.throws(() => p.proposeExtension(capped, proposal(capped)), errorCode('PARENT_CAP_CONFLICT'));
});

test('grant atomically describes debit, revision, receipt and audit; it never increases work implicitly', () => {
  const s = deepFreeze(proposed());
  const result = p.grantExtension(s, grant(s));
  assert.equal(result.state.policyRevision, 2);
  assert.equal(result.state.ledgerRevision, 2);
  assert.equal(result.state.grants.length, 1);
  assert.equal(result.state.offers[0].state, 'granted');
  assert.equal(result.state.audit.at(-1).operation, 'grant_extension');
  assert.equal(result.state.grants[0].atomicLedgerTransactionId, 'transaction-offer');
  assert.deepEqual(result.state.scopes, s.scopes);
  assert.deepEqual(p.resolveConstraints(result.state, 'chapter').quotas, p.resolveConstraints(s, 'chapter').quotas);
  assert.equal(p.poolBalances(result.state).find(b => b.poolId === 'shared-days').remaining, 2);
  assert.equal(s.grants.length, 0);
});

test('retry after timeout returns the original receipt without debit, even after expiry and another revision', () => {
  const s = proposed(); const request = grant(s);
  let result = p.grantExtension(s, request);
  result = p.applyPolicyChange(result.state, migration(result.state));
  const replay = p.grantExtension(result.state, { ...request, now: at(25), atomicLedgerTransactionId: 'new-retry-transaction' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.policyRevision, 2);
  assert.equal(replay.state.policyRevision, 3);
  assert.equal(replay.state.grants.length, 1);
  assert.equal(replay.state.grants[0].atomicLedgerTransactionId, 'transaction-offer');
  assert.deepEqual(replay.state, result.state);
});

test('duplicate offer grant with a new key and idempotency-key reuse for different terms are rejected', () => {
  const s = proposed(); const request = grant(s);
  const granted = p.grantExtension(s, request).state;
  assert.throws(() => p.grantExtension(granted, grant(granted, 'offer', { idempotencyKey: 'another', grantId: 'another', atomicLedgerTransactionId: 'another' })), errorCode('DUPLICATE_GRANT'));
  assert.throws(() => p.grantExtension(granted, { ...request, grantId: 'changed' }), errorCode('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => p.proposeExtension(granted, proposal(granted, 'different', { idempotencyKey: request.idempotencyKey })), errorCode('IDEMPOTENCY_CONFLICT'));
});

test('competing accepted offers revalidated against fresh state cannot consume the same final allowance', () => {
  let s = state(i => { i.pools.find(p => p.poolId === 'shared-days').total = 2; });
  s = proposed(s, 'a'); s = proposed(s, 'b', { scopeId: 'sibling' });
  const a = grant(s, 'a'), b = grant(s, 'b');
  const first = p.grantExtension(s, a);
  assert.throws(() => p.grantExtension(first.state, b), errorCode('STALE_POLICY_REVISION'));
  assert.throws(() => p.grantExtension(first.state, { ...b, expectedPolicyRevision: first.state.policyRevision, expectedLedgerRevision: first.state.ledgerRevision }), errorCode('STALE_OFFER'));
  assert.throws(() => p.proposeExtension(first.state, proposal(first.state, 'replacement', { scopeId: 'sibling' })), errorCode('ALLOWANCE_EXHAUSTED'));
  assert.equal(p.poolBalances(first.state).find(p => p.poolId === 'shared-days').remaining, 0);
  // Same-input branches are both possible for a pure function. These identical
  // preconditions are what the integrating database MUST serialize or CAS.
  const alternative = p.grantExtension(s, b);
  assert.deepEqual(alternative.preconditions, first.preconditions);
});

test('allowance total, grant count, per-grant limits and scope eligibility are independent', () => {
  for (const [mutate, code] of [
    [i => i.pools.find(p => p.poolId === 'shared-days').total = 1, 'ALLOWANCE_EXHAUSTED'],
    [i => i.pools.find(p => p.poolId === 'shared-days').maxGrants = 0, 'ALLOWANCE_EXHAUSTED'],
    [i => i.pools.find(p => p.poolId === 'shared-days').maxPerGrant = 1, 'PER_GRANT_LIMIT'],
    [i => i.scopes[0].extensions.enabled = false, 'EXTENSIONS_DISABLED'],
    [i => i.scopes[1].extensions.enabled = false, 'EXTENSIONS_DISABLED'],
  ]) {
    const s = state(mutate);
    assert.throws(() => p.proposeExtension(s, proposal(s)), errorCode(code));
  }
  const s = state();
  for (const [poolDebits, code] of [
    [[{ poolId: 'course-days', amount: 2 }], 'POOL_NOT_ALLOWED'],
    [[{ poolId: 'missing', amount: 2 }], 'POOL_NOT_ALLOWED'],
    [[{ poolId: 'shared-days', amount: 1 }], 'DEBIT_MISMATCH'],
    [[{ poolId: 'shared-days', amount: 1 }, { poolId: 'shared-days', amount: 1 }], 'INVALID_INPUT'],
  ]) assert.throws(() => p.proposeExtension(s, proposal(s, 'offer', { poolDebits })), errorCode(code));
});

test('silence, false or unrelated consent cannot grant; exact affirmative acceptance can wait for administration', () => {
  const s = proposed();
  const noConsent = grant(s); delete noConsent.acceptance;
  assert.throws(() => p.grantExtension(s, noConsent), errorCode('CONSENT_REQUIRED'));
  for (const change of [{ learnerId: 'someone-else' }, { enrollmentId: 'other' }, { offerId: 'other' }, { termsDigest: 'old-terms' }, { acceptedAt: at(1) }, { acceptedAt: at(4) }]) {
    assert.throws(() => p.grantExtension(s, grant(s, 'offer', { acceptance: acceptance(s, 'offer', change) })), errorCode('CONSENT_REQUIRED'));
  }
  assert.throws(() => p.grantExtension(s, grant(s, 'offer', { acceptance: acceptance(s, 'offer', { explicit: false }) })), errorCode('INVALID_INPUT'));
  const accepted = p.acceptExtension(s, cmd(s, 'accept', { offerId: 'offer', acceptance: acceptance(s) })).state;
  assert.equal(accepted.offers[0].state, 'accepted_pending_admin');
  assert.deepEqual(p.poolBalances(accepted), p.poolBalances(s));
  const request = grant(accepted); delete request.acceptance;
  assert.equal(p.grantExtension(accepted, request).state.grants.length, 1);
});

test('authority requirements are inherited and bound to scope, enrollment, permission and terms', () => {
  let s = state(i => { i.scopes[0].extensions.requiredAuthorityIds = ['admin']; i.scopes[1].extensions.requiredAuthorityIds = ['reviewer']; });
  s = proposed(s);
  assert.deepEqual(s.offers[0].terms.requiredApprovals, ['admin', 'reviewer']);
  assert.throws(() => p.grantExtension(s, grant(s)), errorCode('AUTHORITY_REQUIRED'));
  const terms = s.offers[0].termsDigest;
  const receipts = [authority(s, 'grant_extension', terms, 'chapter'), authority(s, 'grant_extension', terms, 'chapter', { actorId: 'reviewer', receiptId: 'reviewer-receipt' })];
  for (const patch of [{ scopeId: 'course' }, { enrollmentId: 'other' }, { permission: 'accommodate' }, { termsDigest: 'stale' }, { authorizedAt: at(3) }]) {
    assert.throws(() => p.grantExtension(s, grant(s, 'offer', { authorityReceipts: [{ ...receipts[0], ...patch }, receipts[1]] })), errorCode('AUTHORITY_REQUIRED'));
  }
  assert.equal(p.grantExtension(s, grant(s, 'offer', { authorityReceipts: receipts })).state.grants.length, 1);
});

test('decline and expiry consume nothing and prevent grants; decline starts a cooldown', () => {
  let s = state(i => { i.scopes[1].extensions.offerCooldownHours = 24; });
  s = proposed(s);
  s = p.disposeOffer(s, cmd(s, 'decline', { offerId: 'offer', state: 'declined', learnerId: 'learner', now: at(4) })).state;
  assert.throws(() => p.proposeExtension(s, proposal(s, 'again', { now: at(4), expiresAt: at(6) })), errorCode('OFFER_COOLDOWN'));
  assert.throws(() => p.grantExtension(s, grant(s, 'offer', { now: at(4) })), errorCode('INVALID_OFFER_STATE'));
  assert.equal(p.poolBalances(s).find(p => p.poolId === 'shared-days').remaining, 4);
  const pending = proposed();
  assert.throws(() => p.grantExtension(pending, grant(pending, 'offer', { now: at(5) })), errorCode('OFFER_EXPIRED'));
  assert.throws(() => p.disposeOffer(pending, cmd(pending, 'expire', { offerId: 'offer', state: 'expired' })), errorCode('INVALID_TIME'));
  const expired = p.disposeOffer(pending, cmd(pending, 'expire', { offerId: 'offer', state: 'expired', now: at(5) })).state;
  assert.equal(expired.offers[0].state, 'expired');
  assert.equal(expired.grants.length, 0);
});

test('outstanding and lifetime offer limits prevent repeated pressure', () => {
  let s = state(i => { i.scopes[1].extensions.maxOutstandingOffersPerScope = 1; i.scopes[1].extensions.maxOffersPerScope = 1; });
  s = proposed(s);
  assert.throws(() => p.proposeExtension(s, proposal(s, 'two')), errorCode('OFFER_FREQUENCY_LIMIT'));
  s = p.disposeOffer(s, cmd(s, 'decline', { offerId: 'offer', state: 'declined', learnerId: 'learner' })).state;
  assert.throws(() => p.proposeExtension(s, proposal(s, 'two')), errorCode('OFFER_FREQUENCY_LIMIT'));
  const outstanding = proposed(state(i => { i.scopes[1].extensions.maxOutstandingOffersPerScope = 1; }));
  assert.throws(() => p.proposeExtension(outstanding, proposal(outstanding, 'two')), errorCode('OUTSTANDING_OFFER_LIMIT'));
});

test('work extensions require exact named pool costs and cannot weaken parent quotas', () => {
  const s = state();
  const overrides = { change: { work: { additionalMinutes: 20, additionalEpisodes: 2 } }, poolDebits: [{ poolId: 'minutes', amount: 20 }, { poolId: 'episodes', amount: 2 }] };
  const offered = proposed(s, 'work', overrides);
  assert.equal(offered.offers[0].terms.currentWorkQuotas.find(q => q.scopeId === 'chapter' && q.metric === 'additionalMinutes').limit, 60);
  assert.equal(offered.offers[0].terms.proposedWorkQuotas.find(q => q.scopeId === 'chapter' && q.metric === 'additionalMinutes').limit, 80);
  assert.equal(offered.offers[0].terms.proposedWorkQuotas.find(q => q.scopeId === 'course' && q.metric === 'additionalMinutes').limit, 120);
  const granted = p.grantExtension(offered, grant(offered, 'work')).state;
  const limits = p.resolveConstraints(granted, 'chapter').quotas;
  assert.equal(limits.find(q => q.scopeId === 'chapter' && q.metric === 'additionalMinutes').limit, 80);
  assert.equal(limits.find(q => q.scopeId === 'chapter' && q.metric === 'additionalEpisodes').limit, 8);
  assert.equal(p.resolveConstraints(granted, 'chapter').effectiveDeadline, at(10));
  const capped = state(i => { i.scopes[0].work.additionalMinutes = 70; });
  assert.throws(() => p.proposeExtension(capped, proposal(capped, 'work', overrides)), errorCode('PARENT_CAP_CONFLICT'));
});

test('changed disclosed parent quota balances require revised terms even when the new plan still fits', () => {
  let s = proposed();
  s = p.reserveWork(s, cmd(s, 'sibling-work', { reservationId: 'sibling-work', scopeId: 'sibling', work: { additionalMinutes: 1 } })).state;
  assert.throws(() => p.grantExtension(s, grant(s)), errorCode('TERMS_CHANGED'));
});

test('proposed work must fit after extension, and changed work reservations are revalidated at acceptance', () => {
  let s = proposed();
  s = p.reserveWork(s, cmd(s, 'consume', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 60 } })).state;
  assert.throws(() => p.grantExtension(s, grant(s)), errorCode('INFEASIBLE_WORK'));
  const initial = state();
  assert.throws(() => p.proposeExtension(initial, proposal(initial, 'huge', { addedWork: { additionalMinutes: 61 } })), errorCode('INFEASIBLE_WORK'));
});

test('tampered offers, unknown states, missing disclosures and empty changes fail closed', () => {
  const s = state();
  for (const patch of [{ change: {} }, { alternatives: [] }, { rationaleEvidenceRefs: [] }, { change: { deadline: { kind: 'unknown', calendarDays: 2 } } }, { expiresAt: at(1) }]) {
    assert.throws(() => p.proposeExtension(s, proposal(s, 'offer', patch)), p.PolicyError);
  }
  const tampered = proposed(); tampered.offers[0].terms.planImpact = 'Different plan';
  assert.throws(() => p.grantExtension(tampered, grant(tampered)), errorCode('TERMS_CHANGED'));
  const malformed = proposed(); malformed.offers[0].state = 'accepted-by-silence';
  assert.throws(() => p.grantExtension(malformed, grant(malformed)), errorCode('INVALID_INPUT'));
});

test('children cannot weaken ancestor cooldown or outstanding-offer limits', () => {
  let s = state(i => { i.scopes[0].extensions.offerCooldownHours = 48; });
  s = proposed(s);
  assert.throws(() => p.proposeExtension(s, proposal(s, 'second', { now: at(3) })), errorCode('OFFER_COOLDOWN'));
  let limited = state(i => { i.scopes[0].extensions.maxOutstandingOffersPerScope = 1; });
  limited = proposed(limited);
  assert.throws(() => p.proposeExtension(limited, proposal(limited, 'second')), errorCode('OUTSTANDING_OFFER_LIMIT'));
});

test('rejection and supersession require offer-management authority and retain ledger history', () => {
  const s = proposed();
  for (const target of ['rejected', 'superseded']) {
    const request = cmd(s, `dispose-${target}`, { offerId: 'offer', state: target });
    assert.throws(() => p.disposeOffer(s, request), errorCode('AUTHORITY_REQUIRED'));
    const result = p.disposeOffer(s, { ...request, authorityReceipt: authority(s, 'manage_offers', s.offers[0].termsDigest, 'chapter') });
    assert.equal(result.state.offers[0].state, target);
    assert.deepEqual(p.poolBalances(result.state), p.poolBalances(s));
    assert.equal(result.state.audit.length, s.audit.length + 1);
    assert.equal(result.state.grants.length, 0);
  }
});

test('sequential shared-pool grants consume units and counts exactly once per grant', () => {
  let s = proposed(); s = p.grantExtension(s, grant(s)).state;
  s = proposed(s, 'second', { scopeId: 'sibling' });
  const request = grant(s, 'second');
  s = p.grantExtension(s, request).state;
  assert.deepEqual(p.poolBalances(s).find(b => b.poolId === 'shared-days'), { poolId: 'shared-days', remaining: 0, grantsRemaining: 0 });
  assert.deepEqual(p.grantExtension(s, request).state, s);
  assert.throws(() => p.proposeExtension(s, proposal(s, 'third')), errorCode('ALLOWANCE_EXHAUSTED'));
});
