import { z } from 'zod';
import {
  acceptanceSchema, assert, authoritySchema, changeSchema, commandFields, debitSchema,
  id, instant, parse, workSchema,
  type Adjustment, type ExtensionChange, type Offer, type PolicyState,
} from './contracts.js';
import { adjustedScope, quotaViolations, readState, resolveInternal, safeSum, scopePath, validateConcepts } from './resolver.js';
import { addCalendarDays, compareInstants, hoursBetween } from './time.js';
import { begin, digest, finish, requireAuthority } from './transitions.js';

export function poolBalances(input: PolicyState) {
  const state = readState(input);
  return state.pools.map(pool => {
    const debits = state.grants.flatMap(g => g.poolDebits.filter(d => d.poolId === pool.poolId));
    return { poolId: pool.poolId, remaining: pool.total - safeSum(debits.map(d => d.amount)), grantsRemaining: pool.maxGrants - debits.length };
  });
}

export function buildAdjustment(state: PolicyState, scopeId: string, change: ExtensionChange): Adjustment {
  const path = scopePath(state, scopeId);
  const scope = adjustedScope(state, path.at(-1)!);
  const adjustment: Adjustment = { scopeId, additionalMinutes: change.work?.additionalMinutes ?? 0, additionalEpisodes: change.work?.additionalEpisodes ?? 0 };
  if (change.deadline?.kind === 'absolute') {
    assert(scope.hardDeadline, 'INVALID_CHANGE', 'Scope has no absolute deadline');
    adjustment.absoluteDeadline = addCalendarDays({ at: scope.hardDeadline.at, calendarDays: change.deadline.calendarDays,
      timeZone: scope.hardDeadline.timeZone, disambiguation: scope.hardDeadline.disambiguation });
  } else if (change.deadline?.kind === 'window') {
    assert(scope.window, 'INVALID_CHANGE', 'Scope has no calendar window');
    adjustment.windowDeadline = addCalendarDays({ at: scope.window.resolvedDeadline, calendarDays: change.deadline.calendarDays,
      timeZone: scope.window.timeZone, disambiguation: scope.window.disambiguation });
  }
  for (const metric of ['additionalMinutes', 'additionalEpisodes'] as const) {
    if (adjustment[metric] > 0) assert(scope.work[metric] !== undefined, 'INVALID_CHANGE', 'Cannot extend an unlimited or absent work cap');
  }
  const before = resolveInternal(state, scopeId), after = resolveInternal(state, scopeId, adjustment);
  if (change.deadline) {
    const desired = adjustment.absoluteDeadline ?? adjustment.windowDeadline!;
    assert(after.effectiveDeadline !== null && compareInstants(desired, after.effectiveDeadline) === 0,
      'PARENT_CAP_CONFLICT', 'An ancestor, ultimate ceiling, or other deadline binds; offer explicitly revised terms');
    assert(before.effectiveDeadline !== null && compareInstants(after.effectiveDeadline, before.effectiveDeadline) > 0,
      'NO_EFFECT', 'Deadline extension must change the effective deadline');
  }
  for (const metric of ['additionalMinutes', 'additionalEpisodes'] as const) {
    if (!adjustment[metric]) continue;
    const remaining = (snapshot: typeof before) => Math.min(...snapshot.quotas.filter(q => q.metric === metric).map(q => q.remaining));
    assert(remaining(after) - remaining(before) === adjustment[metric], 'PARENT_CAP_CONFLICT', 'Requested work increase is not fully effective under all ancestor caps');
  }
  return adjustment;
}

const previewSchema = z.strictObject({ scopeId: id, change: changeSchema, addedWork: workSchema, poolDebits: z.array(debitSchema).min(1) });

