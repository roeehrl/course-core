import { z } from 'zod';
import {
  assert, count, id, instant, parse, scopeSchema, stateSchema, workSchema,
  type Adjustment, type PolicyState, type ScopePolicy, type Work,
} from './contracts.js';
import { compareInstants, resolveCalendarWindow } from './time.js';

export function safeSum(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  assert(Number.isSafeInteger(sum), 'INVALID_INPUT', 'Counter exceeds safe integer range');
  return sum;
}

function unique(values: string[], label: string) {
  assert(new Set(values).size === values.length, 'INVALID_INPUT', `Duplicate ${label}`);
}

export function scopePath(state: PolicyState, scopeId: string): ScopePolicy[] {
  const path: ScopePolicy[] = [];
  let cursor: string | null = scopeId;
  while (cursor !== null) {
    assert(!path.some(s => s.scopeId === cursor), 'INVALID_INPUT', 'Cyclic scope ancestry');
    const scope = state.scopes.find(s => s.scopeId === cursor);
    assert(scope, 'UNKNOWN_SCOPE', `Unknown scope: ${cursor}`);
    path.unshift(scope);
    cursor = scope.parentScopeId;
  }
  return path;
}

export function readState(input: unknown): PolicyState {
  const state = parse(stateSchema, input);
  unique(state.scopes.map(s => s.scopeId), 'scope');
  unique(state.scopes.map(s => s.policyId), 'policy');
  unique(state.pools.map(p => p.poolId), 'pool');
  unique(state.offers.map(o => o.terms.offerId), 'offer');
  unique(state.grants.map(g => g.grantId), 'grant');
  unique(state.grants.map(g => g.offerId), 'granted offer');
  unique(state.accommodations.map(a => a.accommodationId), 'accommodation');
  unique(state.migrations.map(m => m.migrationId), 'migration');
  unique(state.reservations.map(r => r.reservationId), 'reservation');
  unique(state.reservations.flatMap(r => r.workId ? [r.workId] : []), 'assigned work');
  unique(state.refunds.map(r => r.refundId), 'refund');
  unique(state.exceptionalGrants.map(e => e.exceptionId), 'exceptional grant');
  unique(state.receipts.map(r => r.idempotencyKey), 'idempotency key');
  unique(state.coreObjectiveIds, 'core objective'); unique(state.conceptIds, 'concept');
  if (state.requiredConceptIds) {
    unique(state.requiredConceptIds, 'required concept');
    assert(state.requiredConceptIds.every(id => state.conceptIds.includes(id)), 'INVALID_INPUT', 'Required concept is not registered');
  }
  assert(state.scopes.filter(s => s.parentScopeId === null).length === 1, 'INVALID_INPUT', 'Exactly one root is required');
  assert((state.status === 'closed') === Boolean(state.closure), 'INVALID_INPUT', 'Closure and status disagree');
  const anchors = new Map<string, { anchor: string; at: string }>();
  for (const scope of state.scopes) {
    const path = scopePath(state, scope.scopeId);
    if (scope.mode === 'bounded') {
      assert(path.some(s => s.hardDeadline || s.window || s.ultimateDeadline || Object.values(s.work).some(v => v !== undefined)),
        'UNBOUNDED_POLICY', 'Bounded scopes need an inherited deadline or finite work envelope');
    }
    if (scope.window) {
      const previous = anchors.get(scope.window.anchorId);
      assert(!previous || (previous.anchor === scope.window.anchor && compareInstants(previous.at, scope.window.anchorInstant) === 0),
        'INVALID_INPUT', 'A persisted anchor ID cannot refer to different events');
      anchors.set(scope.window.anchorId, { anchor: scope.window.anchor, at: scope.window.anchorInstant });
      assert(compareInstants(scope.window.resolvedDeadline, scope.window.anchorInstant) >= 0, 'INVALID_CALENDAR_TIME', 'Window cannot end before its anchor');
    }
    if (scope.extensions) {
      unique(scope.extensions.poolIds, 'extension pool reference');
      unique(scope.extensions.requiredAuthorityIds, 'required authority');
      for (const poolId of scope.extensions.poolIds) {
        assert(state.pools.some(p => p.poolId === poolId && p.scopeIds.includes(scope.scopeId)),
          'INVALID_INPUT', 'Extension pool must explicitly cover its scope');
      }
    }
  }
  for (const pool of state.pools) {
    unique(pool.scopeIds, 'pool scope');
    pool.scopeIds.forEach(s => scopePath(state, s));
    const grants = state.grants.filter(g => g.poolDebits.some(d => d.poolId === pool.poolId));
    const debited = safeSum(grants.flatMap(g => g.poolDebits.filter(d => d.poolId === pool.poolId).map(d => d.amount)));
    const refunded = safeSum(state.refunds.filter(r => r.poolId === pool.poolId).map(r => r.amount));
    assert(debited - refunded <= pool.total && grants.length <= pool.maxGrants, 'INVALID_LEDGER', 'Allowance ledger is overdrawn');
  }
  for (const refund of state.refunds) {
    const grant = state.grants.find(g => g.grantId === refund.grantId);
    const debit = grant?.poolDebits.find(d => d.poolId === refund.poolId);
    assert(debit && safeSum(state.refunds.filter(r => r.grantId === refund.grantId && r.poolId === refund.poolId).map(r => r.amount)) <= debit.amount,
      'INVALID_LEDGER', 'A refund can return at most what its grant debited from that pool');
  }
  for (const entry of [...state.grants, ...state.accommodations, ...state.exceptionalGrants]) {
    scopePath(state, entry.adjustment.scopeId);
    assert(entry.newPolicyRevision <= state.policyRevision, 'INVALID_LEDGER', 'Future adjustment revision');
  }
  for (const entry of [...state.grants, ...state.exceptionalGrants]) if (entry.revocation) {
    assert(entry.revocation.newPolicyRevision <= state.policyRevision && entry.revocation.newPolicyRevision > entry.newPolicyRevision,
      'INVALID_LEDGER', 'Revocation must follow its grant');
  }
  for (const grant of state.grants) {
    unique(grant.poolDebits.map(d => d.poolId), 'grant debit');
    assert(state.offers.some(o => o.terms.offerId === grant.offerId && o.state === 'granted'), 'INVALID_LEDGER', 'Grant requires its retained offer');
    for (const debit of grant.poolDebits) {
      assert(state.pools.some(p => p.poolId === debit.poolId && p.scopeIds.includes(grant.adjustment.scopeId)),
        'INVALID_LEDGER', 'Grant names an unknown or inapplicable pool');
    }
  }
  for (const reservation of state.reservations) {
    assert(JSON.stringify(scopePath(state, reservation.scopeId).map(s => s.scopeId)) === JSON.stringify(reservation.ancestorScopeIds),
      'INVALID_LEDGER', 'Reservation ancestry changed');
    assert((reservation.state === 'committed') === Boolean(reservation.workId), 'INVALID_LEDGER', 'Work receipt and reservation state disagree');
    validateConcepts(state, reservation.work);
    const { funding, release } = reservation;
    if (funding) {
      const source = state.reservations.find(r => r.reservationId === funding.reservationId);
      assert(source && source.purpose !== 'extra' && source.purpose === reservation.purpose && source.reservationId !== reservation.reservationId
        && funding.additionalMinutes <= reservation.work.additionalMinutes && funding.additionalEpisodes <= reservation.work.additionalEpisodes,
      'INVALID_LEDGER', 'Funded work must name the headroom it was drawn from and draw no more than it reserves');
    }
    if (release) {
      assert(reservation.state === 'cancelled' && !(release.used.additionalMinutes > reservation.work.additionalMinutes
        || release.used.additionalEpisodes > reservation.work.additionalEpisodes
        || release.used.remediation.some(u => u.cycles > (reservation.work.remediation.find(r => r.conceptId === u.conceptId)?.cycles ?? 0))),
      'INVALID_LEDGER', 'A release can only record use within a cancelled reservation');
      const refund = release.headroomRefund;
      assert(!refund || (funding && refund.reservationId === funding.reservationId
        && refund.additionalMinutes <= funding.additionalMinutes && refund.additionalEpisodes <= funding.additionalEpisodes),
      'INVALID_LEDGER', 'A headroom refund returns at most what was drawn, to the headroom it came from');
    }
  }
  for (const offer of state.offers) {
    scopePath(state, offer.terms.scopeId);
    assert(offer.terms.enrollmentId === state.enrollmentId, 'INVALID_LEDGER', 'Offer belongs to a different enrollment');
  }
  return state;
}

