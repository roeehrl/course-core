import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/index.js';
import { cmd, errorCode, state } from './helpers.mjs';

const headroom = [{ reservationId: 'headroom:core', scopeId: 'course', purpose: 'core', work: { additionalMinutes: 60, additionalEpisodes: 4 } }];
const withHeadroom = () => state(i => { i.headroom = headroom; });
const find = (s, id) => s.reservations.find(r => r.reservationId === id);
const left = s => { const { additionalMinutes, additionalEpisodes } = find(s, 'headroom:core').work; return { additionalMinutes, additionalEpisodes }; };
const quota = (s, metric, scopeId = 'course') => p.resolveConstraints(s, scopeId).quotas.find(q => q.metric === metric && q.conceptId === null);
const fund = (s, id = 'fix', work = { additionalMinutes: 20, additionalEpisodes: 1, remediation: [{ conceptId: 'concept-a', cycles: 1 }] }) =>
  p.reserveWork(s, cmd(s, `reserve-${id}`, { reservationId: id, scopeId: 'chapter', work, fundedByReservationId: 'headroom:core' })).state;

for (const reason of ['cancelled', 'refused', 'expired']) {
  test(`${reason} funded core remediation returns its unused headroom exactly once`, () => {
    const start = withHeadroom(), coverage = p.coverageSummary(start);
    const funded = fund(start);
    assert.deepEqual(left(funded), { additionalMinutes: 40, additionalEpisodes: 3 });
    assert.deepEqual(find(funded, 'fix').funding, { reservationId: 'headroom:core', additionalMinutes: 20, additionalEpisodes: 1 });
    const cancel = cmd(funded, `cancel-${reason}`, { reservationId: 'fix', reason });
    const ended = p.cancelReservation(funded, cancel);
    assert.equal(ended.replayed, false);
    assert.deepEqual(left(ended.state), { additionalMinutes: 60, additionalEpisodes: 4 });
    assert.deepEqual(find(ended.state, 'fix').release, { reason, at: cancel.now, used: { additionalMinutes: 0, additionalEpisodes: 0, remediation: [] },
      headroomRefund: { reservationId: 'headroom:core', additionalMinutes: 20, additionalEpisodes: 1 } });
    assert.deepEqual(ended.state.audit.at(-1).operation, 'cancel_reservation');
    // Every quota is back where it was before the funded work, and the denominator never moved.
    for (const metric of ['additionalMinutes', 'additionalEpisodes']) assert.deepEqual(quota(ended.state, metric), quota(start, metric));
    assert.equal(p.coverageSummary(ended.state).denominator, coverage.denominator);
    assert.deepEqual(p.coverageSummary(ended.state).personalExtras, coverage.personalExtras);
    // A retried request replays the stored receipt without refunding again...
    const replayed = p.cancelReservation(ended.state, cancel);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(left(replayed.state), { additionalMinutes: 60, additionalEpisodes: 4 });
    // ...and a second, different cancellation is refused.
    assert.throws(() => p.cancelReservation(ended.state, cmd(ended.state, 'cancel-again', { reservationId: 'fix', reason })), errorCode('INVALID_RESERVATION_STATE'));
  });
}

test('partially used funded work returns only the unused remainder and keeps the used part charged', () => {
  const start = withHeadroom(), funded = fund(start);
  const before = quota(funded, 'additionalMinutes');
  const used = { additionalMinutes: 15, additionalEpisodes: 1, remediation: [{ conceptId: 'concept-a', cycles: 1 }] };
  const ended = p.cancelReservation(funded, cmd(funded, 'stop', { reservationId: 'fix', reason: 'refused', used })).state;
  assert.deepEqual(left(ended), { additionalMinutes: 45, additionalEpisodes: 3 });
  assert.deepEqual(find(ended, 'fix').release.headroomRefund, { reservationId: 'headroom:core', additionalMinutes: 5, additionalEpisodes: 0 });
  const after = quota(ended, 'additionalMinutes');
  // 20 reserved became 15 consumed plus 5 back in headroom: nothing leaks into the shared envelope.
  assert.equal(after.consumed, before.consumed + 15);
  assert.equal(after.reserved, before.reserved - 15);
  assert.equal(after.remaining, before.remaining);
  assert.equal(quota(ended, 'additionalEpisodes').consumed, 1);
  const cycles = p.resolveConstraints(ended, 'chapter').quotas.find(q => q.metric === 'remediationCyclesPerConcept' && q.conceptId === 'concept-a');
  assert.deepEqual([cycles.consumed, cycles.reserved], [1, 0]);
  assert.equal(p.coverageSummary(ended).denominator, p.coverageSummary(start).denominator);
  // The ledger round-trips through validation.
  assert.deepEqual(p.cancelReservation(ended, cmd(funded, 'stop', { reservationId: 'fix', reason: 'refused', used })).state, ended);
});

