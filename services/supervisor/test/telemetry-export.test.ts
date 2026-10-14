import test from 'node:test';
import assert from 'node:assert/strict';
import { startTelemetry, telemetry } from '../src/telemetry.js';
import { createActivities } from '../src/activities.js';
import { dispatchOnce } from '../src/outbox.js';
import { HttpHostBridge } from '../src/bridge.js';
import { TestHost, TestProvider } from './fixtures.js';
import { otlpReceiver } from './otlp-receiver.js';

test('enabled telemetry exports allowlisted supervisor spans and metrics and propagates trace context', async () => {
  const receiver = await otlpReceiver();
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-worker', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
      OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=synthetic-collector-value' } });
    assert.ok(runtime.enabled && runtime.tracing && telemetry() === runtime);
    await assert.rejects(startTelemetry({ serviceName: 'again', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url } }), /telemetry_already_started/);

    const host = new TestHost(), provider = new TestProvider();
    const activities = createActivities(host, provider, () => ({ signal: new AbortController().signal, heartbeat() {} }));
    await activities.loadJob(host.ref);
    await activities.executeCheckpoint(host.ref, 'plan'); await activities.verifyJob(host.ref); await activities.applyJob(host.ref);
    assert.equal(host.snapshot.state, 'applied');
    await assert.rejects(activities.executeCheckpoint(host.ref, 'Missing Checkpoint'));

    // Idle polls are unsampled; a poll that claims work is traced.
    const idle = new TestHost(); await dispatchOnce(idle, { start: async () => {} });
    const busy = new TestHost(); busy.events = [busy.outboxEvent()];
    assert.equal((await dispatchOnce(busy, { start: async () => {} })).delivered, 1);

    // Outgoing service calls carry W3C context of the active span; the idle poll is marked not sampled.
    const sent: Headers[] = [];
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => { sent.push(new Headers(init?.headers)); return new Response('[]'); }) as typeof fetch;
    const bridge = new HttpHostBridge('http://127.0.0.1:9', 'token', 1000, fetcher);
    await dispatchOnce(bridge, { start: async () => {} });
    await runtime.span('supervisor.activity', { 'course.supervisor.activity': 'load_job' }, async () => { await bridge.claimOutbox(crypto.randomUUID(), 1, 30000); });
    assert.match(sent[0]!.get('traceparent') ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    assert.match(sent[1]!.get('traceparent') ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await runtime.shutdown();
    assert.equal(telemetry().enabled, false);
    const spans = receiver.spans(), traceExports = receiver.received.filter(r => r.path === '/v1/traces');
    assert.ok(traceExports.length >= 1);
    for (const exported of receiver.received) {
      assert.equal(exported.headers['x-collector-key'], 'synthetic-collector-value');
      assert.match(String(exported.headers['content-type']), /application\/json/);
    }
    const activitySpans = spans.filter(s => s.name === 'supervisor.activity');
    assert.deepEqual(activitySpans.map(s => s.attributes['course.supervisor.activity']).sort(),
      ['apply_job', 'execute_checkpoint', 'execute_checkpoint', 'load_job', 'load_job', 'verify_job']);
    const executed = activitySpans.find(s => s.attributes['course.supervisor.outcome'] === 'succeeded')!;
    assert.deepEqual(executed.attributes, { 'course.supervisor.activity': 'execute_checkpoint', 'course.supervisor.checkpoint': 'plan',
      'course.supervisor.role': 'supervisor', 'course.supervisor.outcome': 'succeeded', 'course.supervisor.state': 'running', 'course.supervisor.effect': 'continue' });
    const failed = activitySpans.find(s => s.status?.code === 2)!;
    assert.deepEqual(failed.attributes, { 'course.supervisor.activity': 'execute_checkpoint', 'error.type': 'invalid_request' });
    assert.equal(failed.status?.message ?? '', '');
    const applied = activitySpans.find(s => s.attributes['course.supervisor.activity'] === 'apply_job')!;
    assert.equal(applied.attributes['course.supervisor.state'], 'applied');
    const dispatch = spans.filter(s => s.name === 'supervisor.dispatch');
    assert.equal(dispatch.length, 1);
    assert.deepEqual(dispatch[0]!.attributes, { 'course.dispatch.claimed': 1, 'course.dispatch.delivered': 1, 'course.dispatch.deferred': 0,
      'course.dispatch.quarantined': 0, 'course.dispatch.failed': 0 });
    // Only the configured resource attributes: no host, process or environment detection.
    for (const span of spans) assert.deepEqual(span.resource, { 'service.name': 'course-core-worker', 'service.namespace': 'course-core' });

    const metrics = receiver.metrics();
    const outcomes = metrics.filter(m => m.name === 'course.supervisor.run.outcomes').flatMap(m => m.points);
    assert.ok(outcomes.some(p => p['course.supervisor.state'] === 'applied' && p['course.supervisor.role'] === 'supervisor'));
    assert.ok(metrics.some(m => m.name === 'course.supervisor.checkpoint.outcomes'));
    // No identifiers of jobs, enrollments or workspaces leave the process.
    const everything = receiver.received.map(r => r.raw).join('\n');
    for (const value of [host.ref.jobId, host.ref.enrollmentId, host.ref.workspaceId, 'token']) assert.ok(!everything.includes(value), value);
  } finally { await telemetry().shutdown(); await receiver.close(); }
});
