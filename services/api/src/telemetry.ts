import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProviderCallObserver } from '@course-core/providers';
import type { DockerSandbox } from '@course-core/sandbox';
import { httpMethod, telemetry, type Attributes, type SpanName, type StartedSpan } from '@course-core/supervisor/telemetry';

export { startTelemetry, telemetry, TelemetryConfigurationError } from '@course-core/supervisor/telemetry';

/**
 * HTTP server spans and request-duration metrics. Registered only when telemetry is
 * enabled, so a disabled API has no extra hooks. Spans name the route template and
 * record method and status only: no URL, query, headers, client address, body or user.
 */
export function registerHttpTelemetry(app: FastifyInstance) {
  const runtime = telemetry();
  if (!runtime.enabled) return;
  const active = new WeakMap<FastifyRequest, { span: StartedSpan; started: bigint; attributes: Attributes }>();
  app.addHook('onRequest', (request, _reply, done) => {
    const method = httpMethod(request.method), route = request.routeOptions.url;
    const attributes = { 'http.request.method': method, 'http.route': route };
    // Trace context is continued only on authenticated service-to-service routes. A browser's
    // `traceparent` starts a new trace here too, but is kept as a span link, so the client's spans
    // and this request can be joined without letting a browser choose the parent or the sampling.
    const service = request.url.startsWith('/v1/');
    const span = runtime.start((route ? `${method} ${route}` : method) as SpanName, attributes, { kind: 'server', ...(service ? { carrier: request.headers } : { link: request.headers }) });
    active.set(request, { span, started: process.hrtime.bigint(), attributes });
    span.run(done);
  });
  const finish = (request: FastifyRequest, status: number | null) => {
    const entry = active.get(request);
    if (!entry) return;
    active.delete(request);
    const failure = status === null ? 'aborted' : status >= 500 ? String(status) : undefined;
    const attributes = { ...entry.attributes, 'http.response.status_code': status, 'error.type': failure };
    entry.span.setAttributes(attributes);
    if (failure) entry.span.fail(failure);
    entry.span.end();
    runtime.record('http.server.request.duration', Number(process.hrtime.bigint() - entry.started) / 1e9, attributes);
  };
  app.addHook('onResponse', (request, reply, done) => { finish(request, reply.statusCode); done(); });
  app.addHook('onRequestAbort', (request, done) => { finish(request, null); done(); });
}

/** Provider model-call spans and GenAI metrics: model ID, provider ID, token counts and outcome code only. */
export const providerCallObserver: ProviderCallObserver = call => {
  const runtime = telemetry();
  if (!runtime.enabled) return;
  const base = { 'gen_ai.operation.name': 'generate_content', 'gen_ai.request.model': call.modelId, 'course.provider.operation': call.operation };
  const span = runtime.start('provider.call', base, { kind: 'client' });
  return end => {
    const attributes = { ...base, 'gen_ai.provider.name': end.providerId, 'gen_ai.usage.input_tokens': end.tokens?.input,
      'gen_ai.usage.output_tokens': end.tokens?.output, 'course.usage.total_tokens': end.tokens?.total, 'course.provider.outcome': end.outcome,
      'course.provider.attempts': end.attempts, 'course.provider.access': end.access };
    span.setAttributes(attributes);
    if (end.outcome === 'error') span.fail(end.code ?? undefined);
    span.end();
    runtime.record('gen_ai.client.operation.duration', end.elapsedMs / 1000, { ...attributes, 'error.type': end.code });
    for (const type of ['input', 'output'] as const) {
      const value = end.tokens?.[type];
      if (typeof value === 'number') runtime.record('gen_ai.client.token.usage', value, { ...attributes, 'gen_ai.token.type': type });
    }
  };
};

/** Wraps sandbox grading with a span and duration metric: status, case and batch counts only. */
export function instrumentSandbox(sandbox: DockerSandbox): DockerSandbox {
  const runtime = telemetry();
  if (!runtime.enabled) return sandbox;
  const grade = sandbox.grade.bind(sandbox);
  sandbox.grade = (input: Parameters<DockerSandbox['grade']>[0]) => runtime.span('sandbox.grade', { 'course.sandbox.case_count': input.cases.length }, async span => {
    const report = await grade(input);
    span.setAttributes({ 'course.sandbox.status': report.status, 'course.sandbox.batches': report.batchesCompleted });
    if (report.status !== 'graded') span.fail(report.status);
    runtime.record('course.sandbox.job.duration', report.durationMs / 1000, { 'course.sandbox.status': report.status });
    return report;
  });
  return sandbox;
}

/** One appeal opened or resolved. Call only after the transaction that recorded it has committed. */
export function countAppeal(kind: 'written_answer' | 'gate_review', action: 'opened' | 'resolved', outcome?: 'changed' | 'upheld' | 'exception_granted') {
  telemetry().count('course.appeals', 1, { 'course.appeal.kind': kind, 'course.appeal.action': action, 'course.appeal.outcome': outcome });
}

/** Marks the active request span with the attempt it recorded and the digest of the artifact that
 * graded it (the course release), so a trace can be found from an attempt and the reverse. Never a
 * digest of the learner's own answer or code: a short answer's plain digest could be guessed. */
export function annotateAttempt(attemptId: string, artifactHash: string) {
  telemetry().annotate({ 'course.attempt.id': attemptId, 'course.artifact.hash': artifactHash });
}
