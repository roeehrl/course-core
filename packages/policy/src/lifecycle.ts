import { z } from 'zod';
import {
  assert, authoritySchema, changeSchema, commandFields, id, parse, scopeSchema,
  type PolicyState,
} from './contracts.js';
import { buildAdjustment } from './extensions.js';
import { readState, resolveInternal, safeSum, scopePath } from './resolver.js';
import { compareInstants, resolveCalendarWindow } from './time.js';
import { begin, digest, finish, requireAuthority } from './transitions.js';

const migrationPreviewSchema = z.strictObject({ scopes: z.array(scopeSchema).min(1) });
export function previewPolicyChange(input: PolicyState, request: z.input<typeof migrationPreviewSchema>) {
  const state = readState(input), args = parse(migrationPreviewSchema, request);
  for (const scope of args.scopes) if (!state.scopes.some(s => s.scopeId === scope.scopeId) && scope.window) {
    const { resolvedDeadline, ...rule } = scope.window;
    assert(compareInstants(resolveCalendarWindow(rule).resolvedDeadline, resolvedDeadline) === 0,
      'INVALID_CALENDAR_TIME', 'New scope needs an accepted calendar preview');
  }
  for (const old of state.scopes) {
    const updated = args.scopes.find(s => s.scopeId === old.scopeId);
    assert(updated && updated.policyId === old.policyId && updated.parentScopeId === old.parentScopeId && updated.kind === old.kind,
      'RESET_FORBIDDEN', 'Existing scopes, policy identity and ancestry must be preserved');
    assert(digest(updated.window ?? null) === digest(old.window ?? null), 'RESET_FORBIDDEN', 'Persisted anchors and calendar windows cannot reset on revisions; use audited adjustments');
    assert(!old.hardDeadline || updated.hardDeadline, 'RESET_FORBIDDEN', 'Removing an established absolute deadline requires a separate exception operation');
    for (const key of ['additionalMinutes', 'additionalEpisodes', 'remediationCyclesPerConcept'] as const) {
      assert(old.work[key] === undefined || updated.work[key] !== undefined, 'RESET_FORBIDDEN', 'Existing work counters cannot be removed');
    }
    assert(!old.ultimateDeadline || (updated.ultimateDeadline && compareInstants(updated.ultimateDeadline, old.ultimateDeadline) <= 0),
      'ULTIMATE_CEILING', 'Ultimate ceilings cannot be removed or relaxed by a routine migration');
  }
  const candidate = readState({ ...state, scopes: args.scopes });
  const impacts = state.scopes.map(scope => ({ scopeId: scope.scopeId,
    before: resolveInternal(state, scope.scopeId), after: resolveInternal(candidate, scope.scopeId) }));
  const preview = { enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision,
    scopes: args.scopes, impacts,
    affectedReservationIds: state.reservations.filter(r => r.state === 'reserved').map(r => r.reservationId),
    supersededOfferIds: state.offers.filter(o => ['proposed', 'accepted_pending_admin'].includes(o.state)).map(o => o.terms.offerId) };
  return { ...preview, previewDigest: digest(preview) };
}

const migrationSchema = migrationPreviewSchema.extend({
  ...commandFields, migrationId: id, reasonRef: id, previewDigest: id, authorityReceipt: authoritySchema,
});
export function applyPolicyChange(input: PolicyState, request: z.input<typeof migrationSchema>) {
  const state = readState(input), args = parse(migrationSchema, request);
  const replay = begin(state, args, 'migrate_policy'); if (replay) return replay;
  assert(!state.migrations.some(m => m.migrationId === args.migrationId), 'DUPLICATE_MIGRATION', 'Migration ID already exists');
  const preview = previewPolicyChange(state, { scopes: args.scopes });
  assert(args.previewDigest === preview.previewDigest, 'STALE_PREVIEW', 'Impact preview changed; review current impact first');
  const root = state.scopes.find(s => s.parentScopeId === null)!;
  requireAuthority(state, args.authorityReceipt, 'migrate_policy', root.scopeId, preview.previewDigest, args.now);
  const next = structuredClone(state); next.scopes = args.scopes;
  for (const offer of next.offers) if (preview.supersededOfferIds.includes(offer.terms.offerId)) {
    offer.state = 'superseded'; offer.lastTransitionAt = args.now;
  }
  next.migrations.push({ migrationId: args.migrationId, reasonRef: args.reasonRef, authorityReceipt: args.authorityReceipt,
    previewDigest: preview.previewDigest, previousPolicyRevision: state.policyRevision, newPolicyRevision: safeSum([state.policyRevision, 1]) });
  return finish(state, next, args, 'migrate_policy', args.migrationId, true);
}

const accommodationPreviewSchema = z.strictObject({
  scopeId: id, accommodationId: id, reasonRef: id, kind: z.enum(['accommodation', 'approved_pause']), change: changeSchema,
});
export function previewAccommodation(input: PolicyState, request: z.input<typeof accommodationPreviewSchema>) {
  const state = readState(input), args = parse(accommodationPreviewSchema, request);
  assert(state.status === 'active', 'ENROLLMENT_INACTIVE', 'An adjustment cannot silently reopen an enrollment');
  const scope = scopePath(state, args.scopeId).at(-1)!;
  if (args.kind === 'approved_pause') {
    assert(scope.window?.pauseRule === 'approved_only' && args.change.deadline?.kind === 'window' && !args.change.work,
      'PAUSE_NOT_ALLOWED', 'Approved leave may move only a pause-enabled relative window');
  }
  const adjustment = buildAdjustment(state, args.scopeId, args.change);
  const preview = { ...args, enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision, adjustment };
  return { ...preview, previewDigest: digest(preview) };
}

