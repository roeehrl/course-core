import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageSummary } from '@course-core/policy';
import { admitAdaptation, applyAdaptation, cancelAdaptation, materializeAdaptation } from '../dist/index.js';
import { fixture, bundle, command, advance, authorize, code, LATE } from './helpers.mjs';

const withHeadroom = minutes => fixture({ policy: p => { p.headroom = [{ reservationId: 'headroom:core', scopeId: 'course-scope', purpose: 'core',
  work: { additionalMinutes: minutes, additionalEpisodes: 1, remediation: [] } }]; } });
async function publish(f, b, key) {
  advance(f, await admitAdaptation(f.context, f.state, command(f, `admit-${key}`, b)));
  return advance(f, await applyAdaptation(f.context, f.state, command(f, `apply-${key}`, { admissionId: b.admissionId })));
}
const headroom = f => f.context.policy.reservations.find(r => r.reservationId === 'headroom:core');
const own = (f, b) => f.state.admissions.find(a => a.id === b.admissionId).reservations;

test('core remediation is funded from core headroom: the denominator and the personal-extras counter do not move', async () => {
  const f = await withHeadroom(10), before = coverageSummary(f.context.policy);
  const b = await bundle(f, 'core');
  await publish(f, b, 'core');
  const [binding] = own(f, b);
  assert.equal(binding.fundedByReservationId, 'headroom:core');
  const reservation = f.context.policy.reservations.find(r => r.reservationId === binding.reservationId);
  assert.equal(reservation.purpose, 'core'); assert.equal(reservation.state, 'committed');
  assert.deepEqual(reservation.work.remediation, [{ conceptId: 'comparison-concept', cycles: 1 }]); // Cycles stay on the work.
  assert.equal(headroom(f).work.additionalMinutes, 8);
  const after = coverageSummary(f.context.policy);
  assert.equal(after.denominator, before.denominator);
  assert.deepEqual(after.personalExtras, before.personalExtras);
  await materializeAdaptation(f.context, structuredClone(f.state)); // The stored chain still verifies.
});
test('optional additions stay personal extras on their own counter, beside funded core work', async () => {
  const f = await withHeadroom(10), b = await bundle(f, 'optional');
  b.assignments[0].classification = 'optional';
  const optional = await authorize(f, b);
  await publish(f, optional, 'optional');
  assert.equal(own(f, optional)[0].fundedByReservationId, undefined);
  assert.equal(f.context.policy.reservations.find(r => r.reservationId === own(f, optional)[0].reservationId).purpose, 'extra');
  assert.equal(headroom(f).work.additionalMinutes, 10);
  assert.deepEqual(coverageSummary(f.context.policy).personalExtras.committed, { count: 1, additionalMinutes: 2, additionalEpisodes: 0 });
});
test('without headroom nothing changes, and exhausted headroom falls back to ordinary work', async () => {
  const plain = await fixture(), b = await bundle(plain, 'plain');
  await publish(plain, b, 'plain');
  assert.equal(own(plain, b)[0].fundedByReservationId, undefined);
  assert.equal(plain.context.policy.reservations.find(r => r.reservationId === own(plain, b)[0].reservationId).purpose, 'extra');
  const tight = await withHeadroom(1), c = await bundle(tight, 'tight');
  await publish(tight, c, 'tight');
  assert.equal(own(tight, c)[0].fundedByReservationId, undefined);
  assert.equal(headroom(tight).work.additionalMinutes, 1);
});
test('applying after headroom is spent elsewhere still matches the admitted reservation; cancelling unfunded work releases it', async () => {
  const f = await withHeadroom(2), a = await bundle(f, 'a');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-a', a)));
  assert.equal(own(f, a)[0].fundedByReservationId, 'headroom:core'); assert.equal(headroom(f).work.additionalMinutes, 0);
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-a', { admissionId: a.admissionId })));
  const b = await bundle(f, 'b');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-b', b)));
  assert.equal(own(f, b)[0].fundedByReservationId, undefined);
  advance(f, await cancelAdaptation(f.context, f.state, command(f, 'cancel-b', { admissionId: b.admissionId })));
  assert.equal(f.context.policy.reservations.find(r => r.reservationId === own(f, b)[0].reservationId).state, 'cancelled');
});

