import { digestJson, digestTeachingArtifact, digestAdaptationProposal, instantiateNumericalRecipe } from '@course-core/sdk';
import { createPolicyState } from '@course-core/policy';
import { createAdaptationState } from '../dist/index.js';

export const NOW = '2032-04-03T10:00:00Z';
export const LATE = '2032-04-10T00:00:00Z';
const kinds = ['explanation', 'practice', 'assessment_variant', 'visual', 'media', 'profile_suggestion'];
export function course() {
  const extension = (id, capability, execution = 'server') => ({ id, version: '1.0.0', platforms: ['web'], execution,
    capabilities: [capability], entrypoint: `extensions/${id}.js`, integrity: `sha256-${'a'.repeat(64)}`,
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Synthetic public teaching extension.' } });
  return { schemaVersion: 1, id: 'public-ordering', version: '1.0.0', title: 'Comparing quantities',
    summary: 'Synthetic public contract examples.', locale: 'en', platforms: ['web'],
    objectives: [{ id: 'compare', description: 'Identify the smaller of two quantities.', prerequisites: [], critical: true }],
    chapters: [{ id: 'comparison', title: 'Compare', episodes: [{ id: 'pair', title: 'Compare two quantities', requirement: 'required',
      objectiveIds: ['compare'], gateId: 'ready', blocks: [{ id: 'intro', type: 'text', markdown: 'Use the order relation to compare quantities.' },
        { id: 'canonical-block', type: 'assessment', assessmentId: 'canonical' }] }] }],
    assessments: [{ id: 'canonical', type: 'numeric', objectiveIds: ['compare'], familyId: 'minimum', prompt: 'Enter the smaller of 1 and 5.',
      grading: { expected: 1, absoluteTolerance: 0, explanation: 'Choose the smaller quantity.' } }],
    gates: [{ id: 'ready', objectiveIds: ['compare'], assessmentIds: ['canonical'], minimumIndependentFamilies: 1, requireAllObjectives: true }],
    extensions: [extension('creator-extension', 'teaching.generate'), extension('review-extension', 'teaching.verify'), extension('renderer', 'visual.render', 'declarative')],
    visuals: [], media: [], sources: ['teaching-source', 'reference-source'].map(id => ({ id, title: 'Synthetic public example', url: `urn:example:${id}`, reviewedAt: NOW })),
    policy: { mode: 'bounded', work: { additionalMinutes: 30 }, existingMaterialAccess: 'read_only' },
    adaptation: { schemaVersion: 1,
      targets: [{ episodeId: 'pair', objectiveIds: ['compare'], allowedOperations: ['append_teaching', 'replace_teaching', 'add_assessment_variant', 'attach_visual', 'attach_media'], replaceableBlockIds: ['intro'] }],
      families: [{ familyId: 'minimum', canonicalAssessmentId: 'canonical', generatorIds: ['creator'], verifierIds: ['reviewer'], numericalRecipeIds: ['minimum-recipe'], maxVariantsPerPlan: 10 }],
      generators: [{ id: 'creator', version: '1.0.0', extensionId: 'creator-extension', sourceRefs: ['teaching-source'], artifactKinds: kinds }],
      verifiers: [{ id: 'reviewer', version: '1.0.0', extensionId: 'review-extension', sourceRefs: ['reference-source'], artifactKinds: kinds, requiredCheckIds: ['reference'] }],
      sourceRefs: ['teaching-source', 'reference-source'], profileFieldIds: ['presentation'],
      numericalRecipes: [{ id: 'minimum-recipe', version: '1.0.0', promptTemplate: 'Enter the smaller of {{a}} and {{b}}.', sourceRefs: ['teaching-source'],
        variables: [{ name: 'a', minimum: 1, maximum: 4, integer: true }, { name: 'b', minimum: 5, maximum: 8, integer: true }],
        expression: { type: 'binary', operator: 'min', left: { type: 'variable', name: 'a' }, right: { type: 'variable', name: 'b' } },
        maxNodes: 3, maxDepth: 2, maxAbsoluteValue: 100, referenceCheck: { verifierId: 'reviewer', verifierVersion: '1.0.0', checkId: 'reference', absoluteTolerance: 0 } }],
      limits: { maxOperations: 10, maxArtifacts: 10, maxArtifactBytes: 30000, maxPlannedMinutesPerAssignment: 10,
        maxAdditionalEpisodesPerAssignment: 1, allowedClassifications: ['required', 'optional'] } },
  };
}
export async function fixture(options = {}) {
  const c = course(); options.course?.(c);
  const policyInput = { enrollmentId: 'enrollment', learnerId: 'learner', coreObjectiveIds: c.objectives.map(o => o.id), conceptIds: ['comparison-concept'], pools: [],
    scopes: [{ scopeId: 'course-scope', parentScopeId: null, policyId: 'course-policy', kind: 'course', mode: 'bounded',
      hardDeadline: { at: LATE, timeZone: 'UTC', disambiguation: 'reject' }, work: { additionalMinutes: 20, additionalEpisodes: 8, remediationCyclesPerConcept: 3 }, existingMaterialAccess: 'read_only' },
    { scopeId: 'unit-scope', parentScopeId: 'course-scope', policyId: 'unit-policy', kind: 'episode', mode: 'bounded',
      work: { additionalMinutes: 40, additionalEpisodes: 10, remediationCyclesPerConcept: 10 }, existingMaterialAccess: 'read_only' }] };
  options.policy?.(policyInput);
  const policy = createPolicyState(policyInput), baseCourseDigest = await digestJson(c);
  const evidenceRecord = { attemptId: 'failed-canonical', assessmentId: 'canonical', familyId: 'minimum', objectiveIds: ['compare'], answer: 99, correct: false };
  const context = { course: c, policy, evidence: { enrollmentId: policy.enrollmentId, baseCourseDigest, revision: 1, digest: await digestJson(evidenceRecord) },
    registry: { revision: 1, verifiers: [{ id: 'reviewer', version: '1.0.0', implementationDigest: 'a'.repeat(64), sourceRefs: ['reference-source'], artifactKinds: kinds, checkIds: ['reference'] }],
      proofs: [], authorizations: [], episodeScopes: [{ episodeId: 'pair', scopeId: 'unit-scope' }],
      objectiveConcepts: c.objectives.map(o => ({ objectiveId: o.id, conceptId: 'comparison-concept' })), protectedReservationIds: [] } };
  options.registry?.(context.registry);
  return { context, state: await createAdaptationState(context), evidenceRecord };
}
export function command(f, key, extra = {}) {
  return { idempotencyKey: key, now: NOW, expectedAdaptationRevision: f.state.ledgerRevision,
    expectedPolicyRevision: f.context.policy.policyRevision, expectedPolicyLedgerRevision: f.context.policy.ledgerRevision,
    expectedRegistryRevision: f.context.registry.revision, expectedEvidenceRevision: f.context.evidence.revision, ...extra };
}
export function advance(f, transition) { f.state = transition.state; f.context.policy = transition.policy; return transition; }
/** Test stand-in for persisted authenticated records; never a production authentication implementation. */
export async function authorize(f, bundle) {
  const { proposal, assignments } = bundle;
  for (const artifact of proposal.artifacts) artifact.digest = await digestTeachingArtifact(artifact);
  const digest = await digestAdaptationProposal(proposal);
  proposal.proofReceipts = proposal.artifacts.map((artifact, i) => ({ id: `proof-${proposal.id}-${i}`, proposalDigest: digest, artifactId: artifact.id, artifactDigest: artifact.digest,
    verifierId: 'reviewer', verifierVersion: '1.0.0', verifierImplementationDigest: f.context.registry.verifiers[0].implementationDigest,
    sourceRefs: [...artifact.sourceRefs], verifierSourceRefs: ['reference-source'], checks: [{ id: 'reference', result: 'passed' }],
    outcome: 'passed', issuedAt: NOW, receiptRef: `trusted-${proposal.id}-${i}` }));
  assignments.forEach(a => { a.proposalDigest = digest; });
  f.context.registry.proofs = f.context.registry.proofs.filter(p => !proposal.proofReceipts.some(r => r.receiptRef === p.receipt.receiptRef));
  f.context.registry.proofs.push(...proposal.proofReceipts.map(receipt => ({ enrollmentId: 'enrollment', baseCourseDigest: proposal.baseCourseDigest,
    authenticationRef: 'test-authentication-record', status: 'active', receipt: structuredClone(receipt) })));
  f.context.registry.authorizations = f.context.registry.authorizations.filter(a => a.receiptRef !== bundle.authorizationRef);
  f.context.registry.authorizations.push({ receiptRef: bundle.authorizationRef, enrollmentId: 'enrollment', baseCourseDigest: proposal.baseCourseDigest,
    proposalDigest: digest, assignmentsDigest: await digestJson(assignments), evidenceRevision: f.context.evidence.revision,
    evidenceDigest: f.context.evidence.digest, authorizedAt: NOW, expiresAt: '2032-04-11T00:00:00Z', status: 'active' });
  f.context.registry.revision++;
  return bundle;
}
export async function bundle(f, suffix = 'one', requestedKinds = ['explanation']) {
  const artifacts = [], operations = [], assignments = [], authorizationRef = `authority-${suffix}`;
  for (const [i, kind] of requestedKinds.entries()) {
    const artifact = { id: `artifact-${suffix}-${i}`, kind, objectiveIds: ['compare'], sourceRefs: ['teaching-source'], generator: { id: 'creator', version: '1.0.0' } };
    const operation = { id: `operation-${suffix}-${i}`, type: 'append_teaching', episodeId: 'pair', artifactId: artifact.id };
    if (kind === 'explanation' || kind === 'practice') {
      artifact.markdown = `Compare the two quantities using a fresh ${kind}.`;
      if (kind === 'practice') Object.assign(operation, { type: 'replace_teaching', blockId: 'intro',
        expectedTargetDigest: f.state.plan.targetDigests.find(t => t.blockId === 'intro')?.digest ?? await digestJson(f.context.course.chapters[0].episodes[0].blocks[0]) });
    }
    if (kind === 'assessment_variant') {
      const recipe = await instantiateNumericalRecipe(f.context.course.adaptation.numericalRecipes[0], { a: 2, b: 6 });
      artifact.canonicalAssessmentId = 'canonical'; artifact.recipe = recipe.instance;
      artifact.assessment = { ...structuredClone(f.context.course.assessments[0]), id: `item-${suffix}-${i}`, prompt: recipe.prompt,
        grading: { ...f.context.course.assessments[0].grading, expected: recipe.value } };
      artifact.hiddenFixtures = { sentinel: 'HIDDEN_GENERATED_FIXTURE' }; operation.type = 'add_assessment_variant';
    }
    if (kind === 'visual') {
      artifact.visual = { id: `visual-${suffix}-${i}`, rendererId: 'renderer', platforms: ['web'], state: { a: 2, b: 6 }, scene: { kind: 'number-line' },
        layouts: { compact: { orientation: 'vertical' }, expanded: { orientation: 'horizontal' } }, timeline: { durationMs: 0, seekable: true, cues: [] },
        accessibility: { description: 'Two appears before six.', reducedMotion: { static: true } }, referenceChecks: ['reference'] }; operation.type = 'attach_visual';
    }
    if (kind === 'media') {
      artifact.media = { id: `media-${suffix}-${i}`, type: 'image', sourceRef: 'teaching-source', url: 'asset:public-number-line', review: 'reviewed', generated: true,
        alternativeMarkdown: 'Two and six on a number line.' }; operation.type = 'attach_media';
    }
    if (kind === 'profile_suggestion') {
      Object.assign(artifact, { fieldId: 'presentation', proposedValue: 'larger diagrams', rationale: 'Proposed display preference.' });
      operation.type = 'suggest_profile_correction'; delete operation.episodeId;
    } else assignments.push({ operationId: operation.id, proposalDigest: '0'.repeat(64), classification: 'required', plannedMinutes: 2, additionalEpisodes: 0,
      authority: 'server', authorityReceiptRef: authorizationRef });
    artifact.digest = await digestTeachingArtifact(artifact); artifacts.push(artifact); operations.push(operation);
  }
  const proposal = { schemaVersion: 1, id: `proposal-${suffix}`, baseCourseDigest: f.state.baseCourseDigest, expectedPlanRevision: f.state.plan.revision,
    expectedPlanDigest: f.state.plan.digest, rationale: 'Offer a verified alternate representation after a failed attempt.', artifacts, operations, proofReceipts: [] };
  return authorize(f, { admissionId: `admission-${suffix}`, authorizationRef, proposal, assignments });
}
export const code = expected => error => error?.code === expected;
export function freeze(value) { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return value; }
