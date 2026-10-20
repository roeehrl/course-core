import type { Payload } from '@temporalio/common';
import type { WorkflowInterceptorsFactory } from '@temporalio/workflow';
import { JOB_PREPARED_SIGNAL, runRefSchema, workflowId } from '../contracts.js';
import { TRACE_HEADER } from './trace-header.js';

/** At most this many queued jobs keep a trace header in a coordinator; later ones run untraced. */
const MAX_PENDING_HEADERS = 256;

/**
 * Workflow interceptors that pass the trace header on, unchanged and opaque:
 * - a job workflow attaches the header it was started with to every activity it schedules;
 * - the enrollment coordinator remembers the header of each prepared-job signal and attaches it
 *   to that job's child workflow.
 * The header is part of workflow history, so replay sees the same values. Nothing here reads
 * telemetry settings, clocks or randomness. Jobs queued across continue-as-new lose their header.
 */
export const interceptors: WorkflowInterceptorsFactory = () => {
  let own: Payload | undefined;
  const pending = new Map<string, Payload>();
  return {
    inbound: [{
      execute(input, next) { own = input.headers[TRACE_HEADER]; return next(input); },
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
      startChildWorkflowExecution(input, next) {
        const header = pending.get(input.options.workflowId);
        pending.delete(input.options.workflowId);
        return next(header && !input.headers[TRACE_HEADER] ? { ...input, headers: { ...input.headers, [TRACE_HEADER]: header } } : input);
      },
    }],
  };
};
