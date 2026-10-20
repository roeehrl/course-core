import { randomUUID } from 'node:crypto';
import {
  availabilitySchema, outcomeSchema, runRefSchema, snapshotSchema, transitionSchema, operationId,
  type RunRef, type Snapshot, type Transition, type ProviderRequest, type HaltReason,
} from './contracts.js';
import { BoundaryError, parseSafe, type HostBridge } from './bridge.js';
import type { ProviderGateway } from './providers.js';
import { telemetry, type SpanHandle } from './telemetry.js';

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

type ActivityName = 'load_job' | 'execute_checkpoint' | 'verify_job' | 'apply_job' | 'halt_job';
/** Records only allowlisted run metadata: role, checkpoint key, effect, state and reason codes. */
function observed(activity: ActivityName, result: Transition, span: SpanHandle) {
  const attributes = { 'course.supervisor.role': result.snapshot.specification.role, 'course.supervisor.state': result.snapshot.state,
    'course.supervisor.reason': result.snapshot.reason, 'course.supervisor.effect': result.effect };
  span.setAttributes(attributes);
  const role = { 'course.supervisor.role': result.snapshot.specification.role };
  if (result.effect === 'retry') telemetry().count('course.supervisor.job.retries', 1, role);
  if (result.effect === 'stop' || activity === 'apply_job' || activity === 'halt_job') {
    telemetry().count('course.supervisor.run.outcomes', 1, attributes);
    const reason = result.snapshot.reason;
    if (reason === 'verification_rejected' || reason === 'provider_rejected') telemetry().count('course.supervisor.rejections', 1, { ...role, 'course.rejection.reason': reason });
  }
  return result;
}
const activitySpan = <T>(activity: ActivityName, body: (span: SpanHandle) => Promise<T>, checkpointId?: string) =>
  telemetry().span('supervisor.activity', { 'course.supervisor.activity': activity, 'course.supervisor.checkpoint': checkpointId }, body);

/** Plain async functions, independently testable without Temporal. */
export function createActivities(bridge: HostBridge, provider: ProviderGateway, runtime: () => ActivityRuntime) {
  return {
    loadJob: (raw: RunRef) => activitySpan('load_job', async span => {
      const ref = parseSafe(runRefSchema, raw);
      const specification = boundSnapshot(await bridge.load(ref), ref).specification;
      span.setAttributes({ 'course.supervisor.role': specification.role });
      return specification;
    }),
    executeCheckpoint: (raw: RunRef, checkpointId: string): Promise<Transition> => activitySpan('execute_checkpoint', async span => {
      const ref = parseSafe(runRefSchema, raw);
      const rt = runtime();
      const s = boundSnapshot(await bridge.load(ref), ref);
      const cp = s.specification.checkpoints.find(c => c.id === checkpointId);
      if (!cp) throw new BoundaryError('invalid_request');
      span.setAttributes({ 'course.supervisor.role': s.specification.role });
      const availabilitySignal = AbortSignal.any([rt.signal, AbortSignal.timeout(10_000)]);
      const existing = s.operations.find(o => o.checkpointId === cp.id);
      const availability = existing && existing.status !== 'not_started' ? { status: 'ready' as const }
        : parseSafe(availabilitySchema, await abortable(provider.availability(cp.capability, availabilitySignal,ref), availabilitySignal));
      const ownerId = randomUUID(); // Per activity INVOCATION, never derived from Temporal attempt number.
      const claimed = boundTransition(await bridge.transition({ type: 'claim', ref, checkpointId, ownerId, availability }), ref);
      if (claimed.effect !== 'invoke') return observed('execute_checkpoint', claimed, span);
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
      const settled = boundTransition(await bridge.transition({ type: 'settle', ref, operationId: opId, ownerId, outcome }), ref);
      span.setAttributes({ 'course.supervisor.outcome': outcome.status });
      telemetry().count('course.supervisor.checkpoint.outcomes', 1, { 'course.supervisor.role': s.specification.role,
        'course.supervisor.outcome': outcome.status, 'course.supervisor.effect': settled.effect });
      return observed('execute_checkpoint', settled, span);
    }, checkpointId),
    verifyJob: (ref: RunRef) => activitySpan('verify_job', async span =>
      observed('verify_job', boundTransition(await bridge.transition({ type: 'verify', ref: parseSafe(runRefSchema, ref) }), ref), span)),
    applyJob: (ref: RunRef) => activitySpan('apply_job', async span =>
      observed('apply_job', boundTransition(await bridge.transition({ type: 'apply', ref: parseSafe(runRefSchema, ref) }), ref), span)),
    haltJob: (ref: RunRef, reason: HaltReason) => activitySpan('halt_job', async span =>
      observed('halt_job', boundTransition(await bridge.transition({ type: 'halt', ref: parseSafe(runRefSchema, ref), reason }), ref), span)),
  };
}
export type Activities = ReturnType<typeof createActivities>;
