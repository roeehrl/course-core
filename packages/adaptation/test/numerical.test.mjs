import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestAdaptationProposal, digestTeachingArtifact } from '@course-core/sdk';
import { createNumericalExerciseGenerator, createNumericalArtifactVerifier, generateFreshNumericalVariant,
  admitAdaptation, applyAdaptation, materializeAdaptation } from '../dist/index.js';
import { fixture, bundle, authorize, command, advance, code } from './helpers.mjs';

async function ports(f, evaluate) {
  const config = { course: f.context.course, canonicalAssessmentId: 'canonical', templateId: 'minimum-recipe', generatorId: 'creator' };
  const generator = await createNumericalExerciseGenerator(config);
  // Independent reference: explicit ordering branch, not the SDK AST interpreter.
  const reference = { verifierId: 'reviewer', verifierVersion: '1.0.0', checkId: 'reference', evaluate: evaluate ?? (async input => {
    assert.deepEqual(Object.keys(input).sort(), ['templateDigest', 'variables']);
    return input.variables.a <= input.variables.b ? input.variables.a : input.variables.b;
  }) };
  const verifier = await createNumericalArtifactVerifier({ ...config, registration: f.context.registry.verifiers[0] }, reference);
  return { generator, verifier };
}
const request = (suffix = 'fresh') => ({ artifactId: `artifact-${suffix}`, assessmentId: `assessment-${suffix}`, canonicalAssessmentId: 'canonical',
  templateId: 'minimum-recipe', episodeId: 'pair', startOrdinal: 0, maximumCandidates: 16 });

test('failed learner gets a fresh independently checked numerical question without resetting evidence or inventing a family', async () => {
  const f = await fixture(), { generator, verifier } = await ports(f);
  assert.deepEqual(generator.registration.artifactKinds, ['assessment_variant']);
  assert.deepEqual(verifier.registration.artifactKinds, ['assessment_variant']);
  assert.deepEqual(verifier.registration.checkIds, ['reference']);
  const first = await generateFreshNumericalVariant(f.context.course, f.state, request(), generator, verifier);
  assert.equal(first.ordinal, 1); // Ordinal zero reproduces the exhausted canonical question.
  assert.equal(first.artifact.assessment.prompt, 'Enter the smaller of 2 and 5.');
  assert.equal(first.artifact.assessment.grading.expected, 2);
  assert.equal(first.verification.checks[0].result, 'passed'); assert.equal(first.publicationAuthority, 'not_granted');
  assert.deepEqual(first, await generateFreshNumericalVariant(f.context.course, f.state, request(), generator, verifier));
  const b = await bundle(f, 'fresh', ['assessment_variant']); b.proposal.artifacts = [first.artifact]; b.proposal.operations[0].artifactId = first.artifact.id;
  // Recheck against the final exact proposal before the test host persists its authenticated record.
  const checked = await verifier.verify({ baseCourseDigest: f.state.baseCourseDigest, proposalDigest: await digestAdaptationProposal(b.proposal),
    artifact: first.artifact, requiredCheckIds: ['reference'] }, {});
  assert.equal(checked.checks[0].result, 'passed');
  await authorize(f, b);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-fresh', b)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-fresh', { admissionId: b.admissionId })));
  const view = await materializeAdaptation(f.context, f.state);
  assert.equal(view.variants[0].canonicalAssessmentId, 'canonical'); assert.equal(view.variants[0].canonicalFamilyId, 'minimum');
  assert.equal(view.server.gates[0].minimumIndependentFamilies, 1); assert.deepEqual(view.server.gates[0].assessmentIds, ['canonical']);
  assert.equal(f.evidenceRecord.correct, false); assert.equal(f.context.evidence.revision, 1);
  assert.equal(f.state.plan.variantCounts[0].count, 1);
  const second = await generateFreshNumericalVariant(f.context.course, f.state, request('next'), generator, verifier);
  assert.equal(second.ordinal, 2); assert.equal(second.artifact.assessment.grading.expected, 3);
  assert.notEqual(first.artifact.assessment.prompt, second.artifact.assessment.prompt);
});