for (const [reason, now] of [['cancelled', undefined], ['refused', undefined], ['expired', LATE]]) {
  test(`${reason} funded core remediation returns its headroom exactly once and leaves the denominator alone`, async () => {
    const f = await withHeadroom(10), before = coverageSummary(f.context.policy), b = await bundle(f, reason);
    advance(f, await admitAdaptation(f.context, f.state, command(f, `admit-${reason}`, b)));
    const [binding] = own(f, b);
    assert.equal(binding.fundedByReservationId, 'headroom:core'); assert.equal(headroom(f).work.additionalMinutes, 8);
    const cancel = command(f, `cancel-${reason}`, { admissionId: b.admissionId, ...(reason === 'cancelled' ? {} : { reason }), ...(now ? { now } : {}) });
    advance(f, await cancelAdaptation(f.context, f.state, cancel));
    assert.equal(headroom(f).work.additionalMinutes, 10); assert.equal(headroom(f).work.additionalEpisodes, 1);
    const released = f.context.policy.reservations.find(r => r.reservationId === binding.reservationId);
    assert.equal(released.state, 'cancelled');
    assert.deepEqual(released.release, { reason, at: cancel.now, used: { additionalMinutes: 0, additionalEpisodes: 0, remediation: [] },
      headroomRefund: { reservationId: 'headroom:core', additionalMinutes: 2, additionalEpisodes: 0 } });
    const after = coverageSummary(f.context.policy);
    assert.equal(after.denominator, before.denominator); assert.deepEqual(after.personalExtras, before.personalExtras);
    assert.deepEqual(after.headroom, before.headroom);
    // A retry replays; a fresh cancellation is refused; nothing is refunded twice.
    const replay = await cancelAdaptation(f.context, f.state, cancel);
    assert.equal(replay.replayed, true); assert.equal(replay.policy.reservations.find(r => r.reservationId === 'headroom:core').work.additionalMinutes, 10);
    await assert.rejects(cancelAdaptation(f.context, f.state, command(f, `again-${reason}`, { admissionId: b.admissionId, ...(now ? { now } : {}) })), code('INVALID_ADMISSION_STATE'));
    // Before the deadline, the released headroom funds the next core remediation.
    if (now) return;
    const next = await bundle(f, `${reason}-next`);
    advance(f, await admitAdaptation(f.context, f.state, command(f, `admit-${reason}-next`, next)));
    assert.equal(own(f, next)[0].fundedByReservationId, 'headroom:core'); assert.equal(headroom(f).work.additionalMinutes, 8);
  });
}
test('expiry is refused while the admission can still publish, and a binding must match the recorded funding', async () => {
  const f = await withHeadroom(10), b = await bundle(f, 'early');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-early', b)));
  await assert.rejects(cancelAdaptation(f.context, f.state, command(f, 'expire-early', { admissionId: b.admissionId, reason: 'expired' })), code('NOT_EXPIRED'));
  await assert.rejects(cancelAdaptation(f.context, f.state, command(f, 'bad-reason', { admissionId: b.admissionId, reason: 'lost' })), code('INVALID_INPUT'));
  // A policy ledger that lost the draw cannot be cancelled as funded work: the refund would go nowhere.
  const forged = { ...f.context, policy: structuredClone(f.context.policy) };
  delete forged.policy.reservations.find(r => r.reservationId === own(f, b)[0].reservationId).funding;
  await assert.rejects(cancelAdaptation(forged, f.state, command(f, 'forged', { admissionId: b.admissionId })), code('RESERVATION_BINDING'));
  assert.equal(headroom(f).work.additionalMinutes, 8);
});
