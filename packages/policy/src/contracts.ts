import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

export class PolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function assert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new PolicyError(code, message);
}

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new PolicyError('INVALID_INPUT', result.error.message);
  return result.data;
}

export const id = z.string().trim().min(1).max(256);
export const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positive = count.refine(n => n > 0, 'Must be positive');
export const instant = z.string().refine(value => {
  try { Temporal.Instant.from(value); return true; } catch { return false; }
}, 'Expected an ISO instant with an explicit offset');
export const timeZone = z.string().refine(value => {
  // Numeric offsets are not IANA identifiers, even when Temporal accepts them.
  if (/^[+\-−]/u.test(value)) return false;
  try { Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(value); return true; }
  catch { return false; }
}, 'Expected an IANA time zone');
export const disambiguation = z.enum(['reject', 'earlier', 'later', 'compatible']);
export const calendarRuleSchema = z.strictObject({
  anchorId: id,
  anchor: z.enum(['enrollment_started', 'scope_assigned', 'scope_started']),
  anchorInstant: instant,
  calendarDays: count,
  timeZone,
  disambiguation,
  pauseRule: z.enum(['never', 'approved_only']),
});
export const calendarWindowSchema = calendarRuleSchema.extend({ resolvedDeadline: instant });
export const workCapsSchema = z.strictObject({
  additionalMinutes: count.optional(),
  additionalEpisodes: count.optional(),
  remediationCyclesPerConcept: count.optional(),
});
export const workSchema = z.strictObject({
  additionalMinutes: count.default(0),
  additionalEpisodes: count.default(0),
  remediation: z.array(z.strictObject({ conceptId: id, cycles: positive })).default([]),
}).refine(w => new Set(w.remediation.map(r => r.conceptId)).size === w.remediation.length,
  'Concept counters must be unique');
