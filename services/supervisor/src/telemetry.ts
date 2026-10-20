import { randomBytes } from 'node:crypto';
import type { ReadableSpan, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  context, isSpanContextValid, metrics, propagation, trace, ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags,
  type Attributes as OtelAttributes, type Context, type Counter, type Histogram, type Span, type Tracer,
} from '@opentelemetry/api';

/**
 * Optional OpenTelemetry tracing and metrics shared by the Core services.
 *
 * Off by default. It turns on only when standard OTLP environment variables name
 * an endpoint (the local pilot sets them from its `telemetry` configuration key).
 * While off, no SDK module is loaded, no hook is registered by callers that check
 * `enabled`, and nothing is sent anywhere.
 *
 * Privacy: span names, metric names and attributes pass through a fixed allowlist.
 * Every attribute value must match a narrow enum or identifier pattern, so prompts,
 * learner text, answers, credentials, URLs with identifiers, and exception messages
 * cannot be recorded through this module, even by mistake. Unknown keys and values
 * that do not match are dropped.
 */
export type AttributeValue = string | number | boolean;
export type Attributes = Readonly<Record<string, AttributeValue | null | undefined>>;
type Rule = (value: unknown) => boolean;

const oneOf = (...values: readonly (string | boolean)[]): Rule => value => values.includes(value as string);
const matching = (pattern: RegExp): Rule => value => typeof value === 'string' && pattern.test(value);
const integer = (min: number, max: number): Rule => value => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const count = integer(0, 1_000_000_000_000);
const flag: Rule = value => typeof value === 'boolean';
// Identifiers chosen by trusted operator configuration or code, never by learners.
const configId = matching(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const modelId = matching(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/);
const code = matching(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const roles = ['supervisor', 'companion', 'research', 'media', 'reviewer'] as const;
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const ATTRIBUTE_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  'http.request.method': oneOf(...HTTP_METHODS, '_OTHER'),
  // Route templates (`/api/enrollments/:enrollmentId`), never concrete paths or queries.
  'http.route': matching(/^\/[A-Za-z0-9/:_.*-]{0,199}$/),
  'http.response.status_code': integer(100, 599),
  'error.type': code,
  'db.system.name': oneOf('postgresql'),
  'db.operation.name': oneOf('transaction'),
  'course.db.outcome': oneOf('commit', 'rollback'),
  'gen_ai.operation.name': oneOf('generate_content', 'execute_tool'),
  'gen_ai.provider.name': configId,
  'gen_ai.request.model': modelId,
  'gen_ai.usage.input_tokens': count,
  'gen_ai.usage.output_tokens': count,
  'gen_ai.token.type': oneOf('input', 'output'),
  'gen_ai.tool.name': matching(/^[a-z][a-z0-9_]{0,63}$/),
  'course.provider.operation': oneOf('tutor', 'assess', 'research', 'image', 'video_submit', 'video_poll', 'video_cancel'),
  'course.provider.outcome': oneOf('response', 'error'),
  'course.provider.attempts': integer(0, 100),
  'course.provider.access': oneOf('subscription', 'api_key_fallback'),
  'course.usage.total_tokens': count,
  'course.usage.tokens_basis': oneOf('reported', 'reserved_ceiling'),
  'course.cost.estimate_micro_usd': count,
  'course.cost.basis': oneOf('reported', 'reserved_ceiling'),
  // Whether a gateway call ran under an operator price, ran unpriced at the full allowance, or was refused.
  'course.cost.pricing': oneOf('priced', 'unpriced', 'refused'),
  'course.supervisor.role': oneOf(...roles),
  'course.supervisor.activity': oneOf('load_job', 'execute_checkpoint', 'verify_job', 'apply_job', 'halt_job',
    'cross_course_consent', 'cross_course_plan', 'cross_course_observe'),
  // Learner coordinator passes: a fixed status and a count, never learner, course or objective identifiers.
  'course.cross_course.status': oneOf('planned', 'no_consent', 'budget_wait'),
  'course.cross_course.created': integer(0, 100),
  'course.supervisor.checkpoint': matching(/^[a-z][a-z0-9_-]{0,63}$/),
  'course.supervisor.effect': oneOf('invoke', 'retry', 'continue', 'stop', 'hold'),
  'course.supervisor.state': oneOf('queued', 'running', 'waiting', 'verifying', 'ready', 'applied', 'failed', 'cancelled', 'budget_wait',
    'analyzing', 'building', 'evaluating', 'needs_input', 'follow_up_due'),
  'course.supervisor.reason': oneOf('configuration_missing', 'capability_missing', 'provider_uncertain', 'verification_required',
    'verification_rejected', 'stale_revision', 'inactive_enrollment', 'deadline_exceeded', 'attempts_exhausted', 'provider_rejected',
    'budget_exhausted', 'usage_exceeded', 'cancel_requested', 'activity_exhausted', 'supervision_stopped',
    'input_required', 'follow_up_scheduled'),
  'course.supervisor.outcome': oneOf('succeeded', 'not_started', 'uncertain'),
  'course.supervisor.tool_round': integer(0, 64),
  'course.supervisor.tool_outcome': oneOf('ok', 'error'),
  'course.supervisor.cached': flag,
  'course.dispatch.claimed': integer(0, 100),
  'course.dispatch.delivered': integer(0, 100),
  'course.dispatch.deferred': integer(0, 100),
  'course.dispatch.quarantined': integer(0, 100),
  'course.dispatch.failed': integer(0, 100),
  'course.sandbox.status': oneOf('graded', 'timeout', 'output_limit', 'cancelled', 'execution_failed', 'unavailable', 'busy', 'cleanup_failed'),
  'course.sandbox.case_count': integer(0, 10_000),
  'course.sandbox.batches': integer(0, 10_000),
  // Generated-media jobs: fixed states, steps and server-enumerated codes only; never prompts, scripts or IDs.
  'course.media.state': oneOf('requested', 'admitted', 'submitted', 'polling', 'generated', 'under_review', 'approved', 'rejected',
    'attached', 'expired', 'failed', 'cancelled', 'uncertain'),
  'course.media.step': oneOf('admit', 'submit', 'poll', 'review', 'attach', 'revoke', 'cancel', 'expire', 'pass'),
  'course.media.code': matching(/^MEDIA_[A-Z_]{1,58}$/),
  'course.media.claimed': integer(0, 100),
  // Supervisor run accounting: fixed dispositions and rejection reasons, never event payloads or IDs.
  'course.supervisor.disposition': oneOf('prepared', 'coalesced', 'agent_event', 'supervision_stopped', 'inactive', 'policy_denied', 'oversized', 'refused'),
  'course.supervisor.workflow': oneOf('supervisorJob', 'enrollmentSupervisor', 'learnerCoordinator'),
  'course.rejection.reason': oneOf('verification_rejected', 'provider_rejected', 'policy_denied', 'preparation_refused'),
  'course.appeal.kind': oneOf('written_answer', 'gate_review'),
  'course.appeal.action': oneOf('opened', 'resolved'),
  'course.appeal.outcome': oneOf('changed', 'upheld', 'exception_granted'),
  'course.telemetry.drop_reason': oneOf('queue_full', 'export_failed'),
});

