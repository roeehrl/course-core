import { defaultPayloadConverter, type Payload } from '@temporalio/common';
import type { WorkflowInterceptorsFactory } from '@temporalio/workflow';
import { JOB_PREPARED_SIGNAL, runRefSchema, workflowId } from '../contracts.js';
import { TRACE_HEADER } from './trace-header.js';

/** At most this many queued jobs keep a trace header in a coordinator; later ones run untraced. */
const MAX_PENDING_HEADERS = 256;
/** Queued jobs' trace headers carried across continue-as-new: [[workflowId, header value], ...]. */
export const PENDING_TRACES_HEADER = '_course-pending-traces';
function restorePending(carried: Payload | undefined, into: Map<string, Payload>) {
  if (!carried) return;
  let value: unknown;
  try { value = defaultPayloadConverter.fromPayload(carried); } catch { return; }
  if (!Array.isArray(value)) return;
  for (const entry of value.slice(0, MAX_PENDING_HEADERS))
    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 300 && entry[1] && typeof entry[1] === 'object')
      into.set(entry[0], defaultPayloadConverter.toPayload(entry[1]));
}

/**
 * Workflow interceptors that pass the trace header on, unchanged and opaque:
 * - a job workflow attaches the header it was started with to every activity it schedules;
 * - the enrollment coordinator remembers the header of each prepared-job signal and attaches it
 *   to that job's child workflow.
 * - continue-as-new (U03) carries both on: the coordinator's own header, and the headers of jobs
 *   still queued, in one extra header the next run reads back. So a job queued before the
 *   coordinator continued still runs in the trace that prepared it.
 * The header is part of workflow history, so replay sees the same values. Nothing here reads
 * telemetry settings, clocks or randomness.
 */
export const interceptors: WorkflowInterceptorsFactory = () => {
  let own: Payload | undefined;
  const pending = new Map<string, Payload>();
  return {
    inbound: [{
      execute(input, next) {
        own = input.headers[TRACE_HEADER];
        restorePending(input.headers[PENDING_TRACES_HEADER], pending);
        return next(input);
      },
      handleSignal(input, next) {
        const header = input.headers[TRACE_HEADER];
        if (header && input.signalName === JOB_PREPARED_SIGNAL && pending.size < MAX_PENDING_HEADERS) {
          const ref = runRefSchema.safeParse(input.args[0]);
          if (ref.success) pending.set(workflowId(ref.data), header);
        }
        return next(input);
      },
    }],
    outbound: [{
      scheduleActivity(input, next) {
        return next(own && !input.headers[TRACE_HEADER] ? { ...input, headers: { ...input.headers, [TRACE_HEADER]: own } } : input);
      },
      continueAsNew(input, next) {
        const headers = { ...input.headers };
        if (own && !headers[TRACE_HEADER]) headers[TRACE_HEADER] = own;
        if (pending.size && !headers[PENDING_TRACES_HEADER]) {
          const carried: [string, unknown][] = [];
          for (const [id, header] of pending) {
            try { carried.push([id, defaultPayloadConverter.fromPayload(header)]); } catch { /* not ours: dropped */ }
          }
          headers[PENDING_TRACES_HEADER] = defaultPayloadConverter.toPayload(carried);
        }
        return next({ ...input, headers });
      },
      startChildWorkflowExecution(input, next) {
        const header = pending.get(input.options.workflowId);
        pending.delete(input.options.workflowId);
        return next(header && !input.headers[TRACE_HEADER] ? { ...input, headers: { ...input.headers, [TRACE_HEADER]: header } } : input);
      },
    }],
  };
};
