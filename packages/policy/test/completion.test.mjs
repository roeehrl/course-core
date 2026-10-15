import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/index.js';
import { state, proposed, grant, cmd, authority, migration, hard, at, NOW, errorCode, deepFreeze } from './helpers.mjs';

const granted = (s = state()) => { const offered = proposed(s); return p.grantExtension(offered, grant(offered)).state; };
const core = (minutes) => [
  { workId: 'episode-1', scopeId: 'chapter', purpose: 'core', estimatedMinutes: minutes },
  { workId: 'episode-2', scopeId: 'sibling', purpose: 'core', estimatedMinutes: minutes },
  { workId: 'final', scopeId: 'course', purpose: 'final_assessment', estimatedMinutes: minutes },
];

test('P18: feasibility discloses a passed deadline without offering gaps or weaker mastery', () => {
  const s = state();
  const result = p.checkFeasibility(s, { now: at(11), requiredWork: core(30) });
  assert.equal(result.feasible, false);
  assert.equal(result.masteryCriteria, 'unchanged');
  assert.deepEqual(result.issues.filter(i => i.severity === 'error').map(i => [i.code, i.scopeId]),
    [['DEADLINE_ALREADY_REACHED', 'chapter'], ['DEADLINE_ALREADY_REACHED', 'sibling']]);
  assert.deepEqual(result.alternatives, ['authorized_policy_change', 'choose_a_smaller_goal']);
  assert.ok(!result.alternatives.some(a => /mastery|criteria|skip/u.test(a)));
});

test('P18: an estimated core path that does not fit the pace is infeasible with exact minutes and an allowed extension', () => {
  const s = state();
  // 8 whole days to the chapter deadline at 30 minutes a day = 240 minutes; the chapter needs 300.
  const result = p.checkFeasibility(s, { now: NOW, requiredWork: core(300), pace: { studyMinutesPerDay: 30 } });
  assert.equal(result.feasible, false);
  const chapter = result.issues.find(i => i.code === 'TIME_ENVELOPE_TOO_SMALL' && i.scopeId === 'chapter');
  assert.deepEqual([chapter.neededMinutes, chapter.availableMinutes, chapter.workIds], [300, 240, ['episode-1']]);
  const course = result.issues.find(i => i.code === 'TIME_ENVELOPE_TOO_SMALL' && i.scopeId === 'course');
  assert.deepEqual([course.neededMinutes, course.availableMinutes], [900, 540]);
  assert.deepEqual(result.alternatives, ['request_allowed_extension', 'authorized_policy_change', 'continue_with_documented_gaps', 'choose_a_smaller_goal']);
  const fits = p.checkFeasibility(s, { now: NOW, requiredWork: core(60), pace: { studyMinutesPerDay: 30 } });
  assert.equal(fits.feasible, true);
  assert.deepEqual(fits.alternatives, []);
  assert.ok(!fits.issues.some(i => i.code === 'TIME_FIT_UNCHECKED'));
});

test('feasibility without a pace or estimate checks only deadlines and says so; a looser child deadline is flagged', () => {
  const s = state(i => { i.scopes[1].hardDeadline = hard(25); });
  const result = p.checkFeasibility(s, { now: NOW, requiredWork: [{ workId: 'episode-1', scopeId: 'chapter', purpose: 'core' }] });
  assert.equal(result.feasible, true);
  assert.deepEqual(result.issues.map(i => [i.severity, i.code, i.scopeId]),
    [['warning', 'TIME_FIT_UNCHECKED', 'course'], ['warning', 'LOOSER_CHILD_DEADLINE', 'chapter']]);
  // Known estimates are a lower bound: exceeding the envelope with them alone is already infeasible.
  const partial = p.checkFeasibility(s, { now: NOW, pace: { studyMinutesPerDay: 10 },
    requiredWork: [{ workId: 'a', scopeId: 'sibling', purpose: 'core', estimatedMinutes: 500 }, { workId: 'b', scopeId: 'sibling', purpose: 'final_assessment' }] });
  assert.equal(partial.feasible, false);
  assert.deepEqual(partial.issues.filter(i => i.severity === 'error').map(i => [i.code, i.scopeId, i.neededMinutes, i.availableMinutes]),
    [['TIME_ENVELOPE_TOO_SMALL', 'course', 500, 180], ['TIME_ENVELOPE_TOO_SMALL', 'sibling', 500, 80]]);
  assert.ok(partial.issues.some(i => i.code === 'TIME_FIT_UNCHECKED' && i.workIds.includes('b')));
  assert.throws(() => p.checkFeasibility(s, { now: NOW, requiredWork: [] }), errorCode('INVALID_INPUT'));
  assert.throws(() => p.checkFeasibility(s, { now: NOW, requiredWork: [{ workId: 'x', scopeId: 'missing', purpose: 'core' }] }), errorCode('UNKNOWN_SCOPE'));
});

