import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DockerSandbox, GradeReport } from '@course-core/sandbox';
import { instrumentSandbox, providerCallObserver, startTelemetry, telemetry } from '../src/telemetry.js';
import { otlpReceiver } from './otlp-receiver.js';

const SOURCE = 'def learner_solution(): return "Dana Example private attempt"';
let receiver: Awaited<ReturnType<typeof otlpReceiver>>;
beforeAll(async () => {
  receiver = await otlpReceiver();
  await startTelemetry({ serviceName: 'course-core-api', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url } });
});
afterAll(async () => { await telemetry().shutdown(); await receiver.close(); });

it('sandbox and provider-call instrumentation record only status, counts, model and token metadata', async () => {
  const report = (status: GradeReport['status']): GradeReport => ({ status, passed: status === 'graded', cases: [{ id: 'case-1', passed: true, reason: SOURCE }],
    sourceDigest: 'a'.repeat(64), durationMs: 120, executionMs: 20, setupMs: 100, outputBytes: 10, batchesCompleted: 1, runtime: { protocol: 'python-json-v1', image: 'python@sha256:' + 'b'.repeat(64) } });
  let next: GradeReport['status'] = 'graded';
  const sandbox = instrumentSandbox({ grade: async () => report(next) } as unknown as DockerSandbox);
  const input = { source: SOURCE, cases: [{ id: 'case-1', input: SOURCE, expected: SOURCE }] } as unknown as Parameters<DockerSandbox['grade']>[0];
  expect((await sandbox.grade(input)).status).toBe('graded');
  next = 'timeout'; expect((await sandbox.grade(input)).status).toBe('timeout');
  next = 'setup_timeout'; expect((await sandbox.grade(input)).status).toBe('setup_timeout');
  const end = providerCallObserver({ operation: 'tutor', modelId: 'tutor-model' })!;
  end({ outcome: 'error', code: 'THROTTLED', providerId: 'vendor', attempts: 2, tokens: { input: 5, output: null, total: null }, access: 'subscription', elapsedMs: 50 });
  await telemetry().shutdown();
  const spans = receiver.spans();
  const graded = spans.filter(span => span.name === 'sandbox.grade');
  expect(graded.map(span => span.attributes)).toEqual([
    { 'course.sandbox.case_count': 1, 'course.sandbox.status': 'graded', 'course.sandbox.batches': 1 },
    { 'course.sandbox.case_count': 1, 'course.sandbox.status': 'timeout', 'course.sandbox.batches': 1, 'error.type': 'timeout' },
    { 'course.sandbox.case_count': 1, 'course.sandbox.status': 'setup_timeout', 'course.sandbox.batches': 1, 'error.type': 'setup_timeout' },
  ]);
  expect(graded[1]!.status?.code).toBe(2);
  const call = spans.find(span => span.name === 'provider.call')!;
  expect(call.kind).toBe(3);
  expect(call.attributes).toEqual({ 'gen_ai.operation.name': 'generate_content', 'gen_ai.request.model': 'tutor-model', 'course.provider.operation': 'tutor',
    'gen_ai.provider.name': 'vendor', 'gen_ai.usage.input_tokens': 5, 'course.provider.outcome': 'error', 'course.provider.attempts': 2,
    'course.provider.access': 'subscription', 'error.type': 'THROTTLED' });
  const metrics = receiver.metrics().map(metric => metric.name);
  expect(metrics).toEqual(expect.arrayContaining(['course.sandbox.job.duration', 'course.sandbox.setup.duration', 'gen_ai.client.operation.duration', 'gen_ai.client.token.usage']));
  const raw = receiver.received.map(entry => entry.raw).join('\n');
  for (const secret of ['Dana', 'learner_solution', 'private attempt', 'sha256:', 'case-1']) expect(raw.includes(secret), secret).toBe(false);
});
