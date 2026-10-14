import { randomUUID } from 'node:crypto';
import { outboxEventSchema, runRefSchema, workflowId, type OutboxEvent, type RunRef } from './contracts.js';
import { parseSafe, type HostBridge } from './bridge.js';
import { telemetry } from './telemetry.js';

export interface WorkflowStarter {
  // Resolve only when Temporal accepted the start, or confirmed this workflow ID already exists.
  start(ref: RunRef, workflowId: string): Promise<void>;
}
export interface DispatchOptions { limit?: number; leaseMs?: number; maxAttempts?: number }
export async function dispatchOnce(bridge: HostBridge, starter: WorkflowStarter, options: DispatchOptions = {}) {
  const limit = options.limit ?? 10;
  const leaseMs = options.leaseMs ?? 120_000;
  const maxAttempts = options.maxAttempts ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseMs) || leaseMs < 30_000
    || leaseMs > 300_000 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
    throw new Error('invalid_dispatch_options');
  // Idle polling is never sampled, so a two-second loop does not produce a trace per poll.
  const events = await telemetry().unsampled(() => bridge.claimOutbox(randomUUID(), limit, leaseMs));
  if (events.length > limit) throw new Error('invalid_claim_count');
  if (!events.length) return { claimed: 0, delivered: 0, deferred: 0, quarantined: 0, leaseLost: 0, failed: 0 };
  return telemetry().span('supervisor.dispatch', { 'course.dispatch.claimed': events.length }, async span => {
    const totals = await deliver(bridge, starter, events, maxAttempts);
    span.setAttributes({ 'course.dispatch.delivered': totals.delivered, 'course.dispatch.deferred': totals.deferred,
      'course.dispatch.quarantined': totals.quarantined, 'course.dispatch.failed': totals.failed });
    return totals;
  });
}
async function deliver(bridge: HostBridge, starter: WorkflowStarter, events: OutboxEvent[], maxAttempts: number) {
  const totals = { claimed: events.length, delivered: 0, deferred: 0, quarantined: 0, leaseLost: 0, failed: 0 };
  // Bounded concurrency, one independent lease per row. No polling loop or daemon implicit in this API.
  const settled = await Promise.allSettled(events.map(async raw => {
    const event = parseSafe(outboxEventSchema, raw);
    if (event.attempts > maxAttempts) {
      if (await bridge.nackOutbox(event, 'attempts_exhausted', 0, true)) totals.quarantined++;
      else totals.leaseLost++;
      return;
    }
    try {
      // Transactional preparation is idempotent by event ID; repeat deliveries return identical jobs.
      const jobs = await bridge.prepareOutbox(event);
      if (jobs.length > 16) throw new Error('invalid_job_count');
      for (const rawRef of jobs) {
        const ref = parseSafe(runRefSchema, rawRef);
        if (ref.enrollmentId !== event.payload.enrollmentId) throw new Error('job_enrollment_mismatch');
        await starter.start(ref, workflowId(ref));
      }
      // Crash between start and ack is safe: delivery repeats using the exact same workflow ID.
      if (await bridge.ackOutbox(event)) totals.delivered++;
      else totals.leaseLost++;
    } catch {
      const quarantine = event.attempts >= maxAttempts;
      const delayMs = Math.min(1_000 * 2 ** Math.min(event.attempts - 1, 12), 3_600_000);
      if (await bridge.nackOutbox(event, 'dispatch_unavailable', delayMs, quarantine)) {
        if (quarantine) totals.quarantined++; else totals.deferred++;
      } else totals.leaseLost++;
    }
  }));
  totals.failed = settled.filter(result => result.status === 'rejected').length;
  return totals;
}