test('revocation is previewed, authorized, keeps usage and restores the earlier deadline', () => {
  const s = deepFreeze(granted());
  assert.equal(p.resolveConstraints(s, 'chapter').effectiveDeadline, at(12));
  const preview = p.previewRevocation(s, { grantId: 'grant-offer', reasonRef: 'ticket-1' });
  assert.equal(preview.shortensDeadline, true);
  assert.equal(preview.allowanceRefunded, false);
  const request = cmd(s, 'revoke', { grantId: 'grant-offer', reasonRef: 'ticket-1', previewDigest: preview.previewDigest,
    authorityReceipt: authority(s, 'revoke_extension', preview.previewDigest, 'chapter') });
  assert.throws(() => p.revokeGrant(s, { ...request, authorityReceipt: authority(s, 'grant_extension', preview.previewDigest, 'chapter') }), errorCode('AUTHORITY_REQUIRED'));
  assert.throws(() => p.revokeGrant(s, { ...request, previewDigest: 'stale' }), errorCode('STALE_PREVIEW'));
  const result = p.revokeGrant(s, request);
  assert.equal(result.state.policyRevision, s.policyRevision + 1);
  assert.equal(p.resolveConstraints(result.state, 'chapter').effectiveDeadline, at(10));
  assert.equal(result.state.grants.length, 1, 'the grant record is never deleted');
  assert.equal(result.state.grants[0].revocation.reasonRef, 'ticket-1');
  assert.deepEqual(p.poolBalances(result.state), p.poolBalances(s), 'revocation alone does not refund usage');
  assert.equal(result.state.audit.at(-1).operation, 'revoke_grant');
  assert.equal(p.revokeGrant(result.state, request).replayed, true);
  assert.throws(() => p.previewRevocation(result.state, { grantId: 'grant-offer', reasonRef: 'again' }), errorCode('ALREADY_REVOKED'));
  assert.throws(() => p.previewRevocation(s, { grantId: 'unknown', reasonRef: 'x' }), errorCode('UNKNOWN_GRANT'));
});

test('refund returns at most the debited units, changes only the ledger and needs its own authority', () => {
  const s = granted();
  const terms = { refundId: 'refund-1', grantId: 'grant-offer', poolId: 'shared-days', amount: 1, reasonRef: 'outage-ticket' };
  const preview = p.previewRefund(s, terms);
  assert.deepEqual([preview.balanceBefore.remaining, preview.balanceAfter.remaining], [2, 3]);
  const request = cmd(s, 'refund-1', { ...terms, previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'refund_allowance', preview.previewDigest, 'chapter') });
  assert.throws(() => p.refundAllowance(s, { ...request, authorityReceipt: authority(s, 'refund_allowance', 'other', 'chapter') }), errorCode('AUTHORITY_REQUIRED'));
  const result = p.refundAllowance(s, request);
  assert.equal(result.state.policyRevision, s.policyRevision, 'a refund does not move deadlines');
  assert.equal(result.state.ledgerRevision, s.ledgerRevision + 1);
  assert.equal(p.poolBalances(result.state).find(b => b.poolId === 'shared-days').remaining, 3);
  assert.equal(p.resolveConstraints(result.state, 'chapter').effectiveDeadline, at(12));
  assert.throws(() => p.previewRefund(result.state, { ...terms, refundId: 'refund-2', amount: 2 }), errorCode('REFUND_EXCEEDS_DEBIT'));
  assert.throws(() => p.previewRefund(result.state, { ...terms, refundId: 'refund-2', poolId: 'course-days' }), errorCode('POOL_NOT_DEBITED'));
  assert.throws(() => p.previewRefund(result.state, terms), errorCode('DUPLICATE_REFUND'));
  const forged = structuredClone(result.state); forged.refunds.push({ ...forged.refunds[0], refundId: 'forged', amount: 5 });
  assert.throws(() => p.resolveConstraints(forged, 'chapter'), errorCode('INVALID_LEDGER'));
});

