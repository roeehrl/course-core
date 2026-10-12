import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/index.js';
import { state, initial, cmd, at, hard, errorCode, deepFreeze, migration } from './helpers.mjs';

test('earliest ancestor deadline binds open-ended children; targets are advisory', () => {
  const s = state(i => { i.scopes[0].hardDeadline = hard(8); i.scopes[1].mode = 'open_ended'; i.scopes[1].targetDate = at(1); });
  const constraints = p.resolveConstraints(s, 'chapter');
  assert.equal(constraints.effectiveDeadline, at(8));
  assert.deepEqual(constraints.bindingDeadlines.map(d => d.scopeId), ['course']);
  assert.equal(p.checkAction(s, { scopeId: 'chapter', now: at(7), expectedPolicyRevision: 1, kind: 'plan' }).allowed, true);
  assert.equal(p.checkAction(s, { scopeId: 'chapter', now: at(8), expectedPolicyRevision: 1, kind: 'publish' }).allowed, false);
});

test('intersection is independent of input order and retains equally binding caps', () => {
  const s = state(i => { i.scopes[0].hardDeadline = hard(10); });
  const expected = p.resolveConstraints(s, 'chapter');
  assert.deepEqual(expected.bindingDeadlines.map(d => d.scopeId), ['course', 'chapter']);
  s.scopes.reverse();
  assert.deepEqual(p.resolveConstraints(s, 'chapter'), expected);
});

test('bounded defaults reject no terminating condition; open-ended scope still has external technical quotas', () => {
  const input = initial();
  for (const s of input.scopes) { delete s.hardDeadline; delete s.mode; s.work = {}; }
  assert.throws(() => p.createPolicyState(input), errorCode('UNBOUNDED_POLICY'));
  for (const s of input.scopes) s.mode = 'open_ended';
  const open = p.createPolicyState(input);
  assert.equal(p.resolveConstraints(open, 'chapter').effectiveDeadline, null);
  assert.deepEqual(p.checkQuotas([{ id: 'job-seconds', limit: 10, consumed: 5, reserved: 4, requested: 2 }]), { allowed: false, exceeded: ['job-seconds'] });
});

test('unknown values, malformed ancestry, unknown scopes and duplicate pool IDs fail closed', () => {
  for (const modify of [
    i => i.scopes[0].mode = 'unlimited', i => i.scopes[0].work.additionalMinutes = -1,
    i => i.scopes[0].work.typo = 99, i => i.scopes[0].extensions.learnerAcceptanceRequired = false,
    i => i.scopes[1].parentScopeId = 'missing', i => i.scopes[1].parentScopeId = 'chapter',
    i => i.scopes.push(structuredClone(i.scopes[1])), i => i.pools.push(structuredClone(i.pools[0])),
    i => i.scopes[0].existingMaterialAccess = 'unrestricted', i => i.scopes[0].window = null,
  ]) assert.throws(() => state(modify), p.PolicyError);
  assert.throws(() => p.resolveConstraints(state(), 'missing'), errorCode('UNKNOWN_SCOPE'));
  assert.throws(() => p.checkAction(state(), { scopeId: 'course', now: at(2), expectedPolicyRevision: 1, kind: 'unknown' }), errorCode('INVALID_INPUT'));
  assert.throws(() => p.checkQuotas([{ id: 'x', limit: null, consumed: 0, reserved: 0, requested: 0 }]), errorCode('INVALID_INPUT'));
  assert.throws(() => p.checkQuotas([{ id: 'x', limit: Number.MAX_SAFE_INTEGER, consumed: Number.MAX_SAFE_INTEGER, reserved: 1, requested: 0 }]), errorCode('INVALID_INPUT'));
});

test('every ancestor quota binds; sibling work consumes a shared course budget', () => {
  let s = state(i => { i.scopes[0].work.additionalMinutes = 70; });
  s = p.reserveWork(s, cmd(s, 'a', { reservationId: 'a', scopeId: 'chapter', work: { additionalMinutes: 50 } })).state;
  assert.throws(() => p.reserveWork(s, cmd(s, 'b', { reservationId: 'b', scopeId: 'sibling', work: { additionalMinutes: 30 } })), errorCode('QUOTA_EXCEEDED'));
  const quotas = p.resolveConstraints(s, 'sibling').quotas;
  assert.equal(quotas.find(q => q.scopeId === 'course' && q.metric === 'additionalMinutes').remaining, 20);
  assert.equal(quotas.find(q => q.scopeId === 'sibling' && q.metric === 'additionalMinutes').remaining, 60);
});

