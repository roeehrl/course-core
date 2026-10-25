import { z } from 'zod';
import { counter, transportSettingsSchema, type AttemptOutcome, type CallOptions, type Operation, type TelemetryEvent,
  type TokenUsage, type TransportSettings, type UsageReceipt } from './contracts.js';
import { classifyHttpError, classifyRetry, connectionNeverOpened, ensure, ProviderError, safeError, type ErrorCode } from './errors.js';
import { parse } from './validation.js';
import { boundedJson } from './json.js';

export const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com';
export interface TransportOptions {
  getApiKey: () => string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  telemetry?: (event: TelemetryEvent) => void | Promise<void>;
  settings?: Partial<TransportSettings>;
}
export type GoogleTransportOptions = TransportOptions;
export const emptyTokens = (): TokenUsage => ({ input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null });
const usageSchema = z.object({ promptTokenCount: counter.optional(), candidatesTokenCount: counter.optional(), totalTokenCount: counter.optional(),
  cachedContentTokenCount: counter.optional(), thoughtsTokenCount: counter.optional(), toolUsePromptTokenCount: counter.optional() });
export function tokenUsage(input: unknown): TokenUsage {
  if (input === undefined) return emptyTokens();
  const u = parse(usageSchema, input, 'INVALID_RESPONSE');
  return { input: u.promptTokenCount ?? null, output: u.candidatesTokenCount ?? null, total: u.totalTokenCount ?? null,
    cachedInput: u.cachedContentTokenCount ?? null, thoughts: u.thoughtsTokenCount ?? null, toolInput: u.toolUsePromptTokenCount ?? null };
}

const interactionUsageSchema = z.object({ total_input_tokens: counter.optional(), total_output_tokens: counter.optional(),
  total_tokens: counter.optional(), total_cached_tokens: counter.optional(), total_thought_tokens: counter.optional(), total_tool_use_tokens: counter.optional() });
/** Token counters of an Interactions API `usage` object. */
export function interactionUsage(input: unknown): TokenUsage {
  const u = parse(interactionUsageSchema, input, 'INVALID_RESPONSE');
  return { input: u.total_input_tokens ?? null, output: u.total_output_tokens ?? null, total: u.total_tokens ?? null,
    cachedInput: u.total_cached_tokens ?? null, thoughts: u.total_thought_tokens ?? null, toolInput: u.total_tool_use_tokens ?? null };
}

/** An abort scope under `parent` with its own deadline; `code` names what its deadline means. */
export function abortScope(parent: AbortSignal | undefined, timeoutMs: number, code: ErrorCode = 'TIMEOUT') {
  const controller = new AbortController(); let timeout = false;
  const forward = () => controller.abort();
  if (parent?.aborted) forward(); else parent?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, timeoutMs);
  return { signal: controller.signal, error: () => new ProviderError(timeout ? code : 'CANCELLED', { submission: 'unknown' }),
    /** Ends this scope's own deadline; the parent still aborts it. */
    extend: () => clearTimeout(timer),
    dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', forward); } };
}

export async function abortable<T>(run: () => Promise<T>, signal: AbortSignal, error: () => ProviderError): Promise<T> {
  if (signal.aborted) throw error();
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { listener = () => reject(error()); signal.addEventListener('abort', listener, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { if (signal.aborted) throw error(); return run(); }), aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

export function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ProviderError('CANCELLED')); return; }
    const cancel = () => { clearTimeout(timer); reject(new ProviderError('CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.length > 128) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : undefined;
  const ms = seconds === undefined ? Date.parse(value) - nowMs : seconds * 1000;
  return !Number.isNaN(ms) && ms >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(ms)) : undefined;
}

export async function readJson(response: Response, maxBytes: number, signal: AbortSignal, error: () => ProviderError) {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  ensure(contentType === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(contentType ?? ''), 'INVALID_RESPONSE');
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength)) ensure(Number(contentLength) <= maxBytes, 'OUTPUT_TOO_LARGE');
  ensure(response.body, 'INVALID_RESPONSE');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal, error);
      if (done) break;
      size += value.byteLength; ensure(size <= maxBytes, 'OUTPUT_TOO_LARGE'); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let result: unknown;
    try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ProviderError('INVALID_RESPONSE'); }
    boundedJson(result, 'INVALID_RESPONSE');
    ensure(result !== null && typeof result === 'object' && !Array.isArray(result), 'INVALID_RESPONSE');
    return result as Record<string, unknown>;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Accepts only credential-free HTTPS URLs on an approved host list, default port. */
