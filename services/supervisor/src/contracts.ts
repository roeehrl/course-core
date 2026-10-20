import { z } from 'zod';

export const uuid = z.uuid();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const key = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const count = z.number().int().min(0).max(1_000_000_000);
export const roleSchema = z.enum(['supervisor', 'companion', 'research', 'media', 'reviewer']);
export const fenceSchema = z.strictObject({
  enrollmentRevision: z.number().int().positive(),
  profileRevision: z.number().int().positive(),
  policyRevision: z.number().int().positive(),
  ledgerRevision: z.number().int().nonnegative(),
  courseDigest: digest,
});
export const jobKeySchema = z.strictObject({ jobId: uuid, workspaceId: uuid, enrollmentId: uuid });
export const runRefSchema = jobKeySchema.extend({ generation: z.number().int().min(1).max(16) });
export const allowanceSchema = z.strictObject({ microUsd: count, tokens: count });
export const checkpointSchema = z.strictObject({
  id: key,
  capability: roleSchema,
  inputRef: uuid,
  allowance: allowanceSchema,
  timeoutMs: z.number().int().min(100).max(120_000),
  maxAttempts: z.number().int().min(1).max(5),
  // What the checkpoint does, shown as the job's state while its call is out. Omitted = 'running'.
  phase: z.enum(['analyze', 'build', 'evaluate']).optional(),
});
export const jobSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  key: jobKeySchema,
  inputEventId: uuid,
  role: roleSchema,
  fence: fenceSchema,
  checkpoints: z.array(checkpointSchema).min(1).max(16),
  budget: allowanceSchema,
  deadlineAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).superRefine((spec, ctx) => {
  if (new Set(spec.checkpoints.map(c => c.id)).size !== spec.checkpoints.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate_checkpoint' });
});
export const availabilitySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({ status: z.literal('configuration_missing') }),
  z.strictObject({ status: z.literal('capability_missing') }),
]);
export const artifactSchema = z.strictObject({ artifactId: uuid, digest });
export const usageBasisSchema = z.strictObject({
  microUsd: z.enum(['reported', 'reserved_ceiling']),
  tokens: z.enum(['reported', 'reserved_ceiling']),
});
/** Upper bound on a provider rate-limit hint the workflow will honour before its next attempt. */
export const MAX_RETRY_AFTER_MS = 600_000;
// References only. Provider text, prompts, credentials and reasoning never enter workflow history.
export const outcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('succeeded'), artifact: artifactSchema, usage: allowanceSchema,
    usageBasis: usageBasisSchema.optional() }),
  // A retryable non-start may carry the provider's rate-limit hint; the workflow waits at least that long.
  z.strictObject({ status: z.literal('not_started'), retryable: z.boolean(),
    retryAfterMs: z.number().int().min(0).max(MAX_RETRY_AFTER_MS).optional() }),
  z.strictObject({ status: z.literal('uncertain') }),
]);
export const reasonSchema = z.enum([
  'configuration_missing', 'capability_missing', 'provider_uncertain', 'verification_required',
  'verification_rejected', 'stale_revision', 'inactive_enrollment', 'deadline_exceeded',
  'attempts_exhausted', 'provider_rejected', 'budget_exhausted', 'usage_exceeded',
  'cancel_requested', 'activity_exhausted', 'supervision_stopped', 'input_required', 'follow_up_scheduled',
]);
export const stateSchema = z.enum([
  'queued', 'running', 'waiting', 'verifying', 'ready', 'applied', 'failed', 'cancelled', 'budget_wait',
  // A checkpoint's call is out: reading and diagnosing, making material, or judging it.
  'analyzing', 'building', 'evaluating',
  // Parked by the host until a person answers, or until a scheduled follow-up is due.
  'needs_input', 'follow_up_due',
]);
export const TERMINAL_STATES = ['applied', 'failed', 'cancelled'] as const;
export const operationIdSchema = z.string().regex(/^[0-9a-f-]{36}\/[a-z][a-z0-9_-]{0,63}$/);
export const operationSchema = z.strictObject({
  id: operationIdSchema,
  checkpointId: key,
  ownerId: uuid,
  attempt: z.number().int().min(1).max(5),
  status: z.enum(['in_flight', 'uncertain', 'not_started', 'succeeded']),
  reservation: allowanceSchema,
  outcome: outcomeSchema.nullable(),
});
export const verificationSchema = z.strictObject({
  receiptId: uuid,
  jobId: uuid,
  fence: fenceSchema,
  artifacts: z.array(artifactSchema).min(1).max(16),
  verdict: z.enum(['verified', 'rejected']),
});
export const snapshotSchema = z.strictObject({
  specification: jobSpecSchema,
  generation: z.number().int().min(1).max(16),
  version: z.number().int().nonnegative(),
  state: stateSchema,
  reason: reasonSchema.nullable(),
  operations: z.array(operationSchema).max(16),
  verification: verificationSchema.nullable(),
  applicationReceiptId: uuid.nullable(),
  // When a parked follow-up becomes due (host clock, ms). Absent unless parked as follow_up_due.
  dueAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
// `hold`: supervision of the enrollment is paused; nothing changed and the same step is retried
// after the pause ends (a `supervisionControl` signal, or the next poll).
export const effectSchema = z.enum(['invoke', 'retry', 'continue', 'stop', 'hold']);
export const transitionSchema = z.strictObject({ snapshot: snapshotSchema, effect: effectSchema });
export const haltReasonSchema = z.enum(['cancel_requested', 'deadline_exceeded', 'activity_exhausted', 'supervision_stopped']);
/** Staff control over an enrollment's AI supervision. The host database row is authoritative. */
export const supervisionStateSchema = z.enum(['active', 'paused', 'stopped']);
/** Temporal signal name and payload. Advisory wake-up only: workflows still obey the host's state. */
export const SUPERVISION_SIGNAL = 'supervisionControl';
export const supervisionSignalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enrollmentId: uuid,
  state: supervisionStateSchema,
  revision: z.number().int().positive(),
});
/** One undelivered control change: signal every listed workflow, then acknowledge. */
export const controlDeliverySchema = z.strictObject({
  changeId: uuid,
  leaseToken: uuid,
  attempts: z.number().int().positive(),
  workspaceId: uuid,
  signal: supervisionSignalSchema,
  jobs: z.array(runRefSchema).max(64),
}).refine(d => d.jobs.every(j => j.enrollmentId === d.signal.enrollmentId && j.workspaceId === d.workspaceId),
  { message: 'control_scope_mismatch' });