export function validateConcepts(state: PolicyState, work: Work) {
  assert(work.remediation.every(r => state.conceptIds.includes(r.conceptId)), 'UNKNOWN_CONCEPT', 'Remediation must use registered stable concept IDs');
}

const headroomSchema = z.strictObject({ reservationId: id, scopeId: id, purpose: z.enum(['core', 'final_assessment']), work: workSchema });
const initialSchema = stateSchema.pick({ enrollmentId: true, learnerId: true, coreObjectiveIds: true, conceptIds: true, requiredConceptIds: true, scopes: true, pools: true, afterClosure: true })
  .extend({ headroom: z.array(headroomSchema).default([]) });

/** Only for a NEW enrollment. Revisions must use the migration command. */
export function createPolicyState(input: z.input<typeof initialSchema>): PolicyState {
  const initial = parse(initialSchema, input);
  // At creation, a stored preview must agree with the authoring rule. Subsequent
  // reads deliberately do not recalculate it under possibly updated tzdata.
  for (const scope of initial.scopes) if (scope.window) {
    const { resolvedDeadline, ...rule } = scope.window;
    assert(compareInstants(resolveCalendarWindow(rule).resolvedDeadline, resolvedDeadline) === 0,
      'INVALID_CALENDAR_TIME', 'Stored preview does not match the calendar rule');
  }
  const { headroom, ...fields } = initial;
  const state = readState({ ...fields, policyRevision: 1, ledgerRevision: 0, status: 'active',
    offers: [], grants: [], migrations: [], accommodations: [], reservations: [], receipts: [], audit: [] });
  // Core and final-assessment headroom is reserved before any enrichment can be admitted.
  for (const entry of headroom) {
    assert(entry.work.additionalEpisodes > 0 || entry.work.additionalMinutes > 0 || entry.work.remediation.length > 0,
      'INVALID_INPUT', 'Reserved headroom must declare a nonzero amount');
    validateConcepts(state, entry.work);
    const violations = quotaViolations(resolveInternal(state, entry.scopeId), entry.work);
    assert(violations.length === 0, 'RESERVE_EXCEEDS_QUOTA', 'Reserved core headroom does not fit the work envelope');
    state.reservations.push({ reservationId: entry.reservationId, scopeId: entry.scopeId, ancestorScopeIds: scopePath(state, entry.scopeId).map(s => s.scopeId),
      work: entry.work, state: 'reserved', admittedPolicyRevision: 1, purpose: entry.purpose });
  }
  return readState(state);
}

