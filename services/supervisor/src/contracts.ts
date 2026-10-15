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
  'cancel_requested', 'activity_exhausted', 'supervision_stopped',
]);
export const stateSchema = z.enum([
  'queued', 'running', 'waiting', 'verifying', 'ready', 'applied', 'failed', 'cancelled', 'budget_wait',
]);
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
export const jobCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('claim'), ref: runRefSchema, checkpointId: key, ownerId: uuid, availability: availabilitySchema }),
  z.strictObject({ type: z.literal('settle'), ref: runRefSchema, operationId: operationIdSchema, ownerId: uuid, outcome: outcomeSchema }),
  z.strictObject({ type: z.literal('verify'), ref: runRefSchema }),
  z.strictObject({ type: z.literal('apply'), ref: runRefSchema }),
  z.strictObject({ type: z.literal('halt'), ref: runRefSchema, reason: haltReasonSchema }),
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
export const deliveryCodeSchema = z.enum(['dispatch_unavailable', 'invalid_envelope', 'attempts_exhausted']);
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
]);
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
export type HaltReason = z.infer<typeof haltReasonSchema>;

export function workflowId(ref: RunRef): string {
  const r = runRefSchema.parse(ref);
  return `supervisor-v1/${r.workspaceId}/${r.jobId}/${r.generation}`;
}
export function operationId(jobId: string, checkpointId: string): string {
  return operationIdSchema.parse(`${uuid.parse(jobId)}/${key.parse(checkpointId)}`);
}
export function summarize(snapshot: Snapshot): Summary {
  return { ref: { ...snapshot.specification.key, generation: snapshot.generation }, state: snapshot.state, reason: snapshot.reason };
}
