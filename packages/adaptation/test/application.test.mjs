import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestJson, validateCourseAdaptation } from '@course-core/sdk';
import { reserveWork, resolveConstraints } from '@course-core/policy';
import { admitAdaptation, applyAdaptation, cancelAdaptation, materializeAdaptation, createAdaptationState, previewAdaptation } from '../dist/index.js';
import { fixture, bundle, authorize, command, advance, code, freeze, NOW, LATE } from './helpers.mjs';

test('applies every teaching kind while preserving immutable objectives, base requirements, canonical families and evidence', async () => {
  const f = await fixture(), b = await bundle(f, 'all', ['explanation', 'practice', 'assessment_variant', 'visual', 'media', 'profile_suggestion']);
  const originalCourse = structuredClone(f.context.course), originalEvidence = structuredClone(f.context.evidence);
  const admission = await admitAdaptation(f.context, f.state, command(f, 'admit-all', b));
  assert.equal(admission.state.plan.revision, 0); assert.equal(admission.policy.reservations[0].state, 'reserved');
  assert.deepEqual(admission.policy.reservations[0].work, { additionalMinutes: 10, additionalEpisodes: 0, remediation: [{ conceptId: 'comparison-concept', cycles: 1 }] });
  advance(f, admission);
  const applied = advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-all', { admissionId: b.admissionId })));
  assert.equal(applied.state.plan.revision, 1); assert.equal(applied.policy.reservations[0].state, 'committed');
  assert.equal(applied.policy.reservations[0].work.additionalMinutes, 10);
  const view = await materializeAdaptation(f.context, f.state);
  assert.deepEqual(view.server.objectives, originalCourse.objectives); assert.deepEqual(view.server.gates, originalCourse.gates);
  assert.equal(view.server.chapters[0].episodes[0].requirement, 'required');
  assert.match(view.server.chapters[0].episodes[0].blocks[0].markdown, /fresh practice/);
  assert.equal(view.server.assessments.length, 2); assert.equal(view.variants[0].canonicalFamilyId, 'minimum');
  assert.equal(view.server.visuals.length, 1); assert.equal(view.server.media.length, 1);
  assert.equal(view.profileSuggestions.length, 1); assert.equal(view.assignments.length, 5);
  assert.equal(view.learner.assessments[1].id, view.variants[0].assessmentId);
  for (const hidden of ['HIDDEN_GENERATED_FIXTURE', 'absoluteTolerance', 'correctOptionId', 'grading', 'proofReceipts']) assert.ok(!JSON.stringify(view.learner).includes(hidden));
  assert.deepEqual(f.context.course, originalCourse); assert.deepEqual(f.context.evidence, originalEvidence);
  assert.deepEqual(applied.evidenceWrites, []); assert.deepEqual(applied.creditWrites, []);
  assert.equal(applied.preconditions.evidence.digest, originalEvidence.digest);
  assert.equal(applied.preconditions.adaptation.planRevision, 0);
  assert.equal(applied.preconditions.policy.ledgerRevision, 1);
  assert.equal(applied.preconditions.mustCommitBefore, LATE);
});

test('same idempotency key replays with fresh transport metadata and no duplicate publication or charge', async () => {
  const f = await fixture(), b = await bundle(f);
  const admitCommand = command(f, 'admit', b), first = advance(f, await admitAdaptation(f.context, f.state, admitCommand));
  const replay = await admitAdaptation(f.context, f.state, { ...admitCommand, now: LATE });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt); assert.deepEqual(replay.outbox, []);
  const applyCommand = command(f, 'apply', { admissionId: b.admissionId });
  const applied = advance(f, await applyAdaptation(f.context, f.state, applyCommand));
  const again = await applyAdaptation(f.context, f.state, { ...applyCommand, now: LATE });
  assert.equal(again.replayed, true); assert.deepEqual(again.receipt, applied.receipt); assert.deepEqual(again.state, f.state);
  assert.equal(again.policy.reservations.length, 1); assert.equal(again.state.plan.revision, 1); assert.deepEqual(again.outbox, []);
  await assert.rejects(applyAdaptation(f.context, f.state, command(f, 'new-apply-key', { admissionId: b.admissionId })), code('INVALID_ADMISSION_STATE'));
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit', { ...b, admissionId: 'different' })), code('IDEMPOTENCY_CONFLICT'));
});

