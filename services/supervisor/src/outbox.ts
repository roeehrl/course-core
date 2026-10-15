import { randomUUID } from 'node:crypto';
import { controlDeliverySchema, enrollmentWorkflowId, outboxEventSchema, runRefSchema, workflowId, type OutboxEvent, type RunRef, type SupervisionSignal } from './contracts.js';
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

/** Sends one staff supervision-control signal to one workflow. Resolves `closed` when the workflow
 * no longer exists or has finished; rejects only when delivery should be retried. */
export interface ControlSignaller {
  signal(workflowId: string, signal: SupervisionSignal): Promise<'delivered' | 'closed'>;
}
/** Forwards committed pause/stop/resume changes to the affected workflows as wake-up signals.
 * The host's stored control is authoritative, so a lost signal only delays a held job's resume
 * until its next poll; it never lets work run against the control. */
export async function deliverControlsOnce(bridge: HostBridge, signaller: ControlSignaller, options: { limit?: number; leaseMs?: number } = {}) {
  const limit = options.limit ?? 20, leaseMs = options.leaseMs ?? 60_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 300_000)
    throw new Error('invalid_control_options');
  const deliveries = await telemetry().unsampled(() => bridge.claimControls(randomUUID(), limit, leaseMs));
  const totals = { claimed: deliveries.length, delivered: 0, retried: 0, signalled: 0, closed: 0, leaseLost: 0 };
  if (deliveries.length > limit) throw new Error('invalid_claim_count');
  await Promise.allSettled(deliveries.map(async raw => {
    const delivery = parseSafe(controlDeliverySchema, raw);
    let delivered = true;
    for (const ref of delivery.jobs) {
      try {
        if (await signaller.signal(workflowId(ref), delivery.signal) === 'closed') totals.closed++; else totals.signalled++;
      } catch { delivered = false; }
    }
    // The enrollment coordinator forwards it to children it started; closed or absent is fine.
    try { await signaller.signal(enrollmentWorkflowId(delivery.workspaceId, delivery.signal.enrollmentId), delivery.signal); }
    catch { delivered = false; }
    if (await bridge.ackControl(delivery, delivered)) { if (delivered) totals.delivered++; else totals.retried++; }
    else totals.leaseLost++;
  }));
  return totals;
}

/** Settles uncertain calls from finished gateway receipts (never by calling the provider again)
 * and starts each job the host moved to a new generation. A start that fails is retried on the
 * next pass: the host keeps listing a resumed job until its new generation has a workflow. */
export async function reconcileOnce(bridge: HostBridge, starter: WorkflowStarter, limit = 20) {
  const result = await telemetry().unsampled(() => bridge.reconcile(limit));
  const totals = { settled: result.settled, resumed: 0, failed: 0 };
  for (const raw of result.resume) {
    try { const ref = parseSafe(runRefSchema, raw); await starter.start(ref, workflowId(ref)); totals.resumed++; }
    catch { totals.failed++; }
  }
  return totals;
}
