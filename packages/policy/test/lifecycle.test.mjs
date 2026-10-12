import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/index.js';
import { state, proposed, grant, proposal, cmd, authority, migration, hard, at, errorCode } from './helpers.mjs';

test('template revision cannot refill spent allowance, erase grants/work, reset anchors or remove scopes', () => {
  let s = state(i => { i.scopes[1].window = p.resolveCalendarWindow({ anchorId: 'chapter-clock', anchor: 'scope_assigned', anchorInstant: at(1), calendarDays: 16,
    timeZone: 'UTC', disambiguation: 'reject', pauseRule: 'approved_only' }); });
  s = proposed(s); s = p.grantExtension(s, grant(s)).state;
  s = p.reserveWork(s, cmd(s, 'reserve', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 10 } })).state;
  s = p.commitWork(s, cmd(s, 'commit', { reservationId: 'r', workId: 'work' })).state;
  const before = structuredClone(s);
  const scopes = structuredClone(s.scopes); scopes[1].targetDate = at(7);
  s = p.applyPolicyChange(s, migration(s, scopes)).state;
  assert.deepEqual(s.grants, before.grants);
  assert.deepEqual(s.reservations, before.reservations);
  assert.deepEqual(p.poolBalances(s), p.poolBalances(before));
  assert.deepEqual(s.scopes[1].window, before.scopes[1].window);
  assert.equal(p.resolveConstraints(s, 'chapter').effectiveDeadline, '2030-01-12T12:00:00Z');
  const reset = structuredClone(s.scopes); reset[1].window.anchorInstant = at(2);
  assert.throws(() => p.previewPolicyChange(s, { scopes: reset }), errorCode('RESET_FORBIDDEN'));
  assert.throws(() => p.previewPolicyChange(s, { scopes: s.scopes.filter(x => x.scopeId !== 'chapter') }), errorCode('RESET_FORBIDDEN'));
  assert.throws(() => p.applyPolicyChange(s, { ...migration(s), pools: [] }), errorCode('INVALID_INPUT'));
});

test('migration requires exact current impact review, retains promised grants and supersedes pending offers', () => {
  let s = proposed(); s = p.grantExtension(s, grant(s)).state; s = proposed(s, 'later');
  const scopes = structuredClone(s.scopes); scopes[1].hardDeadline = hard(9);
  const request = migration(s, scopes);
  assert.throws(() => p.applyPolicyChange(s, { ...request, previewDigest: 'old' }), errorCode('STALE_PREVIEW'));
  assert.throws(() => p.applyPolicyChange(s, { ...request, authorityReceipt: { ...request.authorityReceipt, permission: 'grant_extension' } }), errorCode('AUTHORITY_REQUIRED'));
  const result = p.applyPolicyChange(s, request);
  assert.equal(p.resolveConstraints(result.state, 'chapter').effectiveDeadline, '2030-01-12T12:00:00Z');
  assert.equal(result.state.offers.find(o => o.terms.offerId === 'later').state, 'superseded');
  assert.equal(result.state.migrations[0].authorityReceipt.permission, 'migrate_policy');
  assert.throws(() => p.grantExtension(result.state, grant(result.state, 'later')), errorCode('INVALID_OFFER_STATE'));
});

test('explicit reviewed deadline shortening is visible in impact and changes current commit checks', () => {
  const s = state(); const scopes = structuredClone(s.scopes); scopes[0].hardDeadline = hard(3);
  const preview = p.previewPolicyChange(s, { scopes });
  assert.equal(preview.impacts.find(i => i.scopeId === 'chapter').after.effectiveDeadline, at(3));
  const result = p.applyPolicyChange(s, migration(s, scopes)).state;
  assert.equal(p.checkAction(result, { scopeId: 'chapter', now: at(3), expectedPolicyRevision: result.policyRevision, kind: 'publish' }).allowed, false);
});

test('audited accommodation bypasses discretionary allowance and needs scoped authority', () => {
  const s = state(i => { i.scopes[1].extensions.enabled = false; i.pools.find(p => p.poolId === 'shared-days').total = 0; });
  const terms = { accommodationId: 'a', scopeId: 'chapter', reasonRef: 'approved-adjustment', kind: 'accommodation', change: { deadline: { kind: 'absolute', calendarDays: 2 } } };
  const preview = p.previewAccommodation(s, terms);
  const request = cmd(s, 'accommodate', { ...terms, previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'accommodate', preview.previewDigest, 'chapter') });
  const result = p.applyAccommodation(s, request);
  assert.deepEqual(p.poolBalances(result.state), p.poolBalances(s));
  assert.equal(result.state.accommodations.length, 1);
  assert.equal(result.state.grants.length, 0);
  assert.equal(p.resolveConstraints(result.state, 'chapter').effectiveDeadline, '2030-01-12T12:00:00Z');
  assert.equal(p.applyAccommodation(result.state, request).replayed, true);
  assert.throws(() => p.applyAccommodation(s, { ...request, authorityReceipt: { ...request.authorityReceipt, scopeId: 'course' } }), errorCode('AUTHORITY_REQUIRED'));
});

