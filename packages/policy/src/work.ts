import { z } from 'zod';
import { assert, commandFields, count, id, parse, releaseReason, workSchema, type PolicyState, type Reservation } from './contracts.js';
import { checkAction, readState, safeSum, scopePath } from './resolver.js';
import { begin, finish } from './transitions.js';

const reserveSchema = z.strictObject({ ...commandFields, reservationId: id, scopeId: id, work: workSchema,
  /** Draw the minutes and episodes of core work from headroom reserved at enrollment instead of
   * the shared envelope; the new reservation keeps the headroom's purpose. */
  fundedByReservationId: id.optional() });
export function reserveWork(input: PolicyState, request: z.input<typeof reserveSchema>) {
  const state = readState(input), args = parse(reserveSchema, request);
  const replay = begin(state, args, 'reserve_work'); if (replay) return replay;
  assert(!state.reservations.some(r => r.reservationId === args.reservationId), 'DUPLICATE_RESERVATION', 'Reservation ID is already used');
  assert(args.work.additionalEpisodes > 0 || args.work.additionalMinutes > 0 || args.work.remediation.length > 0,
    'INVALID_INPUT', 'Required work must declare a nonzero cost');
  const next = structuredClone(state);
  let purpose: Reservation['purpose'] = 'extra', drawn: Reservation['funding'];
  if (args.fundedByReservationId) {
    const funding = next.reservations.find(r => r.reservationId === args.fundedByReservationId);
    assert(funding && funding.state === 'reserved' && funding.purpose !== 'extra', 'INVALID_RESERVATION_STATE', 'Only live core or final-assessment headroom can fund work');
    assert(scopePath(state, args.scopeId).some(s => s.scopeId === funding.scopeId), 'POOL_NOT_ALLOWED', 'Headroom applies only inside its own scope');
    // Headroom funds minutes and episodes only. Remediation cycles stay on the new reservation
    // and are checked against every per-concept cycle cap like any other work.
    assert(args.work.additionalMinutes <= funding.work.additionalMinutes && args.work.additionalEpisodes <= funding.work.additionalEpisodes,
      'HEADROOM_EXHAUSTED', 'Requested minutes or episodes exceed the remaining reserved headroom');
    funding.work = { ...funding.work, additionalMinutes: funding.work.additionalMinutes - args.work.additionalMinutes,
      additionalEpisodes: funding.work.additionalEpisodes - args.work.additionalEpisodes };
    purpose = funding.purpose;
    drawn = { reservationId: funding.reservationId, additionalMinutes: args.work.additionalMinutes, additionalEpisodes: args.work.additionalEpisodes };
  }
  // Moving units from headroom keeps every total unchanged; extras must fit around the reserved headroom.
  const decision = checkAction(next, { scopeId: args.scopeId, now: args.now, expectedPolicyRevision: args.expectedPolicyRevision, kind: 'admit_job', work: args.work });
  assert(decision.allowed, decision.violations[0]?.code ?? 'ADMISSION_DENIED', 'Required work does not fit current policy');
  next.reservations.push({ reservationId: args.reservationId, scopeId: args.scopeId,
    ancestorScopeIds: scopePath(state, args.scopeId).map(s => s.scopeId), work: args.work, state: 'reserved', admittedPolicyRevision: state.policyRevision, purpose,
    ...(drawn ? { funding: drawn } : {}) });
  return finish(state, next, args, 'reserve_work', args.reservationId);
}

const commitSchema = z.strictObject({ ...commandFields, reservationId: id, workId: id });
export function commitWork(input: PolicyState, request: z.input<typeof commitSchema>) {
  const state = readState(input), args = parse(commitSchema, request);
  const replay = begin(state, args, 'commit_work'); if (replay) return replay;
  const reservation = state.reservations.find(r => r.reservationId === args.reservationId);
  assert(reservation?.state === 'reserved', 'INVALID_RESERVATION_STATE', 'Only live unused reservations can publish');
  assert(reservation.admittedPolicyRevision === state.policyRevision, 'STALE_JOB', 'Job admission was under an older policy; explicitly revalidate and reserve again');
  assert(!state.reservations.some(r => r.workId === args.workId), 'DUPLICATE_WORK', 'Assigned work ID is already recorded');
  // The reservation already counts toward all quotas. Do not charge it twice.
  const decision = checkAction(state, { scopeId: reservation.scopeId, now: args.now, expectedPolicyRevision: args.expectedPolicyRevision, kind: 'publish' });
  assert(decision.allowed, decision.violations[0]?.code ?? 'PUBLICATION_DENIED', 'Publication is blocked by current policy');
  const next = structuredClone(state), target = next.reservations.find(r => r.reservationId === args.reservationId)!;
  target.state = 'committed'; target.workId = args.workId;
  return finish(state, next, args, 'commit_work', args.workId);
}

