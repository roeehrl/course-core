import { randomUUID } from 'node:crypto';
import {
  availabilitySchema, outcomeSchema, runRefSchema, snapshotSchema, transitionSchema, operationId,
  type RunRef, type Snapshot, type Transition, type ProviderRequest,
} from './contracts.js';
import { BoundaryError, parseSafe, type HostBridge } from './bridge.js';
import type { ProviderGateway } from './providers.js';

export interface ActivityRuntime {
  signal: AbortSignal;
  heartbeat(): void;
}
function boundSnapshot(raw: Snapshot, ref: RunRef): Snapshot {
  const s = parseSafe(snapshotSchema, raw);
  const k = s.specification.key;
  if (k.jobId !== ref.jobId || k.workspaceId !== ref.workspaceId || k.enrollmentId !== ref.enrollmentId || s.generation !== ref.generation)
    throw new BoundaryError('invalid_response');
  return s;
}
function boundTransition(raw: Transition, ref: RunRef): Transition {
  const result = parseSafe(transitionSchema, raw);
  boundSnapshot(result.snapshot, ref);
  return result;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new BoundaryError('provider_unavailable');
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(new BoundaryError('provider_unavailable'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

/** Plain async functions, independently testable without Temporal. */
export function createActivities(bridge: HostBridge, provider: ProviderGateway, runtime: () => ActivityRuntime) {
  return {
    async loadJob(raw: RunRef) {
      const ref = parseSafe(runRefSchema, raw);
      return boundSnapshot(await bridge.load(ref), ref).specification;
    },
    async executeCheckpoint(raw: RunRef, checkpointId: string): Promise<Transition> {
      const ref = parseSafe(runRefSchema, raw);
      const rt = runtime();
      const s = boundSnapshot(await bridge.load(ref), ref);
      const cp = s.specification.checkpoints.find(c => c.id === checkpointId);
      if (!cp) throw new BoundaryError('invalid_request');
      const availabilitySignal = AbortSignal.any([rt.signal, AbortSignal.timeout(10_000)]);
      const existing = s.operations.find(o => o.checkpointId === cp.id);
      const availability = existing && existing.status !== 'not_started' ? { status: 'ready' as const }
        : parseSafe(availabilitySchema, await abortable(provider.availability(cp.capability, availabilitySignal), availabilitySignal));
      const ownerId = randomUUID(); // Per activity INVOCATION, never derived from Temporal attempt number.
      const claimed = boundTransition(await bridge.transition({ type: 'claim', ref, checkpointId, ownerId, availability }), ref);
      if (claimed.effect !== 'invoke') return claimed;
      const opId = operationId(ref.jobId, cp.id);
      const op = claimed.snapshot.operations.find(o => o.id === opId);
      if (op?.status !== 'in_flight' || op.ownerId !== ownerId) throw new BoundaryError('invalid_response');
      const request: ProviderRequest = { schemaVersion: 1, operationId: opId, job: s.specification.key,
        role: s.specification.role, checkpoint: cp, fence: s.specification.fence };
      const signal = AbortSignal.any([rt.signal, AbortSignal.timeout(cp.timeoutMs)]);
      let outcome: import('./contracts.js').Outcome = { status: 'uncertain' };
      const timer = setInterval(() => { try { rt.heartbeat(); } catch { /* cancellation is handled by the signal */ } }, 1_000);
      timer.unref();
      try {
        rt.heartbeat();
        if (!signal.aborted) outcome = parseSafe(outcomeSchema, await abortable(provider.invoke(request, signal), signal));
        else outcome = { status: 'not_started', retryable: true };
      } catch { outcome = { status: 'uncertain' }; }
      finally { clearInterval(timer); }
      // Independent bridge timeout: record uncertainty even after provider cancellation. If this response
      // is lost, the next invocation consults the durable operation and cannot invoke the provider again.
      return boundTransition(await bridge.transition({ type: 'settle', ref, operationId: opId, ownerId, outcome }), ref);
    },
    async verifyJob(ref: RunRef) {
      return boundTransition(await bridge.transition({ type: 'verify', ref: parseSafe(runRefSchema, ref) }), ref);
    },
    async applyJob(ref: RunRef) {
      return boundTransition(await bridge.transition({ type: 'apply', ref: parseSafe(runRefSchema, ref) }), ref);
    },
    async haltJob(ref: RunRef, reason: 'cancel_requested' | 'deadline_exceeded' | 'activity_exhausted') {
      return boundTransition(await bridge.transition({ type: 'halt', ref: parseSafe(runRefSchema, ref), reason }), ref);
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
