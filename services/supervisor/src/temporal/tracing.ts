import { defaultPayloadConverter, type Headers, type Payload } from '@temporalio/common';
import type { WorkflowClientInterceptor } from '@temporalio/client';
import type { ActivityInboundCallsInterceptor } from '@temporalio/worker';
import { telemetry } from '../telemetry.js';
import { TRACE_HEADER } from './trace-header.js';

export { TRACE_HEADER } from './trace-header.js';
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** Reads a trace header written by `workflowTraceInterceptor`. Anything else is ignored. */
export function traceCarrier(header: Payload | undefined): Record<string, string> | undefined {
  if (!header) return undefined;
  let value: unknown;
  try { value = defaultPayloadConverter.fromPayload(header); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const { traceparent, tracestate } = value as Record<string, unknown>;
  if (typeof traceparent !== 'string' || !TRACEPARENT.test(traceparent)) return undefined;
  return typeof tracestate === 'string' && tracestate.length <= 512 ? { traceparent, tracestate } : { traceparent };
}
function withTrace<I extends { readonly headers: Headers }>(input: I): I {
  const carrier: Record<string, string> = {};
  telemetry().inject(carrier);
  if (!carrier.traceparent) return input;
  const payload = { traceparent: carrier.traceparent, ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}) };
  return { ...input, headers: { ...input.headers, [TRACE_HEADER]: defaultPayloadConverter.toPayload(payload) } };
}
/** Client interceptor: a workflow start (or signal-with-start) carries the active span's trace
 * context. With telemetry off, or outside a sampled span, nothing is added. */
export function workflowTraceInterceptor(): WorkflowClientInterceptor {
  return {
    startWithDetails: (input, next) => next(withTrace(input)),
    signalWithStart: (input, next) => next(withTrace(input)),
  };
}
/** Worker interceptor: an activity runs as a continuation of the trace its workflow was started in. */
export function activityTraceInterceptor(): ActivityInboundCallsInterceptor {
  return { execute: (input, next) => telemetry().continueTrace(traceCarrier(input.headers[TRACE_HEADER]), () => next(input)) };
}