export function previewExtension(input: PolicyState, request: z.input<typeof previewSchema>) {
  const state = readState(input), args = parse(previewSchema, request);
  assert(state.status === 'active', 'ENROLLMENT_INACTIVE', 'Extensions cannot silently reopen an enrollment');
  const path = scopePath(state, args.scopeId), scope = path.at(-1)!;
  const configuration = scope.extensions;
  assert(configuration?.enabled && path.every(s => s.extensions?.enabled !== false), 'EXTENSIONS_DISABLED', 'Extensions must be enabled at this scope and permitted by ancestors');
  validateConcepts(state, args.addedWork);
  const adjustment = buildAdjustment(state, args.scopeId, args.change);
  const before = resolveInternal(state, args.scopeId), after = resolveInternal(state, args.scopeId, adjustment);
  assert(quotaViolations(after, args.addedWork).length === 0, 'INFEASIBLE_WORK', 'Proposed activities do not fit the remaining work envelope');
  const balances = poolBalances(state);
  const balanceBefore: typeof balances = [], balanceAfter: typeof balances = [];
  assert(new Set(args.poolDebits.map(d => d.poolId)).size === args.poolDebits.length, 'INVALID_INPUT', 'Duplicate pool debits');
  const charged: Record<'days' | 'minutes' | 'episodes', number[]> = { days: [], minutes: [], episodes: [] };
  const debits = [...args.poolDebits].sort((a, b) => a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0);
  for (const debit of debits) {
    const pool = state.pools.find(p => p.poolId === debit.poolId);
    assert(pool && configuration.poolIds.includes(pool.poolId) && pool.scopeIds.includes(args.scopeId), 'POOL_NOT_ALLOWED', 'Pool is not explicitly enabled for this scope');
    const balance = balances.find(b => b.poolId === pool.poolId)!;
    assert(debit.amount <= pool.maxPerGrant, 'PER_GRANT_LIMIT', 'Debit exceeds the per-grant maximum');
    assert(debit.amount <= balance.remaining && balance.grantsRemaining > 0, 'ALLOWANCE_EXHAUSTED', 'Pool cannot fund this grant');
    charged[pool.unit === 'planned_minute' ? 'minutes' : pool.unit === 'episode' ? 'episodes' : 'days'].push(debit.amount);
    balanceBefore.push(balance);
    balanceAfter.push({ poolId: pool.poolId, remaining: balance.remaining - debit.amount, grantsRemaining: balance.grantsRemaining - 1 });
  }
  assert(safeSum(charged.days) === (args.change.deadline?.calendarDays ?? 0)
    && safeSum(charged.minutes) === (args.change.work?.additionalMinutes ?? 0)
    && safeSum(charged.episodes) === (args.change.work?.additionalEpisodes ?? 0),
  'DEBIT_MISMATCH', 'Every extension unit must have an exact, disclosed pool cost');
  const requiredApprovals = [...new Set(path.flatMap(s => s.extensions?.requiredAuthorityIds ?? []))].sort();
  return { adjustment, currentEffectiveDeadline: before.effectiveDeadline, proposedEffectiveDeadline: after.effectiveDeadline,
    currentWorkQuotas: before.quotas, proposedWorkQuotas: after.quotas,
    poolDebits: debits, balanceBefore, balanceAfter,
    bindingAncestorCaps: after.deadlines.filter(d => d.scopeId !== args.scopeId || d.kind === 'ultimate'), requiredApprovals };
}

const proposalSchema = previewSchema.extend({
  ...commandFields, offerId: id, rationaleEvidenceRefs: z.array(id).min(1), proposedActivities: z.array(id).min(1),
  planImpact: z.string().trim().min(1), alternatives: z.array(z.string().trim().min(1)).min(1), expiresAt: instant,
});

