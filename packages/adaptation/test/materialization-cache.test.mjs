import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '@course-core/sdk';
import { admitAdaptation, applyAdaptation, materializeAdaptation, proposalValidationStatistics, clearValidatedProposals } from '../dist/index.js';
import { fixture, bundle, command, advance, code, freeze } from './helpers.mjs';

const roomy = { policy: p => { for (const scope of p.scopes) scope.work = { additionalMinutes: 500, additionalEpisodes: 50, remediationCyclesPerConcept: 100 }; } };
const delta = (before, after = proposalValidationStatistics()) => Object.fromEntries(Object.keys(before).map(k => [k, after[k] - before[k]]));
async function applied(n) {
  const f = await fixture(roomy);
  for (let i = 0; i < n; i++) {
    const b = await bundle(f, `m${i}`);
    advance(f, await admitAdaptation(f.context, f.state, command(f, `admit-${i}`, b)));
    advance(f, await applyAdaptation(f.context, f.state, command(f, `apply-${i}`, { admissionId: b.admissionId })));
  }
  return f;
}
async function resealed(state, change) {
  const copy = structuredClone(state); change(copy);
  const { digest: _digest, ...data } = copy; copy.digest = await digestJson(data); return copy;
}

test('after the first read of a state, reads neither project nor validate the course again', async () => {
  const f = await applied(5);
  let before = proposalValidationStatistics();
  const first = await materializeAdaptation(f.context, f.state);
  assert.equal(delta(before).projections, 1);
  before = proposalValidationStatistics();
  for (let i = 0; i < 10; i++) assert.equal(await materializeAdaptation(f.context, f.state), first);
  const reads = delta(before);
  assert.deepEqual({ projections: reads.projections, projectionReuses: reads.projectionReuses, courseValidations: reads.courseValidations,
    sdkValidations: reads.sdkValidations, retainedValidations: reads.retainedValidations, stateChecks: reads.stateChecks },
  { projections: 0, projectionReuses: 10, courseValidations: 0, sdkValidations: 0, retainedValidations: 0, stateChecks: 0 });
  // A new adaptation is projected once, then reused.
  const next = await bundle(f, 'later');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-later', next)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-later', { admissionId: next.admissionId })));
  before = proposalValidationStatistics();
  for (let i = 0; i < 5; i++) await materializeAdaptation(f.context, f.state);
  assert.deepEqual([delta(before).projections, delta(before).projectionReuses], [1, 4]);
});

test('a host passing the same deeply frozen course is not re-hashed per read', async () => {
  const f = await applied(3);
  f.context.course = freeze(structuredClone(f.context.course));
  await materializeAdaptation(f.context, f.state);
  const before = proposalValidationStatistics();
  for (let i = 0; i < 5; i++) await materializeAdaptation(f.context, f.state);
  assert.deepEqual([delta(before).courseDigests, delta(before).courseValidations, delta(before).projections], [0, 0, 0]);
  // A mutable course is copied and hashed again on every read.
  const mutable = { ...f.context, course: structuredClone(f.context.course) };
  const again = proposalValidationStatistics();
  await materializeAdaptation(mutable, f.state);
  assert.deepEqual([delta(again).courseDigests, delta(again).courseValidations], [1, 0]);
});

test('views are identical with and without recorded views, frozen and shared read-only', async () => {
  const f = await applied(4);
  const warm = await materializeAdaptation(f.context, f.state);
  clearValidatedProposals();
  const cold = await materializeAdaptation(f.context, f.state);
  assert.notEqual(cold, warm);
  assert.deepEqual(cold, warm);
  assert.equal(JSON.stringify(cold), JSON.stringify(warm)); // Same key order too.
  const frozenCourse = await materializeAdaptation({ ...f.context, course: freeze(structuredClone(f.context.course)) }, f.state);
  assert.equal(JSON.stringify(frozenCourse), JSON.stringify(warm));
  assert.ok(Object.isFrozen(warm.server.chapters[0].episodes[0].blocks) && Object.isFrozen(warm.learner));
  assert.throws(() => { warm.server.chapters[0].episodes[0].blocks.push({ id: 'x', type: 'text', markdown: 'x' }); }, TypeError);
  // The caller's own course and state are never frozen or changed.
  assert.ok(!Object.isFrozen(f.context.course) && !Object.isFrozen(f.state));
  assert.equal(f.context.course.chapters[0].episodes[0].blocks.length, 2);
});

test('tampering is still rejected while the untampered view is recorded', async () => {
  const f = await applied(4);
  const view = await materializeAdaptation(f.context, f.state);
  const before = proposalValidationStatistics();
  const unsealed = structuredClone(f.state); unsealed.admissions[1].proposal.artifacts[0].markdown = 'Tampered teaching.';
  await assert.rejects(materializeAdaptation(f.context, unsealed), code('STATE_DIGEST_MISMATCH'));
  const keepDigest = structuredClone(f.state); keepDigest.plan.revision = 99;
  await assert.rejects(materializeAdaptation(f.context, keepDigest), code('STATE_DIGEST_MISMATCH'));
  const teaching = await resealed(f.state, s => { s.admissions[1].proposal.artifacts[0].markdown = 'Tampered teaching.'; });
  await assert.rejects(materializeAdaptation(f.context, teaching), code('ARTIFACT_DIGEST_MISMATCH'));
  const shape = await resealed(f.state, s => { s.admissions[0].unexpected = true; });
  await assert.rejects(materializeAdaptation(f.context, shape), code('INVALID_INPUT'));
  const changedPolicy = structuredClone(f.context); changedPolicy.policy.reservations[0].work.additionalMinutes = 1;
  await assert.rejects(materializeAdaptation(changedPolicy, f.state), code('RESERVATION_BINDING'));
  const otherBase = structuredClone(f.context); otherBase.course.title = 'Another immutable base';
  await assert.rejects(materializeAdaptation(otherBase, f.state), error => ['EVIDENCE_BINDING', 'BASE_BINDING'].includes(error?.code));
  assert.equal(delta(before).projections, 0); // Nothing rejected was projected or recorded.
  assert.equal(await materializeAdaptation(f.context, f.state), view);
});

test('recorded views are bounded', async () => {
  const f = await applied(1);
  for (let i = 0; i < 40; i++) {
    const b = await bundle(f, `b${i}`);
    advance(f, await admitAdaptation(f.context, f.state, command(f, `admit-b${i}`, b)));
    advance(f, await applyAdaptation(f.context, f.state, command(f, `apply-b${i}`, { admissionId: b.admissionId })));
    await materializeAdaptation(f.context, f.state);
  }
  const stats = proposalValidationStatistics();
  assert.ok(stats.recordedViews <= 32 && stats.recordedCourses <= 16, JSON.stringify(stats));
});