const accommodationCommand = accommodationPreviewSchema.extend({ ...commandFields, previewDigest: id, authorityReceipt: authoritySchema });
export function applyAccommodation(input: PolicyState, request: z.input<typeof accommodationCommand>) {
  const state = readState(input), args = parse(accommodationCommand, request);
  const replay = begin(state, args, 'accommodate'); if (replay) return replay;
  assert(!state.accommodations.some(a => a.accommodationId === args.accommodationId), 'DUPLICATE_ACCOMMODATION', 'Accommodation ID already exists');
  const preview = previewAccommodation(state, { scopeId: args.scopeId, accommodationId: args.accommodationId,
    reasonRef: args.reasonRef, kind: args.kind, change: args.change });
  assert(args.previewDigest === preview.previewDigest, 'STALE_PREVIEW', 'Accommodation preview changed');
  requireAuthority(state, args.authorityReceipt, 'accommodate', args.scopeId, preview.previewDigest, args.now);
  const next = structuredClone(state);
  next.accommodations.push({ accommodationId: args.accommodationId, reasonRef: args.reasonRef, kind: args.kind,
    authorityReceipt: args.authorityReceipt, adjustment: preview.adjustment, newPolicyRevision: safeSum([state.policyRevision, 1]) });
  return finish(state, next, args, 'accommodate', args.accommodationId, true);
}

const closurePreviewSchema = z.strictObject({
  now: commandFields.now, reason: z.enum(['cap', 'completed', 'withdrawn']), coveredObjectiveIds: z.array(id), demonstratedConceptIds: z.array(id),
});
export function previewClosure(input: PolicyState, request: z.input<typeof closurePreviewSchema>) {
  const state = readState(input), args = parse(closurePreviewSchema, request);
  assert(state.status !== 'closed', 'ENROLLMENT_CLOSED', 'Enrollment already has a closure report');
  assert(new Set(args.coveredObjectiveIds).size === args.coveredObjectiveIds.length && new Set(args.demonstratedConceptIds).size === args.demonstratedConceptIds.length,
    'INVALID_INPUT', 'Duplicate coverage or evidence concept');
  assert(args.coveredObjectiveIds.every(o => state.coreObjectiveIds.includes(o)) && args.demonstratedConceptIds.every(c => state.conceptIds.includes(c)),
    'INVALID_INPUT', 'Unknown coverage or evidence concept');
  const root = state.scopes.find(s => s.parentScopeId === null)!;
  const constraints = resolveInternal(state, root.scopeId);
  if (args.reason === 'cap') assert((constraints.effectiveDeadline !== null && compareInstants(args.now, constraints.effectiveDeadline) >= 0)
    || constraints.quotas.some(q => q.consumed >= q.limit), 'CAP_NOT_REACHED', 'Enrollment cap has not been reached');
  const uncoveredObjectiveIds = state.coreObjectiveIds.filter(o => !args.coveredObjectiveIds.includes(o));
  const unprovenConceptIds = (state.requiredConceptIds ?? state.conceptIds).filter(c => !args.demonstratedConceptIds.includes(c));
  if (args.reason === 'completed') assert(uncoveredObjectiveIds.length === 0, 'INCOMPLETE_COVERAGE', 'Completed closure requires core coverage');
  const report = { closedAt: args.now, reason: args.reason,
    coverage: uncoveredObjectiveIds.length ? 'partial' as const : 'complete' as const,
    mastery: unprovenConceptIds.length ? 'gaps' as const : 'demonstrated' as const,
    uncoveredObjectiveIds, unprovenConceptIds, requiredExpansion: 'stopped' as const, continuation: 'explicit_opt_in_separate_track' as const };
  return { report, previewDigest: digest({ enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision, report }) };
}

const closeSchema = closurePreviewSchema.extend({ ...commandFields, previewDigest: id, authorityReceipt: authoritySchema });
export function closeEnrollment(input: PolicyState, request: z.input<typeof closeSchema>) {
  const state = readState(input), args = parse(closeSchema, request);
  const replay = begin(state, args, 'close_enrollment'); if (replay) return replay;
  const preview = previewClosure(state, { now: args.now, reason: args.reason, coveredObjectiveIds: args.coveredObjectiveIds, demonstratedConceptIds: args.demonstratedConceptIds });
  assert(preview.previewDigest === args.previewDigest, 'STALE_PREVIEW', 'Closure report changed');
  const root = state.scopes.find(s => s.parentScopeId === null)!;
  requireAuthority(state, args.authorityReceipt, 'close_enrollment', root.scopeId, preview.previewDigest, args.now);
  const next = structuredClone(state); next.status = 'closed'; next.closure = preview.report;
  for (const reservation of next.reservations) if (reservation.state === 'reserved') reservation.state = 'cancelled';
  for (const offer of next.offers) if (['proposed', 'accepted_pending_admin'].includes(offer.state)) {
    offer.state = 'superseded'; offer.lastTransitionAt = args.now;
  }
  return finish(state, next, args, 'close_enrollment', state.enrollmentId, true);
}
