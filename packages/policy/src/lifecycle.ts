import { z } from 'zod';
import {
  adjustmentKind, assert, authoritySchema, changeSchema, commandFields, count, id, parse, scopeSchema,
  type PolicyState, type ScopePolicy,
} from './contracts.js';
import { buildAdjustment } from './extensions.js';
import { checkAction, envelopeScopeId, looserThanParent, readState, resolveInternal, safeSum, scopePath } from './resolver.js';
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
  // A changed level may only tighten its ancestors; an unchanged setting is never re-judged.
  for (const scope of args.scopes) {
    const old = state.scopes.find(s => s.scopeId === scope.scopeId);
    const changed = (field: string) => !old || digest(fieldOf(scope, field)) !== digest(fieldOf(old, field));
    const looser = looserThanParent(candidate, scope.scopeId).filter(v => changed(v.field));
    assert(looser.length === 0, 'LOOSER_THAN_PARENT',
      `${looser[0]?.field} of ${scope.scopeId} is looser than ${looser[0]?.bindingScopeId}; a child level can only tighten its parent`);
  }
  const impacts = state.scopes.map(scope => ({ scopeId: scope.scopeId,
    before: resolveInternal(state, scope.scopeId), after: resolveInternal(candidate, scope.scopeId) }));
  // A promise made by a grant, exception or accommodation is never shortened silently:
  // every such entry whose scope ends earlier under the new policy is disclosed by ID.
  const promised = [
    ...state.grants.filter(g => !g.revocation).map(g => ({ entryId: g.grantId, kind: 'extension' as const, scopeId: g.adjustment.scopeId })),
    ...state.exceptionalGrants.filter(e => !e.revocation).map(e => ({ entryId: e.exceptionId, kind: 'exceptional' as const, scopeId: e.adjustment.scopeId })),
    ...state.accommodations.map(a => ({ entryId: a.accommodationId, kind: a.kind, scopeId: a.adjustment.scopeId })),
  ];
  const shortenedGrants = promised.flatMap(entry => {
    const impact = impacts.find(i => i.scopeId === entry.scopeId)!;
    const before = impact.before.effectiveDeadline, after = impact.after.effectiveDeadline;
    return before !== null && after !== null && compareInstants(after, before) < 0
      ? [{ ...entry, effectiveDeadlineBefore: before, effectiveDeadlineAfter: after }] : [];
  });
  const preview = { enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision,
    scopes: args.scopes, impacts, shortenedGrants,
    affectedReservationIds: state.reservations.filter(r => r.state === 'reserved').map(r => r.reservationId),
    supersededOfferIds: state.offers.filter(o => ['proposed', 'accepted_pending_admin'].includes(o.state)).map(o => o.terms.offerId) };
  return { ...preview, previewDigest: digest(preview) };
}

function fieldOf(scope: ScopePolicy, field: string) {
  return field === 'hardDeadline' ? scope.hardDeadline?.at ?? null : field === 'ultimateDeadline' ? scope.ultimateDeadline ?? null
    : scope.work[field as keyof ScopePolicy['work']] ?? null;
}

const migrationSchema = migrationPreviewSchema.extend({
  ...commandFields, migrationId: id, reasonRef: id, previewDigest: id, authorityReceipt: authoritySchema,
  /** Exactly the shortened grant, exception and accommodation IDs the authority reviewed. */
  acknowledgedShortenedGrantIds: z.array(id).default([]),
});
export function applyPolicyChange(input: PolicyState, request: z.input<typeof migrationSchema>) {
  const state = readState(input), args = parse(migrationSchema, request);
  const replay = begin(state, args, 'migrate_policy'); if (replay) return replay;
  assert(!state.migrations.some(m => m.migrationId === args.migrationId), 'DUPLICATE_MIGRATION', 'Migration ID already exists');
  const preview = previewPolicyChange(state, { scopes: args.scopes });
  assert(args.previewDigest === preview.previewDigest, 'STALE_PREVIEW', 'Impact preview changed; review current impact first');
  assert(digest([...new Set(args.acknowledgedShortenedGrantIds)].sort()) === digest(preview.shortenedGrants.map(g => g.entryId).sort())
    && new Set(args.acknowledgedShortenedGrantIds).size === args.acknowledgedShortenedGrantIds.length,
  'SHORTENED_GRANT_UNACKNOWLEDGED', 'This change shortens promised time; acknowledge each affected grant explicitly');
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
  scopeId: id, accommodationId: id, reasonRef: id, kind: adjustmentKind, change: changeSchema,
  /** The reviewed batch this entry belongs to when one decision covered several learners. */
  batchId: id.optional(),
});
export function previewAccommodation(input: PolicyState, request: z.input<typeof accommodationPreviewSchema>) {
  const state = readState(input), args = parse(accommodationPreviewSchema, request);
  assert(state.status === 'active', 'ENROLLMENT_INACTIVE', 'An adjustment cannot silently reopen an enrollment');
  const scope = scopePath(state, args.scopeId).at(-1)!;
  if (args.kind === 'approved_pause') {
    assert(scope.window?.pauseRule === 'approved_only' && args.change.deadline?.kind === 'window' && !args.change.work,
      'PAUSE_NOT_ALLOWED', 'Approved leave may move only a pause-enabled relative window');
  }
  // An outage gives back time the service took away; it never adds work.
  if (args.kind === 'outage') assert(args.change.deadline && !args.change.work, 'OUTAGE_DEADLINE_ONLY', 'An outage adjustment moves a deadline and adds no work');
  const adjustment = buildAdjustment(state, args.scopeId, args.change);
  const before = resolveInternal(state, args.scopeId), after = resolveInternal(state, args.scopeId, adjustment);
  const preview = { ...args, enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision, adjustment,
    effectiveDeadlineBefore: before.effectiveDeadline, effectiveDeadlineAfter: after.effectiveDeadline, bindingAfter: after.binding };
  return { ...preview, previewDigest: digest(preview) };
}

