/**
 * Temporal header that carries W3C trace context from a workflow start to the workflow, its child
 * jobs and their activities. The name and JSON payload shape (`{ traceparent, tracestate? }`) match
 * `@temporalio/interceptors-opentelemetry`, so either side can be swapped for that package later.
 * No imports: this module is bundled into the workflow sandbox.
 */
export const TRACE_HEADER = '_tracer-data';
