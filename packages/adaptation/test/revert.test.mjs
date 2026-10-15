import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitAdaptation, applyAdaptation, materializeAdaptation, revertAdaptation } from '../dist/index.js';
import { fixture, bundle, command, advance, code, LATE } from './helpers.mjs';

async function publish(f, b, suffix) {
  advance(f, await admitAdaptation(f.context, f.state, command(f, `admit-${suffix}`, b)));
  return advance(f, await applyAdaptation(f.context, f.state, command(f, `apply-${suffix}`, { admissionId: b.admissionId })));
}
const introOf = view => view.server.chapters[0].episodes[0].blocks.find(block => block.id === 'intro');

test('a revert is a new revision rolling back to the parent, keeping history, committed work and occupied ids', async () => {
  const f = await fixture(), base = await materializeAdaptation(f.context, f.state);
  const b = await bundle(f, 'one');
  const applied = await publish(f, b, 'one');
  const parent = applied.state.applications[0].parentDigest;
  const blocksBefore = base.server.chapters[0].episodes[0].blocks.length;
  assert.equal((await materializeAdaptation(f.context, f.state)).server.chapters[0].episodes[0].blocks.length, blocksBefore + 1);
  const revertCommand = command(f, 'revert-one', { admissionId: b.admissionId });
  const reverted = advance(f, await revertAdaptation(f.context, f.state, revertCommand));
  assert.equal(reverted.state.plan.revision, 2);
  assert.notEqual(reverted.state.plan.digest, parent); // A new revision, not a rewind of history.
  assert.deepEqual(reverted.state.applications.at(-1), { admissionId: b.admissionId, revision: 2, parentDigest: applied.state.plan.digest,
    digest: reverted.state.plan.digest, revert: true, rollbackTargetDigest: parent });
  assert.equal(reverted.state.admissions[0].status, 'reverted');
  assert.deepEqual(reverted.outbox.map(o => o.type), ['adaptation.reverted']);
  assert.deepEqual(reverted.evidenceWrites, []); assert.deepEqual(reverted.creditWrites, []);
  // Used work is never refunded and identifiers stay retired.
  assert.deepEqual(reverted.policy.reservations.map(r => r.state), ['committed']);
  assert.ok(reverted.state.plan.occupiedIds.includes(b.proposal.id));
  const view = await materializeAdaptation(f.context, f.state);
  assert.deepEqual(view.server.chapters[0].episodes[0].blocks, base.server.chapters[0].episodes[0].blocks);
  assert.deepEqual(view.assignments, []);
  // Idempotent replay, then a second revert of the same change is refused.
  const replay = await revertAdaptation(f.context, f.state, { ...revertCommand, now: LATE });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.state, f.state);
  await assert.rejects(revertAdaptation(f.context, f.state, command(f, 'revert-again', { admissionId: b.admissionId })), code('INVALID_ADMISSION_STATE'));
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'readmit', b)), code('DUPLICATE_ADMISSION'));
  // Later changes build on the revert revision, and the stored chain still verifies.
  const next = await bundle(f, 'two');
  const later = await publish(f, next, 'two');
  assert.equal(later.state.plan.revision, 3);
  assert.equal((await materializeAdaptation(f.context, structuredClone(f.state))).server.chapters[0].episodes[0].blocks.length, blocksBefore + 1);
});

test('a revert is refused for unknown, unapplied or assessment changes and when a later change builds on it', async () => {
  const f = await fixture();
  await assert.rejects(revertAdaptation(f.context, f.state, command(f, 'revert-missing', { admissionId: 'admission-missing' })), code('INVALID_ADMISSION_STATE'));
  const variant = await bundle(f, 'variant', ['assessment_variant']);
  await publish(f, variant, 'variant');
  await assert.rejects(revertAdaptation(f.context, f.state, command(f, 'revert-variant', { admissionId: variant.admissionId })), code('REVERT_ASSESSMENT_VARIANT'));
  const reserved = await bundle(f, 'reserved');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-reserved', reserved)));
  await assert.rejects(revertAdaptation(f.context, f.state, command(f, 'revert-reserved', { admissionId: reserved.admissionId })), code('INVALID_ADMISSION_STATE'));
});

test('reverting stacked rewrites restores each earlier version and requires newest-first order', async () => {
  const f = await fixture(), original = introOf(await materializeAdaptation(f.context, f.state));
  const first = await bundle(f, 'first', ['practice']);
  await publish(f, first, 'first');
  const firstIntro = introOf(await materializeAdaptation(f.context, f.state));
  const second = await bundle(f, 'second', ['practice']);
  await publish(f, second, 'second');
  assert.notDeepEqual(firstIntro, original);
  assert.equal(f.state.plan.targetDigests.find(t => t.blockId === 'intro').digest, second.proposal.artifacts[0].digest);
  await assert.rejects(revertAdaptation(f.context, f.state, command(f, 'revert-first-early', { admissionId: first.admissionId })), code('REVERT_DEPENDENCY'));
  advance(f, await revertAdaptation(f.context, f.state, command(f, 'revert-second', { admissionId: second.admissionId })));
  assert.deepEqual(introOf(await materializeAdaptation(f.context, f.state)), firstIntro);
  assert.equal(f.state.plan.targetDigests.find(t => t.blockId === 'intro').digest, first.proposal.artifacts[0].digest);
  advance(f, await revertAdaptation(f.context, f.state, command(f, 'revert-first', { admissionId: first.admissionId })));
  assert.deepEqual(introOf(await materializeAdaptation(f.context, f.state)), original);
  assert.equal(f.state.plan.targetDigests.length, 0);
  // A new rewrite targets the base block again.
  await publish(f, await bundle(f, 'third', ['practice']), 'third');
  assert.equal(f.state.plan.revision, 5);
});

test('a tampered revert chain is rejected on read', async () => {
  const f = await fixture(), b = await bundle(f, 'one');
  await publish(f, b, 'one');
  advance(f, await revertAdaptation(f.context, f.state, command(f, 'revert-one', { admissionId: b.admissionId })));
  const forged = structuredClone(f.state);
  forged.admissions[0].status = 'applied';
  await assert.rejects(materializeAdaptation(f.context, forged), code('STATE_DIGEST_MISMATCH'));
});