const accommodationCommand = accommodationPreviewSchema.extend({ ...commandFields, previewDigest: id, authorityReceipt: authoritySchema });
export function applyAccommodation(input: PolicyState, request: z.input<typeof accommodationCommand>) {
  const state = readState(input), args = parse(accommodationCommand, request);
  const replay = begin(state, args, 'accommodate'); if (replay) return replay;
  assert(!state.accommodations.some(a => a.accommodationId === args.accommodationId), 'DUPLICATE_ACCOMMODATION', 'Accommodation ID already exists');
  const preview = previewAccommodation(state, { scopeId: args.scopeId, accommodationId: args.accommodationId,
    reasonRef: args.reasonRef, kind: args.kind, change: args.change, ...(args.batchId ? { batchId: args.batchId } : {}) });
  assert(args.previewDigest === preview.previewDigest, 'STALE_PREVIEW', 'Accommodation preview changed');
  requireAuthority(state, args.authorityReceipt, 'accommodate', args.scopeId, preview.previewDigest, args.now);
  const next = structuredClone(state);
  next.accommodations.push({ accommodationId: args.accommodationId, reasonRef: args.reasonRef, kind: args.kind,
    authorityReceipt: args.authorityReceipt, adjustment: preview.adjustment, newPolicyRevision: safeSum([state.policyRevision, 1]),
    ...(args.batchId ? { batchId: args.batchId } : {}) });
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
  // The enrollment envelope carries every organization, course and enrollment cap.
  const constraints = resolveInternal(state, envelopeScopeId(state));
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
  // Authority over the enrollment envelope or any level above it (course, organization) may close it.
  const chain = scopePath(state, envelopeScopeId(state)).map(s => s.scopeId);
  assert(chain.includes(args.authorityReceipt.scopeId), 'AUTHORITY_REQUIRED', 'Closing needs authority over the enrollment or a level above it');
  requireAuthority(state, args.authorityReceipt, 'close_enrollment', args.authorityReceipt.scopeId, preview.previewDigest, args.now);
  const next = structuredClone(state); next.status = 'closed'; next.closure = preview.report;
  for (const reservation of next.reservations) if (reservation.state === 'reserved') reservation.state = 'cancelled';
  for (const offer of next.offers) if (['proposed', 'accepted_pending_admin'].includes(offer.state)) {
    offer.state = 'superseded'; offer.lastTransitionAt = args.now;
  }
  return finish(state, next, args, 'close_enrollment', state.enrollmentId, true);
}

const closedQuestionSchema = z.strictObject({ scopeId: id, now: commandFields.now, questionsUsed: count, defaultBudget: count });
/** After closure, explanatory questions are a separate bounded permission: the material must
 * stay readable and the closed-course question budget must have room. It never creates
 * required work, reopens the enrollment or grants credit. */
export function checkClosedQuestion(input: PolicyState, request: z.input<typeof closedQuestionSchema>) {
  const state = readState(input), args = parse(closedQuestionSchema, request);
  const budget = state.afterClosure?.questionBudget ?? args.defaultBudget;
  const violations: string[] = [];
  if (state.status !== 'closed') violations.push('ENROLLMENT_NOT_CLOSED');
  else {
    const read = checkAction(state, { scopeId: args.scopeId, now: args.now, kind: 'read', expectedPolicyRevision: state.policyRevision });
    if (!read.allowed) violations.push('ACCESS_CLOSED');
    if (args.questionsUsed >= budget) violations.push('HELP_BUDGET_EXHAUSTED');
  }
  return { allowed: violations.length === 0, violations, budget, used: args.questionsUsed, remaining: Math.max(0, budget - args.questionsUsed) };
}

const continuationSchema = z.strictObject({
  scopeId: id, now: commandFields.now,
  kind: z.enum(['read', 'review', 'question', 'plan', 'admit_job', 'publish', 'submit']),
  /** The learner's opt-in to the separate continuation track, if any. */
  track: z.strictObject({ state: z.enum(['active', 'stopped']), optedInAt: commandFields.now }).nullable(),
});
/** What a closed enrollment's optional continuation track permits. The track is a separate,
 * opt-in path for review and practice: it reads existing material and takes spaced review
 * checks, never plans or admits new required work, never publishes, and never reopens the
 * enrollment or changes its closure report. Without an active opt-in nothing is permitted. */
export function checkContinuation(input: PolicyState, request: z.input<typeof continuationSchema>) {
  const state = readState(input), args = parse(continuationSchema, request);
  const violations: string[] = [];
  if (state.status !== 'closed') violations.push('ENROLLMENT_NOT_CLOSED');
  else if (args.track?.state !== 'active') violations.push('CONTINUATION_NOT_OPTED_IN');
  else if (!['read', 'review'].includes(args.kind)) violations.push('CONTINUATION_NO_REQUIRED_WORK');
  else {
    const read = checkAction(state, { scopeId: args.scopeId, now: args.now, kind: 'read', expectedPolicyRevision: state.policyRevision });
    if (!read.allowed) violations.push('ACCESS_CLOSED');
  }
  return { allowed: violations.length === 0, violations, reopensEnrollment: false as const, createsRequiredWork: false as const };
}