export function proposeExtension(input: PolicyState, request: z.input<typeof proposalSchema>) {
  const state = readState(input), args = parse(proposalSchema, request);
  const replay = begin(state, args, 'propose_extension'); if (replay) return replay;
  assert(!state.offers.some(o => o.terms.offerId === args.offerId), 'DUPLICATE_OFFER', 'Offer ID already exists');
  assert(compareInstants(args.expiresAt, args.now) > 0, 'OFFER_EXPIRED', 'Offer expiration must be in the future');
  const preview = previewExtension(state, { scopeId: args.scopeId, change: args.change, addedWork: args.addedWork, poolDebits: args.poolDebits });
  const configurations = scopePath(state, args.scopeId).flatMap(s => s.extensions ? [s.extensions] : []);
  const maxOffers = Math.min(...configurations.map(c => c.maxOffersPerScope));
  const maxOutstanding = Math.min(...configurations.map(c => c.maxOutstandingOffersPerScope));
  const cooldownHours = Math.max(...configurations.map(c => c.offerCooldownHours));
  const history = state.offers.filter(o => o.terms.scopeId === args.scopeId);
  assert(history.length < maxOffers, 'OFFER_FREQUENCY_LIMIT', 'Lifetime offer-frequency budget is exhausted');
  assert(history.filter(o => ['proposed', 'accepted_pending_admin'].includes(o.state) && compareInstants(o.terms.expiresAt, args.now) > 0).length
    < maxOutstanding, 'OUTSTANDING_OFFER_LIMIT', 'Too many outstanding offers');
  assert(history.every(o => hoursBetween(o.lastTransitionAt, args.now) >= cooldownHours), 'OFFER_COOLDOWN', 'Offer cooldown has not elapsed');
  const { adjustment: _adjustment, ...disclosures } = preview;
  const terms = { offerId: args.offerId, scopeId: args.scopeId, enrollmentId: state.enrollmentId, expectedPolicyRevision: state.policyRevision,
    rationaleEvidenceRefs: args.rationaleEvidenceRefs, proposedActivities: args.proposedActivities,
    change: args.change, addedWork: args.addedWork, ...disclosures,
    planImpact: args.planImpact, alternatives: args.alternatives, createdAt: args.now, expiresAt: args.expiresAt };
  const next = structuredClone(state);
  next.offers.push({ terms, termsDigest: digest(terms), state: 'proposed', lastTransitionAt: args.now });
  return finish(state, next, args, 'propose_extension', args.offerId);
}

function currentOffer(state: PolicyState, offerId: string, now: string): Offer {
  const offer = state.offers.find(o => o.terms.offerId === offerId);
  assert(offer, 'UNKNOWN_OFFER', 'Unknown offer');
  assert(!state.grants.some(g => g.offerId === offerId), 'DUPLICATE_GRANT', 'This offer already has a grant');
  assert(['proposed', 'accepted_pending_admin'].includes(offer.state), 'INVALID_OFFER_STATE', 'Offer is no longer actionable');
  assert(compareInstants(now, offer.terms.expiresAt) < 0, 'OFFER_EXPIRED', 'Offer has expired');
  assert(compareInstants(now, offer.terms.createdAt) >= 0, 'INVALID_TIME', 'Acceptance cannot precede the offer');
  assert(offer.terms.expectedPolicyRevision === state.policyRevision, 'STALE_OFFER', 'Policy changed; issue a revised offer and request fresh consent');
  assert(digest(offer.terms) === offer.termsDigest, 'TERMS_CHANGED', 'Offer digest does not match its terms');
  const preview = previewExtension(state, { scopeId: offer.terms.scopeId, change: offer.terms.change, addedWork: offer.terms.addedWork, poolDebits: offer.terms.poolDebits });
  for (const key of ['currentEffectiveDeadline', 'proposedEffectiveDeadline', 'currentWorkQuotas', 'proposedWorkQuotas', 'poolDebits', 'balanceBefore', 'balanceAfter', 'bindingAncestorCaps', 'requiredApprovals'] as const) {
    assert(digest(preview[key]) === digest(offer.terms[key]), 'TERMS_CHANGED', 'Current constraints or balances differ from the offered terms');
  }
  return offer;
}

function verifyAcceptance(state: PolicyState, offer: Offer, acceptance: z.infer<typeof acceptanceSchema>, now: string) {
  assert(acceptance.learnerId === state.learnerId && acceptance.enrollmentId === state.enrollmentId
    && acceptance.offerId === offer.terms.offerId && acceptance.termsDigest === offer.termsDigest
    && compareInstants(acceptance.acceptedAt, offer.terms.createdAt) >= 0 && compareInstants(acceptance.acceptedAt, now) <= 0
    && compareInstants(acceptance.acceptedAt, offer.terms.expiresAt) < 0,
  'CONSENT_REQUIRED', 'Learner must affirmatively accept these exact current terms');
}

const acceptanceCommand = z.strictObject({ ...commandFields, offerId: id, acceptance: acceptanceSchema });
export function acceptExtension(input: PolicyState, request: z.input<typeof acceptanceCommand>) {
  const state = readState(input), args = parse(acceptanceCommand, request);
  const replay = begin(state, args, 'accept_extension'); if (replay) return replay;
  const offer = currentOffer(state, args.offerId, args.now);
  verifyAcceptance(state, offer, args.acceptance, args.now);
  assert(offer.state === 'proposed', 'INVALID_OFFER_STATE', 'Offer already has a recorded acceptance');
  const next = structuredClone(state), target = next.offers.find(o => o.terms.offerId === args.offerId)!;
  target.acceptance = args.acceptance; target.state = 'accepted_pending_admin'; target.lastTransitionAt = args.now;
  return finish(state, next, args, 'accept_extension', args.offerId);
}

