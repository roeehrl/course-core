import { digestJson } from '@course-core/sdk';
import { checkAction, reserveWork, commitWork, cancelReservation, compareInstants, resolveConstraints } from '@course-core/policy';
import type { PolicyState } from '@course-core/policy';
import type { AdaptationState, AdaptationTransition, AdmitCommand, AdmissionCommand, Admission, CancelCommand, Command,
  CommandReceipt, RuntimeContext, ReservationBinding, TransactionPreconditions } from './contracts.js';
import { requireCondition as assert } from './contracts.js';
import { admissionCommandSchema, admitSchema, cancelCommandSchema, advancePlan, revertPlan, bindingsDigest, capture, captureContext, emptyPlan, parse, readState, same, seal,
  validateContext, validateProposal } from './validation.js';

export async function createAdaptationState(contextInput: RuntimeContext): Promise<AdaptationState> {
  const context = await validateContext(contextInput);
  assert(!context.policy.reservations.some(r => r.reservationId.startsWith('adapt-')), 'RESET_FORBIDDEN', 'An enrollment with adaptation reservations must reload its retained state.');
  return seal({ schemaVersion: 1, enrollmentId: context.policy.enrollmentId, baseCourseDigest: context.evidence.baseCourseDigest,
    ledgerRevision: 0, digest: '', bindingsDigest: await bindingsDigest(context), plan: await emptyPlan(context.evidence.baseCourseDigest),
    admissions: [], applications: [], receipts: [] });
}
async function preconditions(context: RuntimeContext, state: AdaptationState, now: string): Promise<TransactionPreconditions> {
  return { enrollmentId: state.enrollmentId, baseCourseDigest: state.baseCourseDigest,
    evaluatedAt: now, mustCommitBefore: null,
    adaptation: { ledgerRevision: state.ledgerRevision, digest: state.digest, planRevision: state.plan.revision, planDigest: state.plan.digest },
    policy: { policyRevision: context.policy.policyRevision, ledgerRevision: context.policy.ledgerRevision, digest: await digestJson(context.policy) },
    registry: { revision: context.registry.revision, digest: await digestJson(context.registry) }, evidence: structuredClone(context.evidence) };
}
function revisions(context: RuntimeContext, state: AdaptationState, command: Command) {
  assert(command.expectedAdaptationRevision === state.ledgerRevision, 'STALE_ADAPTATION', 'Reload the adaptation ledger.');
  assert(command.expectedPolicyRevision === context.policy.policyRevision, 'STALE_POLICY_REVISION', 'Policy changed.');
  assert(command.expectedPolicyLedgerRevision === context.policy.ledgerRevision, 'STALE_POLICY_LEDGER', 'Policy usage changed.');
  assert(command.expectedRegistryRevision === context.registry.revision, 'STALE_REGISTRY', 'Trusted registry changed.');
  assert(command.expectedEvidenceRevision === context.evidence.revision, 'STALE_EVIDENCE', 'Evidence changed.');
}
async function begin(contextInput: RuntimeContext, input: AdaptationState, raw: AdmitCommand | AdmissionCommand | CancelCommand, operation: CommandReceipt['operation']) {
  // Capture every argument together before any await, preventing mixed snapshots. A recorded,
  // deeply frozen base course is shared rather than copied (see captureContext).
  const capturedContext = captureContext(contextInput);
  const all = { context: capturedContext, ...await capture({ state: input, command: raw }) };
  const command = operation === 'admit' ? parse(admitSchema, all.command)
    : parse(operation === 'cancel' ? cancelCommandSchema : admissionCommandSchema, all.command);
  const context = await validateContext(all.context), state = await readState(all.state, context);
  const { now: _now, idempotencyKey: _key, expectedAdaptationRevision: _adaptation, expectedPolicyRevision: _policy,
    expectedPolicyLedgerRevision: _ledger, expectedRegistryRevision: _registry, expectedEvidenceRevision: _evidence, ...terms } = command;
  const requestDigest = await digestJson({ operation, terms });
  const previous = state.receipts.find(r => r.idempotencyKey === command.idempotencyKey);
  const fence = await preconditions(context, state, command.now);
  if (previous) {
    assert(previous.requestDigest === requestDigest, 'IDEMPOTENCY_CONFLICT', 'Key already names different semantic terms.');
    return { context, state, command, requestDigest, fence, replay: { state, policy: context.policy, receipt: previous,
      replayed: true, preconditions: fence, outbox: [], evidenceWrites: [], creditWrites: [] } as AdaptationTransition };
  }
  revisions(context, state, command);
  return { context, state, command, requestDigest, fence, replay: undefined };
}
async function finish(before: AdaptationState, state: AdaptationState, policy: PolicyState, command: Command,
  operation: CommandReceipt['operation'], resourceId: string, requestDigest: string, fence: TransactionPreconditions): Promise<AdaptationTransition> {
  state.ledgerRevision = before.ledgerRevision + 1;
  assert(Number.isSafeInteger(state.ledgerRevision), 'REVISION_LIMIT', 'Adaptation ledger revision exhausted.');
  const receipt: CommandReceipt = { idempotencyKey: command.idempotencyKey, requestDigest, operation, resourceId,
    ledgerRevision: state.ledgerRevision, planRevision: state.plan.revision, planDigest: state.plan.digest };
  state.receipts.push(receipt);
  return { state: await seal(state), policy, receipt, replayed: false, preconditions: fence,
    outbox: [{ id: await digestJson({ enrollmentId: state.enrollmentId, operation, key: command.idempotencyKey }),
      type: operation === 'admit' ? 'adaptation.admitted' : operation === 'apply' ? 'adaptation.applied' : operation === 'revert' ? 'adaptation.reverted' : 'adaptation.cancelled',
      admissionId: resourceId, planRevision: state.plan.revision, planDigest: state.plan.digest }], evidenceWrites: [], creditWrites: [] };
}
async function authorize(context: RuntimeContext, admission: Pick<Admission, 'proposal' | 'proposalDigest' | 'assignments' | 'authorizationRef'>, now: string) {
  const authorization = context.registry.authorizations.find(a => a.receiptRef === admission.authorizationRef);
  assert(authorization?.status === 'active' && authorization.enrollmentId === context.policy.enrollmentId
    && authorization.baseCourseDigest === context.evidence.baseCourseDigest && authorization.proposalDigest === admission.proposalDigest,
  'UNTRUSTED_AUTHORIZATION', 'An active host-authenticated authorization for these exact terms is required.');
  assert(authorization.assignmentsDigest === await digestJson(admission.assignments)
    && admission.assignments.every(a => a.authorityReceiptRef === authorization.receiptRef),
  'ASSIGNMENT_BINDING', 'Classification and costs must match the authenticated author/server decision.');
  assert(authorization.evidenceRevision === context.evidence.revision && authorization.evidenceDigest === context.evidence.digest,
    'STALE_EVIDENCE', 'Authorization binds a different evidence snapshot.');
  assert(compareInstants(authorization.authorizedAt, now) <= 0 && compareInstants(now, authorization.expiresAt) < 0,
    'AUTHORIZATION_EXPIRED', 'Authorization is not currently valid.');
  for (const receipt of admission.proposal.proofReceipts) {
    const trusted = context.registry.proofs.find(p => p.receipt?.receiptRef === receipt.receiptRef);
    assert(trusted?.status === 'active' && trusted.enrollmentId === context.policy.enrollmentId
      && trusted.baseCourseDigest === context.evidence.baseCourseDigest && await same(trusted.receipt, receipt),
    'UNTRUSTED_PROOF', 'Each proof must exactly match a host-authenticated registry record.');
    assert(compareInstants(receipt.issuedAt, now) <= 0, 'FUTURE_PROOF', 'Proof cannot come from the future.');
  }
  return digestJson(authorization);
}
async function requireFreshVariants(context: RuntimeContext, state: AdaptationState, proposal: AdmitCommand['proposal']) {
  // Item IDs and answer keys cannot turn the same question into a fresh attempt.
  const fingerprint = ({ id: _id, grading: _grading, ...question }: RuntimeContext['course']['assessments'][number]) => digestJson(question);
  const seen = new Set(await Promise.all(context.course.assessments.map(fingerprint)));
  for (const previous of state.admissions.filter(a => a.status !== 'cancelled')) for (const artifact of previous.proposal.artifacts) {
    if (artifact.kind === 'assessment_variant') seen.add(await fingerprint(artifact.assessment));
  }
  for (const artifact of proposal.artifacts) if (artifact.kind === 'assessment_variant') {
    const digest = await fingerprint(artifact.assessment);
    assert(!seen.has(digest), 'DUPLICATE_QUESTION', 'Renaming a retained question does not make it a fresh assessment variant.');
    seen.add(digest);
  }
}
/** The live core headroom an enrollment reserved at the start, if any. */
function coreHeadroom(policy: RuntimeContext['policy']) {
  return policy.reservations.filter(r => r.purpose === 'core' && r.state === 'reserved');
}
/**
 * Work reservations per scope. With live core headroom, required (core-path) operations get a
 * reservation of their own, separate from optional personal extras, so it can be funded from
 * that headroom; without headroom the bindings are exactly as before. Deterministic for the
 * same context, so application can recompute and compare them.
 */