test('stale plan competitors may reserve but only one sequential application succeeds; cancellation releases only unused work', async () => {
  const f = await fixture(), a = await bundle(f, 'a'), b = await bundle(f, 'b');
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-a', a)));
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-b', b)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-a', { admissionId: a.admissionId })));
  await assert.rejects(applyAdaptation(f.context, f.state, command(f, 'apply-b', { admissionId: b.admissionId })), code('STALE_PLAN'));
  advance(f, await cancelAdaptation(f.context, f.state, command(f, 'cancel-b', { admissionId: b.admissionId })));
  assert.deepEqual(f.context.policy.reservations.map(r => r.state), ['committed', 'cancelled']);
  assert.equal(f.state.plan.revision, 1);
  await assert.rejects(cancelAdaptation(f.context, f.state, command(f, 'cancel-a', { admissionId: a.admissionId })), code('INVALID_ADMISSION_STATE'));
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'reuse-b', b)), code('DUPLICATE_ADMISSION'));
});

test('pure competing transitions expose the same commit fence; they do not prove database race isolation', async () => {
  const f = await fixture(), a = await bundle(f, 'a'), b = await bundle(f, 'b');
  freeze(f); freeze(a); freeze(b);
  const [one, two] = await Promise.all([admitAdaptation(f.context, f.state, command(f, 'one', a)), admitAdaptation(f.context, f.state, command(f, 'two', b))]);
  assert.deepEqual(one.preconditions, two.preconditions);
  assert.notEqual(one.state.digest, two.state.digest);
  assert.equal(f.state.ledgerRevision, 0); assert.equal(f.context.policy.reservations.length, 0);
});

test('all explicit revision fences reject stale commands', async () => {
  const names = { expectedAdaptationRevision: 'STALE_ADAPTATION', expectedPolicyRevision: 'STALE_POLICY_REVISION',
    expectedPolicyLedgerRevision: 'STALE_POLICY_LEDGER', expectedRegistryRevision: 'STALE_REGISTRY', expectedEvidenceRevision: 'STALE_EVIDENCE' };
  for (const [field, expected] of Object.entries(names)) {
    const f = await fixture(), b = await bundle(f), args = command(f, 'admit', b); args[field]++;
    await assert.rejects(admitAdaptation(f.context, f.state, args), code(expected));
  }
});

test('a model-self-issued proof that passes SDK data checks still fails trusted registry matching', async () => {
  const f = await fixture(), b = await bundle(f);
  const sdk = await validateCourseAdaptation(b.proposal, { course: f.context.course, baseCourseDigest: f.state.baseCourseDigest,
    plan: f.state.plan, registeredVerifiers: f.context.registry.verifiers });
  assert.equal(sdk.valid, true); assert.equal(sdk.proofAuthenticity, 'not_checked');
  f.context.registry.proofs = [];
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit', b)), code('UNTRUSTED_PROOF'));
  assert.equal(f.context.policy.reservations.length, 0);
});

test('proof sources, hash, implementation version, claimed checks and canonical family cannot be forged', async () => {
  for (const mode of ['source', 'hash', 'implementation', 'version', 'checks', 'family']) {
    const f = await fixture(), b = await bundle(f, mode, ['assessment_variant']);
    if (mode === 'source') b.proposal.proofReceipts[0].sourceRefs = ['reference-source'];
    if (mode === 'hash') b.proposal.artifacts[0].hiddenFixtures = { changed: true };
    if (mode === 'implementation') b.proposal.proofReceipts[0].verifierImplementationDigest = 'f'.repeat(64);
    if (mode === 'version') b.proposal.proofReceipts[0].verifierVersion = '2.0.0';
    if (mode === 'checks') b.proposal.proofReceipts[0].checks = [{ id: 'invented', result: 'passed' }];
    if (mode === 'family') { b.proposal.artifacts[0].assessment.familyId = 'new-family'; await authorize(f, b); }
    await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit', b)));
    assert.equal(f.state.plan.revision, 0); assert.equal(f.context.policy.reservations.length, 0);
  }
});

