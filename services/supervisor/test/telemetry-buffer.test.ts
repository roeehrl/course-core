import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { startTelemetry, telemetry } from '../src/telemetry.js';
import { otlpReceiver } from './otlp-receiver.js';

// One process-wide runtime at a time: each test starts and shuts down its own.
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
/** A port that refuses connections: bound once, then released. */
async function deadEndpoint() {
  const server = createServer();
  const url = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return url;
}
/** A collector that accepts connections and never answers, until released. */
async function stalledCollector() {
  const sockets = new Set<Socket>(), held: (() => void)[] = [];
  let spans = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try { for (const rs of JSON.parse(Buffer.concat(chunks).toString('utf8')).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) spans += (ss.spans ?? []).length; }
      catch { /* counted as nothing */ }
      held.push(() => response.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const url = await listen(server);
  return { url, spans: () => spans,
    close: async () => { for (const answer of held.splice(0)) answer(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('trace IDs come only from a valid, sampled span', async () => {
  const receiver = await otlpReceiver();
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-worker', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_METRICS_EXPORTER: 'none' } });
    assert.equal(runtime.traceId(), null, 'no active span');
    let inside: string | null = null;
    await runtime.span('supervisor.dispatch', {}, async () => { inside = runtime.traceId(); });
    assert.match(inside ?? '', /^[0-9a-f]{32}$/);
    // Idle polling is explicitly unsampled: nothing to link.
    assert.equal(await runtime.unsampled(() => runtime.span('supervisor.dispatch', {}, async () => runtime.traceId())), null);
    // A continued trace links to the carried trace when it is valid and sampled.
    const carried = '4bf92f3577b34da6a3ce929d0e0e4736';
    assert.equal(runtime.continueTrace({ traceparent: `00-${carried}-00f067aa0ba902b7-01` }, () => runtime.traceId()), carried);
    assert.equal(await runtime.continueTrace({ traceparent: `00-${carried}-00f067aa0ba902b7-01` },
      () => runtime.span('supervisor.activity', {}, async () => runtime.traceId())), carried);
    // Not sampled, malformed, all-zero or absent: never invented.
    assert.equal(runtime.continueTrace({ traceparent: `00-${carried}-00f067aa0ba902b7-00` }, () => runtime.traceId()), null);
    for (const traceparent of ['garbage', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, `00-${carried}-${'0'.repeat(16)}-01`, `00-${carried.toUpperCase()}-00f067aa0ba902b7-01`])
      assert.equal(runtime.continueTrace({ traceparent }, () => runtime.traceId()), null, traceparent);
    assert.equal(runtime.continueTrace(undefined, () => runtime.traceId()), null);
    await runtime.shutdown();
    assert.ok(receiver.spans().some(span => span.traceId === inside));
    assert.equal(telemetry().traceId(), null, 'after shutdown');
  } finally { await receiver.close(); }
});

test('a browser trace context is linked, never adopted; annotations keep only allowlisted ids and digests', async () => {
  const receiver = await otlpReceiver();
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-api', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_METRICS_EXPORTER: 'none' } });
    const browser = '4bf92f3577b34da6a3ce929d0e0e4736', attemptId = '7c9e6679-7425-40de-944b-e07fc1f90ae7', digest = 'a'.repeat(64);
    // Even an unsampled browser context cannot stop recording, and its trace state is never read.
    const linked = runtime.start('GET /api/courses', {}, { kind: 'server', link: { traceparent: `00-${browser}-00f067aa0ba902b7-00`, tracestate: 'vendor=LEAK' } });
    linked.run(() => runtime.annotate({ 'course.attempt.id': attemptId, 'course.artifact.hash': digest, 'course.answer': 'LEAK', 'course.attempt.id ': 'x' }));
    linked.end();
    // Malformed, uppercase, all-zero or repeated headers add no link.
    for (const traceparent of ['garbage', `00-${browser.toUpperCase()}-00f067aa0ba902b7-01`, `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`, [`00-${browser}-00f067aa0ba902b7-01`, 'x']])
      runtime.start('GET /api/courses', {}, { kind: 'server', link: { traceparent } }).end();
    runtime.annotate({ 'course.attempt.id': attemptId });
    await runtime.shutdown();
    const spans = receiver.spans().filter(span => span.name === 'GET /api/courses');
    assert.equal(spans.length, 5);
    const [first, ...rest] = spans as (typeof spans[number] & { links?: { traceId: string; spanId: string; traceState?: string }[] })[];
    assert.notEqual(first!.traceId, browser);
    assert.deepEqual(first!.links?.map(link => [link.traceId, link.spanId, link.traceState ?? '']), [[browser, '00f067aa0ba902b7', '']]);
    assert.deepEqual(first!.attributes, { 'course.client.trace_linked': true, 'course.attempt.id': attemptId, 'course.artifact.hash': digest });
    for (const span of rest) { assert.deepEqual(span.links ?? [], []); assert.deepEqual(span.attributes, {}); }
  } finally { await receiver.close(); }
});

test('the batch processor applies the configured bounds: export batches and queue size', async () => {
  const receiver = await otlpReceiver();
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-worker', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_METRICS_EXPORTER: 'none',
      OTEL_BSP_MAX_QUEUE_SIZE: '40', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '7', OTEL_BSP_SCHEDULE_DELAY: '60000', OTEL_BSP_EXPORT_TIMEOUT: '5000' } });
    for (let i = 0; i < 30; i++) runtime.start('supervisor.dispatch', {}).end();
    await runtime.flush();
    const batches = receiver.received.filter(r => r.path === '/v1/traces').map(r => (r.body.resourceSpans ?? [])
      .flatMap((rs: any) => rs.scopeSpans ?? []).reduce((n: number, ss: any) => n + (ss.spans ?? []).length, 0));
    assert.equal(batches.reduce((a, b) => a + b, 0), 30);
    assert.ok(batches.every(size => size <= 7), `batches ${batches.join(',')}`);
    assert.deepEqual(runtime.spanBuffer(), { maxQueueSize: 40, maxExportBatchSize: 7, exportTimeoutMillis: 5000, queued: 0, exported: 30, dropped: { queueFull: 0, exportFailed: 0 } });
    await runtime.shutdown();
  } finally { await receiver.close(); }
});