async function reservationsFor(context: RuntimeContext, admissionId: string, proposal: AdmitCommand['proposal'], decisions: AdmitCommand['assignments']) {
  const split = coreHeadroom(context.policy).length > 0;
  const groups = new Map<string, { scopeId: string; core: boolean; minutes: number; episodes: number; concepts: Set<string> }>();
  for (const operation of proposal.operations) {
    if (operation.type === 'suggest_profile_correction') continue;
    // An inserted episode is charged to the scope of the episode it follows.
    const anchor = operation.type === 'insert_episode' ? operation.afterEpisodeId : operation.episodeId;
    const scopeId = context.registry.episodeScopes.find(b => b.episodeId === anchor)!.scopeId;
    const decision = decisions.find(d => d.operationId === operation.id)!;
    const core = split && decision.classification === 'required', key = `${scopeId}\u0000${core}`;
    const group = groups.get(key) ?? { scopeId, core, minutes: 0, episodes: 0, concepts: new Set<string>() };
    // Optional work and replacements consume the same counters; past usage is never refunded.
    group.minutes += decision.plannedMinutes; group.episodes += decision.additionalEpisodes;
    assert(Number.isSafeInteger(group.minutes) && Number.isSafeInteger(group.episodes), 'COST_OVERFLOW', 'Work costs overflow.');
    const artifact = proposal.artifacts.find(a => a.id === operation.artifactId)!;
    for (const objectiveId of artifact.objectiveIds) group.concepts.add(context.registry.objectiveConcepts.find(b => b.objectiveId === objectiveId)!.conceptId);
    groups.set(key, group);
  }
  const reservations: ReservationBinding[] = [], core = new Set<string>();
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const reservationId = `adapt-${await digestJson({ enrollmentId: context.policy.enrollmentId, admissionId, scopeId: group.scopeId, ...(group.core ? { funding: 'core' } : {}) })}`;
    if (group.core) core.add(reservationId);
    reservations.push({ reservationId, scopeId: group.scopeId,
      work: { additionalMinutes: group.minutes, additionalEpisodes: group.episodes,
        remediation: [...group.concepts].sort().map(conceptId => ({ conceptId, cycles: 1 })) } });
  }
  return { reservations, core };
}
/** Headroom able to fund this core work now: live, in the work's scope path, enough minutes and episodes. */
function fundingFor(policy: RuntimeContext['policy'], binding: ReservationBinding) {
  const path = new Set(policy.scopes.length ? scopePathIds(policy, binding.scopeId) : []);
  return coreHeadroom(policy).find(r => path.has(r.scopeId) && r.work.additionalMinutes >= binding.work.additionalMinutes
    && r.work.additionalEpisodes >= binding.work.additionalEpisodes)?.reservationId;
}
function scopePathIds(policy: RuntimeContext['policy'], scopeId: string) {
  const ids: string[] = [];
  for (let scope = policy.scopes.find(s => s.scopeId === scopeId); scope; scope = scope.parentScopeId === null ? undefined : policy.scopes.find(s => s.scopeId === scope!.parentScopeId))
    ids.push(scope.scopeId);
  return ids;
}
const unfunded = (bindings: readonly ReservationBinding[]) => bindings.map(({ reservationId, scopeId, work }) => ({ reservationId, scopeId, work }));
function policyCommand(policy: PolicyState, command: Command, reservationId: string, operation: string) {
  return { expectedPolicyRevision: policy.policyRevision, expectedLedgerRevision: policy.ledgerRevision, now: command.now,
    idempotencyKey: `${operation}:${reservationId}` };
}
function rootGate(context: RuntimeContext, now: string, kind: 'plan' | 'publish') {
  const decision = checkAction(context.policy, { scopeId: context.policy.scopes.find(s => s.parentScopeId === null)!.scopeId,
    now, expectedPolicyRevision: context.policy.policyRevision, kind });
  assert(decision.allowed, decision.violations[0]?.code ?? 'POLICY_DENIED', 'Current policy blocks adaptation.');
}
function publicationDeadline(context: RuntimeContext, reservations: ReservationBinding[], authorizationRef: string): string {
  const author = context.registry.authorizations.find(a => a.receiptRef === authorizationRef)!;
  const root = context.policy.scopes.find(s => s.parentScopeId === null)!.scopeId;
  const cutoffs = [author.expiresAt, ...[root, ...reservations.map(r => r.scopeId)]
    .flatMap(scopeId => resolveConstraints(context.policy, scopeId).deadlines.map(d => d.at))];
  return cutoffs.reduce((earliest, next) => compareInstants(next, earliest) < 0 ? next : earliest);
}
export async function admitAdaptation(contextInput: RuntimeContext, input: AdaptationState, raw: AdmitCommand): Promise<AdaptationTransition> {
  const started = await begin(contextInput, input, raw, 'admit'); if (started.replay) return started.replay;
  const { context, state, requestDigest, fence } = started, command = started.command as AdmitCommand;
  assert(!state.admissions.some(a => a.id === command.admissionId || a.proposal.id === command.proposal.id),
    'DUPLICATE_ADMISSION', 'Admission and proposal IDs cannot be reused, including after cancellation.');
  const checked = await validateProposal(context, state.plan, command.proposal, command.assignments);
  await requireFreshVariants(context, state, command.proposal);
  rootGate(context, command.now, 'plan');
  const authorizationDigest = await authorize(context, { ...command, proposalDigest: checked.proposalDigest }, command.now);
  const planned = await reservationsFor(context, command.admissionId, command.proposal, command.assignments), reservations = planned.reservations;
  fence.mustCommitBefore = publicationDeadline(context, reservations, command.authorizationRef);
  let policy = context.policy;
  for (const binding of reservations) {
    // Core remediation draws on the core headroom while it lasts; otherwise it is ordinary work.
    const funded = planned.core.has(binding.reservationId) ? fundingFor(policy, binding) : undefined;
    if (funded) binding.fundedByReservationId = funded;
    policy = reserveWork(policy, { ...policyCommand(policy, command, binding.reservationId, 'adapt-reserve'), reservationId: binding.reservationId,
      scopeId: binding.scopeId, work: binding.work, ...(funded ? { fundedByReservationId: funded } : {}) }).state;
  }
  const next = structuredClone(state);
  next.admissions.push({ id: command.admissionId, authorizationRef: command.authorizationRef, status: 'reserved', proposal: checked.proposal,
    proposalDigest: checked.proposalDigest, assignments: command.assignments, admittedPlan: state.plan, admittedVerifiers: context.registry.verifiers,
    admittedPolicyRevision: context.policy.policyRevision, evidence: context.evidence, bindingsDigest: state.bindingsDigest,
    authorizationDigest, reservations });
  return finish(state, next, policy, command, 'admit', command.admissionId, requestDigest, fence);
}
export async function applyAdaptation(contextInput: RuntimeContext, input: AdaptationState, raw: AdmissionCommand): Promise<AdaptationTransition> {
  const started = await begin(contextInput, input, raw, 'apply'); if (started.replay) return started.replay;
  const { context, state, command, requestDigest, fence } = started;
  const admission = state.admissions.find(a => a.id === command.admissionId);
  assert(admission?.status === 'reserved', 'INVALID_ADMISSION_STATE', 'Only a live unapplied admission can publish.');
  assert(admission.admittedPolicyRevision === context.policy.policyRevision, 'STALE_JOB', 'Policy changed since admission; cancel and re-plan.');
  assert(await same(admission.evidence, context.evidence), 'STALE_EVIDENCE', 'Evidence changed since admission.');
  await validateProposal(context, state.plan, admission.proposal, admission.assignments);
  assert(admission.authorizationDigest === await authorize(context, admission, command.now), 'AUTHORIZATION_CHANGED', 'Admission authority changed.');
  rootGate(context, command.now, 'publish');
  fence.mustCommitBefore = publicationDeadline(context, admission.reservations, admission.authorizationRef);
  assert(await same(unfunded(admission.reservations), (await reservationsFor(context, admission.id, admission.proposal, admission.assignments)).reservations),
    'RESERVATION_BINDING', 'Reservation costs and stable concepts differ.');
  let policy = context.policy;
  for (const binding of admission.reservations) {
    const reservation = policy.reservations.find(r => r.reservationId === binding.reservationId);
    assert(reservation && reservation.scopeId === binding.scopeId && await same(reservation.work, binding.work), 'RESERVATION_BINDING', 'Policy reservation differs.');
    policy = commitWork(policy, { ...policyCommand(policy, command, binding.reservationId, 'adapt-commit'),
      reservationId: binding.reservationId, workId: `assigned-${binding.reservationId}` }).state;
  }
  const next = structuredClone(state); next.admissions.find(a => a.id === admission.id)!.status = 'applied';
  next.plan = await advancePlan(state.plan, admission);
  next.applications.push({ admissionId: admission.id, revision: next.plan.revision, parentDigest: state.plan.digest, digest: next.plan.digest });
  return finish(state, next, policy, command, 'apply', admission.id, requestDigest, fence);
}
/**
 * Ends a live, unpublished admission. Each policy reservation is released with the reason, and
 * core work funded from enrollment headroom returns its minutes and episodes to that headroom
 * (see `cancelReservation`); the per-reservation idempotency keys keep a retry from refunding twice.
 */