test('a refund goes to the headroom that funded the work, only while that headroom is live', () => {
  let s = fund(fund(withHeadroom(), 'first'), 'second', { additionalMinutes: 10, additionalEpisodes: 1 });
  assert.deepEqual(left(s), { additionalMinutes: 30, additionalEpisodes: 2 });
  s = p.cancelReservation(s, cmd(s, 'cancel-second', { reservationId: 'second' })).state;
  assert.deepEqual(left(s), { additionalMinutes: 40, additionalEpisodes: 3 });
  assert.equal(find(s, 'first').state, 'reserved');
  // With the headroom itself released, the funded remainder simply leaves every quota.
  s = p.cancelReservation(s, cmd(s, 'cancel-headroom', { reservationId: 'headroom:core' })).state;
  const released = quota(s, 'additionalMinutes').reserved;
  s = p.cancelReservation(s, cmd(s, 'cancel-first', { reservationId: 'first', reason: 'expired' })).state;
  assert.deepEqual(find(s, 'first').release.headroomRefund, { reservationId: 'headroom:core', additionalMinutes: 0, additionalEpisodes: 0 });
  assert.equal(find(s, 'headroom:core').work.additionalMinutes, 40);
  assert.equal(quota(s, 'additionalMinutes').reserved, released - 20);
});

test('unfunded and committed work are unaffected; invalid use is refused', () => {
  let s = withHeadroom();
  s = p.reserveWork(s, cmd(s, 'extra', { reservationId: 'extra', scopeId: 'chapter', work: { additionalMinutes: 5 } })).state;
  const plain = p.cancelReservation(s, cmd(s, 'cancel-extra', { reservationId: 'extra' })).state;
  assert.deepEqual(find(plain, 'extra').release, { reason: 'cancelled', at: plain.audit.at(-1).at, used: { additionalMinutes: 0, additionalEpisodes: 0, remediation: [] } });
  assert.deepEqual(left(plain), { additionalMinutes: 60, additionalEpisodes: 4 });
  const funded = fund(s);
  for (const used of [{ additionalMinutes: 21 }, { additionalEpisodes: 2 }, { remediation: [{ conceptId: 'concept-b', cycles: 1 }] },
    { remediation: [{ conceptId: 'concept-a', cycles: 2 }] }]) {
    assert.throws(() => p.cancelReservation(funded, cmd(funded, 'bad', { reservationId: 'fix', used })), errorCode('INVALID_INPUT'));
  }
  assert.throws(() => p.cancelReservation(funded, cmd(funded, 'bad', { reservationId: 'fix', reason: 'forgotten' })), errorCode('INVALID_INPUT'));
  const committed = p.commitWork(funded, cmd(funded, 'commit', { reservationId: 'fix', workId: 'work' })).state;
  assert.throws(() => p.cancelReservation(committed, cmd(committed, 'late', { reservationId: 'fix' })), errorCode('INVALID_RESERVATION_STATE'));
  assert.deepEqual(left(committed), { additionalMinutes: 40, additionalEpisodes: 3 });
});

test('stored ledgers cannot claim a refund or a draw they did not make', () => {
  const funded = fund(withHeadroom());
  const ended = p.cancelReservation(funded, cmd(funded, 'cancel', { reservationId: 'fix' })).state;
  const tamper = change => { const copy = structuredClone(ended); change(copy); return () => p.coverageSummary(copy); };
  assert.throws(tamper(s => { find(s, 'fix').release.headroomRefund.additionalMinutes = 21; }), errorCode('INVALID_LEDGER'));
  assert.throws(tamper(s => { find(s, 'fix').release.headroomRefund.reservationId = 'fix'; }), errorCode('INVALID_LEDGER'));
  assert.throws(tamper(s => { find(s, 'fix').release.used.additionalMinutes = 21; }), errorCode('INVALID_LEDGER'));
  assert.throws(tamper(s => { find(s, 'fix').state = 'reserved'; }), errorCode('INVALID_LEDGER'));
  assert.throws(tamper(s => { find(s, 'fix').funding.reservationId = 'missing'; }), errorCode('INVALID_LEDGER'));
  assert.throws(tamper(s => { find(s, 'fix').funding.additionalMinutes = 21; }), errorCode('INVALID_LEDGER'));
});