test('proof/authority revocation after admission blocks publication without deleting drafts', async () => {
  for (const kind of ['proof', 'authority']) {
    const f = await fixture(), b = await bundle(f); advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit', b)));
    if (kind === 'proof') f.context.registry.proofs[0].status = 'revoked'; else f.context.registry.authorizations[0].status = 'revoked';
    f.context.registry.revision++;
    await assert.rejects(applyAdaptation(f.context, f.state, command(f, 'apply', { admissionId: b.admissionId })), code(kind === 'proof' ? 'UNTRUSTED_PROOF' : 'UNTRUSTED_AUTHORIZATION'));
    assert.equal(f.state.admissions[0].status, 'reserved'); assert.equal(f.context.policy.reservations[0].state, 'reserved');
  }
});

test('optional classification cannot reduce the authenticated cost or escape ancestor caps', async () => {
  const f = await fixture({ policy: p => { p.scopes[0].work.additionalMinutes = 1; } }), b = await bundle(f);
  b.assignments[0].classification = 'optional'; b.assignments[0].plannedMinutes = 0;
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'bypass', b)), code('ASSIGNMENT_BINDING'));
  b.assignments[0].plannedMinutes = 2; await authorize(f, b);
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'optional', b)), code('QUOTA_EXCEEDED'));
  assert.equal(f.context.policy.ledgerRevision, 0);
});

test('renamed/replacement work retains stable remediation counters; plan revisions never refill allowances', async () => {
  const f = await fixture({ policy: p => { p.scopes[0].work.remediationCyclesPerConcept = 1; } });
  const first = await bundle(f, 'initial', ['practice']);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-one', first)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-one', { admissionId: first.admissionId })));
  const second = await bundle(f, 'renamed', ['practice']); second.assignments[0].classification = 'optional'; await authorize(f, second);
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit-two', second)), code('QUOTA_EXCEEDED'));
  const quota = resolveConstraints(f.context.policy, 'unit-scope').quotas.find(q => q.scopeId === 'course-scope' && q.metric === 'remediationCyclesPerConcept');
  assert.equal(quota.consumed, 1); assert.equal(quota.remaining, 0);
  f.context.registry.objectiveConcepts[0].conceptId = 'new-concept'; f.context.policy.conceptIds.push('new-concept');
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'remap', second)), code('BINDINGS_CHANGED'));
});

test('core work reservation headroom is counted before enrichment', async () => {
  const f = await fixture();
  f.context.policy = reserveWork(f.context.policy, { expectedPolicyRevision: 1, expectedLedgerRevision: 0, idempotencyKey: 'core-reserve', now: NOW,
    reservationId: 'core-final-work', scopeId: 'course-scope', work: { additionalMinutes: 19 } }).state;
  f.context.registry.protectedReservationIds = ['core-final-work'];
  const b = await bundle(f);
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit', b)), code('QUOTA_EXCEEDED'));
  assert.equal(f.context.policy.reservations.length, 1);
});

test('late publication, policy migration and new evidence invalidate an admitted job', async () => {
  for (const mode of ['deadline', 'policy', 'evidence']) {
    const f = await fixture(), b = await bundle(f); advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit', b)));
    if (mode === 'policy') f.context.policy.policyRevision++;
    if (mode === 'evidence') { f.context.evidence.revision++; f.context.evidence.digest = 'e'.repeat(64); }
    const args = command(f, 'apply', { admissionId: b.admissionId }); if (mode === 'deadline') args.now = LATE;
    await assert.rejects(applyAdaptation(f.context, f.state, args), code(mode === 'deadline' ? 'DEADLINE_REACHED' : mode === 'policy' ? 'STALE_JOB' : 'STALE_EVIDENCE'));
    advance(f, await cancelAdaptation(f.context, f.state, command(f, 'cancel', { admissionId: b.admissionId, now: LATE })));
    assert.equal(f.context.policy.reservations[0].state, 'cancelled');
  }
});

test('base-unit requirement changes, credit fields and unrelated assessment replacement are denied', async () => {
  for (const mode of ['requirement', 'credit', 'assessment']) {
    const f = await fixture(), b = await bundle(f, mode, ['practice']);
    if (mode === 'requirement') b.proposal.operations[0].requirement = 'optional';
    if (mode === 'credit') b.proposal.credit = 'passed';
    if (mode === 'assessment') { b.proposal.operations[0].blockId = 'canonical-block'; await authorize(f, b); }
    await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit', b)));
  }
});