export const extensionsSchema = z.strictObject({
  enabled: z.boolean(),
  learnerAcceptanceRequired: z.literal(true),
  poolIds: z.array(id),
  requiredAuthorityIds: z.array(id),
  offerCooldownHours: count,
  maxOutstandingOffersPerScope: positive,
  maxOffersPerScope: positive,
});
export const scopeSchema = z.strictObject({
  scopeId: id,
  parentScopeId: id.nullable(),
  policyId: id,
  kind: z.enum(['organization', 'course', 'enrollment', 'chapter', 'episode', 'activity']),
  mode: z.enum(['bounded', 'open_ended']).default('bounded'),
  targetDate: instant.optional(),
  hardDeadline: z.strictObject({ at: instant, timeZone, disambiguation }).optional(),
  window: calendarWindowSchema.optional(),
  ultimateDeadline: instant.optional(),
  work: workCapsSchema.default({}),
  extensions: extensionsSchema.optional(),
  existingMaterialAccess: z.enum(['read_only', 'closed']).default('read_only'),
  submissionGraceUntil: instant.optional(),
});
export const poolSchema = z.strictObject({
  poolId: id,
  scopeIds: z.array(id).min(1),
  unit: z.enum(['calendar_day', 'scope_calendar_day', 'planned_minute', 'episode']),
  total: count,
  maxPerGrant: positive,
  maxGrants: count,
});
export const changeSchema = z.strictObject({
  deadline: z.strictObject({ kind: z.enum(['absolute', 'window']), calendarDays: positive }).optional(),
  work: z.strictObject({ additionalMinutes: positive.optional(), additionalEpisodes: positive.optional() }).optional(),
}).refine(c => c.deadline || c.work?.additionalMinutes || c.work?.additionalEpisodes, 'Empty extension');
export const debitSchema = z.strictObject({ poolId: id, amount: positive });
export const balanceSchema = z.strictObject({ poolId: id, remaining: count, grantsRemaining: count });
export const deadlineSchema = z.strictObject({
  scopeId: id,
  kind: z.enum(['absolute', 'window', 'ultimate']),
  at: instant,
});
export const quotaSnapshotSchema = z.strictObject({
  scopeId: id, metric: z.enum(['additionalMinutes', 'additionalEpisodes', 'remediationCyclesPerConcept']),
  conceptId: id.nullable(), limit: count, consumed: count, reserved: count, remaining: count,
});
export const acceptanceSchema = z.strictObject({
  receiptId: id, learnerId: id, enrollmentId: id, offerId: id,
  termsDigest: id, explicit: z.literal(true), acceptedAt: instant,
});
export const authoritySchema = z.strictObject({
  receiptId: id, actorId: id, enrollmentId: id, scopeId: id,
  permission: z.enum(['grant_extension', 'migrate_policy', 'accommodate', 'manage_offers', 'close_enrollment']),
  termsDigest: id, authorizedAt: instant,
});
export const offerTermsSchema = z.strictObject({
  offerId: id, scopeId: id, enrollmentId: id, expectedPolicyRevision: count,
  rationaleEvidenceRefs: z.array(id).min(1),
  proposedActivities: z.array(id).min(1),
  currentEffectiveDeadline: instant.nullable(),
  proposedEffectiveDeadline: instant.nullable(),
  currentWorkQuotas: z.array(quotaSnapshotSchema), proposedWorkQuotas: z.array(quotaSnapshotSchema),
  change: changeSchema,
  addedWork: workSchema,
  poolDebits: z.array(debitSchema).min(1),
  balanceBefore: z.array(balanceSchema), balanceAfter: z.array(balanceSchema),
  bindingAncestorCaps: z.array(deadlineSchema),
  planImpact: z.string().trim().min(1), alternatives: z.array(z.string().trim().min(1)).min(1),
  createdAt: instant, expiresAt: instant, requiredApprovals: z.array(id),
});
export const offerSchema = z.strictObject({
  terms: offerTermsSchema, termsDigest: id,
  lastTransitionAt: instant,
  state: z.enum(['proposed', 'accepted_pending_admin', 'granted', 'declined', 'expired', 'rejected', 'superseded']),
  acceptance: acceptanceSchema.optional(),
});
export const adjustmentSchema = z.strictObject({
  scopeId: id,
  absoluteDeadline: instant.optional(), windowDeadline: instant.optional(),
  additionalMinutes: count.default(0), additionalEpisodes: count.default(0),
});
export const grantSchema = z.strictObject({
  grantId: id, offerId: id, acceptedTermsDigest: id,
  learnerAcceptanceReceipt: acceptanceSchema,
  authorityReceipts: z.array(authoritySchema),
  idempotencyKey: id, atomicLedgerTransactionId: id,
  newPolicyRevision: count, grantedAt: instant,
  poolDebits: z.array(debitSchema), adjustment: adjustmentSchema,
});
export const accommodationSchema = z.strictObject({
  accommodationId: id, reasonRef: id, kind: z.enum(['accommodation', 'approved_pause']),
  authorityReceipt: authoritySchema, adjustment: adjustmentSchema, newPolicyRevision: count,
});
export const reservationSchema = z.strictObject({
  reservationId: id, scopeId: id, ancestorScopeIds: z.array(id).min(1),
  work: workSchema, state: z.enum(['reserved', 'committed', 'cancelled']),
  admittedPolicyRevision: count, workId: id.optional(),
});
export const receiptSchema = z.strictObject({
  idempotencyKey: id, requestDigest: id, operation: id, resourceId: id,
  policyRevision: count, ledgerRevision: count,
});
export const auditSchema = z.strictObject({
  eventId: id, operation: id, resourceId: id, at: instant,
  policyRevision: count, ledgerRevision: count, idempotencyKey: id,
});
export const closureSchema = z.strictObject({
  closedAt: instant, reason: z.enum(['cap', 'completed', 'withdrawn']),
  coverage: z.enum(['complete', 'partial']),
  mastery: z.enum(['demonstrated', 'gaps']),
  uncoveredObjectiveIds: z.array(id), unprovenConceptIds: z.array(id),
  requiredExpansion: z.literal('stopped'), continuation: z.literal('explicit_opt_in_separate_track'),
});
export const stateSchema = z.strictObject({
  enrollmentId: id, learnerId: id, policyRevision: count, ledgerRevision: count,
  status: z.enum(['active', 'paused', 'closed']),
  coreObjectiveIds: z.array(id).min(1), conceptIds: z.array(id).min(1), requiredConceptIds: z.array(id).optional(),
  scopes: z.array(scopeSchema).min(1), pools: z.array(poolSchema),
  offers: z.array(offerSchema), grants: z.array(grantSchema),
  migrations: z.array(z.strictObject({
    migrationId: id, reasonRef: id, authorityReceipt: authoritySchema, previewDigest: id,
    previousPolicyRevision: count, newPolicyRevision: count,
  })),
  accommodations: z.array(accommodationSchema), reservations: z.array(reservationSchema),
  receipts: z.array(receiptSchema), audit: z.array(auditSchema), closure: closureSchema.optional(),
});
export const commandFields = {
  expectedPolicyRevision: count, expectedLedgerRevision: count, idempotencyKey: id, now: instant,
};

export type CalendarRule = z.infer<typeof calendarRuleSchema>;
export type CalendarWindow = z.infer<typeof calendarWindowSchema>;
export type ScopePolicy = z.infer<typeof scopeSchema>;
export type PolicyState = z.infer<typeof stateSchema>;
export type Work = z.infer<typeof workSchema>;
export type Offer = z.infer<typeof offerSchema>;
export type ExtensionChange = z.infer<typeof changeSchema>;
export type Adjustment = z.infer<typeof adjustmentSchema>;
export type AuthorityReceipt = z.infer<typeof authoritySchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Command = { expectedPolicyRevision: number; expectedLedgerRevision: number; idempotencyKey: string; now: string };

export interface Transition {
  state: PolicyState;
  receipt: Receipt;
  replayed: boolean;
  preconditions: { enrollmentId: string; policyRevision: number; ledgerRevision: number };
}
