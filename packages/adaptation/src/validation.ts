import { z } from 'zod';
import { digestJson, validateCourse, validateCourseAdaptation, validateAssignmentDecisions } from '@course-core/sdk';
import { canonicalJson } from '@course-core/sdk/compiler';
import type { ActivityAssignmentDecision, AdaptationPlanSnapshot, CourseAdaptation, RegisteredVerifier } from '@course-core/sdk';
import { compareInstants, resolveConstraints } from '@course-core/policy';
import { AdaptationError, requireCondition as assert } from './contracts.js';
import type { AdaptationState, Admission, RuntimeContext } from './contracts.js';

export const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$(?![\s\S])/);
export const ref = z.string().min(1).max(256);
export const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
export const instant = z.string().refine(value => { try { compareInstants(value, value); return true; } catch { return false; } });
const sdkProposal = z.custom<CourseAdaptation>(value => value !== null && typeof value === 'object' && !Array.isArray(value)); // Full validation through SDK below.
const assignments = z.array(z.custom<ActivityAssignmentDecision>()).max(1000);
export const registeredVerifierSchema = z.strictObject({ id, version: ref, implementationDigest: hash,
  sourceRefs: z.array(id), artifactKinds: z.array(z.enum(['explanation', 'practice', 'assessment_variant', 'media', 'visual', 'profile_suggestion', 'episode'])), checkIds: z.array(id) });
const verifiers = z.array(registeredVerifierSchema).max(1000);
const proofSchema = z.strictObject({ id, proposalDigest: hash, artifactId: id, artifactDigest: hash,
  verifierId: id, verifierVersion: ref, verifierImplementationDigest: hash, sourceRefs: z.array(id), verifierSourceRefs: z.array(id),
  checks: z.array(z.strictObject({ id, result: z.enum(['passed', 'failed']) })), outcome: z.enum(['passed', 'failed']), issuedAt: instant, receiptRef: ref });
export const evidenceSchema = z.strictObject({ enrollmentId: ref, baseCourseDigest: hash, revision: count, digest: hash });
const planSchema = z.strictObject({ baseCourseDigest: hash, revision: count, digest: hash,
  occupiedIds: z.array(ref), targetDigests: z.array(z.strictObject({ episodeId: id, blockId: id, digest: hash })),
  variantCounts: z.array(z.strictObject({ familyId: id, count })) });
const workSchema = z.strictObject({ additionalMinutes: count, additionalEpisodes: count,
  remediation: z.array(z.strictObject({ conceptId: ref, cycles: count.min(1) })) });
const admissionSchema = z.strictObject({ id, authorizationRef: ref, status: z.enum(['reserved', 'applied', 'cancelled']),
  proposal: sdkProposal, proposalDigest: hash, assignments, admittedPlan: planSchema, admittedVerifiers: verifiers,
  admittedPolicyRevision: count, evidence: evidenceSchema, bindingsDigest: hash, authorizationDigest: hash,
  reservations: z.array(z.strictObject({ reservationId: ref, scopeId: ref, work: workSchema })) });
export const stateSchema = z.strictObject({ schemaVersion: z.literal(1), enrollmentId: ref, baseCourseDigest: hash,
  ledgerRevision: count, digest: hash, bindingsDigest: hash, plan: planSchema,
  admissions: z.array(admissionSchema).max(1000),
  applications: z.array(z.strictObject({ admissionId: id, revision: count, parentDigest: hash, digest: hash })).max(1000),
  receipts: z.array(z.strictObject({ idempotencyKey: ref, requestDigest: hash, operation: z.enum(['admit', 'apply', 'cancel']), resourceId: id,
    ledgerRevision: count, planRevision: count, planDigest: hash })).max(3000),
});
export const registrySchema = z.strictObject({ revision: count, verifiers,
  proofs: z.array(z.strictObject({ enrollmentId: ref, baseCourseDigest: hash, authenticationRef: ref,
    status: z.enum(['active', 'revoked']), receipt: proofSchema })).max(5000),
  authorizations: z.array(z.strictObject({ receiptRef: ref, enrollmentId: ref, baseCourseDigest: hash,
    proposalDigest: hash, assignmentsDigest: hash, evidenceRevision: count, evidenceDigest: hash,
    authorizedAt: instant, expiresAt: instant, status: z.enum(['active', 'revoked']) })).max(2000),
  episodeScopes: z.array(z.strictObject({ episodeId: id, scopeId: ref })).max(20000),
  objectiveConcepts: z.array(z.strictObject({ objectiveId: id, conceptId: ref })).max(2000),
  protectedReservationIds: z.array(ref).max(20000),
});
export const commandSchema = z.strictObject({ idempotencyKey: ref, now: instant,
  expectedAdaptationRevision: count, expectedPolicyRevision: count, expectedPolicyLedgerRevision: count,
  expectedRegistryRevision: count, expectedEvidenceRevision: count });