/** Adjustments that currently apply. A revoked grant keeps its ledger entry and usage. */
export function activeAdjustments(state: PolicyState): Adjustment[] {
  return [...state.grants.filter(g => !g.revocation).map(g => g.adjustment), ...state.accommodations.map(a => a.adjustment),
    ...state.exceptionalGrants.filter(e => !e.revocation).map(e => e.adjustment)];
}

export function adjustedScope(state: PolicyState, scope: ScopePolicy, extra?: Adjustment): ScopePolicy {
  const adjusted = structuredClone(scope);
  const adjustments = [...activeAdjustments(state), ...(extra ? [extra] : [])].filter(a => a.scopeId === scope.scopeId);
  for (const adjustment of adjustments) {
    if (adjustment.absoluteDeadline && adjusted.hardDeadline
      && compareInstants(adjustment.absoluteDeadline, adjusted.hardDeadline.at) > 0) adjusted.hardDeadline.at = adjustment.absoluteDeadline;
    if (adjustment.windowDeadline && adjusted.window
      && compareInstants(adjustment.windowDeadline, adjusted.window.resolvedDeadline) > 0) adjusted.window.resolvedDeadline = adjustment.windowDeadline;
  }
  for (const key of ['additionalMinutes', 'additionalEpisodes'] as const) {
    const base = adjusted.work[key];
    if (base !== undefined) adjusted.work[key] = safeSum([base, ...adjustments.map(a => a[key])]);
  }
  return adjusted;
}

