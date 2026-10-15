import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageSummary } from '@course-core/policy';
import { admitAdaptation, applyAdaptation, cancelAdaptation, materializeAdaptation } from '../dist/index.js';
import { fixture, bundle, command, advance, authorize } from './helpers.mjs';

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