export async function cancelAdaptation(contextInput: RuntimeContext, input: AdaptationState, raw: CancelCommand): Promise<AdaptationTransition> {
  const started = await begin(contextInput, input, raw, 'cancel'); if (started.replay) return started.replay;
  const { context, state, requestDigest, fence } = started, command = started.command as CancelCommand;
  const admission = state.admissions.find(a => a.id === command.admissionId);
  assert(admission?.status === 'reserved', 'INVALID_ADMISSION_STATE', 'Applied work cannot be refunded or removed.');
  if (command.reason === 'expired') assert(compareInstants(command.now, publicationDeadline(context, admission.reservations, admission.authorizationRef)) >= 0,
    'NOT_EXPIRED', 'The admission can still publish; cancel or refuse it instead.');
  let policy = context.policy;
  for (const binding of admission.reservations) {
    const existing = policy.reservations.find(r => r.reservationId === binding.reservationId);
    assert(existing && existing.state !== 'committed' && existing.scopeId === binding.scopeId && await same(existing.work, binding.work)
      && existing.funding?.reservationId === binding.fundedByReservationId,
    'RESERVATION_BINDING', 'Cannot cancel another or committed reservation.');
    if (existing.state === 'reserved') policy = cancelReservation(policy, { ...policyCommand(policy, command, binding.reservationId, 'adapt-cancel'),
      reservationId: binding.reservationId, ...(command.reason ? { reason: command.reason } : {}) }).state;
  }
  const next = structuredClone(state); next.admissions.find(a => a.id === admission.id)!.status = 'cancelled';
  return finish(state, next, policy, command, 'cancel', admission.id, requestDigest, fence);
}

