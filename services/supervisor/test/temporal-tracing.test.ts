import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPayloadConverter, type Headers } from '@temporalio/common';
import type { WorkflowSignalWithStartInput, WorkflowStartInput } from '@temporalio/client';
import { startTelemetry, telemetry } from '../src/telemetry.js';
import { activityTraceInterceptor, traceCarrier, TRACE_HEADER, workflowTraceInterceptor } from '../src/temporal/tracing.js';
import { otlpReceiver } from './otlp-receiver.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736', PARENT = `00-${TRACE}-00f067aa0ba902b7-01`;
const startInput = (): WorkflowStartInput => ({ workflowType: 'supervisorJob', headers: {}, options: {} as WorkflowStartInput['options'] });
const signalInput = (): WorkflowSignalWithStartInput => ({ workflowType: 'enrollmentSupervisor', signalName: 'jobPrepared', signalArgs: [], headers: {},
  options: {} as WorkflowSignalWithStartInput['options'] });
async function startHeaders(): Promise<Headers[]> {
  const seen: Headers[] = [], interceptor = workflowTraceInterceptor();
  await interceptor.startWithDetails!(startInput(), async input => { seen.push(input.headers); return { runId: 'r', eagerlyStarted: false } as never; });
  await interceptor.signalWithStart!(signalInput(), async input => { seen.push(input.headers); return 'r'; });
  return seen;
}
const activityTrace = (headers: Headers) => activityTraceInterceptor().execute!({ args: [], headers }, async () => telemetry().traceId());

test('the trace header is read only in the expected shape', () => {
  assert.equal(traceCarrier(undefined), undefined);
  assert.deepEqual(traceCarrier(defaultPayloadConverter.toPayload({ traceparent: PARENT })), { traceparent: PARENT });
  assert.deepEqual(traceCarrier(defaultPayloadConverter.toPayload({ traceparent: PARENT, tracestate: 'vendor=1' })), { traceparent: PARENT, tracestate: 'vendor=1' });
  assert.deepEqual(traceCarrier(defaultPayloadConverter.toPayload({ traceparent: PARENT, tracestate: 'x'.repeat(513) })), { traceparent: PARENT });
  for (const value of [null, 'text', 42, [PARENT], { traceparent: 'garbage' }, { traceparent: PARENT.toUpperCase() }, { tracestate: 'a=1' }])
    assert.equal(traceCarrier(defaultPayloadConverter.toPayload(value)), undefined, JSON.stringify(value));
  assert.equal(traceCarrier({ metadata: { encoding: new TextEncoder().encode('binary/unknown') }, data: new Uint8Array([1]) }), undefined);
});

test('with telemetry off, workflow starts carry no trace header and activities link no trace', async () => {
  assert.equal(telemetry().enabled, false);
  for (const headers of await telemetry().span('supervisor.dispatch', {}, startHeaders)) assert.deepEqual(headers, {});
  assert.equal(await activityTrace({ [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceparent: PARENT }) }), null);
});

test('with telemetry on, a start inside a span carries its trace and the activity continues it', async () => {
  const receiver = await otlpReceiver();
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-dispatcher', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_METRICS_EXPORTER: 'none' } });
    // Outside any span there is nothing to carry.
    for (const headers of await startHeaders()) assert.deepEqual(headers, {});
    // Idle, unsampled work carries a not-sampled context, which an activity never links.
    const idle = await runtime.unsampled(() => startHeaders());
    assert.equal(await activityTrace(idle[0]!), null);
    let traceId: string | null = null;
    const carried = await runtime.span('supervisor.dispatch', {}, async () => { traceId = runtime.traceId(); return startHeaders(); });
    assert.equal(carried.length, 2);
    for (const headers of carried) {
      assert.deepEqual(Object.keys(headers), [TRACE_HEADER]);
      assert.match(traceCarrier(headers[TRACE_HEADER])?.traceparent ?? "", new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
      assert.equal(await activityTrace(headers), traceId);
    }
    // A missing or forged header leaves the activity in no trace rather than an invented one.
    assert.equal(await activityTrace({}), null);
    assert.equal(await activityTrace({ [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceparent: 'garbage' }) }), null);
    await runtime.shutdown();
  } finally { await receiver.close(); }
});