test('an exceptional grant needs authority, debits no pool, names its level and can be revoked', () => {
  const s = state();
  const terms = { exceptionId: 'exception-1', scopeId: 'course', reasonRef: 'committee-decision', change: { deadline: { kind: 'absolute', calendarDays: 3 } } };
  const preview = p.previewExceptionalGrant(s, terms);
  assert.deepEqual([preview.effectiveDeadlineBefore, preview.effectiveDeadlineAfter], [at(20), at(23)]);
  assert.deepEqual(preview.poolDebits, []);
  const request = cmd(s, 'exception-1', { ...terms, previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'exceptional_grant', preview.previewDigest) });
  assert.throws(() => p.grantExceptional(s, { ...request, authorityReceipt: authority(s, 'accommodate', preview.previewDigest) }), errorCode('AUTHORITY_REQUIRED'));
  const result = p.grantExceptional(s, request).state;
  assert.equal(p.resolveConstraints(result, 'course').effectiveDeadline, at(23));
  assert.deepEqual(p.poolBalances(result), p.poolBalances(s));
  assert.equal(p.resolveConstraints(result, 'chapter').effectiveDeadline, at(10), 'a course exception does not move a chapter deadline');
  assert.throws(() => p.previewExceptionalGrant(s, { ...terms, scopeId: 'chapter', change: { deadline: { kind: 'absolute', calendarDays: 15 } } }), errorCode('PARENT_CAP_CONFLICT'));
  const revoke = p.previewRevocation(result, { grantId: 'exception-1', reasonRef: 'withdrawn' });
  const revoked = p.revokeGrant(result, cmd(result, 'revoke-exception', { grantId: 'exception-1', reasonRef: 'withdrawn', previewDigest: revoke.previewDigest,
    authorityReceipt: authority(result, 'revoke_extension', revoke.previewDigest) })).state;
  assert.equal(p.resolveConstraints(revoked, 'course').effectiveDeadline, at(20));
  assert.equal(revoked.exceptionalGrants.length, 1);
});

test('P16: a migration that shortens promised time names each affected grant and needs explicit acknowledgement', () => {
  const s = granted();
  const scopes = structuredClone(s.scopes); scopes[0].hardDeadline = hard(11);
  const preview = p.previewPolicyChange(s, { scopes });
  assert.deepEqual(preview.shortenedGrants.map(g => [g.entryId, g.kind, g.effectiveDeadlineBefore, g.effectiveDeadlineAfter]),
    [['grant-offer', 'extension', at(12), at(11)]]);
  assert.throws(() => p.applyPolicyChange(s, migration(s, scopes)), errorCode('SHORTENED_GRANT_UNACKNOWLEDGED'));
  assert.throws(() => p.applyPolicyChange(s, migration(s, scopes, { acknowledgedShortenedGrantIds: ['other'] })), errorCode('SHORTENED_GRANT_UNACKNOWLEDGED'));
  const applied = p.applyPolicyChange(s, migration(s, scopes, { acknowledgedShortenedGrantIds: ['grant-offer'] })).state;
  assert.equal(p.resolveConstraints(applied, 'chapter').effectiveDeadline, at(11));
  const relaxed = structuredClone(s.scopes); relaxed[1].targetDate = at(8);
  assert.deepEqual(p.previewPolicyChange(s, { scopes: relaxed }).shortenedGrants, []);
  assert.equal(p.applyPolicyChange(s, migration(s, relaxed)).replayed, false);
});