/** Fixed span names. HTTP server spans use "METHOD /route/template". */
export const SPAN_NAMES = Object.freeze(['db.transaction', 'provider.call', 'provider.operation', 'supervisor.tool',
  'supervisor.activity', 'supervisor.dispatch', 'supervisor.workflow.start', 'sandbox.grade', 'media.job.step', 'media.job.pass'] as const);
const httpSpanName = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|_OTHER)(?: \/[A-Za-z0-9/:_.*-]{0,199})?$/;
export type SpanName = typeof SPAN_NAMES[number] | `${string} /${string}` | typeof HTTP_METHODS[number] | '_OTHER';

type MetricDefinition = { kind: 'counter' | 'histogram'; unit: string; description: string; attributes: readonly string[]; boundaries?: number[] };
const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60, 120];
const LAG_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 900, 1800, 3600, 21600, 86400];
export const METRICS = Object.freeze({
  'http.server.request.duration': { kind: 'histogram', unit: 's', description: 'Duration of HTTP server requests.',
    attributes: ['http.request.method', 'http.route', 'http.response.status_code', 'error.type'], boundaries: SECONDS },
  'gen_ai.client.operation.duration': { kind: 'histogram', unit: 's', description: 'Duration of provider model calls.',
    attributes: ['gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model', 'course.provider.operation', 'error.type'], boundaries: SECONDS },
  'gen_ai.client.token.usage': { kind: 'histogram', unit: '{token}', description: 'Provider-reported tokens per model call.',
    attributes: ['gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.token.type'],
    boundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304] },
  'course.provider.cost.estimate': { kind: 'counter', unit: '{microUSD}',
    description: 'Application allowance consumed by provider operations. A conservative estimate, not a provider invoice.',
    attributes: ['course.supervisor.role', 'course.cost.basis'] },
  'course.provider.operations': { kind: 'counter', unit: '{operation}', description: 'Provider gateway operations by outcome.',
    attributes: ['course.supervisor.role', 'course.supervisor.outcome', 'error.type', 'course.cost.pricing'] },
  'course.provider.cost.reserved': { kind: 'counter', unit: '{microUSD}',
    description: 'Per-job allowance reserved against the paid-work budgets at admission.',
    attributes: ['course.supervisor.role'] },
  'course.provider.cost.actual': { kind: 'counter', unit: '{microUSD}',
    description: 'Cost computed from provider-reported usage and the operator price version in force. Not a provider invoice.',
    attributes: ['course.supervisor.role', 'gen_ai.request.model'] },
  'course.provider.cost.released': { kind: 'counter', unit: '{microUSD}',
    description: 'Unused reservation returned to the paid-work budgets after reconciliation or a certain non-start.',
    attributes: ['course.supervisor.role'] },
  'course.supervisor.run.outcomes': { kind: 'counter', unit: '{run}', description: 'Supervisor runs that reached a stopping state.',
    attributes: ['course.supervisor.role', 'course.supervisor.state', 'course.supervisor.reason'] },
  'course.supervisor.checkpoint.outcomes': { kind: 'counter', unit: '{checkpoint}', description: 'Supervisor checkpoint executions by provider outcome.',
    attributes: ['course.supervisor.role', 'course.supervisor.outcome', 'course.supervisor.effect'] },
  'course.sandbox.job.duration': { kind: 'histogram', unit: 's', description: 'Duration of isolated sandbox grading jobs.',
    attributes: ['course.sandbox.status'], boundaries: SECONDS },
  'course.media.transitions': { kind: 'counter', unit: '{transition}', description: 'Generated-media job state changes by target state and code.',
    attributes: ['course.media.state', 'course.media.code'] },
  'course.media.cost.reserved': { kind: 'counter', unit: '{microUSD}',
    description: 'Paid-work allowance reserved by admitted media jobs (full per-job allowance). Not a provider invoice.', attributes: [] },
  'course.media.step.duration': { kind: 'histogram', unit: 's', description: 'Duration of one generated-media worker step.',
    attributes: ['course.media.step', 'course.media.state'], boundaries: SECONDS },
  'course.supervisor.event.lag': { kind: 'histogram', unit: 's',
    description: 'Time from a learning event being recorded to the host preparing it for the supervisor (first preparation only).',
    attributes: ['course.supervisor.role', 'course.supervisor.disposition'], boundaries: LAG_SECONDS },
  'course.supervisor.job.retries': { kind: 'counter', unit: '{retry}', description: 'Supervisor checkpoint attempts the host scheduled to run again.',
    attributes: ['course.supervisor.role'] },
  'course.supervisor.rejections': { kind: 'counter', unit: '{rejection}',
    description: 'Supervisor work refused by policy or the host, or whose result was rejected by verification or the provider.',
    attributes: ['course.supervisor.role', 'course.rejection.reason'] },
  'course.appeals': { kind: 'counter', unit: '{appeal}', description: 'Learner appeals (written-answer appeals and gate reviews) opened and resolved.',
    attributes: ['course.appeal.kind', 'course.appeal.action', 'course.appeal.outcome'] },
  'course.telemetry.spans.dropped': { kind: 'counter', unit: '{span}',
    description: 'Finished spans this process could not export: the bounded queue was full, or the collector refused or did not answer.',
    attributes: ['course.telemetry.drop_reason'] },
} satisfies Record<string, MetricDefinition>);
export type MetricName = keyof typeof METRICS;

