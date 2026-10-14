import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNumericalExerciseGenerator, createNumericalArtifactVerifier, generateFreshNumericalVariant, admitAdaptation, applyAdaptation,
  materializeAdaptation, proposalValidationStatistics, validateAdaptationProposal } from '../dist/index.js';
import { fixture, bundle, command, advance, code, freeze } from './helpers.mjs';

const roomy = { policy: p => { for (const scope of p.scopes) scope.work = { additionalMinutes: 500, additionalEpisodes: 50, remediationCyclesPerConcept: 100 }; } };
const delta = (before, after = proposalValidationStatistics()) => Object.fromEntries(Object.keys(before).map(k => [k, after[k] - before[k]]));
const reference = { verifierId: 'reviewer', verifierVersion: '1.0.0', checkId: 'reference', evaluate: async input => Math.min(input.variables.a, input.variables.b) };
const options = course => ({ course, canonicalAssessmentId: 'canonical', templateId: 'minimum-recipe', generatorId: 'creator' });
const request = suffix => ({ artifactId: `artifact-${suffix}`, assessmentId: `assessment-${suffix}`, canonicalAssessmentId: 'canonical',
  templateId: 'minimum-recipe', episodeId: 'pair', startOrdinal: 0, maximumCandidates: 16 });
/** A frozen base course, as the API's verified release cache passes it, recorded by a first read. */
async function frozenFixture() {
  const f = await fixture(roomy);
  f.context.course = freeze(structuredClone(f.context.course));
  await materializeAdaptation(f.context, f.state);
  return f;
}

test('a recorded frozen base course is neither copied, hashed nor validated again by admission, application or numerical ports', async () => {
  const f = await frozenFixture(), before = proposalValidationStatistics();
  const generator = await createNumericalExerciseGenerator(options(f.context.course));
  const verifier = await createNumericalArtifactVerifier({ ...options(f.context.course), registration: f.context.registry.verifiers[0] }, reference);
  const fresh = await generateFreshNumericalVariant(f.context.course, f.state, request('shared'), generator, verifier);
  assert.equal(fresh.verification.checks[0].result, 'passed');
  const b = await bundle(f, 'shared');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-shared', b)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-shared', { admissionId: b.admissionId })));
  const work = delta(before);
  assert.deepEqual({ digests: work.courseDigests, validations: work.courseValidations }, { digests: 0, validations: 0 });
  assert.ok(work.courseReuses >= 5);
  // The course was shared read-only: it is still frozen and the plan advanced normally.
  assert.ok(Object.isFrozen(f.context.course.assessments[0])); assert.equal(f.state.plan.revision, 1);
});

test('an unrecorded or mutable course is still copied and validated in full', async () => {
  const f = await fixture(roomy);
  const mutable = structuredClone(f.context.course), before = proposalValidationStatistics();
  await createNumericalExerciseGenerator(options(mutable));
  assert.equal(delta(before).courseValidations, 1);
  // Deeply frozen but never validated here: not trusted, so an invalid course is rejected.
  const invalid = structuredClone(f.context.course); invalid.gates[0].assessmentIds = ['missing-item'];
  await assert.rejects(createNumericalExerciseGenerator(options(freeze(invalid))), code('INVALID_COURSE'));
  // A mutable course changed after an earlier identical one was recorded is validated again.
  const changed = structuredClone(f.context.course); changed.adaptation.families[0].numericalRecipeIds = ['unknown-recipe'];
  await assert.rejects(createNumericalExerciseGenerator(options(changed)), code('INVALID_COURSE'));
});

test('admission reuses a host validation of the exact same bytes, and only of those bytes', async () => {
  const f = await frozenFixture(), b = await bundle(f, 'host');
  const input = { course: f.context.course, baseCourseDigest: f.state.baseCourseDigest, plan: f.state.plan, registeredVerifiers: f.context.registry.verifiers };
  let before = proposalValidationStatistics();
  const hosted = await validateAdaptationProposal(input, b.proposal, b.assignments);
  assert.equal(delta(before).sdkValidations, 1);
  before = proposalValidationStatistics();
  const admitted = advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-host', b)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-host', { admissionId: b.admissionId })));
  assert.deepEqual([delta(before).sdkValidations, delta(before).proposalReuses], [0, 2]);
  assert.equal(admitted.state.admissions[0].proposalDigest, hosted.proposalDigest);
  assert.deepEqual(admitted.state.admissions[0].proposal, b.proposal);

  // The same proposal with one assignment changed beyond the author limit is a different key: validated in full and rejected.
  const next = await bundle(f, 'changed');
  await validateAdaptationProposal({ ...input, plan: f.state.plan }, next.proposal, next.assignments);
  next.assignments[0].plannedMinutes = 999;
  before = proposalValidationStatistics();
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit-changed', next)), code('AUTHOR_LIMIT'));
  assert.deepEqual([delta(before).sdkValidations, delta(before).proposalReuses], [1, 0]);
});

test('a proposal that is itself invalid is reported before malformed assignments, as before', async () => {
  const f = await frozenFixture(), b = await bundle(f, 'order');
  const input = { course: f.context.course, baseCourseDigest: f.state.baseCourseDigest, plan: f.state.plan, registeredVerifiers: f.context.registry.verifiers };
  const stale = { ...b.proposal, expectedPlanRevision: b.proposal.expectedPlanRevision + 1 };
  await assert.rejects(validateAdaptationProposal(input, stale, [{ unexpected: true }]), code('STALE_PLAN'));
  // A valid proposal with malformed assignments reports the assignments' issue.
  await assert.rejects(validateAdaptationProposal(input, b.proposal, [{ unexpected: true }]), error => error?.name === 'AdaptationError' && error.code !== 'STALE_PLAN');
});

test('failed host validations are never recorded', async () => {
  const f = await frozenFixture(), b = await bundle(f, 'failed');
  b.assignments[0].plannedMinutes = 999;
  const input = { course: f.context.course, baseCourseDigest: f.state.baseCourseDigest, plan: f.state.plan, registeredVerifiers: f.context.registry.verifiers };
  for (let i = 0; i < 2; i++) {
    const before = proposalValidationStatistics();
    await assert.rejects(validateAdaptationProposal(input, b.proposal, b.assignments), code('AUTHOR_LIMIT'));
    assert.equal(delta(before).sdkValidations, 1);
  }
  // A digest that does not name this course is rejected by the SDK and not recorded either.
  await assert.rejects(validateAdaptationProposal({ ...input, baseCourseDigest: 'f'.repeat(64) }, b.proposal, b.assignments), code('BASE_DIGEST_MISMATCH'));
  const before = proposalValidationStatistics();
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit-failed', b)), code('AUTHOR_LIMIT'));
  assert.equal(delta(before).sdkValidations, 1);
});