export const controlDeliveriesSchema = z.array(controlDeliverySchema).max(100);
/** Why the host cancelled a job outside staff control: the enrollment's data is being erased, or
 * the workspace's provider configuration changed under it. */
export const cancellationReasonSchema = z.enum(['data_erasure', 'provider_changed']);
/** Temporal signal asking one job to stop now. Advisory like `supervisionControl`: the host has
 * already recorded the cancellation, and the job's next host step stops whether or not this arrives. */
export const JOB_CANCELLATION_SIGNAL = 'jobCancellation';
export const jobCancellationSignalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enrollmentId: uuid,
  jobId: uuid,
  reason: cancellationReasonSchema,
});
/** One undelivered cancellation: signal every listed job workflow and the enrollment's coordinator, then acknowledge. */
export const cancellationDeliverySchema = z.strictObject({
  cancellationId: uuid,
  leaseToken: uuid,
  attempts: z.number().int().positive(),
  workspaceId: uuid,
  enrollmentId: uuid,
  reason: cancellationReasonSchema,
  jobs: z.array(runRefSchema).max(64),
}).refine(d => d.jobs.every(j => j.enrollmentId === d.enrollmentId && j.workspaceId === d.workspaceId),
  { message: 'cancellation_scope_mismatch' });
export const cancellationDeliveriesSchema = z.array(cancellationDeliverySchema).max(100);
export const jobCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('claim'), ref: runRefSchema, checkpointId: key, ownerId: uuid, availability: availabilitySchema }),
  z.strictObject({ type: z.literal('settle'), ref: runRefSchema, operationId: operationIdSchema, ownerId: uuid, outcome: outcomeSchema }),
  z.strictObject({ type: z.literal('verify'), ref: runRefSchema }),
  z.strictObject({ type: z.literal('apply'), ref: runRefSchema }),
  z.strictObject({ type: z.literal('halt'), ref: runRefSchema, reason: haltReasonSchema }),
  // Host-issued: park a job until input arrives or a follow-up is due; a new generation resumes it.
  z.strictObject({ type: z.literal('park'), ref: runRefSchema, reason: z.enum(['needs_input', 'follow_up_due']),
    dueAtMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }),
]);
export const providerRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: operationIdSchema,
  job: jobKeySchema,
  role: roleSchema,
  checkpoint: checkpointSchema,
  fence: fenceSchema,
});
export const outboxEventSchema = z.strictObject({
  eventId: uuid,
  kind: z.literal('supervisor.event'),
  payload: z.strictObject({ eventId: uuid, enrollmentId: uuid }),
  leaseToken: uuid,
  attempts: z.number().int().positive(),
}).refine(event => event.eventId === event.payload.eventId, { message: 'event_identity_mismatch' });
export const deliveryCodeSchema = z.enum(['dispatch_unavailable', 'invalid_envelope', 'attempts_exhausted', 'prepare_conflict', 'prepare_refused']);

