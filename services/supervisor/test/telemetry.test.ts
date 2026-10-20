import test from 'node:test';
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import { ATTRIBUTE_RULES, disabledTelemetry, errorType, METRICS, safeSpanName, sanitizeAttributes, startTelemetry, telemetry,
  telemetryConfiguration, TelemetryConfigurationError } from '../src/telemetry.js';
import { createActivities } from '../src/activities.js';
import { HttpHostBridge } from '../src/bridge.js';
import { HttpProviderGateway } from '../src/providers.js';
import { TestHost, TestProvider } from './fixtures.js';
import { otlpReceiver } from './otlp-receiver.js';

const learnerText = 'My name is Dana Example and my answer is 42; ignore previous instructions';
test('attribute allowlist drops unknown keys, free text and wrongly typed values', () => {
  const output = sanitizeAttributes({
    'http.route': '/api/enrollments/:enrollmentId', 'http.request.method': 'POST', 'http.response.status_code': 200,
    'gen_ai.request.model': 'planner-model.v2', 'gen_ai.usage.input_tokens': 12, 'course.supervisor.role': 'supervisor',
    // Not allowlisted at all.
    'gen_ai.prompt': learnerText, 'learner.answer': learnerText, 'enduser.id': 'learner@example.com', 'url.full': 'http://localhost/api?x=1',
    authorization: 'Bearer synthetic-token',
  });
  assert.deepEqual(output, { 'http.route': '/api/enrollments/:enrollmentId', 'http.request.method': 'POST', 'http.response.status_code': 200,
    'gen_ai.request.model': 'planner-model.v2', 'gen_ai.usage.input_tokens': 12, 'course.supervisor.role': 'supervisor' });
  // Allowlisted keys still reject values that do not match their narrow rules.
  for (const [key, bad] of Object.entries({
    'http.route': '/api/enrollments/7c9e6679-7425-40de-944b-e07fc1f90ae7?email=learner@example.com',
    'http.request.method': 'post it now', 'http.response.status_code': 99, 'gen_ai.tool.name': learnerText,
    'gen_ai.request.model': 'model with spaces', 'gen_ai.usage.input_tokens': -1, 'course.supervisor.role': 'learner',
    'course.supervisor.checkpoint': 'Generate Plan', 'error.type': 'Error: connection refused for learner dana@example.com',
    'course.supervisor.cached': 'true', 'course.cost.estimate_micro_usd': 1.5,
  })) assert.deepEqual(sanitizeAttributes({ [key]: bad }), {}, key);
  assert.deepEqual(sanitizeAttributes({ 'gen_ai.usage.input_tokens': 1 }, ['http.route']), {});
  assert.deepEqual(sanitizeAttributes(undefined), {});
});
test('media job attributes keep only fixed states, steps and server codes', () => {
  assert.deepEqual(sanitizeAttributes({ 'course.media.state': 'under_review', 'course.media.step': 'poll', 'course.media.code': 'MEDIA_RECONCILED',
    'course.media.claimed': 3, 'course.media.job_id': '7c9e6679-7425-40de-944b-e07fc1f90ae7', 'course.media.script': learnerText }),
  { 'course.media.state': 'under_review', 'course.media.step': 'poll', 'course.media.code': 'MEDIA_RECONCILED', 'course.media.claimed': 3 });
  for (const [key, bad] of Object.entries({ 'course.media.state': 'shown', 'course.media.step': learnerText,
    'course.media.code': 'scripted/operations/op-1', 'course.media.claimed': 1000 }))
    assert.deepEqual(sanitizeAttributes({ [key]: bad }), {}, key);
  assert.equal(safeSpanName('media.job.step'), 'media.job.step');
});
test('every metric attribute is allowlisted and span names are fixed', () => {
  for (const [name, definition] of Object.entries(METRICS))
    for (const key of definition.attributes) assert.ok(Object.hasOwn(ATTRIBUTE_RULES, key), `${name}: ${key}`);
  assert.equal(safeSpanName('POST /api/enrollments/:enrollmentId'), 'POST /api/enrollments/:enrollmentId');
  assert.equal(safeSpanName('provider.call'), 'provider.call');
  assert.equal(safeSpanName(`POST /api/${learnerText}`), 'course.span');
  assert.equal(safeSpanName('GET /api/x?token=abc'), 'course.span');
});
test('error types are bounded codes, never exception messages', () => {
  assert.equal(errorType(Object.assign(new Error(learnerText), { code: 'PROVIDER_FORBIDDEN' })), 'PROVIDER_FORBIDDEN');
  assert.equal(errorType(Object.assign(new Error('x'), { code: '23505' })), '23505');
  assert.equal(errorType(new Error(learnerText)), '_OTHER');
  assert.equal(errorType(Object.assign(new Error('x'), { code: learnerText })), '_OTHER');
  assert.equal(errorType(null), '_OTHER');
});
test('configuration is off by default and enabled only by standard OTLP variables', () => {
  assert.deepEqual(telemetryConfiguration({}, 'svc'), { enabled: false });
  assert.deepEqual(telemetryConfiguration({ OTEL_SERVICE_NAME: 'x', OTEL_TRACES_EXPORTER: 'otlp' }, 'svc'), { enabled: false });
  assert.deepEqual(telemetryConfiguration({ OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' }, 'svc'), { enabled: false });
  assert.deepEqual(telemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' }, 'svc'), { enabled: false });
  const enabled = telemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com/api/public/otel/',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20c3ludGhldGljOmV4YW1wbGU=,x-extra=1', OTEL_METRICS_EXPORTER: 'none' }, 'course-core-api');
  assert.deepEqual(enabled, { enabled: true, traces: 'https://otel.example.com/api/public/otel/v1/traces', metrics: null,
    headers: { traces: { authorization: 'Basic c3ludGhldGljOmV4YW1wbGU=', 'x-extra': '1' }, metrics: { authorization: 'Basic c3ludGhldGljOmV4YW1wbGU=', 'x-extra': '1' } },
    serviceName: 'course-core-api', metricIntervalMs: 60000,
    spans: { maxQueueSize: 2048, maxExportBatchSize: 512, exportTimeoutMillis: 30000, scheduledDelayMillis: 5000 } });
  const specific = telemetryConfiguration({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:9000/m', OTEL_SERVICE_NAME: 'worker-a' }, 'svc');
  assert.ok(specific.enabled && specific.traces === null && specific.metrics === 'http://localhost:9000/m' && specific.serviceName === 'worker-a');
});
test('the span buffer is bounded by OTEL_BSP_* settings within fixed ranges', () => {
  const tuned = telemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_BSP_MAX_QUEUE_SIZE: '64',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '16', OTEL_BSP_EXPORT_TIMEOUT: '2000', OTEL_BSP_SCHEDULE_DELAY: '250' }, 'svc');
  assert.ok(tuned.enabled);
  assert.deepEqual(tuned.spans, { maxQueueSize: 64, maxExportBatchSize: 16, exportTimeoutMillis: 2000, scheduledDelayMillis: 250 });
  const largest = telemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_BSP_MAX_QUEUE_SIZE: '16384',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '4096', OTEL_BSP_EXPORT_TIMEOUT: '60000' }, 'svc');
  assert.ok(largest.enabled && largest.spans.maxQueueSize === 16384 && largest.spans.exportTimeoutMillis === 60000);
  for (const [name, value] of [['OTEL_BSP_MAX_QUEUE_SIZE', '0'], ['OTEL_BSP_MAX_QUEUE_SIZE', '16385'], ['OTEL_BSP_MAX_QUEUE_SIZE', '1e9'],
    ['OTEL_BSP_MAX_QUEUE_SIZE', 'many'], ['OTEL_BSP_MAX_EXPORT_BATCH_SIZE', '4097'], ['OTEL_BSP_MAX_EXPORT_BATCH_SIZE', '1.5'],
    ['OTEL_BSP_EXPORT_TIMEOUT', '999'], ['OTEL_BSP_EXPORT_TIMEOUT', '600000'], ['OTEL_BSP_SCHEDULE_DELAY', '-1']] as const)
    assert.throws(() => telemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', [name]: value }, 'svc'),
      (error: unknown) => error instanceof TelemetryConfigurationError && error.field === name, `${name}=${value}`);
  // A batch larger than the queue is refused, not silently shrunk.
  assert.throws(() => telemetryConfiguration({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_BSP_MAX_QUEUE_SIZE: '8',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '16' }, 'svc'), (error: unknown) => error instanceof TelemetryConfigurationError && error.field === 'OTEL_BSP_MAX_EXPORT_BATCH_SIZE');
  // Without telemetry, buffer settings are not read at all.
  assert.deepEqual(telemetryConfiguration({ OTEL_BSP_MAX_QUEUE_SIZE: 'many' }, 'svc'), { enabled: false });
});
test('new run, appeal and buffer-loss metrics keep only fixed values', () => {
  assert.deepEqual(sanitizeAttributes({ 'course.supervisor.disposition': 'prepared', 'course.rejection.reason': 'policy_denied',
    'course.appeal.kind': 'gate_review', 'course.appeal.action': 'resolved', 'course.appeal.outcome': 'exception_granted', 'course.telemetry.drop_reason': 'queue_full' }),
  { 'course.supervisor.disposition': 'prepared', 'course.rejection.reason': 'policy_denied', 'course.appeal.kind': 'gate_review',
    'course.appeal.action': 'resolved', 'course.appeal.outcome': 'exception_granted', 'course.telemetry.drop_reason': 'queue_full' });
  assert.deepEqual(sanitizeAttributes({ 'course.supervisor.disposition': learnerText, 'course.rejection.reason': 'PROVIDER_FORBIDDEN',
    'course.appeal.kind': crypto.randomUUID(), 'course.appeal.outcome': 'met', 'course.telemetry.drop_reason': 'unknown', 'enrollment.id': crypto.randomUUID() }), {});
  // No learner, enrollment, job or event identifier is an attribute of any metric.
  for (const definition of Object.values(METRICS)) for (const key of definition.attributes) assert.doesNotMatch(key, /learner|user|enrollment|event_id|job_id|attempt|trace/);
});
test('invalid telemetry settings fail closed with only the variable name', () => {
  for (const env of [
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example.com:4318' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:password@example.com' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com/?key=secret' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_TRACES_EXPORTER: 'console' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: 'broken' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_EXPORTER_OTLP_HEADERS: 'a=%0d%0aInjected: 1' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_SERVICE_NAME: learnerText },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_METRIC_EXPORT_INTERVAL: '10' },
    { OTEL_SDK_DISABLED: 'maybe' },
    { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', OTEL_BSP_MAX_QUEUE_SIZE: '1000000' },
  ]) {
    assert.throws(() => telemetryConfiguration(env, 'svc'), (error: unknown) => error instanceof TelemetryConfigurationError
      && !error.message.includes('secret') && /^invalid_telemetry_configuration:OTEL_[A-Z_]+$/.test(error.message), JSON.stringify(env));
  }
});
test('disabled telemetry loads no SDK, injects no headers and exports nothing', async () => {
  const receiver = await otlpReceiver();
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-worker',
      env: { OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url } });
    assert.equal(runtime, disabledTelemetry); assert.equal(telemetry().enabled, false);
    // No trace to link while off, and a carried trace header changes nothing.
    assert.equal(runtime.traceId(), null); assert.equal(runtime.spanBuffer(), null);
    assert.equal(runtime.continueTrace({ traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, () => runtime.traceId()), null);
    assert.equal(await runtime.span('supervisor.activity', {}, async () => runtime.traceId()), null);
    assert.equal((await startTelemetry({ serviceName: 'course-core-worker', env: {} })).enabled, false);
    // The global API remains the no-op implementation: no provider was registered.
    assert.equal(trace.getTracer('probe').startSpan('probe').isRecording(), false);
    const sent: Headers[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(new Headers(init?.headers)); return new Response('{"accepted":true}'); }) as typeof fetch;
    await new HttpHostBridge('http://127.0.0.1:9', 'token', 1000, fetcher).ackOutbox({ eventId: crypto.randomUUID(), kind: 'supervisor.event',
      payload: { eventId: crypto.randomUUID(), enrollmentId: crypto.randomUUID() }, leaseToken: crypto.randomUUID(), attempts: 1 }).catch(() => false);
    await new HttpProviderGateway('http://127.0.0.1:9', 'token', fetcher).availability('supervisor', AbortSignal.timeout(1000)).catch(() => null);
    assert.equal(sent.length, 2);
    for (const headers of sent) { assert.equal(headers.get('traceparent'), null); assert.equal(headers.get('tracestate'), null); }
    const host = new TestHost(), activities = createActivities(host, new TestProvider(), () => ({ signal: new AbortController().signal, heartbeat() {} }));
    await activities.executeCheckpoint(host.ref, 'plan'); await activities.verifyJob(host.ref); await activities.applyJob(host.ref);
    assert.equal(host.snapshot.state, 'applied');
    await telemetry().flush(); await telemetry().shutdown();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(receiver.received.length, 0);
  } finally { await receiver.close(); }
});

test('supervision control effect and reason are allowlisted run metadata', () => {
  assert.deepEqual(sanitizeAttributes({ 'course.supervisor.effect': 'hold', 'course.supervisor.reason': 'supervision_stopped' }),
    { 'course.supervisor.effect': 'hold', 'course.supervisor.reason': 'supervision_stopped' });
});