test('a stalled collector: memory stays bounded, span ends never wait, overflow is counted and reported', async () => {
  const collector = await stalledCollector(), notices: string[] = [];
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-worker', notice: line => notices.push(line), env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_METRICS_EXPORTER: 'none', OTEL_BSP_MAX_QUEUE_SIZE: '16', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '4', OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_BSP_EXPORT_TIMEOUT: '1000' } });
    const started = performance.now();
    let peak = 0;
    for (let i = 0; i < 5000; i++) {
      await runtime.span('supervisor.activity', { 'course.supervisor.activity': 'load_job' }, async () => {});
      peak = Math.max(peak, runtime.spanBuffer()!.queued);
    }
    const elapsed = performance.now() - started;
    // 5000 spans against a collector that never answers: no span end waited on the network.
    assert.ok(elapsed < 5000, `ended in ${elapsed} ms`);
    assert.ok(peak <= 16, `peak queue ${peak}`);
    const status = runtime.spanBuffer()!;
    assert.ok(status.dropped.queueFull >= 5000 - 16 - 4 * 3, JSON.stringify(status));
    // The collector holds at most the batches already handed to the exporter.
    assert.ok(collector.spans() <= 4 * 3, `collector got ${collector.spans()}`);
    assert.equal(notices.length, 1, 'one notice a minute per reason');
    assert.deepEqual(JSON.parse(notices[0]!), { code: 'telemetry_spans_dropped', reason: 'queue_full', total: 1 });
    // Shutdown is bounded by the export timeout even though the collector never answers.
    const stopping = performance.now();
    await runtime.shutdown();
    assert.ok(performance.now() - stopping < 15_000);
  } finally { await collector.close(); }
});

test('a collector that is down: exports fail fast, are counted, and nothing throws into callers', async () => {
  const notices: string[] = [];
  const runtime = await startTelemetry({ serviceName: 'course-core-worker', notice: line => notices.push(line), env: { OTEL_EXPORTER_OTLP_ENDPOINT: await deadEndpoint(),
    OTEL_METRIC_EXPORT_INTERVAL: '1000', OTEL_BSP_MAX_QUEUE_SIZE: '8', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '4', OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_BSP_EXPORT_TIMEOUT: '1000' } });
  for (let i = 0; i < 6; i++) assert.equal(await runtime.span('supervisor.dispatch', {}, async () => i), i);
  await runtime.flush();
  const deadline = Date.now() + 10_000;
  while (runtime.spanBuffer()!.dropped.exportFailed < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(runtime.spanBuffer(), { maxQueueSize: 8, maxExportBatchSize: 4, exportTimeoutMillis: 1000, queued: 0, exported: 0, dropped: { queueFull: 0, exportFailed: 6 } });
  assert.ok(notices.some(line => JSON.parse(line).reason === 'export_failed'));
  for (const line of notices) assert.deepEqual(Object.keys(JSON.parse(line)), ['code', 'reason', 'total']);
  await runtime.shutdown();
});