test('nonfinite/unknown data and getters fail closed without execution; input snapshots cannot change after call', async () => {
  const f = await fixture(), b = await bundle(f);
  for (const bad of [NaN, Infinity, null, -1]) await assert.rejects(admitAdaptation(f.context, f.state, { ...command(f, 'admit', b), expectedAdaptationRevision: bad }));
  await assert.rejects(admitAdaptation(f.context, f.state, { ...command(f, 'admit', b), bypassCaps: true }), code('INVALID_INPUT'));
  let reads = 0; const bad = Object.defineProperty(command(f, 'admit', b), 'attack', { enumerable: true, get() { reads++; return 'data'; } });
  await assert.rejects(admitAdaptation(f.context, f.state, bad), code('INVALID_INPUT')); assert.equal(reads, 0);
  const args = command(f, 'admit', b), pending = admitAdaptation(f.context, f.state, args);
  args.proposal.rationale = 'mutated after call'; f.context.registry.proofs = [];
  const result = await pending; assert.equal(result.state.admissions[0].proposal.rationale, 'Offer a verified alternate representation after a failed attempt.');
});

test('integrity failures and missing protected core reservations are rejected', async () => {
  const f = await fixture(), b = await bundle(f); f.state.plan.revision++;
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit', b)), code('STATE_DIGEST_MISMATCH'));
  const g = await fixture(); g.context.registry.protectedReservationIds = ['missing'];
  await assert.rejects(createAdaptationState(g.context), code('CORE_HEADROOM_LOST'));
  g.context.registry.protectedReservationIds = []; g.context.policy.coreObjectiveIds = ['invented'];
  await assert.rejects(createAdaptationState(g.context), code('CORE_OBJECTIVES_CHANGED'));
});

test('preview is deterministic and does not reserve, publish or consume state', async () => {
  const f = await fixture(), b = await bundle(f), args = command(f, 'preview', b), before = structuredClone(f);
  const preview = await previewAdaptation(f.context, f.state, args);
  assert.deepEqual(preview, await previewAdaptation(f.context, f.state, args));
  assert.equal(preview.reservations[0].work.additionalMinutes, 2); assert.deepEqual(f, before);
});

test('multiple replacement revisions retain historical cost and bind the current artifact', async () => {
  const f = await fixture(), first = await bundle(f, 'first', ['practice']);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-first', first)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-first', { admissionId: first.admissionId })));
  const second = await bundle(f, 'second', ['practice']); second.proposal.artifacts[0].markdown = 'A newer verified explanation.'; await authorize(f, second);
  assert.equal(second.proposal.operations[0].expectedTargetDigest, first.proposal.artifacts[0].digest);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-second', second)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-second', { admissionId: second.admissionId })));
  assert.equal((await materializeAdaptation(f.context, f.state)).server.chapters[0].episodes[0].blocks[0].markdown, 'A newer verified explanation.');
  assert.equal(f.context.policy.reservations.filter(r => r.state === 'committed').length, 2);
  assert.equal(f.state.plan.revision, 2); assert.equal(f.state.admissions.length, 2);
});

test('renamed duplicate assessment questions cannot reset item exhaustion', async () => {
  const f = await fixture(), first = await bundle(f, 'first', ['assessment_variant']);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit-first', first)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-first', { admissionId: first.admissionId })));
  const renamed = await bundle(f, 'renamed', ['assessment_variant']);
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'admit-renamed', renamed)), code('DUPLICATE_QUESTION'));
});

test('unused cancelled drafts may be reauthorized without refunding any applied work', async () => {
  const f = await fixture(), b = await bundle(f, 'unused', ['assessment_variant']);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'reserve-unused', b)));
  advance(f, await cancelAdaptation(f.context, f.state, command(f, 'cancel-unused', { admissionId: b.admissionId })));
  const retry = await bundle(f, 'retry', ['assessment_variant']);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'reserve-retry', retry)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply-retry', { admissionId: retry.admissionId })));
  assert.deepEqual(f.context.policy.reservations.map(r => r.state), ['cancelled', 'committed']);
  assert.equal(f.state.plan.variantCounts[0].count, 1);
});