test('wrong generator answer and independently wrong reference both fail actual arithmetic verification', async () => {
  const f = await fixture(), good = await ports(f);
  const badGenerator = { registration: good.generator.registration, async generate(input, options) {
    const draft = await good.generator.generate(input, options); draft.assessment.grading.expected += 1; return draft;
  } };
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, request(), badGenerator, good.verifier), code('NUMERICAL_VERIFICATION_FAILED'));
  const badReference = await ports(f, async ({ variables }) => variables.a + variables.b);
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, request(), badReference.generator, badReference.verifier), code('NUMERICAL_VERIFICATION_FAILED'));
});

test('a malicious generator cannot rename the canonical family, source, objective, template or tolerance', async () => {
  for (const mutation of [
    a => { a.assessment.familyId = 'invented'; },
    a => { a.sourceRefs = ['reference-source']; },
    a => { a.objectiveIds = ['invented']; },
    a => { a.recipe.templateDigest = 'f'.repeat(64); },
    a => { a.assessment.grading.absoluteTolerance = 100; },
    a => { a.hiddenAuthority = true; },
  ]) {
    const f = await fixture(), p = await ports(f);
    const generator = { registration: p.generator.registration, async generate(input, options) { const a = await p.generator.generate(input, options); mutation(a); return a; } };
    await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, request(), generator, p.verifier));
  }
});

test('verifier cannot mutate the returned artifact or smuggle a proof-authority flag into its result', async () => {
  const f = await fixture(), p = await ports(f);
  const verifier = { registration: p.verifier.registration, async verify(input, options) {
    const result = await p.verifier.verify(input, options); input.artifact.assessment.grading.expected = 999;
    return result;
  } };
  const fresh = await generateFreshNumericalVariant(f.context.course, f.state, request(), p.generator, verifier);
  assert.equal(fresh.artifact.assessment.grading.expected, 2);
  const forged = { registration: p.verifier.registration, async verify(input, options) { return { ...await p.verifier.verify(input, options), authenticated: true }; } };
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, request(), p.generator, forged), code('INVALID_INPUT'));
});

test('bounds, nonfinite values, unsupported creator recipes and exhausted search are explicit failures', async () => {
  const f = await fixture(), p = await ports(f);
  for (const extra of [{ maximumCandidates: 0 }, { maximumCandidates: 257 }, { startOrdinal: Infinity }, { startOrdinal: -1 }, { eval: 'return 1' }]) {
    await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, { ...request(), ...extra }, p.generator, p.verifier));
  }
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, { ...request(), maximumCandidates: 1 }, p.generator, p.verifier), code('FRESH_VARIANT_UNAVAILABLE'));
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, { ...request(), startOrdinal: 16 }, p.generator, p.verifier), code('RECIPE_SPACE_EXHAUSTED'));
  const nonfinite = await ports(f, async () => NaN);
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, request(), nonfinite.generator, nonfinite.verifier));
  const decimal = await fixture({ course: c => { c.adaptation.numericalRecipes[0].variables[0].integer = false; } }), decimalPorts = await ports(decimal);
  await assert.rejects(generateFreshNumericalVariant(decimal.context.course, decimal.state, request(), decimalPorts.generator, decimalPorts.verifier), code('CREATOR_REQUIRED'));
});

test('abort before generation and during the independent reference prevents returning a publishable candidate', async () => {
  const f = await fixture(), p = await ports(f), early = new AbortController(); early.abort();
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, request(), p.generator, p.verifier, { signal: early.signal }), code('ABORTED'));
  const interrupted = new AbortController(), q = await ports(f, async () => { interrupted.abort(); return 2; });
  await assert.rejects(generateFreshNumericalVariant(f.context.course, f.state, request(), q.generator, q.verifier, { signal: interrupted.signal }));
});

test('an incorrect numerical key fails admission even with newly hashed fake proof records', async () => {
  const f = await fixture(), b = await bundle(f, 'bad-key', ['assessment_variant']);
  b.proposal.artifacts[0].assessment.grading.expected = 999; await authorize(f, b);
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit', b)), code('RECIPE_OUTPUT_MISMATCH'));
});