/** Drops every key that is not allowlisted and every value that does not match its rule. */
export function sanitizeAttributes(input: Attributes | undefined, allowed?: readonly string[]): Record<string, AttributeValue> {
  const output: Record<string, AttributeValue> = {};
  if (!input || typeof input !== 'object') return output;
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (allowed && !allowed.includes(key)) continue;
    const rule = Object.hasOwn(ATTRIBUTE_RULES, key) ? ATTRIBUTE_RULES[key] : undefined;
    if (rule?.(value)) output[key] = value;
  }
  return output;
}
export function safeSpanName(name: string): string {
  return (SPAN_NAMES as readonly string[]).includes(name) || httpSpanName.test(name) ? name : 'course.span';
}
/** A stable, bounded error code. Never an exception message. */
export function errorType(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : '_OTHER';
}
export function httpMethod(method: string): string {
  return (HTTP_METHODS as readonly string[]).includes(method) ? method : '_OTHER';
}

export interface SpanHandle {
  readonly recording: boolean;
  setAttributes(attributes: Attributes): void;
  /** Marks the span failed with a bounded code; no message or stack is recorded. */
  fail(code?: string): void;
}
export interface StartedSpan extends SpanHandle {
  end(): void;
  /** Runs `body` with this span as the active parent. */
  run<T>(body: () => T): T;
}
export type SpanKindName = 'server' | 'client' | 'internal';
export interface SpanOptions {
  kind?: SpanKindName;
  /** Incoming W3C trace headers to continue. Pass only for trusted service-to-service routes. */
  carrier?: Readonly<Record<string, string | string[] | undefined>>;
  /** Create the span only inside an already recording trace (cheap child spans such as DB transactions). */
  childOnly?: boolean;
}
export interface Telemetry {
  readonly enabled: boolean;
  readonly tracing: boolean;
  span<T>(name: SpanName, attributes: Attributes, body: (span: SpanHandle) => Promise<T>, options?: SpanOptions): Promise<T>;
  start(name: SpanName, attributes: Attributes, options?: SpanOptions): StartedSpan;
  /** Adds W3C trace headers for the active span to an outgoing service request. */
  inject(headers: Record<string, string>): void;
  /** Runs `body` in a trace that is explicitly not sampled, e.g. idle polling. */
  unsampled<T>(body: () => T): T;
  /** Runs `body` as a continuation of W3C trace headers carried through trusted infrastructure
   * (a Temporal header written by our own client). Invalid or absent headers run it unchanged. */
  continueTrace<T>(carrier: Readonly<Record<string, string>> | undefined, body: () => T): T;
  /** The active trace's ID (32 lowercase hex) when tracing is on and the active span is valid and
   * sampled; otherwise null. Stored beside domain records so they can be found in the trace backend. */
  traceId(): string | null;
  /** The span export buffer's bounds and loss counts; null when tracing is off. */
  spanBuffer(): SpanBufferStatus | null;
  count(name: MetricName, value: number, attributes?: Attributes): void;
  record(name: MetricName, value: number, attributes?: Attributes): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface SpanBufferStatus {
  readonly maxQueueSize: number;
  readonly maxExportBatchSize: number;
  readonly exportTimeoutMillis: number;
  /** Finished spans waiting in the queue now (never above maxQueueSize). */
  readonly queued: number;
  readonly exported: number;
  readonly dropped: { readonly queueFull: number; readonly exportFailed: number };
}

const noopHandle: StartedSpan = Object.freeze({ recording: false, setAttributes() {}, fail() {}, end() {}, run: <T>(body: () => T) => body() });
export const disabledTelemetry: Telemetry = Object.freeze({
  enabled: false, tracing: false,
  span: <T>(_name: SpanName, _attributes: Attributes, body: (span: SpanHandle) => Promise<T>) => body(noopHandle),
  start: () => noopHandle, inject() {}, unsampled: <T>(body: () => T) => body(), continueTrace: <T>(_carrier: unknown, body: () => T) => body(),
  traceId: () => null, spanBuffer: () => null, count() {}, record() {},
  flush: async () => {}, shutdown: async () => {},
});
let current: Telemetry = disabledTelemetry;
/** The process telemetry runtime; the disabled no-op unless `startTelemetry` enabled it. */
export function telemetry(): Telemetry { return current; }

export type TelemetryConfiguration =
  | { enabled: false }
  | { enabled: true; traces: string | null; metrics: string | null; headers: { traces: Record<string, string>; metrics: Record<string, string> };
    serviceName: string; metricIntervalMs: number; spans: SpanBufferLimits };
/** Bounds of the batch span processor. The queue is the only span memory the process holds. */
export interface SpanBufferLimits { maxQueueSize: number; maxExportBatchSize: number; exportTimeoutMillis: number; scheduledDelayMillis: number }
/** Standard OTEL_BSP_* variables with their defaults and the ranges this project accepts. */
export const SPAN_BUFFER_SETTINGS = Object.freeze({
  maxQueueSize: { name: 'OTEL_BSP_MAX_QUEUE_SIZE', fallback: 2048, min: 1, max: 16_384 },
  maxExportBatchSize: { name: 'OTEL_BSP_MAX_EXPORT_BATCH_SIZE', fallback: 512, min: 1, max: 4096 },
  exportTimeoutMillis: { name: 'OTEL_BSP_EXPORT_TIMEOUT', fallback: 30_000, min: 1_000, max: 60_000 },
  scheduledDelayMillis: { name: 'OTEL_BSP_SCHEDULE_DELAY', fallback: 5_000, min: 100, max: 60_000 },
} satisfies Record<keyof SpanBufferLimits, { name: string; fallback: number; min: number; max: number }>);
export class TelemetryConfigurationError extends Error {
  constructor(readonly field: string) { super(`invalid_telemetry_configuration:${field}`); }
}
function endpoint(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new TelemetryConfigurationError(name); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // Credentials belong in OTEL_EXPORTER_OTLP_HEADERS, never in a URL that may be logged.
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback))
    throw new TelemetryConfigurationError(name);
  return value;
}
function signalUrl(env: NodeJS.ProcessEnv, signal: 'TRACES' | 'METRICS'): string | null {
  const specific = endpoint(env, `OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`);
  if (specific) return specific;
  const base = endpoint(env, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  return base ? `${base.replace(/\/+$/, '')}/v1/${signal.toLowerCase()}` : null;
}
/** W3C baggage-style `name=value,name=value` (values percent-encoded), as the OTLP specification defines. */
function headers(env: NodeJS.ProcessEnv, signal: 'TRACES' | 'METRICS'): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ['OTEL_EXPORTER_OTLP_HEADERS', `OTEL_EXPORTER_OTLP_${signal}_HEADERS`]) {
    const value = env[name]?.trim();
    if (!value) continue;
    const pairs = value.split(',');
    if (value.length > 8192 || pairs.length > 16) throw new TelemetryConfigurationError(name);
    for (const pair of pairs) {
      const index = pair.indexOf('=');
      const key = pair.slice(0, index).trim();
      let decoded: string;
      try { decoded = decodeURIComponent(pair.slice(index + 1).trim()); } catch { throw new TelemetryConfigurationError(name); }
      if (index < 1 || !/^[A-Za-z0-9-]{1,64}$/.test(key) || !decoded || /[\r\n\0]/.test(decoded)) throw new TelemetryConfigurationError(name);
      output[key.toLowerCase()] = decoded;
    }
  }
  return output;
}
function spanBufferLimits(env: NodeJS.ProcessEnv): SpanBufferLimits {
  const limits = {} as SpanBufferLimits;
  for (const [key, setting] of Object.entries(SPAN_BUFFER_SETTINGS) as [keyof SpanBufferLimits, typeof SPAN_BUFFER_SETTINGS[keyof SpanBufferLimits]][]) {
    const raw = env[setting.name]?.trim();
    const value = raw ? Number(raw) : setting.fallback;
    if (!Number.isSafeInteger(value) || value < setting.min || value > setting.max) throw new TelemetryConfigurationError(setting.name);
    limits[key] = value;
  }
  // A batch larger than the queue could never fill; refuse it rather than silently shrink it.
  if (limits.maxExportBatchSize > limits.maxQueueSize) throw new TelemetryConfigurationError('OTEL_BSP_MAX_EXPORT_BATCH_SIZE');
  return limits;
}
function exporterEnabled(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim();
  if (value === undefined || value === '' || value === 'otlp') return true;
  if (value === 'none') return false;
  throw new TelemetryConfigurationError(name);
}
/** Reads only standard OTEL_* variables. Does not connect anywhere. */
export function telemetryConfiguration(env: NodeJS.ProcessEnv, defaultServiceName: string): TelemetryConfiguration {
  const disabled = env.OTEL_SDK_DISABLED?.trim().toLowerCase();
  if (disabled !== undefined && disabled !== '' && disabled !== 'true' && disabled !== 'false') throw new TelemetryConfigurationError('OTEL_SDK_DISABLED');
  if (disabled === 'true') return { enabled: false };
  const traces = exporterEnabled(env, 'OTEL_TRACES_EXPORTER') ? signalUrl(env, 'TRACES') : null;
  const metricsOn = exporterEnabled(env, 'OTEL_METRICS_EXPORTER') ? signalUrl(env, 'METRICS') : null;
  if (!traces && !metricsOn) return { enabled: false };
  // The bundled exporters speak OTLP/HTTP with JSON bodies only.
  for (const name of ['OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL']) {
    const value = env[name]?.trim();
    if (value && value !== 'http/json') throw new TelemetryConfigurationError(name);
  }
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || defaultServiceName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(serviceName)) throw new TelemetryConfigurationError('OTEL_SERVICE_NAME');
  const interval = env.OTEL_METRIC_EXPORT_INTERVAL?.trim() ? Number(env.OTEL_METRIC_EXPORT_INTERVAL) : 60_000;
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 3_600_000) throw new TelemetryConfigurationError('OTEL_METRIC_EXPORT_INTERVAL');
  return { enabled: true, traces, metrics: metricsOn, headers: { traces: headers(env, 'TRACES'), metrics: headers(env, 'METRICS') },
    serviceName, metricIntervalMs: interval, spans: spanBufferLimits(env) };
}

