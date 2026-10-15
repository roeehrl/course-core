import { z } from 'zod';
import { digestAdaptationProposal, digestJson, validateCourse, validateCourseAdaptation, validateAssignmentDecisions } from '@course-core/sdk';
import { canonicalJson } from '@course-core/sdk/compiler';
import type { ActivityAssignmentDecision, AdaptationPlanSnapshot, CourseAdaptation, CourseManifest, RegisteredVerifier } from '@course-core/sdk';
import { compareInstants, resolveConstraints, type PolicyState } from '@course-core/policy';
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
const admissionSchema = z.strictObject({ id, authorizationRef: ref, status: z.enum(['reserved', 'applied', 'cancelled', 'reverted']),
  proposal: sdkProposal, proposalDigest: hash, assignments, admittedPlan: planSchema, admittedVerifiers: verifiers,
  admittedPolicyRevision: count, evidence: evidenceSchema, bindingsDigest: hash, authorizationDigest: hash,
  reservations: z.array(z.strictObject({ reservationId: ref, scopeId: ref, work: workSchema, fundedByReservationId: ref.optional() })) });
export const stateSchema = z.strictObject({ schemaVersion: z.literal(1), enrollmentId: ref, baseCourseDigest: hash,
  ledgerRevision: count, digest: hash, bindingsDigest: hash, plan: planSchema,
  admissions: z.array(admissionSchema).max(1000),
  applications: z.array(z.strictObject({ admissionId: id, revision: count, parentDigest: hash, digest: hash,
    revert: z.literal(true).optional(), rollbackTargetDigest: hash.optional() })
    .refine(a => (a.revert === true) === (a.rollbackTargetDigest !== undefined))).max(2000),
  receipts: z.array(z.strictObject({ idempotencyKey: ref, requestDigest: hash, operation: z.enum(['admit', 'apply', 'cancel', 'revert']), resourceId: id,
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
/** Why live, unpublished work ends: withdrawn, refused by the learner, or past its publication deadline. */
export const cancelCommandSchema = admissionCommandSchema.extend({ reason: z.enum(['cancelled', 'refused', 'expired']).optional() });
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AdaptationError('INVALID_INPUT', 'Invalid adaptation data shape.');
  return result.data;
}
/** SDK hashing rejects non-JSON/accessors/cycles before cloning. Synchronous, so a caller cannot change the data mid-read.
 * A top-level field holding a validated base course this process recorded as deeply frozen
 * (see validatedCourses) is shared instead of copied: it cannot change, and it already passed
 * the same JSON checks and full SDK course validation. Every other field is copied. */
export function snapshot<T>(value: T): T {
  const shared = sharedCourseFields(value);
  if (shared) {
    const copy = copied(Object.fromEntries(shared.filter(([, , known]) => !known).map(([key, field]) => [key, field])));
    return Object.fromEntries(shared.map(([key, field, known]) => [key, known ? field : copy[key]])) as T;
  }
  return copied(value);
}
function copied<T>(value: T): T {
  try { canonicalJson(value); return structuredClone(value); }
  catch { throw new AdaptationError('INVALID_INPUT', 'Expected bounded finite JSON data.'); }
}
/** Own data fields of a plain object, each flagged when it is a recorded frozen course; undefined
 * when there is none (or the value is not a plain data object, which copied() then rejects). */
function sharedCourseFields(value: unknown): [string, unknown, boolean][] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key === 'symbol')) return undefined;
  const fields: [string, unknown, boolean][] = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) return undefined;
    const field: unknown = descriptor.value;
    fields.push([key, field, field !== null && typeof field === 'object' && frozenCourses.has(field)]);
  }
  return fields.some(([, , known]) => known) ? fields : undefined;
}
export async function capture<T>(value: T): Promise<T> { return snapshot(value); }
export function unique(values: string[], label: string) {
  assert(new Set(values).size === values.length, 'DUPLICATE_ID', `Duplicate ${label}.`);
}
export const same = async (a: unknown, b: unknown) => await digestJson(a) === await digestJson(b);
export const bindingsDigest = (context: RuntimeContext) => digestJson({
  episodeScopes: [...context.registry.episodeScopes].sort((a, b) => a.episodeId < b.episodeId ? -1 : a.episodeId > b.episodeId ? 1 : 0),
  objectiveConcepts: [...context.registry.objectiveConcepts].sort((a, b) => a.objectiveId < b.objectiveId ? -1 : a.objectiveId > b.objectiveId ? 1 : 0),
});
/** Bounded LRU of content-addressed records (see the notes on validatedProposals below). */
export class Verified<V = string> {
  readonly #entries = new Map<string, V>();
  constructor(readonly limit: number) {}
  get size() { return this.#entries.size; }
  get(key: string) {
    const value = this.#entries.get(key);
    if (value !== undefined) { this.#entries.delete(key); this.#entries.set(key, value); }
    return value;
  }
  set(key: string, value: V) {
    this.#entries.delete(key); this.#entries.set(key, value);
    while (this.#entries.size > this.limit) this.#entries.delete(this.#entries.keys().next().value!);
  }
  clear() { this.#entries.clear(); }
}
/** Own enumerable data fields of a plain object, read without running getters. */
function dataFields(input: unknown): Record<string, unknown> {
  const plain = input !== null && typeof input === 'object' && !Array.isArray(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)) && !Reflect.ownKeys(input).some(key => typeof key === 'symbol');
  assert(plain, 'INVALID_INPUT', 'Expected bounded finite JSON data.');
  const fields: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
    assert(descriptor.enumerable && 'value' in descriptor, 'INVALID_INPUT', 'Expected bounded finite JSON data.');
    fields[key] = descriptor.value;
  }
  return fields;
}
function deeplyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  for (const child of Object.values(value)) if (!deeplyFrozen(child)) return false;
  return true;
}
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
/**
 * Validated immutable base courses, so a large course is not re-cloned, re-hashed and
 * re-validated on every request.
 *
 * A course is identified by the SHA-256 of its canonical JSON. Records are deeply frozen
 * plain data and are only ever shared read-only. A host that passes the same deeply frozen
 * plain-data course object again (the API's verified release cache) is recognised by
 * identity: such an object cannot change, so its recorded digest still describes it. Any
 * other input is copied synchronously, before any await, and hashed again on every call.
 * Only fully valid adaptation-enabled courses are recorded.
 */
const validatedCourses = new Verified<CourseRecord>(16);
const frozenCourses = new WeakMap<object, CourseRecord>();
interface CourseRecord { readonly course: CourseManifest; readonly digest: string }
/** Synchronous part: decide whether `input` is immutable, else take a private copy. */
function courseCandidate(input: unknown): { value: unknown; immutable: boolean; known?: CourseRecord } {
  if (input !== null && typeof input === 'object') {
    const known = frozenCourses.get(input);
    if (known) return { value: input, immutable: true, known };
    if (Object.isFrozen(input) && deeplyFrozen(input)) {
      try { canonicalJson(input); } catch { throw new AdaptationError('INVALID_INPUT', 'Expected bounded finite JSON data.'); }
      return { value: input, immutable: true };
    }
  }
  return { value: snapshot(input), immutable: false };
}
async function validatedCourse(input: unknown, candidate = courseCandidate(input)): Promise<CourseRecord> {
  if (candidate.known) { counters.courseReuses++; return candidate.known; }
  counters.courseDigests++;
  const digest = await digestJson(candidate.value);
  let record = validatedCourses.get(digest);
  if (record) counters.courseReuses++;
  else {
    counters.courseValidations++;
    const course = validateCourse(candidate.value);
    assert(course.valid, 'INVALID_COURSE', 'A valid immutable author course is required.');
    assert(course.course.adaptation, 'ADAPTATION_DISABLED', 'Author adaptation rules are required.');
    record = Object.freeze({ course: deepFreeze(course.course), digest });
    validatedCourses.set(digest, record);
    frozenCourses.set(record.course, record);
  }
  if (candidate.immutable) frozenCourses.set(input as object, record);
  return record;
}
/**
 * The validated course and its digest when `input` is a course object this process already
 * validated and holds deeply frozen (see validatedCourses); otherwise undefined. Synchronous.
 */
export function recordedCourse(input: unknown): CourseRecord | undefined {
  return input !== null && typeof input === 'object' ? frozenCourses.get(input) : undefined;
}
/** Synchronous private copy of a runtime context, taken before any await. The course is
 * shared only when it is immutable (deeply frozen plain data); otherwise it is copied too. */
export function captureContext(input: RuntimeContext): RuntimeContext {
  const { course, ...fields } = dataFields(input);
  return { ...snapshot(fields), course: courseCandidate(course).value } as unknown as RuntimeContext;
}
/**
 * The returned context is a private copy, except `course`, which is a deeply frozen
 * validated record shared read-only between calls (see validatedCourses).
 */
export async function validateContext(input: RuntimeContext): Promise<RuntimeContext> {
  // Everything is read synchronously before the first await.
  const { course: courseInput, ...fields } = dataFields(input);
  const context = { ...snapshot(fields), course: null } as unknown as RuntimeContext;
  const candidate = courseCandidate(courseInput);
  parse(z.strictObject({ course: z.unknown(), policy: z.unknown(), evidence: evidenceSchema, registry: registrySchema }), context);
  const record = await validatedCourse(courseInput, candidate);
  context.course = record.course;
  const base = record.digest;
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
/**
 * Content-addressed records of deterministic checks that already passed in this process.
 *
 * SDK proposal validation is a pure function of the immutable base course (bound by its
 * digest), the plan the proposal was validated against, the proposal, its assignment
 * decisions and the registered verifiers. It reads no clock, proof, policy or evidence.
 * Likewise every retained-state check in readState except the policy reservation
 * bindings depends only on the state's own content and that base course. Each record
 * is keyed by a SHA-256 over exactly those inputs (for a state, its verified content
 * digest, which covers the base digest and the ordered admissions/applications), so it
 * can only answer for byte-identical data: a changed, substituted or tampered stored
 * admission or state yields another key and is checked again in full. Only successes
 * are recorded. Per-request work therefore no longer repeats validation of every
 * adaptation already applied; each is validated in full once when it is staged or
 * admitted (admission and application reuse that record for the same bytes) and at most
 * once more per process when first read from storage.
 *
 * Bounded LRU of short strings. Nothing is shared between processes, so several API
 * instances remain independently correct; concurrent requests at worst repeat a check.
 */
const validatedProposals = new Verified(10000), verifiedStates = new Verified(2000);
/** Materialized adapted courses, keyed by base course digest and verified state digest (see projection.ts). */
export const materializedViews = new Verified<object>(32);
export const counters = { sdkValidations: 0, proposalReuses: 0, retainedValidations: 0, retainedReuses: 0, stateChecks: 0, stateReuses: 0,
  courseDigests: 0, courseValidations: 0, courseReuses: 0, projections: 0, projectionReuses: 0 };
/** Process-local counters for tests and diagnostics. They grant nothing. */
export function proposalValidationStatistics() {
  return { ...counters, recordedProposals: validatedProposals.size, recordedStates: verifiedStates.size,
    recordedCourses: validatedCourses.size, recordedViews: materializedViews.size };
}
/** Forget recorded checks and views (tests and diagnostics). Never required for correctness. */
export function clearValidatedProposals() {
  validatedProposals.clear(); verifiedStates.clear(); validatedCourses.clear(); materializedViews.clear();
}
async function validationKey(baseCourseDigest: string, plan: AdaptationPlanSnapshot, proposal: CourseAdaptation,
  decisions: ActivityAssignmentDecision[], verifiers: RegisteredVerifier[]) {
  return digestJson({ protocol: 'validated-adaptation-proposal-v1', baseCourseDigest, plan, proposal, decisions, verifiers });
}
/**
 * SDK validation of a proposal and its assignment decisions against `plan`. Admission and
 * application call this every time. It runs in full unless exactly these inputs (see
 * validationKey) already passed in this process, for example when the host validated the
 * same proposal before staging it or admission validated it moments before application.
 * `context` must come from validateContext, which proves `evidence.baseCourseDigest` is the
 * digest of `context.course`. Failures are never recorded.
 */
export async function validateProposal(context: RuntimeContext, plan: AdaptationPlanSnapshot, proposal: CourseAdaptation,
  decisions: ActivityAssignmentDecision[], verifiers = context.registry.verifiers): Promise<{ proposal: CourseAdaptation; proposalDigest: string }> {
  const baseCourseDigest = context.evidence.baseCourseDigest;
  let key: string | undefined;
  // Data the SDK would reject cannot be hashed; it is validated in full and reported with the SDK's code.
  try { key = await validationKey(baseCourseDigest, plan, proposal, decisions, verifiers); } catch { key = undefined; }
  const known = key === undefined ? undefined : validatedProposals.get(key);
  if (known !== undefined) { counters.proposalReuses++; return { proposal: snapshot(proposal), proposalDigest: known }; }
  return fullValidation(context.course, baseCourseDigest, plan, proposal, decisions, verifiers);
}
async function fullValidation(course: CourseManifest, baseCourseDigest: string, plan: AdaptationPlanSnapshot, proposal: CourseAdaptation,
  decisions: ActivityAssignmentDecision[], verifiers: RegisteredVerifier[]) {
  const sdkContext = { course, baseCourseDigest, plan, registeredVerifiers: verifiers };
  counters.sdkValidations++;
  // validateAssignmentDecisions runs the SDK's full validateCourseAdaptation of the proposal itself and
  // fails when it fails, so one call decides validity. Only on failure is the proposal validated on
  // its own, to report the proposal's issue before the assignments' as before.
  const assigned = await validateAssignmentDecisions(proposal, sdkContext, decisions);
  if (!assigned.valid) {
    const checked = await validateCourseAdaptation(proposal, sdkContext);
    if (!checked.valid) throw new AdaptationError(checked.issues[0]?.code ?? 'INVALID_PROPOSAL', 'Proposal fails SDK author, artifact or proof data constraints.');
    throw new AdaptationError(assigned.issues[0]?.code ?? 'INVALID_ASSIGNMENTS', 'Assignments fail SDK author constraints.');
  }
  // As the SDK's own validation result: a private copy and its proposal digest.
  const copy = snapshot(proposal), proposalDigest = await digestAdaptationProposal(copy);
  // The SDK checked that baseCourseDigest is the digest of `course`, so the key binds the course bytes.
  validatedProposals.set(await validationKey(baseCourseDigest, plan, proposal, decisions, verifiers), proposalDigest);
  return { proposal: copy, proposalDigest };
}
/**
 * Host check of a proposal before it is staged: full SDK validation against the immutable base
 * `course` (which must hash to `baseCourseDigest`), the current `plan` and the registered
 * verifiers. A success is recorded under the key admission and application look up, so the
 * same bytes are not validated again in this process. Every input is copied synchronously
 * first (a recorded frozen base course is shared), so a caller cannot change them mid-check.
 */
export async function validateAdaptationProposal(input: { course: CourseManifest; baseCourseDigest: string; plan: AdaptationPlanSnapshot;
  registeredVerifiers: RegisteredVerifier[] }, proposal: CourseAdaptation, decisions: ActivityAssignmentDecision[]) {
  const { course, ...fields } = dataFields(input);
  const copy = snapshot({ ...fields, proposal, decisions }) as unknown as { baseCourseDigest: string; plan: AdaptationPlanSnapshot;
    registeredVerifiers: RegisteredVerifier[]; proposal: CourseAdaptation; decisions: ActivityAssignmentDecision[] };
  const base = courseCandidate(course).value as CourseManifest;
  return fullValidation(base, copy.baseCourseDigest, copy.plan, copy.proposal, copy.decisions, copy.registeredVerifiers);
}
/**
 * Proposal digest of a retained admission, validated in full unless these exact inputs
 * already passed in this process. `context` must come from validateContext, which
 * proves `evidence.baseCourseDigest` is the digest of `context.course`.
 */
async function retainedProposalDigest(context: RuntimeContext, admission: Admission) {
  const key = await validationKey(context.evidence.baseCourseDigest, admission.admittedPlan, admission.proposal, admission.assignments, admission.admittedVerifiers);
  const known = validatedProposals.get(key);
  if (known !== undefined) { counters.retainedReuses++; return known; }
  counters.retainedValidations++;
  return (await fullValidation(context.course, context.evidence.baseCourseDigest, admission.admittedPlan, admission.proposal, admission.assignments, admission.admittedVerifiers)).proposalDigest;
}
export async function emptyPlan(baseCourseDigest: string): Promise<AdaptationPlanSnapshot> {
  return { baseCourseDigest, revision: 0, digest: await digestJson({ baseCourseDigest, revision: 0 }), occupiedIds: [], targetDigests: [], variantCounts: [] };
}
/** Replaced-block digests produced by the live (applied, not reverted) admissions, in application order. */
function liveTargetDigests(admissions: Admission[]): AdaptationPlanSnapshot['targetDigests'] {
  const targets = new Map<string, AdaptationPlanSnapshot['targetDigests'][number]>();
  for (const admission of admissions) for (const operation of admission.proposal.operations) if (operation.type === 'replace_teaching') {
    const digest = admission.proposal.artifacts.find(a => a.id === operation.artifactId)!.digest;
    targets.set(`${operation.episodeId}/${operation.blockId}`, { episodeId: operation.episodeId, blockId: operation.blockId, digest });
  }
  const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...targets.values()].sort((a, b) => lexical(`${a.episodeId}/${a.blockId}`, `${b.episodeId}/${b.blockId}`));
}
/**
 * The revision that rolls `reverted` back. Identifiers stay occupied and variant counts stay
 * counted, so an undone change can neither be replayed as fresh nor refund its use;
 * replaced blocks return to what the remaining live admissions (or the base course) give them.
 * `live` lists the admissions still in effect after the revert, in application order.
 */
export async function revertPlan(plan: AdaptationPlanSnapshot, reverted: Admission, rollbackTargetDigest: string, live: Admission[]): Promise<AdaptationPlanSnapshot> {
  const next = structuredClone(plan); next.revision++;
  assert(Number.isSafeInteger(next.revision), 'REVISION_LIMIT', 'Plan revision exhausted.');
  next.digest = await digestJson({ baseCourseDigest: plan.baseCourseDigest, parentDigest: plan.digest, revision: next.revision,
    revertsProposalDigest: reverted.proposalDigest, rollbackTargetDigest });
  next.targetDigests = liveTargetDigests(live);
  return next;
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
/** `owned` means the caller already passed a private snapshot() of the stored state. */
export async function readState(input: AdaptationState, context: RuntimeContext, owned = false): Promise<AdaptationState> {
  const copy: unknown = owned ? input : snapshot(input);
  const plain = copy !== null && typeof copy === 'object' && !Array.isArray(copy);
  const { digest: claimed, ...data } = (plain ? copy : parse(stateSchema, copy)) as AdaptationState;
  const computed = await digestJson(data);
  // Content whose digest already passed every check below has, byte for byte, already passed the
  // shape check too; anything else is parsed. The digest itself is recomputed on every read.
  const state = claimed === computed && verifiedStates.get(computed) !== undefined ? copy as AdaptationState : parse(stateSchema, copy);
  const digest = state.digest;
  assert(digest === computed, 'STATE_DIGEST_MISMATCH', 'Adaptation snapshot integrity failed.');
  assert(state.enrollmentId === context.policy.enrollmentId && state.baseCourseDigest === context.evidence.baseCourseDigest,
    'BASE_BINDING', 'State belongs to another enrollment or immutable course.');
  assert(state.bindingsDigest === await bindingsDigest(context), 'BINDINGS_CHANGED', 'Stable scope/concept bindings cannot be remapped to reset accounting.');
  // Apart from the policy reservation bindings, the checks below depend only on this exact verified content
  // and its base course (bound above); see Verified. Reservations are always rechecked.
  const reservations = new Map<string, PolicyState['reservations'][number]>();
  for (const reservation of context.policy.reservations) if (!reservations.has(reservation.reservationId)) reservations.set(reservation.reservationId, reservation);
  const checkReservations = async (admission: Admission) => {
    for (const binding of admission.reservations) {
      const persisted = reservations.get(binding.reservationId);
      assert(persisted && persisted.scopeId === binding.scopeId && await same(persisted.work, binding.work)
        && ((admission.status !== 'applied' && admission.status !== 'reverted') || persisted.state === 'committed'), 'RESERVATION_BINDING', 'Retained policy reservation differs.');
    }
  };
  if (verifiedStates.get(digest) !== undefined) {
    counters.stateReuses++;
    for (const admission of state.admissions) await checkReservations(admission);
    return state;
  }
  counters.stateChecks++;
  unique(state.admissions.map(a => a.id), 'admission'); unique(state.admissions.map(a => a.proposal.id), 'proposal');
  unique(state.applications.filter(a => !a.revert).map(a => a.admissionId), 'application');
  unique(state.applications.filter(a => a.revert).map(a => a.admissionId), 'revert'); unique(state.receipts.map(r => r.idempotencyKey), 'idempotency key');
  const admissions = new Map(state.admissions.map(a => [a.id, a]));
  const appliedIds = new Set(state.applications.filter(a => !a.revert).map(a => a.admissionId));
  const revertedIds = new Set(state.applications.filter(a => a.revert).map(a => a.admissionId));
  assert(state.ledgerRevision === state.receipts.length && state.receipts.every((r, i) => r.ledgerRevision === i + 1
    && r.planRevision <= state.plan.revision && admissions.has(r.resourceId)), 'INVALID_STATE', 'Retained command ledger is incomplete.');
  let plan = await emptyPlan(state.baseCourseDigest);
  const snapshots = new Map([[plan.digest, plan]]);
  const live: Admission[] = [], appliedOn = new Map<string, string>();
  for (const applied of state.applications) {
    const admission = admissions.get(applied.admissionId);
    if (applied.revert) {
      // A revert follows its own application and names that application's parent plan.
      const at = live.findIndex(a => a.id === applied.admissionId);
      assert(admission?.status === 'reverted' && at >= 0 && applied.rollbackTargetDigest === appliedOn.get(admission.id) && applied.parentDigest === plan.digest,
        'INVALID_STATE', 'Revert needs a live retained application.');
      live.splice(at, 1);
      plan = await revertPlan(plan, admission, applied.rollbackTargetDigest!, live);
    } else {
      assert(admission?.status === 'applied' || admission?.status === 'reverted', 'INVALID_STATE', 'Application needs its retained admission.');
      assert(await same(admission.admittedPlan, plan), 'INVALID_STATE', 'Application plan lineage differs.');
      plan = await advancePlan(plan, admission);
      assert(applied.parentDigest === admission.admittedPlan.digest, 'INVALID_STATE', 'Application hash chain differs.');
      live.push(admission); appliedOn.set(admission.id, applied.parentDigest);
    }
    assert(applied.revision === plan.revision && applied.digest === plan.digest, 'INVALID_STATE', 'Application hash chain differs.');
    snapshots.set(plan.digest, plan);
  }
  assert(await same(state.plan, plan), 'INVALID_STATE', 'Plan must match retained applications.');
  for (const admission of state.admissions) {
    assert(await same(snapshots.get(admission.admittedPlan.digest) ?? null, admission.admittedPlan), 'INVALID_STATE', 'Admission names an unknown plan.');
    const proposalDigest = await retainedProposalDigest(context, admission);
    assert(proposalDigest === admission.proposalDigest && admission.bindingsDigest === state.bindingsDigest,
      'INVALID_STATE', 'Retained admission binding differs.');
    assert((admission.status === 'applied' || admission.status === 'reverted') === appliedIds.has(admission.id)
      && (admission.status === 'reverted') === revertedIds.has(admission.id), 'INVALID_STATE', 'Application state differs.');
    await checkReservations(admission);
  }
  verifiedStates.set(digest, digest);
  return state;
}