export const admitSchema = commandSchema.extend({ admissionId: id, authorizationRef: ref, proposal: sdkProposal, assignments });
export const admissionCommandSchema = commandSchema.extend({ admissionId: id });
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AdaptationError('INVALID_INPUT', 'Invalid adaptation data shape.');
  return result.data;
}
/** SDK hashing rejects non-JSON/accessors/cycles before cloning or async callbacks. */
export async function capture<T>(value: T): Promise<T> {
  try { canonicalJson(value); return structuredClone(value); }
  catch { throw new AdaptationError('INVALID_INPUT', 'Expected bounded finite JSON data.'); }
}
export function unique(values: string[], label: string) {
  assert(new Set(values).size === values.length, 'DUPLICATE_ID', `Duplicate ${label}.`);
}
export const same = async (a: unknown, b: unknown) => await digestJson(a) === await digestJson(b);
export const bindingsDigest = (context: RuntimeContext) => digestJson({
  episodeScopes: [...context.registry.episodeScopes].sort((a, b) => a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0),
  objectiveConcepts: [...context.registry.objectiveConcepts].sort((a, b) => a.objectiveId < b.objectiveId ? -1 : a.objectiveId > b.objectiveId ? 1 : 0),
});
export async function validateContext(input: RuntimeContext): Promise<RuntimeContext> {
  const context = await capture(input);
  parse(z.strictObject({ course: z.unknown(), policy: z.unknown(), evidence: evidenceSchema, registry: registrySchema }), context);
  const course = validateCourse(context.course);
  assert(course.valid, 'INVALID_COURSE', 'A valid immutable author course is required.');
  assert(course.course.adaptation, 'ADAPTATION_DISABLED', 'Author adaptation rules are required.');
  context.course = course.course;
  const base = await digestJson(context.course);
  assert(context.evidence.baseCourseDigest === base && context.evidence.enrollmentId === context.policy.enrollmentId,
    'EVIDENCE_BINDING', 'Evidence must bind this enrollment and immutable base.');
  const roots = context.policy.scopes.filter(scope => scope.parentScopeId === null);
  assert(roots.length === 1, 'INVALID_POLICY', 'One policy root is required.');
  resolveConstraints(context.policy, roots[0]!.scopeId); // Public policy parser/ledger validator.
  const requiredObjectives = [...new Set([
    ...context.course.chapters.flatMap(c => c.episodes).filter(e => e.requirement !== 'optional').flatMap(e => e.objectiveIds),
    ...context.course.objectives.filter(o => o.critical).map(o => o.id),
  ])];
  assert(await same([...context.policy.coreObjectiveIds].sort(), requiredObjectives.sort()),
    'CORE_OBJECTIVES_CHANGED', 'The fixed policy objective registry must match the base course.');
  unique(context.registry.episodeScopes.map(b => b.episodeId), 'episode binding');
  unique(context.registry.objectiveConcepts.map(b => b.objectiveId), 'objective binding');
  unique(context.registry.protectedReservationIds, 'protected reservation');
  unique(context.registry.authorizations.map(a => a.receiptRef), 'authority receipt');
  unique(context.registry.proofs.map(p => p.receipt.receiptRef), 'proof receipt');
  unique(context.registry.verifiers.map(v => `${v.id}@${v.version}`), 'verifier registration');
  const episodes = context.course.chapters.flatMap(c => c.episodes);
  for (const binding of context.registry.episodeScopes) {
    assert(episodes.some(e => e.id === binding.episodeId) && context.policy.scopes.some(s => s.scopeId === binding.scopeId),
      'SCOPE_BINDING', 'Bindings require existing episodes and policy scopes.');
  }
  for (const binding of context.registry.objectiveConcepts) {
    assert(context.course.objectives.some(o => o.id === binding.objectiveId) && context.policy.conceptIds.includes(binding.conceptId),
      'CONCEPT_BINDING', 'Use stable registered objective/concept identities.');
  }
  for (const objective of context.course.objectives) assert(context.registry.objectiveConcepts.some(b => b.objectiveId === objective.id),
    'CONCEPT_BINDING', 'Every objective needs a trusted stable concept mapping.');
  for (const target of context.course.adaptation!.targets) assert(context.registry.episodeScopes.some(b => b.episodeId === target.episodeId),
    'SCOPE_BINDING', 'Every author target needs a trusted scope mapping.');
  for (const id of context.registry.protectedReservationIds) assert(context.policy.reservations.some(r => r.reservationId === id && r.state !== 'cancelled'),
    'CORE_HEADROOM_LOST', 'Declared core work headroom must remain reserved or committed.');
  return context;
}
export async function validateProposal(context: RuntimeContext, plan: AdaptationPlanSnapshot, proposal: CourseAdaptation,
  decisions: ActivityAssignmentDecision[], verifiers = context.registry.verifiers) {
  const sdkContext = { course: context.course, baseCourseDigest: context.evidence.baseCourseDigest, plan, registeredVerifiers: verifiers };
  const checked = await validateCourseAdaptation(proposal, sdkContext);
  if (!checked.valid) throw new AdaptationError(checked.issues[0]?.code ?? 'INVALID_PROPOSAL', 'Proposal fails SDK author, artifact or proof data constraints.');
  const assigned = await validateAssignmentDecisions(proposal, sdkContext, decisions);
  if (!assigned.valid) throw new AdaptationError(assigned.issues[0]?.code ?? 'INVALID_ASSIGNMENTS', 'Assignments fail SDK author constraints.');
  return checked;
}
export async function emptyPlan(baseCourseDigest: string): Promise<AdaptationPlanSnapshot> {
  return { baseCourseDigest, revision: 0, digest: await digestJson({ baseCourseDigest, revision: 0 }), occupiedIds: [], targetDigests: [], variantCounts: [] };
}
export async function advancePlan(plan: AdaptationPlanSnapshot, admission: Admission): Promise<AdaptationPlanSnapshot> {
  const next = structuredClone(plan); next.revision++;
  assert(Number.isSafeInteger(next.revision), 'REVISION_LIMIT', 'Plan revision exhausted.');
  next.digest = await digestJson({ baseCourseDigest: plan.baseCourseDigest, parentDigest: plan.digest, revision: next.revision,
    proposalDigest: admission.proposalDigest, assignments: admission.assignments, authorizationDigest: admission.authorizationDigest });
  next.occupiedIds.push(admission.proposal.id, ...admission.proposal.operations.map(o => o.id), ...admission.proposal.proofReceipts.map(p => p.id));
  for (const artifact of admission.proposal.artifacts) {
    next.occupiedIds.push(artifact.id);
    if (artifact.kind === 'assessment_variant') {
      next.occupiedIds.push(artifact.assessment.id);
      const row = next.variantCounts.find(r => r.familyId === artifact.assessment.familyId);
      if (row) row.count++; else next.variantCounts.push({ familyId: artifact.assessment.familyId, count: 1 });
    }
    if (artifact.kind === 'media') next.occupiedIds.push(artifact.media.id);
    if (artifact.kind === 'visual') next.occupiedIds.push(artifact.visual.id);
    if (artifact.kind === 'episode') next.occupiedIds.push(...artifact.blocks.map(b => b.id));
  }
  for (const operation of admission.proposal.operations) if (operation.type === 'replace_teaching') {
    const row = next.targetDigests.find(t => t.episodeId === operation.episodeId && t.blockId === operation.blockId);
    const digest = admission.proposal.artifacts.find(a => a.id === operation.artifactId)!.digest;
    if (row) row.digest = digest; else next.targetDigests.push({ episodeId: operation.episodeId, blockId: operation.blockId, digest });
  }
  next.occupiedIds = [...new Set(next.occupiedIds)].sort();
  const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  next.variantCounts.sort((a, b) => lexical(a.familyId, b.familyId));
  next.targetDigests.sort((a, b) => lexical(`${a.episodeId}/${a.blockId}`, `${b.episodeId}/${b.blockId}`));
  return next;
}
export async function seal(state: AdaptationState): Promise<AdaptationState> {
  const { digest: _digest, ...data } = state; state.digest = await digestJson(data); return parse(stateSchema, state);
}
export async function readState(input: AdaptationState, context: RuntimeContext): Promise<AdaptationState> {
  const state = parse(stateSchema, await capture(input));
  const { digest, ...data } = state;
  assert(digest === await digestJson(data), 'STATE_DIGEST_MISMATCH', 'Adaptation snapshot integrity failed.');
  assert(state.enrollmentId === context.policy.enrollmentId && state.baseCourseDigest === context.evidence.baseCourseDigest,
    'BASE_BINDING', 'State belongs to another enrollment or immutable course.');
  assert(state.bindingsDigest === await bindingsDigest(context), 'BINDINGS_CHANGED', 'Stable scope/concept bindings cannot be remapped to reset accounting.');
  unique(state.admissions.map(a => a.id), 'admission'); unique(state.admissions.map(a => a.proposal.id), 'proposal');
  unique(state.applications.map(a => a.admissionId), 'application'); unique(state.receipts.map(r => r.idempotencyKey), 'idempotency key');
  assert(state.ledgerRevision === state.receipts.length && state.receipts.every((r, i) => r.ledgerRevision === i + 1
    && r.planRevision <= state.plan.revision && state.admissions.some(a => a.id === r.resourceId)), 'INVALID_STATE', 'Retained command ledger is incomplete.');
  let plan = await emptyPlan(state.baseCourseDigest);
  const snapshots = new Map([[plan.digest, plan]]);
  for (const applied of state.applications) {
    const admission = state.admissions.find(a => a.id === applied.admissionId);
    assert(admission?.status === 'applied', 'INVALID_STATE', 'Application needs its retained admission.');
    assert(await same(admission.admittedPlan, plan), 'INVALID_STATE', 'Application plan lineage differs.');
    plan = await advancePlan(plan, admission);
    assert(applied.revision === plan.revision && applied.digest === plan.digest && applied.parentDigest === admission.admittedPlan.digest,
      'INVALID_STATE', 'Application hash chain differs.');
    snapshots.set(plan.digest, plan);
  }
  assert(await same(state.plan, plan), 'INVALID_STATE', 'Plan must match retained applications.');
  for (const admission of state.admissions) {
    assert(await same(snapshots.get(admission.admittedPlan.digest) ?? null, admission.admittedPlan), 'INVALID_STATE', 'Admission names an unknown plan.');
    const checked = await validateProposal(context, admission.admittedPlan, admission.proposal, admission.assignments, admission.admittedVerifiers);
    assert(checked.proposalDigest === admission.proposalDigest && admission.bindingsDigest === state.bindingsDigest,
      'INVALID_STATE', 'Retained admission binding differs.');
    assert((admission.status === 'applied') === state.applications.some(a => a.admissionId === admission.id), 'INVALID_STATE', 'Application state differs.');
    for (const binding of admission.reservations) {
      const persisted = context.policy.reservations.find(r => r.reservationId === binding.reservationId);
      assert(persisted && persisted.scopeId === binding.scopeId && await same(persisted.work, binding.work)
        && (admission.status !== 'applied' || persisted.state === 'committed'), 'RESERVATION_BINDING', 'Retained policy reservation differs.');
    }
  }
  return state;
}