test('a later scope denial returns no partial reservation effects', async () => {
  const f = await fixture({
    course(c) {
      c.chapters[0].episodes.push({ id: 'second-pair', title: 'Second scope', objectiveIds: ['compare'], blocks: [{ id: 'second-text', type: 'text', markdown: 'Compare again.' }] });
      c.adaptation.targets.push({ episodeId: 'second-pair', objectiveIds: ['compare'], allowedOperations: ['append_teaching'], replaceableBlockIds: [] });
    },
    policy(p) { p.scopes.push({ scopeId: 'z-denied', parentScopeId: 'course-scope', policyId: 'z-policy', kind: 'episode', mode: 'bounded', work: { additionalMinutes: 0 }, existingMaterialAccess: 'read_only' }); },
    registry(r) { r.episodeScopes.push({ episodeId: 'second-pair', scopeId: 'z-denied' }); },
  });
  const b = await bundle(f, 'multi', ['explanation', 'explanation']); b.proposal.operations[1].episodeId = 'second-pair'; await authorize(f, b);
  const before = structuredClone(f);
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'multi', b)), code('QUOTA_EXCEEDED'));
  assert.deepEqual(f, before);
});

test('author family limits, registry time bounds and reinitialization cannot be bypassed', async () => {
  const f = await fixture({ course: c => { c.adaptation.families[0].maxVariantsPerPlan = 1; } });
  const b = await bundle(f, 'first', ['assessment_variant']);
  f.context.registry.authorizations[0].expiresAt = '2032-04-04T00:00:00Z';
  const admitted = advance(f, await admitAdaptation(f.context, f.state, command(f, 'first', b)));
  assert.equal(admitted.preconditions.mustCommitBefore, '2032-04-04T00:00:00Z');
  await assert.rejects(createAdaptationState(f.context), code('RESET_FORBIDDEN'));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply', { admissionId: b.admissionId })));
  const extra = await bundle(f, 'second', ['assessment_variant']);
  await assert.rejects(admitAdaptation(f.context, f.state, command(f, 'extra', extra)), code('AUTHOR_LIMIT'));
  const g = await fixture(), expired = await bundle(g);
  g.context.registry.authorizations[0].expiresAt = NOW;
  await assert.rejects(admitAdaptation(g.context, g.state, command(g, 'expired', expired)), code('AUTHORIZATION_EXPIRED'));
});

test('generic choice variants use the same application path without a numerical creator or invented family', async () => {
  const f = await fixture({ course(c) {
    c.title = 'Public language examples'; c.objectives[0].description = 'Recognize a greeting.';
    c.assessments[0] = { id: 'canonical', type: 'choice', objectiveIds: ['compare'], familyId: 'greeting-family',
      prompt: 'Select the greeting.', options: [{ id: 'hello', text: 'Hello' }, { id: 'bye', text: 'Goodbye' }],
      grading: { correctOptionId: 'hello', explanation: 'Hello is a greeting.' } };
    c.adaptation.families[0].familyId = 'greeting-family'; c.adaptation.families[0].numericalRecipeIds = []; c.adaptation.numericalRecipes = [];
  } });
  const b = await bundle(f, 'language');
  const old = b.proposal.artifacts[0];
  b.proposal.artifacts[0] = { id: old.id, digest: old.digest, generator: old.generator, sourceRefs: old.sourceRefs, objectiveIds: old.objectiveIds,
    kind: 'assessment_variant', canonicalAssessmentId: 'canonical', assessment: { ...structuredClone(f.context.course.assessments[0]),
      id: 'greeting-variant', prompt: 'What would you say on meeting someone?', options: [{ id: 'hello', text: 'Hello' }, { id: 'bye', text: 'Goodbye' }] } };
  b.proposal.operations[0].type = 'add_assessment_variant'; await authorize(f, b);
  advance(f, await admitAdaptation(f.context, f.state, command(f, 'admit', b)));
  advance(f, await applyAdaptation(f.context, f.state, command(f, 'apply', { admissionId: b.admissionId })));
  const view = await materializeAdaptation(f.context, f.state);
  assert.equal(view.variants[0].canonicalFamilyId, 'greeting-family');
  assert.equal(view.server.assessments[1].type, 'choice'); assert.equal('options' in view.learner.assessments[1], false);
});