/**
 * Cross-course coordination (one learner, several enrollments). The host decides everything:
 * whether the learner opted in for a pair of their enrollments, which staff-authored concept
 * mapping applies, and what may be suggested. The workflow only carries identifiers and counters;
 * no learner content, evidence or course text enters its history.
 */
/** Why the host woke a learner's coordinator. */
export const crossCourseReasonSchema = z.enum(['consent_granted', 'consent_revoked', 'evidence_changed', 'enrollment_activity', 'erased']);
/** Temporal signal from the dispatcher (host wake-ups). `active: false` means no opt-in remains: stop. */
export const CROSS_COURSE_WAKE_SIGNAL = 'crossCourseWake';
export const crossCourseWakeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  learnerId: uuid,
  /** The learner's consent epoch at the host; it only grows. */
  consentRevision: z.number().int().nonnegative(),
  active: z.boolean(),
  reason: crossCourseReasonSchema,
});
/** Temporal signal from an enrollment coordinator after one of its jobs ended. A wake-up only. */
export const ENROLLMENT_OBSERVED_SIGNAL = 'enrollmentObserved';
export const enrollmentObservedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  learnerId: uuid,
  workspaceId: uuid,
  enrollmentId: uuid,
});
/** One undelivered host wake-up for a learner's coordinator: signal (and, while active, start) it, then acknowledge. */
export const crossCourseDeliverySchema = z.strictObject({
  wakeupId: uuid,
  leaseToken: uuid,
  attempts: z.number().int().positive(),
  learnerId: uuid,
  consentRevision: z.number().int().nonnegative(),
  active: z.boolean(),
  reason: crossCourseReasonSchema,
});
export const crossCourseDeliveriesSchema = z.array(crossCourseDeliverySchema).max(100);
/** The host's answer to "may this learner's coordinator run at all?". */
export const crossCourseConsentSchema = z.strictObject({ active: z.boolean(), consentRevision: z.number().int().nonnegative() });
/** The host's answer to one planning pass. `budget_wait` names when the learner's daily allowance renews. */
export const crossCoursePlanSchema = z.strictObject({
  status: z.enum(['planned', 'no_consent', 'budget_wait']),
  consentRevision: z.number().int().nonnegative(),
  /** Suggestions the host verified and stored in this pass. */
  created: z.number().int().min(0).max(100),
  retryAfterMs: z.number().int().min(1_000).max(86_400_000).optional(),
});
/** The host's answer to an enrollment coordinator: the learner to wake, only while an opt-in covers this enrollment. */
export const crossCourseObservedSchema = z.strictObject({ learnerId: uuid.nullable() });
export const rpcRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('load'), ref: runRefSchema }),
  z.strictObject({ method: z.literal('transition'), command: jobCommandSchema }),
  z.strictObject({ method: z.literal('outbox.claim'), ownerId: uuid, limit: z.number().int().min(1).max(100), leaseMs: z.number().int().min(30_000).max(300_000) }),
  z.strictObject({ method: z.literal('outbox.prepare'), eventId: uuid, leaseToken: uuid }),
  z.strictObject({ method: z.literal('outbox.ack'), eventId: uuid, leaseToken: uuid }),
  z.strictObject({ method: z.literal('outbox.nack'), eventId: uuid, leaseToken: uuid, code: deliveryCodeSchema, delayMs: z.number().int().min(0).max(3_600_000), quarantine: z.boolean() }),
  z.strictObject({ method: z.literal('control.claim'), ownerId: uuid, limit: z.number().int().min(1).max(100), leaseMs: z.number().int().min(30_000).max(300_000) }),
  // delivered=false releases the lease for a later attempt (abandoned after the host's attempt limit).
  z.strictObject({ method: z.literal('control.ack'), changeId: uuid, leaseToken: uuid, delivered: z.boolean() }),
  z.strictObject({ method: z.literal('cancel.claim'), ownerId: uuid, limit: z.number().int().min(1).max(100), leaseMs: z.number().int().min(30_000).max(300_000) }),
  z.strictObject({ method: z.literal('cancel.ack'), cancellationId: uuid, leaseToken: uuid, delivered: z.boolean() }),
  // Settle uncertain calls from finished gateway receipts and return jobs to restart in a new generation.
  z.strictObject({ method: z.literal('reconcile'), limit: z.number().int().min(1).max(100) }),
  // Cross-course coordination. Every answer is decided by the host from stored consent and mapping.
  z.strictObject({ method: z.literal('crosscourse.claim'), ownerId: uuid, limit: z.number().int().min(1).max(100), leaseMs: z.number().int().min(30_000).max(300_000) }),
  z.strictObject({ method: z.literal('crosscourse.ack'), wakeupId: uuid, leaseToken: uuid, delivered: z.boolean() }),
  z.strictObject({ method: z.literal('crosscourse.consent'), learnerId: uuid }),
  z.strictObject({ method: z.literal('crosscourse.plan'), learnerId: uuid, consentRevision: z.number().int().nonnegative() }),
  z.strictObject({ method: z.literal('crosscourse.observe'), workspaceId: uuid, enrollmentId: uuid }),
]);
export const reconciledSchema = z.strictObject({ settled: z.number().int().min(0).max(1000), resume: z.array(runRefSchema).max(100) });
export const ackSchema = z.strictObject({ accepted: z.boolean() });
export const preparedSchema = z.strictObject({ jobs: z.array(runRefSchema).max(16) });
export const leasesSchema = z.array(outboxEventSchema).max(100);
export const summarySchema = z.strictObject({ ref: runRefSchema, state: stateSchema, reason: reasonSchema.nullable() });
export type JobKey = z.infer<typeof jobKeySchema>;
export type RunRef = z.infer<typeof runRefSchema>;
export type Fence = z.infer<typeof fenceSchema>;
export type JobSpec = z.infer<typeof jobSpecSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Command = z.infer<typeof jobCommandSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type UsageBasis = z.infer<typeof usageBasisSchema>;
export type ProviderRequest = z.infer<typeof providerRequestSchema>;
export type Verification = z.infer<typeof verificationSchema>;
export type OutboxEvent = z.infer<typeof outboxEventSchema>;
export type DeliveryCode = z.infer<typeof deliveryCodeSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type SupervisionState = z.infer<typeof supervisionStateSchema>;
export type SupervisionSignal = z.infer<typeof supervisionSignalSchema>;
export type ControlDelivery = z.infer<typeof controlDeliverySchema>;
export type CancellationReason = z.infer<typeof cancellationReasonSchema>;
export type JobCancellationSignal = z.infer<typeof jobCancellationSignalSchema>;
export type CancellationDelivery = z.infer<typeof cancellationDeliverySchema>;
export type HaltReason = z.infer<typeof haltReasonSchema>;
export type Reconciled = z.infer<typeof reconciledSchema>;
export type CrossCourseReason = z.infer<typeof crossCourseReasonSchema>;
export type CrossCourseWake = z.infer<typeof crossCourseWakeSchema>;
export type EnrollmentObserved = z.infer<typeof enrollmentObservedSchema>;
export type CrossCourseDelivery = z.infer<typeof crossCourseDeliverySchema>;
export type CrossCourseConsent = z.infer<typeof crossCourseConsentSchema>;
export type CrossCoursePlan = z.infer<typeof crossCoursePlanSchema>;
export type CrossCourseObserved = z.infer<typeof crossCourseObservedSchema>;