test('G08: core and final-assessment headroom is reserved first; extras fit around it on a separate counter', () => {
  const headroom = [
    { reservationId: 'core:course', scopeId: 'course', purpose: 'core', work: { additionalMinutes: 60, additionalEpisodes: 4 } },
    { reservationId: 'final:course', scopeId: 'course', purpose: 'final_assessment', work: { additionalMinutes: 30, additionalEpisodes: 2 } },
  ];
  const s = state(i => { i.headroom = headroom; });
  assert.deepEqual(s.reservations.map(r => [r.reservationId, r.purpose, r.state]), [['core:course', 'core', 'reserved'], ['final:course', 'final_assessment', 'reserved']]);
  assert.equal(p.resolveConstraints(s, 'course').quotas.find(q => q.metric === 'additionalMinutes').remaining, 30);
  assert.throws(() => p.reserveWork(s, cmd(s, 'extra-big', { reservationId: 'extra-big', scopeId: 'chapter', work: { additionalMinutes: 31 } })), errorCode('QUOTA_EXCEEDED'));
  let next = p.reserveWork(s, cmd(s, 'extra', { reservationId: 'extra', scopeId: 'chapter', work: { additionalMinutes: 20, additionalEpisodes: 1 } })).state;
  next = p.commitWork(next, cmd(next, 'extra-commit', { reservationId: 'extra', workId: 'personal-example' })).state;
  // Core remediation draws on its own headroom even when the shared envelope is nearly spent.
  next = p.reserveWork(next, cmd(next, 'core-fix', { reservationId: 'core-fix', scopeId: 'chapter', work: { additionalMinutes: 40, additionalEpisodes: 2 }, fundedByReservationId: 'core:course' })).state;
  assert.equal(next.reservations.find(r => r.reservationId === 'core-fix').purpose, 'core');
  assert.deepEqual(next.reservations.find(r => r.reservationId === 'core:course').work, { additionalMinutes: 20, additionalEpisodes: 2, remediation: [] });
  assert.throws(() => p.reserveWork(next, cmd(next, 'core-more', { reservationId: 'core-more', scopeId: 'chapter', work: { additionalMinutes: 21 }, fundedByReservationId: 'core:course' })), errorCode('HEADROOM_EXHAUSTED'));
  assert.throws(() => p.reserveWork(next, cmd(next, 'bad-fund', { reservationId: 'bad-fund', scopeId: 'chapter', work: { additionalMinutes: 1 }, fundedByReservationId: 'extra' })), errorCode('INVALID_RESERVATION_STATE'));
  const coverage = p.coverageSummary(next);
  assert.equal(coverage.denominator, 2);
  assert.deepEqual(coverage.personalExtras.committed, { count: 1, additionalMinutes: 20, additionalEpisodes: 1 });
  assert.deepEqual(coverage.personalExtras.reserved, { count: 0, additionalMinutes: 0, additionalEpisodes: 0 });
  assert.deepEqual(coverage.headroom.map(h => h.reservationId), ['core:course', 'final:course', 'core-fix']);
  assert.throws(() => state(i => { i.headroom = [{ ...headroom[0], work: { additionalMinutes: 121 } }]; }), errorCode('RESERVE_EXCEEDS_QUOTA'));
  assert.throws(() => state(i => { i.headroom = [{ ...headroom[0], work: {} }]; }), errorCode('INVALID_INPUT'));
});

function closed(s, access = 'read_only', afterClosure) {
  const input = structuredClone(s); input.scopes[0].existingMaterialAccess = access; if (afterClosure) input.afterClosure = afterClosure;
  const report = { now: at(21), reason: 'cap', coveredObjectiveIds: ['objective-a'], demonstratedConceptIds: [] };
  const preview = p.previewClosure(input, report);
  return p.closeEnrollment(input, { ...cmd(input, 'close', { now: at(21) }), ...report, previewDigest: preview.previewDigest,
    authorityReceipt: authority(input, 'close_enrollment', preview.previewDigest, 'course', { authorizedAt: at(21) }) }).state;
}