const usedSchema = z.strictObject({ additionalMinutes: count.default(0), additionalEpisodes: count.default(0),
  remediation: z.array(z.strictObject({ conceptId: id, cycles: count })).default([]) });
const cancelSchema = z.strictObject({ ...commandFields, reservationId: id,
  /** Recorded on the reservation: withdrawn by the system or an author, refused by the learner, or expired unpublished. */
  reason: releaseReason.optional(),
  /** What was already delivered before the work stopped. It stays charged; only the remainder is released. */
  used: usedSchema.optional() });
/**
 * Ends a live reservation without publication. Its unused minutes and episodes leave every quota
 * and, when the reservation was funded from enrollment headroom that is still live, go back to
 * that headroom, so they stay reserved for core work instead of drifting into the shared envelope.
 * The state check makes this happen once: a replay returns the stored receipt and a second
 * cancellation is refused.
 */
export function cancelReservation(input: PolicyState, request: z.input<typeof cancelSchema>) {
  const state = readState(input), args = parse(cancelSchema, request);
  const replay = begin(state, args, 'cancel_reservation'); if (replay) return replay;
  const reservation = state.reservations.find(r => r.reservationId === args.reservationId);
  assert(reservation?.state === 'reserved', 'INVALID_RESERVATION_STATE', 'Assigned work cannot be refunded by cancellation');
  const used = { additionalMinutes: args.used?.additionalMinutes ?? 0, additionalEpisodes: args.used?.additionalEpisodes ?? 0,
    remediation: (args.used?.remediation ?? []).filter(r => r.cycles > 0) };
  assert(used.additionalMinutes <= reservation.work.additionalMinutes && used.additionalEpisodes <= reservation.work.additionalEpisodes
    && new Set(used.remediation.map(r => r.conceptId)).size === used.remediation.length
    && used.remediation.every(u => u.cycles <= (reservation.work.remediation.find(r => r.conceptId === u.conceptId)?.cycles ?? 0)),
  'INVALID_INPUT', 'Used work cannot exceed what the reservation holds');
  const next = structuredClone(state), target = next.reservations.find(r => r.reservationId === args.reservationId)!;
  target.state = 'cancelled';
  let headroomRefund: NonNullable<Reservation['release']>['headroomRefund'];
  if (target.funding) {
    // Use is charged against the funded part first: only what was drawn and not used goes back.
    const source = next.reservations.find(r => r.reservationId === target.funding!.reservationId)!;
    const live = source.state === 'reserved';
    headroomRefund = { reservationId: source.reservationId,
      additionalMinutes: live ? Math.max(0, target.funding.additionalMinutes - used.additionalMinutes) : 0,
      additionalEpisodes: live ? Math.max(0, target.funding.additionalEpisodes - used.additionalEpisodes) : 0 };
    source.work = { ...source.work, additionalMinutes: safeSum([source.work.additionalMinutes, headroomRefund.additionalMinutes]),
      additionalEpisodes: safeSum([source.work.additionalEpisodes, headroomRefund.additionalEpisodes]) };
  }
  target.release = { reason: args.reason ?? 'cancelled', at: args.now, used, ...(headroomRefund ? { headroomRefund } : {}) };
  return finish(state, next, args, 'cancel_reservation', args.reservationId);
}

/** A stable coverage denominator (the core objectives fixed at enrollment), the reserved
 * core and final-assessment headroom, and personal extras on their own counter so adding
 * a remedial example never moves the displayed completion denominator. */
export function coverageSummary(input: PolicyState) {
  const state = readState(input);
  const extras = state.reservations.filter(r => r.purpose === 'extra' && r.state !== 'cancelled');
  const total = (rows: Reservation[], metric: 'additionalMinutes' | 'additionalEpisodes') => safeSum(rows.map(r => r.work[metric]));
  const committed = extras.filter(r => r.state === 'committed'), reserved = extras.filter(r => r.state === 'reserved');
  return {
    coreObjectiveIds: [...state.coreObjectiveIds], denominator: state.coreObjectiveIds.length,
    headroom: state.reservations.filter(r => r.purpose !== 'extra' && r.state !== 'cancelled')
      .map(r => ({ reservationId: r.reservationId, purpose: r.purpose, scopeId: r.scopeId, state: r.state, remaining: structuredClone(r.work) })),
    personalExtras: {
      committed: { count: committed.length, additionalMinutes: total(committed, 'additionalMinutes'), additionalEpisodes: total(committed, 'additionalEpisodes') },
      reserved: { count: reserved.length, additionalMinutes: total(reserved, 'additionalMinutes'), additionalEpisodes: total(reserved, 'additionalEpisodes') },
    },
  };
}