/**
 * Undo of an applied personal change: a NEW plan revision whose rollback target is the plan the
 * change was applied on. History, receipts, occupied identifiers and committed work all stay
 * (undo never refunds use or frees an id for reuse), and nothing touches evidence or progress.
 * Refused when a later live change replaces a block this one placed or replaced, and for
 * assessment variants, whose recorded attempts would otherwise lose their item.
 */
export async function revertAdaptation(contextInput: RuntimeContext, input: AdaptationState, raw: AdmissionCommand): Promise<AdaptationTransition> {
  const started = await begin(contextInput, input, raw, 'revert'); if (started.replay) return started.replay;
  const { context, state, command, requestDigest, fence } = started;
  const admission = state.admissions.find(a => a.id === command.admissionId);
  assert(admission?.status === 'applied', 'INVALID_ADMISSION_STATE', 'Only a live applied change can be reverted.');
  assert(!admission.proposal.artifacts.some(a => a.kind === 'assessment_variant'), 'REVERT_ASSESSMENT_VARIANT',
    'A fresh assessment item stays: attempts and evidence may refer to it.');
  const position = state.applications.findIndex(a => !a.revert && a.admissionId === admission.id);
  const rollbackTargetDigest = state.applications[position]!.parentDigest;
  const touched = new Set(admission.proposal.operations.flatMap(o => o.type === 'replace_teaching' ? [`${o.episodeId}/${o.blockId}`]
    : o.type === 'append_teaching' ? [`${o.episodeId}/${o.id}`] : o.type === 'insert_episode' ? [`${o.artifactId}/`] : []));
  const revertedLater = new Set(state.applications.filter(a => a.revert).map(a => a.admissionId));
  for (const later of state.applications.slice(position + 1)) {
    if (later.revert || revertedLater.has(later.admissionId)) continue;
    const other = state.admissions.find(a => a.id === later.admissionId)!;
    assert(!other.proposal.operations.some(o => (o.type === 'replace_teaching' && (touched.has(`${o.episodeId}/${o.blockId}`) || touched.has(`${o.episodeId}/`)))
      || ((o.type === 'append_teaching' || o.type === 'replace_teaching') && touched.has(`${o.episodeId}/`))),
    'REVERT_DEPENDENCY', 'A later change builds on this one; revert that change first.');
  }
  // Removing a personal change is never new work, so no policy action is checked or charged.
  const next = structuredClone(state);
  next.admissions.find(a => a.id === admission.id)!.status = 'reverted';
  const live = next.applications.filter(a => !a.revert && !revertedLater.has(a.admissionId) && a.admissionId !== admission.id)
    .map(a => next.admissions.find(x => x.id === a.admissionId)!);
  next.plan = await revertPlan(state.plan, admission, rollbackTargetDigest, live);
  next.applications.push({ admissionId: admission.id, revision: next.plan.revision, parentDigest: state.plan.digest, digest: next.plan.digest,
    revert: true, rollbackTargetDigest });
  return finish(state, next, context.policy, command, 'revert', admission.id, requestDigest, fence);
}

/** Dry-run the same admission checks; never persist this preview as a transaction. */
export async function previewAdaptation(context: RuntimeContext, state: AdaptationState, command: AdmitCommand) {
  const captured = await capture({ context, state, command });
  const transition = await admitAdaptation(captured.context, captured.state, captured.command);
  const admission = transition.state.admissions.find(a => a.id === captured.command.admissionId)!;
  return { proposalDigest: admission.proposalDigest, currentPlan: captured.state.plan, reservations: structuredClone(admission.reservations),
    replayed: transition.replayed, preconditions: transition.preconditions,
    previewDigest: await digestJson({ proposalDigest: admission.proposalDigest, reservations: admission.reservations, preconditions: transition.preconditions }) };
}