test('approved leave only adjusts a permitted relative window; absolute deadlines never move implicitly', () => {
  const s = state(i => { i.scopes[1].window = p.resolveCalendarWindow({ anchorId: 'clock', anchor: 'scope_assigned', anchorInstant: at(1), calendarDays: 6,
    timeZone: 'UTC', disambiguation: 'reject', pauseRule: 'approved_only' }); });
  const terms = { accommodationId: 'pause', scopeId: 'chapter', reasonRef: 'approved-leave', kind: 'approved_pause', change: { deadline: { kind: 'window', calendarDays: 2 } } };
  const preview = p.previewAccommodation(s, terms);
  const result = p.applyAccommodation(s, cmd(s, 'pause', { ...terms, previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'accommodate', preview.previewDigest, 'chapter') })).state;
  assert.equal(p.resolveConstraints(result, 'chapter').effectiveDeadline, '2030-01-09T12:00:00Z');
  assert.equal(result.scopes[1].hardDeadline.at, at(10));
  assert.equal(result.scopes[1].window.resolvedDeadline, '2030-01-07T12:00:00Z');
  assert.throws(() => p.previewAccommodation(s, { ...terms, change: { deadline: { kind: 'absolute', calendarDays: 1 } } }), errorCode('PAUSE_NOT_ALLOWED'));
  const never = structuredClone(s); never.scopes[1].window.pauseRule = 'never';
  assert.throws(() => p.previewAccommodation(never, terms), errorCode('PAUSE_NOT_ALLOWED'));
});

function close(s, coverage = [], demonstrated = []) {
  const input = { now: at(20), reason: 'cap', coveredObjectiveIds: coverage, demonstratedConceptIds: demonstrated };
  const preview = p.previewClosure(s, input);
  const request = cmd(s, 'close', { ...input, previewDigest: preview.previewDigest,
    authorityReceipt: authority(s, 'close_enrollment', preview.previewDigest) });
  return { result: p.closeEnrollment(s, request), request };
}

test('closure retains achieved work, reports gaps and stops expansion without manufacturing mastery', () => {
  let s = state();
  s = p.reserveWork(s, cmd(s, 'reserve', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 5 } })).state;
  s = p.commitWork(s, cmd(s, 'commit', { reservationId: 'r', workId: 'work' })).state;
  s = p.reserveWork(s, cmd(s, 'unused', { reservationId: 'unused', scopeId: 'chapter', work: { additionalMinutes: 5 } })).state;
  s = proposed(s);
  const { result, request } = close(s, ['objective-a'], ['concept-a']);
  assert.equal(result.state.status, 'closed');
  assert.equal(result.state.closure.coverage, 'partial'); assert.equal(result.state.closure.mastery, 'gaps');
  assert.deepEqual(result.state.closure.unprovenConceptIds, ['concept-b']);
  assert.deepEqual(result.state.closure.uncoveredObjectiveIds, ['objective-b']);
  assert.equal(result.state.reservations.find(r => r.reservationId === 'r').state, 'committed');
  assert.equal(result.state.reservations.find(r => r.reservationId === 'unused').state, 'cancelled');
  assert.equal(result.state.offers[0].state, 'superseded');
  assert.equal(result.state.closure.continuation, 'explicit_opt_in_separate_track');
  assert.equal(p.closeEnrollment(result.state, request).replayed, true);
  assert.equal(p.checkAction(result.state, { scopeId: 'course', now: at(21), expectedPolicyRevision: result.state.policyRevision, kind: 'read' }).allowed, true);
  assert.equal(p.checkAction(result.state, { scopeId: 'course', now: at(21), expectedPolicyRevision: result.state.policyRevision, kind: 'plan' }).allowed, false);
  assert.throws(() => p.proposeExtension(result.state, proposal(result.state, 'reopen', { now: at(21), expiresAt: at(25) })), errorCode('ENROLLMENT_INACTIVE'));
});