export interface DeadlineConstraint { scopeId: string; kind: 'absolute' | 'window' | 'ultimate'; at: string }
export interface QuotaConstraint {
  scopeId: string; metric: 'additionalMinutes' | 'additionalEpisodes' | 'remediationCyclesPerConcept';
  conceptId: string | null; limit: number; consumed: number; reserved: number; remaining: number;
}
export interface ConstraintSnapshot {
  enrollmentId: string; scopeId: string; policyRevision: number; ledgerRevision: number;
  ancestorScopeIds: string[]; effectiveDeadline: string | null;
  deadlines: DeadlineConstraint[]; bindingDeadlines: DeadlineConstraint[];
  quotas: QuotaConstraint[]; existingMaterialAccess: 'read_only' | 'closed';
}

export function resolveInternal(state: PolicyState, scopeId: string, extra?: Adjustment): ConstraintSnapshot {
  const path = scopePath(state, scopeId).map(s => adjustedScope(state, s, extra));
  const deadlines: DeadlineConstraint[] = [];
  const quotas: QuotaConstraint[] = [];
  for (const scope of path) {
    if (scope.hardDeadline) deadlines.push({ scopeId: scope.scopeId, kind: 'absolute', at: scope.hardDeadline.at });
    if (scope.window) deadlines.push({ scopeId: scope.scopeId, kind: 'window', at: scope.window.resolvedDeadline });
    if (scope.ultimateDeadline) deadlines.push({ scopeId: scope.scopeId, kind: 'ultimate', at: scope.ultimateDeadline });
    const entries = state.reservations.filter(r => r.ancestorScopeIds.includes(scope.scopeId));
    for (const metric of ['additionalMinutes', 'additionalEpisodes', 'remediationCyclesPerConcept'] as const) {
      const limit = scope.work[metric];
      if (limit === undefined) continue;
      const concepts = metric === 'remediationCyclesPerConcept' ? [...state.conceptIds].sort() : [null];
      for (const conceptId of concepts) {
        const cost = (work: Work) => metric === 'remediationCyclesPerConcept'
          ? (work.remediation.find(r => r.conceptId === conceptId)?.cycles ?? 0) : work[metric];
        // Work used before a reservation was released stays charged; only the remainder is freed.
        const consumed = safeSum([...entries.filter(r => r.state === 'committed').map(r => cost(r.work)),
          ...entries.flatMap(r => r.state === 'cancelled' && r.release ? [cost(r.release.used)] : [])]);
        const reserved = safeSum(entries.filter(r => r.state === 'reserved').map(r => cost(r.work)));
        quotas.push({ scopeId: scope.scopeId, metric, conceptId, limit, consumed, reserved,
          remaining: Math.max(0, limit - safeSum([consumed, reserved])) });
      }
    }
  }
  const effectiveDeadline = deadlines.reduce<string | null>((min, d) => min === null || compareInstants(d.at, min) < 0 ? d.at : min, null);
  return { enrollmentId: state.enrollmentId, scopeId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision,
    ancestorScopeIds: path.map(s => s.scopeId), effectiveDeadline, deadlines,
    bindingDeadlines: deadlines.filter(d => effectiveDeadline !== null && compareInstants(d.at, effectiveDeadline) === 0), quotas,
    existingMaterialAccess: path.some(s => s.existingMaterialAccess === 'closed') ? 'closed' : 'read_only' };
}

export function resolveConstraints(input: PolicyState, scopeId: string): ConstraintSnapshot {
  return resolveInternal(readState(input), parse(id, scopeId));
}

export interface Violation { code: string; scopeId: string; metric?: string; conceptId?: string | null }
export function quotaViolations(snapshot: ConstraintSnapshot, work: Work): Violation[] {
  return snapshot.quotas.filter(q => {
    const cost = q.metric === 'remediationCyclesPerConcept'
      ? (work.remediation.find(r => r.conceptId === q.conceptId)?.cycles ?? 0) : work[q.metric];
    return safeSum([q.consumed, q.reserved, cost]) > q.limit;
  }).map(q => ({ code: 'QUOTA_EXCEEDED', scopeId: q.scopeId, metric: q.metric, conceptId: q.conceptId }));
}

