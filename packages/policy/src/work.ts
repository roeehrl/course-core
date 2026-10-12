import { z } from 'zod';
import { assert, commandFields, id, parse, workSchema, type PolicyState } from './contracts.js';
import { checkAction, readState, scopePath } from './resolver.js';
import { begin, finish } from './transitions.js';

const reserveSchema = z.strictObject({ ...commandFields, reservationId: id, scopeId: id, work: workSchema });
export function reserveWork(input: PolicyState, request: z.input<typeof reserveSchema>) {
  const state = readState(input), args = parse(reserveSchema, request);
  const replay = begin(state, args, 'reserve_work'); if (replay) return replay;
  assert(!state.reservations.some(r => r.reservationId === args.reservationId), 'DUPLICATE_RESERVATION', 'Reservation ID is already used');
  assert(args.work.additionalEpisodes > 0 || args.work.additionalMinutes > 0 || args.work.remediation.length > 0,
    'INVALID_INPUT', 'Required work must declare a nonzero cost');
  const decision = checkAction(state, { scopeId: args.scopeId, now: args.now, expectedPolicyRevision: args.expectedPolicyRevision, kind: 'admit_job', work: args.work });
  assert(decision.allowed, decision.violations[0]?.code ?? 'ADMISSION_DENIED', 'Required work does not fit current policy');
  const next = structuredClone(state);
  next.reservations.push({ reservationId: args.reservationId, scopeId: args.scopeId,
    ancestorScopeIds: scopePath(state, args.scopeId).map(s => s.scopeId), work: args.work, state: 'reserved', admittedPolicyRevision: state.policyRevision });
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

const cancelSchema = z.strictObject({ ...commandFields, reservationId: id });
export function cancelReservation(input: PolicyState, request: z.input<typeof cancelSchema>) {
  const state = readState(input), args = parse(cancelSchema, request);
  const replay = begin(state, args, 'cancel_reservation'); if (replay) return replay;
  const reservation = state.reservations.find(r => r.reservationId === args.reservationId);
  assert(reservation?.state === 'reserved', 'INVALID_RESERVATION_STATE', 'Assigned work cannot be refunded by cancellation');
  const next = structuredClone(state);
  next.reservations.find(r => r.reservationId === args.reservationId)!.state = 'cancelled';
  return finish(state, next, args, 'cancel_reservation', args.reservationId);
}
