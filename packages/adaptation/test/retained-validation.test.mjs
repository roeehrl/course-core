import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '@course-core/sdk';
import { admitAdaptation, applyAdaptation, materializeAdaptation, proposalValidationStatistics, clearValidatedProposals } from '../dist/index.js';
import { fixture, bundle, command, advance, code } from './helpers.mjs';

const roomy = { policy: p => { for (const scope of p.scopes) scope.work = { additionalMinutes: 500, additionalEpisodes: 50, remediationCyclesPerConcept: 100 }; } };
const delta = (before, after = proposalValidationStatistics()) => Object.fromEntries(Object.keys(before).map(k => [k, after[k] - before[k]]));
async function applied(n) {
  const f = await fixture(roomy), perApply = [];
  for (let i = 0; i < n; i++) {
    const b = await bundle(f, `r${i}`), before = proposalValidationStatistics();
    advance(f, await admitAdaptation(f.context, f.state, command(f, `admit-${i}`, b)));
    advance(f, await applyAdaptation(f.context, f.state, command(f, `apply-${i}`, { admissionId: b.admissionId })));
    perApply.push(delta(before));
  }
  return { f, perApply };
}
/** Recompute the unkeyed snapshot digest, as someone with direct database access could. */
async function resealed(state, change) {
  const copy = structuredClone(state); change(copy);
  const { digest: _digest, ...data } = copy; copy.digest = await digestJson(data); return copy;
}

test('per-request validation does not grow with the number of applied adaptations', async () => {
  const N = 12, { f, perApply } = await applied(N);
  assert.equal(f.state.plan.revision, N);
  // Admission validates the new proposal in full and application reuses that record for the same bytes;
  // nothing already applied is revalidated.
  for (const step of perApply) assert.deepEqual({ sdk: step.sdkValidations, reused: step.proposalReuses, retained: step.retainedValidations }, { sdk: 1, reused: 1, retained: 0 });
  const before = proposalValidationStatistics();
  for (let i = 0; i < 5; i++) await materializeAdaptation(f.context, f.state);
  // The newest state is checked once (reusing every proposal record), then reused.
  assert.deepEqual(delta(before), { ...delta(before), sdkValidations: 0, retainedValidations: 0, stateChecks: 1, stateReuses: 4 });
});

test('a process that never saw the adaptations validates each retained admission exactly once', async () => {
  const N = 6, { f } = await applied(N);
  clearValidatedProposals();
  let before = proposalValidationStatistics();
  const first = await materializeAdaptation(f.context, f.state);
  assert.equal(delta(before).sdkValidations, N); assert.equal(delta(before).retainedValidations, N);
  before = proposalValidationStatistics();
  const second = await materializeAdaptation(f.context, f.state);
  assert.equal(delta(before).sdkValidations, 0);
  assert.deepEqual(second, first);
});

test('materialization stays deterministic and equal with and without recorded checks', async () => {
  const { f } = await applied(4);
  const warm = await materializeAdaptation(f.context, f.state);
  clearValidatedProposals();
  assert.deepEqual(await materializeAdaptation(f.context, f.state), warm);
  assert.equal(warm.planRevision, 4); assert.equal(warm.server.chapters[0].episodes[0].blocks.length, 2 + 4);
});

test('a tampered stored adaptation is rejected even when the original was already validated', async () => {
  const { f } = await applied(4), pending = await bundle(f, 'pending');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-pending', pending))); // Reserved, not applied.
  await materializeAdaptation(f.context, f.state); // Warm every record for the untampered state.
  // Changed bytes with the old digest.
  const unsealed = structuredClone(f.state); unsealed.admissions[1].proposal.artifacts[0].markdown = 'Tampered teaching.';
  await assert.rejects(materializeAdaptation(f.context, unsealed), code('STATE_DIGEST_MISMATCH'));
  // Changed teaching with a recomputed state digest: full validation runs and the proposal digest differs.
  const teaching = await resealed(f.state, s => { s.admissions[1].proposal.artifacts[0].markdown = 'Tampered teaching.'; });
  await assert.rejects(materializeAdaptation(f.context, teaching), code('ARTIFACT_DIGEST_MISMATCH'));
  // Applied assignments are bound by the plan hash chain.
  const chained = await resealed(f.state, s => { s.admissions[2].assignments[0].plannedMinutes = 1; });
  await assert.rejects(materializeAdaptation(f.context, chained), code('INVALID_STATE'));
  // A retained admission's assignment raised beyond the author limit is caught by the SDK again, not by a stale record.
  const before = proposalValidationStatistics();
  const cost = await resealed(f.state, s => { s.admissions.find(a => a.id === pending.admissionId).assignments[0].plannedMinutes = 99; });
  await assert.rejects(materializeAdaptation(f.context, cost), code('AUTHOR_LIMIT'));
  assert.equal(delta(before).retainedValidations, 1);
  // A substituted verifier registration is revalidated and rejected.
  const verifier = await resealed(f.state, s => { s.admissions[0].admittedVerifiers[0].version = '9.9.9'; });
  await assert.rejects(materializeAdaptation(f.context, verifier), code('UNREGISTERED_VERIFIER'));
  // Reordered applications break the lineage.
  const reordered = await resealed(f.state, s => { s.applications.reverse(); });
  await assert.rejects(materializeAdaptation(f.context, reordered), code('INVALID_STATE'));
  // A verified state is still checked against the current policy reservations every time.
  const changedPolicy = structuredClone(f.context); changedPolicy.policy.reservations[0].work.additionalMinutes = 1;
  await assert.rejects(materializeAdaptation(changedPolicy, f.state), code('RESERVATION_BINDING'));
  // The untampered state still materializes.
  assert.equal((await materializeAdaptation(f.context, f.state)).planRevision, 4);
});

test('recorded checks are bounded and answer only for the base course they were made against', async () => {
  const { f } = await applied(2);
  await materializeAdaptation(f.context, f.state);
  const other = structuredClone(f.context); other.course.title = 'Another immutable base';
  await assert.rejects(materializeAdaptation(other, f.state), error => ['EVIDENCE_BINDING', 'BASE_BINDING'].includes(error?.code));
  const stats = proposalValidationStatistics();
  assert.ok(stats.recordedProposals <= 10000 && stats.recordedStates <= 2000);
});