export function workflowId(ref: RunRef): string {
  const r = runRefSchema.parse(ref);
  return `supervisor-v1/${r.workspaceId}/${r.jobId}/${r.generation}`;
}
/** One long-lived coordinator per enrollment; it starts each job as a child workflow. */
export function enrollmentWorkflowId(workspaceId: string, enrollmentId: string): string {
  return `enrollment-supervisor-v1/${uuid.parse(workspaceId)}/${uuid.parse(enrollmentId)}`;
}
export const JOB_PREPARED_SIGNAL = 'jobPrepared';
export const enrollmentInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: uuid,
  enrollmentId: uuid,
  // Carried across continue-as-new.
  pending: z.array(runRefSchema).max(256).default([]),
  control: z.strictObject({ state: supervisionStateSchema, revision: z.number().int().nonnegative() }).default({ state: 'active', revision: 0 }),
  started: z.number().int().nonnegative().default(0),
  // Bounds per run; tests lower them to exercise continue-as-new.
  maxJobsPerRun: z.number().int().min(1).max(1000).default(200),
  maxConcurrent: z.number().int().min(1).max(8).default(2),
  idleMs: z.number().int().min(1_000).max(7 * 86_400_000).default(86_400_000),
});
export type EnrollmentInput = z.input<typeof enrollmentInputSchema>;
export const enrollmentSummarySchema = z.strictObject({ started: z.number().int().nonnegative(), reason: z.enum(['idle', 'stopped']) });
export type EnrollmentSummary = z.infer<typeof enrollmentSummarySchema>;
/** One coordinator per learner (not per enrollment). It runs only while the host reports an opt-in. */
export function learnerCoordinatorWorkflowId(learnerId: string): string {
  return `learner-coordinator-v1/${uuid.parse(learnerId)}`;
}
export const learnerCoordinatorInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  learnerId: uuid,
  // Carried across continue-as-new. State is bounded: a revision, a flag and counters, never lists.
  consentRevision: z.number().int().nonnegative().default(0),
  dirty: z.boolean().default(true),
  planned: z.number().int().nonnegative().default(0),
  // Bounds per run; tests lower them to exercise continue-as-new and coalescing.
  maxPlansPerRun: z.number().int().min(1).max(500).default(100),
  idleMs: z.number().int().min(1_000).max(7 * 86_400_000).default(86_400_000),
  /** Quiet time after a pass: signals arriving meanwhile are coalesced into the next pass. */
  coalesceMs: z.number().int().min(0).max(3_600_000).default(30_000),
  /** Upper bound on one wait for the learner's daily allowance to renew. */
  maxBudgetWaitMs: z.number().int().min(1_000).max(86_400_000).default(6 * 3_600_000),
});
export type LearnerCoordinatorInput = z.input<typeof learnerCoordinatorInputSchema>;
export const learnerCoordinatorSummarySchema = z.strictObject({
  planned: z.number().int().nonnegative(),
  reason: z.enum(['idle', 'no_consent', 'consent_revoked']),
});
export type LearnerCoordinatorSummary = z.infer<typeof learnerCoordinatorSummarySchema>;
export function operationId(jobId: string, checkpointId: string): string {
  return operationIdSchema.parse(`${uuid.parse(jobId)}/${key.parse(checkpointId)}`);
}
export function summarize(snapshot: Snapshot): Summary {
  return { ref: { ...snapshot.specification.key, generation: snapshot.generation }, state: snapshot.state, reason: snapshot.reason };
}