test('P20: after closure, questions are bounded by the closed-course budget and the access policy', () => {
  const s = state();
  assert.deepEqual(p.checkClosedQuestion(s, { scopeId: 'chapter', now: NOW, questionsUsed: 0, defaultBudget: 5 }).violations, ['ENROLLMENT_NOT_CLOSED']);
  const done = closed(s);
  assert.equal(p.checkClosedQuestion(done, { scopeId: 'chapter', now: at(22), questionsUsed: 4, defaultBudget: 5 }).allowed, true);
  const spent = p.checkClosedQuestion(done, { scopeId: 'chapter', now: at(22), questionsUsed: 5, defaultBudget: 5 });
  assert.deepEqual([spent.allowed, spent.violations, spent.remaining], [false, ['HELP_BUDGET_EXHAUSTED'], 0]);
  assert.deepEqual(p.checkClosedQuestion(closed(s, 'closed'), { scopeId: 'chapter', now: at(22), questionsUsed: 0, defaultBudget: 5 }).violations, ['ACCESS_CLOSED']);
  const configured = closed(state(i => { i.afterClosure = { questionBudget: 1 }; }));
  assert.equal(p.checkClosedQuestion(configured, { scopeId: 'chapter', now: at(22), questionsUsed: 1, defaultBudget: 50 }).allowed, false);
  assert.equal(p.checkAction(done, { scopeId: 'chapter', now: at(22), kind: 'plan', expectedPolicyRevision: done.policyRevision }).allowed, false, 'no new required work');
});

test('P08: an on-time submission may be graded after the cutoff and closure; a late one may not', () => {
  const s = closed(state());
  const receipt = (submittedAt) => ({ receiptId: 'attempt', enrollmentId: s.enrollmentId, scopeId: 'chapter', attemptId: 'attempt', submittedAt, eligible: true, policyRevision: s.policyRevision });
  const grade = (submittedAt) => p.checkAction(s, { scopeId: 'chapter', now: at(25), kind: 'grade', expectedPolicyRevision: s.policyRevision, submissionReceipt: receipt(submittedAt) });
  assert.equal(grade(at(9)).allowed, true);
  assert.deepEqual(grade(at(10)).violations.map(v => v.code), ['SUBMITTED_AFTER_CUTOFF']);
  const grace = state(i => { i.scopes[1].submissionGraceUntil = '2030-01-10T13:00:00Z'; });
  assert.equal(p.checkAction(grace, { scopeId: 'chapter', now: at(25), kind: 'grade', expectedPolicyRevision: grace.policyRevision,
    submissionReceipt: { ...receipt('2030-01-10T12:30:00Z'), policyRevision: grace.policyRevision } }).allowed, true);
});

test('G04: the DST publish preview lists skipped and repeated local times and how the rule resolves them', () => {
  const rule = { timeZone: 'America/New_York', calendarDays: 7, from: '2030-01-01T00:00:00Z', until: '2030-12-31T00:00:00Z' };
  const rejecting = p.previewCalendarRule({ ...rule, disambiguation: 'reject' });
  assert.deepEqual(rejecting.transitions.map(t => [t.kind, t.localDate, t.localStart, t.localEnd, t.resolution]),
    [['gap', '2030-03-10', '02:00:00', '03:00:00', 'rejected'], ['overlap', '2030-11-03', '01:00:00', '02:00:00', 'rejected']]);
  assert.equal(rejecting.transitions[0].affectedAnchorDate, '2030-03-03');
  assert.equal(rejecting.transitions[0].example.resolved, null);
  assert.equal(rejecting.rejectsSomeStarts, true);
  const later = p.previewCalendarRule({ ...rule, disambiguation: 'later' });
  assert.equal(later.transitions[0].example.resolved, '2030-03-10T07:30:00Z');
  assert.equal(later.rejectsSomeStarts, false);
  const absolute = p.previewCalendarRule({ ...rule, disambiguation: 'reject', calendarDays: 0, absoluteAt: '2030-03-08T07:30:00Z', maxExtensionDays: 3 });
  assert.deepEqual(absolute.rejectedExtensionDays, [2]);
  assert.equal(p.previewCalendarRule({ ...rule, timeZone: 'UTC', disambiguation: 'reject' }).transitions.length, 0);
  assert.throws(() => p.previewCalendarRule({ ...rule, timeZone: '+02:00', disambiguation: 'reject' }), errorCode('INVALID_INPUT'));
});