test('rename/recreate does not reset concept cycles or assigned-work accounting', () => {
  let s = state();
  s = p.reserveWork(s, cmd(s, 'reserve', { reservationId: 'r', scopeId: 'chapter', work: { additionalEpisodes: 1, remediation: [{ conceptId: 'concept-a', cycles: 2 }] } })).state;
  s = p.commitWork(s, cmd(s, 'commit', { reservationId: 'r', workId: 'original-title' })).state;
  assert.throws(() => p.reserveWork(s, cmd(s, 'renamed', { reservationId: 'renamed', scopeId: 'sibling', work: { remediation: [{ conceptId: 'concept-a', cycles: 1 }] } })), errorCode('QUOTA_EXCEEDED'));
  assert.throws(() => p.reserveWork(s, cmd(s, 'unknown', { reservationId: 'new', scopeId: 'chapter', work: { remediation: [{ conceptId: 'renamed-concept', cycles: 1 }] } })), errorCode('UNKNOWN_CONCEPT'));
  assert.throws(() => p.cancelReservation(s, cmd(s, 'cancel', { reservationId: 'r' })), errorCode('INVALID_RESERVATION_STATE'));
  assert.equal(p.resolveConstraints(s, 'course').quotas.find(q => q.metric === 'additionalEpisodes').consumed, 1);
});

test('reservation release only frees unused work, and cancellation fences late publication', () => {
  let s = state();
  s = p.reserveWork(s, cmd(s, 'reserve', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 60 } })).state;
  const release = cmd(s, 'cancel', { reservationId: 'r' });
  s = p.cancelReservation(s, release).state;
  assert.equal(p.resolveConstraints(s, 'chapter').quotas.find(q => q.scopeId === 'chapter' && q.metric === 'additionalMinutes').remaining, 60);
  assert.equal(p.cancelReservation(s, release).replayed, true);
  assert.throws(() => p.commitWork(s, cmd(s, 'late', { reservationId: 'r', workId: 'late-work' })), errorCode('INVALID_RESERVATION_STATE'));
});

test('late timer or a job started before cutoff cannot publish at or after cutoff', () => {
  let s = state();
  s = p.reserveWork(s, cmd(s, 'reserve', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 10 } })).state;
  for (const now of [at(10), at(11)]) assert.throws(() => p.commitWork(s, cmd(s, 'late', { now, reservationId: 'r', workId: 'work' })), errorCode('DEADLINE_REACHED'));
  assert.equal(s.reservations[0].state, 'reserved');
});

test('stale revisions fail for admissions and publication, even when fresh command wraps old job', () => {
  let s = state();
  const staleCommand = cmd(s, 'reserve-old', { reservationId: 'old', scopeId: 'chapter', work: { additionalMinutes: 1 } });
  s = p.reserveWork(s, cmd(s, 'r', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 1 } })).state;
  assert.throws(() => p.reserveWork(s, staleCommand), errorCode('STALE_LEDGER_REVISION'));
  s = p.applyPolicyChange(s, migration(s)).state;
  assert.throws(() => p.reserveWork(s, staleCommand), errorCode('STALE_POLICY_REVISION'));
  assert.throws(() => p.commitWork(s, cmd(s, 'publish-old', { reservationId: 'r', workId: 'work' })), errorCode('STALE_JOB'));
  assert.equal(p.checkAction(s, { scopeId: 'chapter', now: at(2), expectedPolicyRevision: 1, kind: 'plan' }).allowed, false);
});

test('operations are deterministic, pure and retries do not double count reservations or assignments', () => {
  const before = deepFreeze(state());
  const request = deepFreeze(cmd(before, 'reserve', { reservationId: 'r', scopeId: 'chapter', work: { additionalMinutes: 10 } }));
  const first = p.reserveWork(before, request);
  assert.deepEqual(p.reserveWork(before, request), first);
  assert.equal(before.reservations.length, 0);
  const retry = p.reserveWork(first.state, { ...request, now: at(3) });
  assert.equal(retry.replayed, true); assert.deepEqual(retry.state, first.state);
  const commit = cmd(first.state, 'commit', { reservationId: 'r', workId: 'work' });
  const assigned = p.commitWork(first.state, commit);
  assert.equal(p.commitWork(assigned.state, commit).replayed, true);
  assert.equal(assigned.state.reservations.length, 1);
  assert.deepEqual(first.preconditions, { enrollmentId: 'enrollment', policyRevision: 1, ledgerRevision: 0 });
});

test('submission grace is explicit and intersects ancestors; it never permits expansion', () => {
  const s = state(i => { i.scopes[0].hardDeadline = hard(11); i.scopes[1].submissionGraceUntil = at(12); });
  assert.equal(p.checkAction(s, { scopeId: 'chapter', now: at(10), expectedPolicyRevision: 1, kind: 'submit' }).allowed, true);
  assert.equal(p.checkAction(s, { scopeId: 'chapter', now: at(10), expectedPolicyRevision: 1, kind: 'publish' }).allowed, false);
  assert.equal(p.checkAction(s, { scopeId: 'chapter', now: at(11), expectedPolicyRevision: 1, kind: 'submit' }).allowed, false);
});