export function approvedDownloadUrl(value: string, hosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('INVALID_RESPONSE'); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname)
    && !/[\u0000-\u0020\u007f]/.test(value), 'INVALID_RESPONSE');
  return url;
}
const videoTypes = new Set(['video/mp4', 'video/webm']);

/** Trusted, code-defined protocol binding. Origin, paths and headers never come from configuration. */
export interface JsonProtocol {
  /** Allowlisted telemetry label; never a URL or account identifier. */
  adapter: 'google' | 'anthropic';
  origin: string;
  path(path: string, method: 'GET' | 'POST'): boolean;
  headers(key: string): Record<string, string>;
  tokens(data: Record<string, unknown>): TokenUsage;
  /** Optional bounded inspection of a JSON error body. It may only pick an allowlisted error
   * code; nothing from the body is kept, logged or returned. */
  refineError?(status: number, body: unknown, retryAfterMs: number | undefined): ProviderError | undefined;
}
const MAX_ERROR_BYTES = 16_384;
async function errorBody(response: Response, signal: AbortSignal, error: () => ProviderError): Promise<unknown> {
  try { return await readJson(response, MAX_ERROR_BYTES, signal, error); }
  catch { void response.body?.cancel().catch(() => {}); return undefined; }
}
/** Retries GET transients and explicit POST throttles; never replays uncertain POSTs. */
export class JsonTransport {
  #key: TransportOptions['getApiKey'];
  #fetch: typeof globalThis.fetch;
  #telemetry: TransportOptions['telemetry'];
  #protocol: JsonProtocol;
  protected readonly settings: TransportSettings;
  constructor(options: TransportOptions, protocol: JsonProtocol) {
    ensure(typeof process !== 'undefined' && Boolean(process.versions?.node) && !('window' in globalThis), 'SERVER_ONLY');
    ensure(typeof options.getApiKey === 'function', 'INVALID_CONFIG');
    this.#key = options.getApiKey; this.#fetch = options.fetch ?? globalThis.fetch; this.#telemetry = options.telemetry;
    this.#protocol = protocol;
    this.settings = parse(transportSettingsSchema, options.settings ?? {}, 'INVALID_CONFIG');
    ensure(this.settings.baseDelayMs <= this.settings.maxDelayMs, 'INVALID_CONFIG');
  }
  protected get fetcher() { return this.#fetch; }
  protected async credential(signal: AbortSignal, error: () => ProviderError): Promise<string> {
    let key: string;
    try { key = await abortable(async () => this.#key(), signal, error); }
    catch { if (signal.aborted) throw error(); throw new ProviderError('MISSING_CREDENTIAL'); }
    ensure(typeof key === 'string' && key.length > 0 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key), 'MISSING_CREDENTIAL');
    return key;
  }
  protected emit(operation: Operation, attempt: number, phase: TelemetryEvent['phase'], status: number | null, code: string | null, start: number, retryDelayMs: number | null = null) {
    // Construct an allowlist event. Never spread caller/provider objects.
    const event: TelemetryEvent = Object.freeze({ adapter: this.#protocol.adapter, operation, attempt, phase, status, code,
      elapsedMs: Math.max(0, Math.round(performance.now() - start)), retryDelayMs });
    try { void Promise.resolve(this.#telemetry?.(event)).catch(() => {}); } catch { /* Telemetry cannot replay or fail a paid operation. */ }
  }
  async request(path: string, method: 'GET' | 'POST', body: unknown, usage: UsageReceipt, maxBytes: number, options: CallOptions): Promise<Record<string, unknown>> {
    ensure(this.#protocol.path(path, method), 'INVALID_INPUT');
    const totalMs = options.timeoutMs ?? this.settings.totalTimeoutMs;
    const total = abortScope(options.signal, totalMs); const start = performance.now();
    try {
      if (total.signal.aborted) throw new ProviderError('CANCELLED');
      const key = await this.credential(total.signal, total.error);
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      for (let attempt = 1; attempt <= this.settings.maxAttempts; attempt++) {
        const attemptMs = Math.min(this.settings.attemptTimeoutMs, totalMs);
        const scope = abortScope(total.signal, attemptMs);
        // A whole reply's first byte is the finished response, so a first-byte bound applies only
        // when the caller set one; it ends as NO_RESPONSE.
        const first = options.firstByteTimeoutMs !== undefined && options.firstByteTimeoutMs < attemptMs
          ? abortScope(scope.signal, options.firstByteTimeoutMs, 'NO_RESPONSE') : null;
        const record = { attempt, status: null as number | null, outcome: 'unknown' as AttemptOutcome, tokens: emptyTokens() };
        usage.attempts.push(record);
        let failure: ProviderError | undefined;
        const scopeError = () => total.signal.aborted ? total.error() : scope.signal.aborted ? scope.error() : first ? first.error() : scope.error();
        const sending = first?.signal ?? scope.signal;
        try {
          const response = await abortable(() => this.#fetch(`${this.#protocol.origin}${path}`, {
            method, headers: { ...this.#protocol.headers(key), 'Content-Type': 'application/json', Accept: 'application/json' },
            ...(encoded === undefined ? {} : { body: encoded }), signal: sending, redirect: 'error',
          }).catch(notOpened), sending, scopeError);
          first?.extend();
          record.status = response.status;
          if (!response.ok) {
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
            const refined = this.#protocol.refineError
              ? this.#protocol.refineError(response.status, await errorBody(response, scope.signal, scopeError), retryAfterMs)
              : (void response.body?.cancel().catch(() => {}), undefined);
            throw refined ?? classifyHttpError(response.status, retryAfterMs);
          }
          const data = await readJson(response, maxBytes, sending, scopeError);
          record.tokens = this.#protocol.tokens(data);
          usage.attempts[usage.attempts.length - 1] = { ...record, outcome: 'response' };
          this.emit(usage.operation, attempt, 'response', response.status, null, start);
          return data;
        } catch (error) {
          const sanitized = safeError(error), unopened = error instanceof NotOpened;
          failure = new ProviderError(sanitized.code, { ...(sanitized.status === null ? {} : { status: sanitized.status }),
            ...(sanitized.retryAfterMs === null ? {} : { retryAfterMs: sanitized.retryAfterMs }),
            submission: sanitized.submission === 'rejected' ? 'rejected' : unopened ? 'not_sent' : 'unknown' });
          usage.attempts[usage.attempts.length - 1] = { ...record, outcome: failure.submission === 'rejected' ? 'rejected' : unopened ? 'not_sent' : 'unknown' };
          this.emit(usage.operation, attempt, 'error', failure.status, failure.code, start);
        } finally { first?.dispose(); scope.dispose(); }
        const retry = classifyRetry(failure!, method);
        if (!retry.automaticRetryAllowed || attempt >= this.settings.maxAttempts || total.signal.aborted) throw failure;
        const backoff = Math.min(this.settings.maxDelayMs, this.settings.baseDelayMs * 2 ** (attempt - 1));
        const delay = Math.max(failure!.retryAfterMs ?? 0, Math.ceil(backoff * (0.5 + Math.random() / 2)));
        if (delay > this.settings.maxDelayMs || performance.now() - start + delay >= totalMs) throw failure;
        this.emit(usage.operation, attempt, 'retry', failure!.status, failure!.code, start, delay);
        await abortable(() => waitAbortable(delay, total.signal), total.signal, total.error);
      }
      throw new ProviderError('UPSTREAM_UNAVAILABLE');
    } catch (error) {
      const safe = safeError(error); safe.usage = structuredClone(usage); throw safe;
    } finally { total.dispose(); }
  }
  /**
   * A streamed POST answered with Server-Sent Events. Retries follow `request` and happen only
   * before any event arrived (an explicit throttle answered with an error status); once the
   * stream has started nothing is ever replayed, and a failure afterwards leaves the outcome
   * unknown. Bounds, each below the total timeout:
   * - first byte (`firstByteTimeoutMs`, at most and by default the attempt timeout): from
   *   sending until the reply's first chunk; ends as NO_RESPONSE.
   * - idle (`idleTimeoutMs`, at most and by default the attempt timeout): between two chunks once
   *   the reply has begun; ends as STREAM_STALLED.
   * - total (`timeoutMs`): the whole stream; ends as TIMEOUT. The caller's signal ends it as CANCELLED.
   * An attempt whose connection never opened is `not_sent`. One that stopped part way after the
   * provider reported its cumulative usage (the sink's counters) is `partial` with that usage;
   * otherwise its outcome is `unknown`.
   */
  async stream(path: string, body: unknown, usage: UsageReceipt, maxBytes: number, options: CallOptions, sink: StreamSink): Promise<void> {
    ensure(this.#protocol.path(path, 'POST'), 'INVALID_INPUT');
    const totalMs = options.timeoutMs ?? this.settings.totalTimeoutMs;
    const total = abortScope(options.signal, totalMs); const start = performance.now();
    try {
      if (total.signal.aborted) throw new ProviderError('CANCELLED');
      const key = await this.credential(total.signal, total.error);
      const encoded = JSON.stringify(body);
      for (let attempt = 1; attempt <= this.settings.maxAttempts; attempt++) {
        const record = { attempt, status: null as number | null, outcome: 'unknown' as AttemptOutcome, tokens: emptyTokens() };
        usage.attempts.push(record);
        let failure: ProviderError | undefined;
        const attemptMs = Math.min(this.settings.attemptTimeoutMs, totalMs);
        // The caller may shorten either bound below the attempt timeout, never lengthen it.
        const firstByteMs = Math.min(options.firstByteTimeoutMs ?? attemptMs, attemptMs), idleMs = Math.min(options.idleTimeoutMs ?? attemptMs, attemptMs);
        const scope = abortScope(total.signal, firstByteMs, 'NO_RESPONSE');
        const scopeError = () => total.signal.aborted ? total.error() : scope.error();
        let began = false;
        try {
          const response = await abortable(() => this.#fetch(`${this.#protocol.origin}${path}`, {
            method: 'POST', headers: { ...this.#protocol.headers(key), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: encoded, signal: scope.signal, redirect: 'error',
          }).catch(notOpened), scope.signal, scopeError);
          record.status = response.status;
          if (!response.ok) {
            scope.extend();
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
            const refined = this.#protocol.refineError
              ? this.#protocol.refineError(response.status, await errorBody(response, total.signal, scopeError), retryAfterMs)
              : (void response.body?.cancel().catch(() => {}), undefined);
            throw refined ?? classifyHttpError(response.status, retryAfterMs);
          }
          // The first chunk ends the first-byte bound; from then on each chunk has the idle bound.
          try { await readEvents(response, maxBytes, idleMs, scope.signal, scopeError, sink, () => { began = true; scope.extend(); }); sink.end?.(); }
          finally { try { record.tokens = sink.tokens(); } catch { /* counters stay unknown */ } }
          usage.attempts[usage.attempts.length - 1] = { ...record, outcome: 'response' };
          this.emit(usage.operation, attempt, 'response', response.status, null, start);
          return;
        } catch (error) {
          const sanitized = safeError(error), unopened = error instanceof NotOpened;
          // Anything after the response began (including a refusal the stream reported) may have run.
          const submission = sanitized.submission === 'rejected' && record.status !== null && record.status >= 400 ? 'rejected' : unopened ? 'not_sent' : 'unknown';
          failure = new ProviderError(sanitized.code, { ...(sanitized.status === null ? {} : { status: sanitized.status }),
            ...(sanitized.retryAfterMs === null ? {} : { retryAfterMs: sanitized.retryAfterMs }), submission });
          const reported = began && record.tokens.input !== null && (record.tokens.output !== null || record.tokens.total !== null);
          usage.attempts[usage.attempts.length - 1] = { ...record,
            outcome: submission === 'rejected' ? 'rejected' : submission === 'not_sent' ? 'not_sent' : reported ? 'partial' : 'unknown' };
          this.emit(usage.operation, attempt, 'error', failure.status, failure.code, start);
        } finally { scope.dispose(); }
        const retry = classifyRetry(failure, 'POST');
        if (!retry.automaticRetryAllowed || failure.submission !== 'rejected' || attempt >= this.settings.maxAttempts || total.signal.aborted) throw failure;
        const backoff = Math.min(this.settings.maxDelayMs, this.settings.baseDelayMs * 2 ** (attempt - 1));
        const delay = Math.max(failure.retryAfterMs ?? 0, Math.ceil(backoff * (0.5 + Math.random() / 2)));
        if (delay > this.settings.maxDelayMs || performance.now() - start + delay >= totalMs) throw failure;
        this.emit(usage.operation, attempt, 'retry', failure.status, failure.code, start, delay);
        await abortable(() => waitAbortable(delay, total.signal), total.signal, total.error);
      }
      throw new ProviderError('UPSTREAM_UNAVAILABLE');
    } catch (error) {
      const safe = safeError(error); safe.usage = structuredClone(usage); throw safe;
    } finally { total.dispose(); }
  }
}

/** A fetch that failed before its connection opened (connectionNeverOpened): nothing was sent. */
class NotOpened extends ProviderError {
  constructor() { super('NETWORK_ERROR', { submission: 'not_sent' }); }
}
function notOpened(error: unknown): never {
  throw connectionNeverOpened(error) ? new NotOpened() : error;
}

/** Receives one parsed Server-Sent Event at a time. `event` throws a ProviderError to end the
 * stream (an invalid chunk or an error event); `end` throws when the stream closed before the
 * provider finished (so the outcome stays unknown); `tokens` reports the attempt's usage once it
 * ended. A refusal is not thrown by the sink: the response is read in full, its usage is known,
 * and the adapter's own checks refuse it afterwards, as for a whole reply. */
export interface StreamSink {
  event(name: string, data: Record<string, unknown>): void;
  end?(): void;
  tokens(): TokenUsage;
}
/** One SSE body read with fixed bounds: total bytes, one event's bytes, and the wait for the next
 * chunk. Each `data:` payload must be bounded JSON. Comments and unknown fields are ignored. */
async function readEvents(response: Response, maxBytes: number, idleMs: number, signal: AbortSignal, error: () => ProviderError, sink: StreamSink, began: () => void) {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  ensure(contentType === 'text/event-stream', 'INVALID_RESPONSE');
  ensure(response.body, 'INVALID_RESPONSE');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, buffer = '', name = 'message', data: string[] = [];
  const dispatch = () => {
    if (data.length) {
      let parsed: unknown;
      try { parsed = JSON.parse(data.join('\n')); } catch { throw new ProviderError('INVALID_RESPONSE'); }
      boundedJson(parsed, 'INVALID_RESPONSE');
      ensure(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'INVALID_RESPONSE');
      sink.event(name, parsed as Record<string, unknown>);
    }
    name = 'message'; data = [];
  };
  const line = (raw: string) => {
    if (raw === '') { dispatch(); return; }
    if (raw.startsWith(':')) return;
    const colon = raw.indexOf(':'), field = colon < 0 ? raw : raw.slice(0, colon);
    const value = colon < 0 ? '' : raw.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') name = value.slice(0, 64);
    else if (field === 'data') data.push(value);
  };
  let first = true;
  try {
    while (true) {
      // Until the first chunk the caller's first-byte bound (on `signal`) applies; then the idle bound.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = first ? null : new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProviderError('STREAM_STALLED', { submission: 'unknown' })), idleMs); });
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await (idle ? Promise.race([abortable(() => reader.read(), signal, error), idle]) : abortable(() => reader.read(), signal, error)); }
      finally { clearTimeout(timer); }
      if (part.done) break;
      if (first) { first = false; began(); }
      size += part.value.byteLength; ensure(size <= maxBytes, 'OUTPUT_TOO_LARGE');
      try { buffer += decoder.decode(part.value, { stream: true }); } catch { throw new ProviderError('INVALID_RESPONSE'); }
      let cut: number;
      while ((cut = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(buffer[cut] === '\r' && buffer[cut + 1] === '\n' ? cut + 2 : cut + 1);
        line(raw);
      }
      // One event (or one line) may not hold more than the response bound allows.
      ensure(buffer.length + data.reduce((n, d) => n + d.length, 0) <= maxBytes, 'OUTPUT_TOO_LARGE');
    }
    if (buffer) line(buffer);
    dispatch();
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const googleProtocol: JsonProtocol = {
  adapter: 'google', origin: GOOGLE_ORIGIN,
  path: path => /^\/(v1|v1beta)\/(models\/[a-zA-Z0-9._-]+:(generateContent|streamGenerateContent\?alt=sse|predictLongRunning)|(?:models\/[a-zA-Z0-9._-]+\/)?operations\/[a-zA-Z0-9_-]+|interactions)$/.test(path),
  headers: key => ({ 'x-goog-api-key': key }),
  // generateContent reports `usageMetadata`; the Interactions API reports `usage`.
  tokens: data => data.usage !== undefined && data.usageMetadata === undefined ? interactionUsage(data.usage) : tokenUsage(data.usageMetadata),
};
export class GoogleTransport extends JsonTransport {
  constructor(options: GoogleTransportOptions) { super(options, googleProtocol); }
  /** Bounded binary GET of a completed clip. The key is sent only to the API origin;
   * each redirect must stay on an approved host and never carries the key. */
  async download(uri: string, hosts: readonly string[], maxBytes: number, usage: UsageReceipt, options: CallOptions): Promise<{ bytes: Uint8Array; mimeType: 'video/mp4' | 'video/webm'; byteLength: number }> {
    const total = abortScope(options.signal, options.timeoutMs ?? this.settings.totalTimeoutMs); const start = performance.now();
    try {
      let url = approvedDownloadUrl(uri, hosts);
      let key: string | undefined;
      for (let hop = 0; hop < 4; hop++) {
        const headers: Record<string, string> = { Accept: 'video/mp4, video/webm' };
        if (url.origin === GOOGLE_ORIGIN) {
          key ??= await this.credential(total.signal, total.error);
          headers['x-goog-api-key'] = key;
        }
        const record = { attempt: usage.attempts.length + 1, status: null as number | null, outcome: 'unknown' as const, tokens: emptyTokens() };
        usage.attempts.push(record);
        const response = await abortable(() => this.fetcher(url.href, { method: 'GET', headers, signal: total.signal, redirect: 'manual' }), total.signal, total.error);
        record.status = response.status;
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => {});
          const location = response.headers.get('location');
          ensure(location && location.length <= 4096, 'INVALID_RESPONSE');
          url = approvedDownloadUrl(new URL(location, url).href, hosts);
          continue;
        }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw classifyHttpError(response.status); }
        const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
        if (!videoTypes.has(mimeType)) { void response.body?.cancel().catch(() => {}); throw new ProviderError('INVALID_RESPONSE'); }
        const length = response.headers.get('content-length');
        if (length && /^\d+$/.test(length) && Number(length) > maxBytes) { void response.body?.cancel().catch(() => {}); throw new ProviderError('OUTPUT_TOO_LARGE'); }
        ensure(response.body, 'INVALID_RESPONSE');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await abortable(() => reader.read(), total.signal, total.error);
            if (done) break;
            size += value.byteLength; ensure(size <= maxBytes, 'OUTPUT_TOO_LARGE'); chunks.push(value);
          }
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        ensure(size > 0, 'INVALID_RESPONSE');
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        usage.attempts[usage.attempts.length - 1] = { ...record, outcome: 'response' };
        this.emit(usage.operation, record.attempt, 'response', response.status, null, start);
        return { bytes, mimeType: mimeType as 'video/mp4' | 'video/webm', byteLength: size };
      }
      throw new ProviderError('INVALID_RESPONSE');
    } catch (error) {
      const safe = safeError(error); safe.usage = structuredClone(usage); throw safe;
    } finally { total.dispose(); }
  }
}