const kinds: Record<SpanKindName, SpanKind> = { server: SpanKind.SERVER, client: SpanKind.CLIENT, internal: SpanKind.INTERNAL };
function handle(span: Span, parent: Context): StartedSpan {
  const active = trace.setSpan(parent, span);
  let ended = false;
  return {
    recording: span.isRecording(),
    setAttributes(attributes) { if (!ended) span.setAttributes(sanitizeAttributes(attributes) as OtelAttributes); },
    fail(failure) {
      if (ended) return;
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', failure && ATTRIBUTE_RULES['error.type']!(failure) ? failure : '_OTHER');
    },
    end() { if (!ended) { ended = true; span.end(); } },
    run: body => context.with(active, body),
  };
}
class EnabledTelemetry implements Telemetry {
  readonly enabled = true;
  readonly tracing: boolean;
  readonly #tracer: Tracer | undefined;
  readonly #counters = new Map<MetricName, Counter>();
  readonly #histograms = new Map<MetricName, Histogram>();
  readonly #shutdown: () => Promise<void>;
  readonly #flush: () => Promise<void>;
  readonly #buffer: (() => SpanBufferStatus) | undefined;
  constructor(tracer: Tracer | undefined, meterReady: boolean, flush: () => Promise<void>, shutdown: () => Promise<void>, buffer?: () => SpanBufferStatus) {
    this.tracing = Boolean(tracer); this.#tracer = tracer; this.#flush = flush; this.#shutdown = shutdown; this.#buffer = buffer;
    if (meterReady) {
      const meter = metrics.getMeter('course-core');
      for (const [name, definition] of Object.entries(METRICS) as [MetricName, MetricDefinition][]) {
        const options = { unit: definition.unit, description: definition.description,
          ...(definition.boundaries ? { advice: { explicitBucketBoundaries: definition.boundaries } } : {}) };
        if (definition.kind === 'counter') this.#counters.set(name, meter.createCounter(name, options));
        else this.#histograms.set(name, meter.createHistogram(name, options));
      }
    }
  }
  start(name: SpanName, attributes: Attributes, options: SpanOptions = {}): StartedSpan {
    if (!this.#tracer) return noopHandle;
    const parent = options.carrier ? propagation.extract(ROOT_CONTEXT, options.carrier) : context.active();
    if (options.childOnly && !trace.getSpan(parent)?.isRecording()) return noopHandle;
    const span = this.#tracer.startSpan(safeSpanName(name), { kind: kinds[options.kind ?? 'internal'], attributes: sanitizeAttributes(attributes) as OtelAttributes }, parent);
    return handle(span, parent);
  }
  async span<T>(name: SpanName, attributes: Attributes, body: (span: SpanHandle) => Promise<T>, options?: SpanOptions): Promise<T> {
    const started = this.start(name, attributes, options);
    try { return await started.run(() => body(started)); }
    catch (error) { started.fail(errorType(error)); throw error; }
    finally { started.end(); }
  }
  inject(headers: Record<string, string>) { if (this.#tracer) propagation.inject(context.active(), headers); }
  unsampled<T>(body: () => T): T {
    if (!this.#tracer) return body();
    const parent = trace.wrapSpanContext({ traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), traceFlags: TraceFlags.NONE });
    return context.with(trace.setSpan(context.active(), parent), body);
  }
  continueTrace<T>(carrier: Readonly<Record<string, string>> | undefined, body: () => T): T {
    if (!this.#tracer || !carrier) return body();
    const remote = propagation.extract(ROOT_CONTEXT, carrier), span = trace.getSpanContext(remote);
    return span && isSpanContextValid(span) ? context.with(remote, body) : body();
  }
  traceId(): string | null {
    if (!this.#tracer) return null;
    const span = trace.getSpanContext(context.active());
    // Never invented: only a real, valid span that the sampler kept (and so may be exported).
    if (!span || !isSpanContextValid(span) || (span.traceFlags & TraceFlags.SAMPLED) === 0) return null;
    return /^[0-9a-f]{32}$/.test(span.traceId) ? span.traceId : null;
  }
  spanBuffer() { return this.#buffer?.() ?? null; }
  count(name: MetricName, value: number, attributes?: Attributes) {
    if (Number.isFinite(value) && value >= 0) this.#counters.get(name)?.add(value, sanitizeAttributes(attributes, METRICS[name].attributes) as OtelAttributes);
  }
  record(name: MetricName, value: number, attributes?: Attributes) {
    if (Number.isFinite(value) && value >= 0) this.#histograms.get(name)?.record(value, sanitizeAttributes(attributes, METRICS[name].attributes) as OtelAttributes);
  }
  flush() { return this.#flush(); }
  shutdown() { return this.#shutdown(); }
}

/**
 * Starts the process telemetry runtime when standard OTEL_* variables enable it.
 * Endpoints and headers come from `env`; the official OTLP/HTTP exporters also read
 * timeout and compression variables from the process. SDK modules load only when enabled.
 */
export async function startTelemetry(options: { serviceName: string; env?: NodeJS.ProcessEnv; notice?: (line: string) => void }): Promise<Telemetry> {
  const configuration = telemetryConfiguration(options.env ?? process.env, options.serviceName);
  if (!configuration.enabled) return current;
  if (current.enabled) throw new Error('telemetry_already_started');
  const [{ resourceFromAttributes }, { W3CTraceContextPropagator }, { AsyncLocalStorageContextManager }] = await Promise.all([
    import('@opentelemetry/resources'), import('@opentelemetry/core'), import('@opentelemetry/context-async-hooks')]);
  // Only these resource attributes are exported; host, process and OTEL_RESOURCE_ATTRIBUTES detectors are not used.
  const resource = resourceFromAttributes({ 'service.name': configuration.serviceName, 'service.namespace': 'course-core' });
  const closers: (() => Promise<void>)[] = [], flushers: (() => Promise<void>)[] = [];
  let tracer: Tracer | undefined, buffer: (() => SpanBufferStatus) | undefined;
  let runtime: EnabledTelemetry | undefined;
  if (configuration.traces) {
    const [{ BasicTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, { ExportResultCode }] = await Promise.all([
      import('@opentelemetry/sdk-trace-base'), import('@opentelemetry/exporter-trace-otlp-http'), import('@opentelemetry/core')]);
    const limits = configuration.spans, notice = options.notice ?? (line => { process.stderr.write(line); });
    const tally = { queued: 0, exported: 0, queueFull: 0, exportFailed: 0 }, lastNotice = { queue_full: 0, export_failed: 0 };
    // Lost spans are counted, never silent: a metric, and at most one stderr line a minute per reason.
    const dropped = (reason: 'queue_full' | 'export_failed', spans: number) => {
      if (reason === 'queue_full') tally.queueFull += spans; else tally.exportFailed += spans;
      runtime?.count('course.telemetry.spans.dropped', spans, { 'course.telemetry.drop_reason': reason });
      const now = Date.now();
      if (now - lastNotice[reason] >= 60_000) {
        lastNotice[reason] = now;
        try { notice(`${JSON.stringify({ code: 'telemetry_spans_dropped', reason, total: reason === 'queue_full' ? tally.queueFull : tally.exportFailed })}\n`); }
        catch { /* never fail an operation for a notice */ }
      }
    };
    // Timeouts are explicit so the exporter cannot inherit a longer process-wide OTEL_EXPORTER_OTLP_TIMEOUT.
    const exporter = new OTLPTraceExporter({ url: configuration.traces, headers: configuration.headers.traces, timeoutMillis: limits.exportTimeoutMillis });
    const counted: SpanExporter = {
      export(spans, done) {
        // The batch processor has just taken these spans out of its queue.
        tally.queued = Math.max(0, tally.queued - spans.length);
        exporter.export(spans, result => {
          if (result.code === ExportResultCode.SUCCESS) tally.exported += spans.length; else dropped('export_failed', spans.length);
          done(result);
        });
      },
      shutdown: () => exporter.shutdown(),
      forceFlush: () => exporter.forceFlush(),
    };
    // Every limit is passed explicitly, so ambient OTEL_BSP_* values outside the accepted ranges are never read.
    const batch = new BatchSpanProcessor(counted, { ...limits });
    let closed = false;
    const processor: SpanProcessor = {
      onStart: (span, parent) => batch.onStart(span, parent),
      onEnd(span: ReadableSpan) {
        // Mirrors the processor's own rule: a sampled span is queued unless the queue is full, then it is dropped.
        if (!closed && (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0) {
          if (tally.queued >= limits.maxQueueSize) dropped('queue_full', 1); else tally.queued += 1;
        }
        batch.onEnd(span);
      },
      forceFlush: () => batch.forceFlush(),
      shutdown: () => { closed = true; return batch.shutdown(); },
    };
    buffer = () => ({ maxQueueSize: limits.maxQueueSize, maxExportBatchSize: limits.maxExportBatchSize, exportTimeoutMillis: limits.exportTimeoutMillis,
      queued: tally.queued, exported: tally.exported, dropped: { queueFull: tally.queueFull, exportFailed: tally.exportFailed } });
    const provider = new BasicTracerProvider({ resource, spanProcessors: [processor] });
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(provider);
    tracer = trace.getTracer('course-core');
    flushers.push(() => provider.forceFlush()); closers.push(() => provider.shutdown());
  }
  if (configuration.metrics) {
    const [{ MeterProvider, PeriodicExportingMetricReader }, { OTLPMetricExporter }] = await Promise.all([
      import('@opentelemetry/sdk-metrics'), import('@opentelemetry/exporter-metrics-otlp-http')]);
    const provider = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({
      // Explicit exporter timeout (the OTLP default is 10 s) so shutdown with a collector down stays short.
      exporter: new OTLPMetricExporter({ url: configuration.metrics, headers: configuration.headers.metrics, timeoutMillis: Math.min(10_000, configuration.metricIntervalMs) }),
      exportIntervalMillis: configuration.metricIntervalMs,
      exportTimeoutMillis: Math.min(30_000, configuration.metricIntervalMs) })] });
    metrics.setGlobalMeterProvider(provider);
    flushers.push(() => provider.forceFlush()); closers.push(() => provider.shutdown());
  }
  let stopped = false;
  runtime = new EnabledTelemetry(tracer, Boolean(configuration.metrics),
    async () => { await Promise.allSettled(flushers.map(flush => flush())); },
    async () => {
      if (stopped) return; stopped = true;
      // Export failures never fail or delay a learner, supervisor or provider operation beyond shutdown.
      await Promise.allSettled(closers.map(close => close()));
      trace.disable(); metrics.disable(); propagation.disable(); context.disable();
      if (current === runtime) current = disabledTelemetry;
    }, buffer);
  current = runtime;
  return runtime;
}
