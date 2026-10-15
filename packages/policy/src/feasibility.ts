import { z } from 'zod';
import { count, id, instant, parse, positive, type PolicyState } from './contracts.js';
import { poolBalances } from './extensions.js';
import { readState, resolveInternal, scopePath } from './resolver.js';
import { compareInstants, hoursBetween } from './time.js';

const feasibilitySchema = z.strictObject({
  now: instant,
  /** The fixed core path and final assessment the envelope must hold. */
  requiredWork: z.array(z.strictObject({
    workId: id, scopeId: id, purpose: z.enum(['core', 'final_assessment']), estimatedMinutes: count.optional(),
  })).min(1),
  /** Declared study pace. Without it, or without estimates, time fit is reported as unchecked. */
  pace: z.strictObject({ studyMinutesPerDay: positive }).optional(),
});

export type FeasibilityAlternative = 'request_allowed_extension' | 'authorized_policy_change' | 'continue_with_documented_gaps' | 'choose_a_smaller_goal';
export interface FeasibilityIssue {
  severity: 'error' | 'warning'; code: string; scopeId: string; message: string;
  workIds?: string[]; deadline?: string; neededMinutes?: number; availableMinutes?: number;
}

/**
 * Compares the required core path and final assessment with the declared envelope before an
 * enrollment starts or a release is published. It discloses infeasibility and alternatives;
 * it never lowers mastery criteria or drops required work to make a plan fit.
 */
export function checkFeasibility(input: PolicyState, request: z.input<typeof feasibilitySchema>) {
  const state = readState(input), args = parse(feasibilitySchema, request);
  const issues: FeasibilityIssue[] = [];
  const deadlines = new Map<string, { scopeId: string; at: string; workIds: string[]; minutes: number; unestimated: number }>();
  for (const item of args.requiredWork) {
    const snapshot = resolveInternal(state, item.scopeId);
    for (const deadline of snapshot.deadlines) {
      const key = `${deadline.scopeId}|${deadline.kind}|${deadline.at}`;
      const entry = deadlines.get(key) ?? { scopeId: deadline.scopeId, at: deadline.at, workIds: [], minutes: 0, unestimated: 0 };
      entry.workIds.push(item.workId);
      if (item.estimatedMinutes === undefined) entry.unestimated += 1; else entry.minutes += item.estimatedMinutes;
      deadlines.set(key, entry);
    }
  }
  for (const entry of deadlines.values()) {
    if (compareInstants(args.now, entry.at) >= 0) {
      issues.push({ severity: 'error', code: 'DEADLINE_ALREADY_REACHED', scopeId: entry.scopeId, deadline: entry.at, workIds: entry.workIds,
        message: 'A deadline that binds required work has already passed.' });
      continue;
    }
    // Estimated minutes are a lower bound when some items have no estimate; exceeding it is still infeasible.
    if (!args.pace || entry.minutes === 0) continue;
    const availableMinutes = Math.floor(hoursBetween(args.now, entry.at) / 24) * args.pace.studyMinutesPerDay;
    if (entry.minutes > availableMinutes) issues.push({ severity: 'error', code: 'TIME_ENVELOPE_TOO_SMALL', scopeId: entry.scopeId, deadline: entry.at,
      workIds: entry.workIds, neededMinutes: entry.minutes, availableMinutes,
      message: 'The estimated required work does not fit before this deadline at the declared pace.' });
  }
  const unestimated = args.requiredWork.filter(w => w.estimatedMinutes === undefined);
  if (!args.pace || unestimated.length) issues.push({ severity: 'warning', code: 'TIME_FIT_UNCHECKED', scopeId: scopePath(state, args.requiredWork[0]!.scopeId)[0]!.scopeId,
    workIds: unestimated.map(w => w.workId), message: 'No study pace or work estimate is declared, so only deadlines were checked.' });
  // A child deadline later than an ancestor's is silently clipped by the ancestor; say so.
  for (const scope of state.scopes) {
    const own = resolveInternal(state, scope.scopeId).deadlines.filter(d => d.scopeId === scope.scopeId);
    const ancestors = scopePath(state, scope.scopeId).slice(0, -1).flatMap(s => resolveInternal(state, s.scopeId).deadlines.filter(d => d.scopeId === s.scopeId));
    const binding = ancestors.reduce<string | null>((min, d) => min === null || compareInstants(d.at, min) < 0 ? d.at : min, null);
    for (const deadline of own) if (binding !== null && compareInstants(deadline.at, binding) > 0) {
      issues.push({ severity: 'warning', code: 'LOOSER_CHILD_DEADLINE', scopeId: scope.scopeId, deadline: deadline.at,
        message: 'This scope ends after an ancestor; the earlier ancestor deadline binds.' });
    }
  }
  const errors = issues.filter(i => i.severity === 'error');
  const alternatives: FeasibilityAlternative[] = [];
  if (errors.length) {
    const blocked = new Set(errors.map(e => e.scopeId));
    const extendable = state.scopes.some(s => blocked.has(s.scopeId) && s.extensions?.enabled
      && poolBalances(state).some(b => s.extensions!.poolIds.includes(b.poolId) && b.remaining > 0 && b.grantsRemaining > 0));
    if (extendable && errors.every(e => e.code !== 'DEADLINE_ALREADY_REACHED')) alternatives.push('request_allowed_extension');
    alternatives.push('authorized_policy_change');
    // Accepting documented gaps is honest only while there is still time to learn something.
    if (errors.every(e => e.code !== 'DEADLINE_ALREADY_REACHED')) alternatives.push('continue_with_documented_gaps');
    alternatives.push('choose_a_smaller_goal');
  }
  return { feasible: errors.length === 0, issues, alternatives, masteryCriteria: 'unchanged' as const,
    checkedAt: args.now, policyRevision: state.policyRevision };
}