test('coverage and mastery remain independent, and exhausted allowance is not passing', () => {
  assert.equal(close(state(), ['objective-a', 'objective-b'], []).result.state.closure.mastery, 'gaps');
  assert.equal(close(state(), [], ['concept-a', 'concept-b']).result.state.closure.coverage, 'partial');
  assert.equal(close(state(), ['objective-a', 'objective-b'], ['concept-a', 'concept-b']).result.state.closure.mastery, 'demonstrated');
  assert.throws(() => p.previewClosure(state(), { now: at(2), reason: 'cap', coveredObjectiveIds: [], demonstratedConceptIds: [] }), errorCode('CAP_NOT_REACHED'));
  assert.throws(() => p.previewClosure(state(), { now: at(2), reason: 'completed', coveredObjectiveIds: [], demonstratedConceptIds: [] }), errorCode('INCOMPLETE_COVERAGE'));
  assert.throws(() => p.previewClosure(state(), { now: at(20), reason: 'cap', coveredObjectiveIds: [], demonstratedConceptIds: ['invented'] }), errorCode('INVALID_INPUT'));
});

test('on-time grading may finish after closure with a trusted receipt without reopening access or submissions', () => {
  const s = close(state()).result.state;
  const request = { scopeId: 'chapter', now: at(21), expectedPolicyRevision: s.policyRevision, kind: 'grade',
    submissionReceipt: { receiptId: 'submission', attemptId: 'attempt', enrollmentId: s.enrollmentId, scopeId: 'chapter', submittedAt: at(5), eligible: true, policyRevision: 1 } };
  assert.equal(p.checkAction(s, request).allowed, true);
  const noReceipt = { ...request }; delete noReceipt.submissionReceipt;
  assert.equal(p.checkAction(s, noReceipt).allowed, false);
  assert.equal(p.checkAction(s, { ...request, submissionReceipt: { ...request.submissionReceipt, enrollmentId: 'other' } }).allowed, false);
  assert.equal(p.checkAction(s, { scopeId: 'chapter', now: at(21), expectedPolicyRevision: s.policyRevision, kind: 'submit' }).allowed, false);
  assert.equal(s.status, 'closed');
  const accessClosed = close(state(i => { i.scopes[0].existingMaterialAccess = 'closed'; })).result.state;
  assert.equal(p.checkAction(accessClosed, { scopeId: 'chapter', now: at(21), expectedPolicyRevision: accessClosed.policyRevision, kind: 'read' }).allowed, false);
});

test('closed-after-cap access permits the lesson before its deadline and denies it at the exact cutoff', () => {
  const s = state(i => { i.scopes[0].existingMaterialAccess = 'closed'; });
  const read = now => p.checkAction(s, { scopeId: 'chapter', now, expectedPolicyRevision: s.policyRevision, kind: 'read' });
  assert.equal(read(at(2)).allowed, true);
  assert.equal(read(at(10)).allowed, false);
  assert.equal(read(at(21)).allowed, false);
});
test('optional concepts remain metered but do not become mandatory mastery requirements', () => {
  const s = state(input => { input.conceptIds.push('optional-concept'); input.requiredConceptIds = ['concept-a', 'concept-b']; });
  const result = p.previewClosure(s, { now: at(2), reason: 'completed', coveredObjectiveIds: ['objective-a', 'objective-b'], demonstratedConceptIds: ['concept-a', 'concept-b'] });
  assert.equal(result.report.mastery, 'demonstrated'); assert.deepEqual(result.report.unprovenConceptIds, []);
  assert.throws(() => state(input => { input.requiredConceptIds = ['invented']; }), errorCode('INVALID_INPUT'));
});

test('new scopes inherit retained ancestor usage and require a valid stored clock preview', () => {
  let s = state(i => { i.scopes[0].work.additionalMinutes = 10; });
  s = p.reserveWork(s, cmd(s, 'reserve', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 10 } })).state;
  s = p.commitWork(s, cmd(s, 'commit', { reservationId: 'r', workId: 'assigned' })).state;
  const newScope = { scopeId: 'new-activity', parentScopeId: 'course', policyId: 'new-policy', kind: 'activity', mode: 'bounded',
    window: p.resolveCalendarWindow({ anchorId: 'new-clock', anchor: 'scope_started', anchorInstant: at(2), calendarDays: 2,
      timeZone: 'UTC', disambiguation: 'reject', pauseRule: 'never' }) };
  const scopes = [...s.scopes, newScope];
  const result = p.applyPolicyChange(s, migration(s, scopes)).state;
  assert.throws(() => p.reserveWork(result, cmd(result, 'renamed', { reservationId: 'renamed', scopeId: 'new-activity', work: { additionalMinutes: 1 } })), errorCode('QUOTA_EXCEEDED'));
  const invalid = structuredClone(scopes); invalid.at(-1).window.resolvedDeadline = at(5);
  assert.throws(() => p.previewPolicyChange(s, { scopes: invalid }), errorCode('INVALID_CALENDAR_TIME'));
});