const actionSchema = z.strictObject({
  scopeId: id, now: instant, expectedPolicyRevision: count,
  kind: z.enum(['plan', 'admit_job', 'tool_call', 'publish', 'submit', 'read', 'grade']),
  work: workSchema.default({ additionalMinutes: 0, additionalEpisodes: 0, remediation: [] }),
  submissionReceipt: z.strictObject({
    receiptId: id, enrollmentId: id, scopeId: id, attemptId: id,
    submittedAt: instant, eligible: z.literal(true), policyRevision: count,
  }).optional(),
});

/** Authoritative time and verified submission receipts must come from the server. */
export function checkAction(input: PolicyState, action: z.input<typeof actionSchema>) {
  return evaluateAction(readState(input), action);
}
/** Many actions against one state: the state is validated once, not per action.
 * Each result is identical to checkAction on the same state and action. */
export function checkActions(input: PolicyState, actions: readonly z.input<typeof actionSchema>[]) {
  const state = readState(input);
  return actions.map(action => evaluateAction(state, action));
}
function evaluateAction(state: PolicyState, action: z.input<typeof actionSchema>) {
  const request = parse(actionSchema, action);
  const snapshot = resolveInternal(state, request.scopeId);
  validateConcepts(state, request.work);
  const violations: Violation[] = [];
  const deny = (code: string, scopeId = request.scopeId) => violations.push({ code, scopeId });
  if (request.expectedPolicyRevision !== state.policyRevision) deny('STALE_POLICY_REVISION');
  if (request.kind === 'read') {
    const capped = state.status === 'closed' || snapshot.deadlines.some(deadline => compareInstants(request.now, deadline.at) >= 0);
    if (capped && snapshot.existingMaterialAccess === 'closed') deny('ACCESS_CLOSED');
  } else if (request.kind === 'grade') {
    // Grading an on-time submission may finish after the cutoff or after closure; it never reopens work.
    const receipt = request.submissionReceipt;
    if (!receipt || receipt.enrollmentId !== state.enrollmentId || receipt.scopeId !== request.scopeId
      || receipt.policyRevision > state.policyRevision || compareInstants(receipt.submittedAt, request.now) > 0) deny('INELIGIBLE_SUBMISSION');
    else for (const deadline of snapshot.deadlines) {
      if (compareInstants(receipt.submittedAt, submissionCutoff(state, deadline)) >= 0) deny('SUBMITTED_AFTER_CUTOFF', deadline.scopeId);
    }
  } else {
    if (state.status !== 'active') deny('ENROLLMENT_INACTIVE');
    for (const deadline of snapshot.deadlines) {
      const cutoff = request.kind === 'submit' ? submissionCutoff(state, deadline) : deadline.at;
      if (compareInstants(request.now, cutoff) >= 0) deny('DEADLINE_REACHED', deadline.scopeId);
    }
    if (request.kind !== 'submit') violations.push(...quotaViolations(snapshot, request.work));
  }
  return { allowed: violations.length === 0, violations, snapshot };
}

function submissionCutoff(state: PolicyState, deadline: DeadlineConstraint): string {
  const scope = state.scopes.find(s => s.scopeId === deadline.scopeId)!;
  return scope.submissionGraceUntil && compareInstants(scope.submissionGraceUntil, deadline.at) > 0 ? scope.submissionGraceUntil : deadline.at;
}

const quotaSchema = z.array(z.strictObject({ id, limit: count, consumed: count, reserved: count, requested: count }));
/** Also usable for independent finite job/spend/security counters. */
export function checkQuotas(input: z.input<typeof quotaSchema>) {
  const quotas = parse(quotaSchema, input);
  unique(quotas.map(q => q.id), 'quota');
  const exceeded = quotas.filter(q => safeSum([q.consumed, q.reserved, q.requested]) > q.limit).map(q => q.id);
  return { allowed: exceeded.length === 0, exceeded };
}

export function validateScopePolicy(input: unknown): ScopePolicy { return parse(scopeSchema, input); }