const grantCommand = z.strictObject({
  ...commandFields, offerId: id, grantId: id, atomicLedgerTransactionId: id,
  acceptance: acceptanceSchema.optional(), authorityReceipts: z.array(authoritySchema),
});
export function grantExtension(input: PolicyState, request: z.input<typeof grantCommand>) {
  const state = readState(input), args = parse(grantCommand, request);
  const replay = begin(state, args, 'grant_extension'); if (replay) return replay;
  assert(!state.grants.some(g => g.grantId === args.grantId), 'DUPLICATE_GRANT', 'Grant ID already exists');
  assert(!state.grants.some(g => g.atomicLedgerTransactionId === args.atomicLedgerTransactionId), 'DUPLICATE_TRANSACTION', 'Ledger transaction ID already exists');
  const offer = currentOffer(state, args.offerId, args.now);
  const acceptance = args.acceptance ?? offer.acceptance;
  assert(acceptance, 'CONSENT_REQUIRED', 'Explicit learner acceptance is required');
  verifyAcceptance(state, offer, acceptance, args.now);
  assert(new Set(args.authorityReceipts.map(r => r.actorId)).size === args.authorityReceipts.length, 'INVALID_INPUT', 'Duplicate authority');
  for (const authority of args.authorityReceipts) requireAuthority(state, authority, 'grant_extension', offer.terms.scopeId, offer.termsDigest, args.now);
  assert(offer.terms.requiredApprovals.every(actorId => args.authorityReceipts.some(r => r.actorId === actorId)), 'AUTHORITY_REQUIRED', 'Required approval is missing');
  const adjustment = buildAdjustment(state, offer.terms.scopeId, offer.terms.change);
  const next = structuredClone(state), target = next.offers.find(o => o.terms.offerId === args.offerId)!;
  target.state = 'granted'; target.acceptance = acceptance; target.lastTransitionAt = args.now;
  next.grants.push({ grantId: args.grantId, offerId: args.offerId, acceptedTermsDigest: offer.termsDigest,
    learnerAcceptanceReceipt: acceptance, authorityReceipts: args.authorityReceipts,
    idempotencyKey: args.idempotencyKey, atomicLedgerTransactionId: args.atomicLedgerTransactionId,
    newPolicyRevision: safeSum([state.policyRevision, 1]), grantedAt: args.now, poolDebits: offer.terms.poolDebits, adjustment });
  return finish(state, next, args, 'grant_extension', args.grantId, true);
}

const dispositionCommand = z.strictObject({
  ...commandFields, offerId: id, state: z.enum(['declined', 'expired', 'rejected', 'superseded']),
  learnerId: id.optional(), authorityReceipt: authoritySchema.optional(),
});
export function disposeOffer(input: PolicyState, request: z.input<typeof dispositionCommand>) {
  const state = readState(input), args = parse(dispositionCommand, request);
  const replay = begin(state, args, 'dispose_offer'); if (replay) return replay;
  const offer = state.offers.find(o => o.terms.offerId === args.offerId);
  assert(offer && ['proposed', 'accepted_pending_admin'].includes(offer.state), 'INVALID_OFFER_STATE', 'Offer is not actionable');
  if (args.state === 'declined') assert(args.learnerId === state.learnerId, 'CONSENT_REQUIRED', 'Decline must come from the learner');
  else if (args.state === 'expired') assert(compareInstants(args.now, offer.terms.expiresAt) >= 0, 'INVALID_TIME', 'Offer is not expired');
  else {
    assert(args.authorityReceipt, 'AUTHORITY_REQUIRED', 'Offer management authority is required');
    requireAuthority(state, args.authorityReceipt, 'manage_offers', offer.terms.scopeId, offer.termsDigest, args.now);
  }
  const next = structuredClone(state);
  next.offers.find(o => o.terms.offerId === args.offerId)!.state = args.state;
  next.offers.find(o => o.terms.offerId === args.offerId)!.lastTransitionAt = args.now;
  return finish(state, next, args, 'dispose_offer', args.offerId);
}
