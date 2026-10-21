import { z } from 'zod';
import { counter, transportSettingsSchema, type CallOptions, type Operation, type TelemetryEvent,
  type TokenUsage, type TransportSettings, type UsageReceipt } from './contracts.js';
import { classifyHttpError, classifyRetry, ensure, ProviderError, safeError } from './errors.js';
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

export function abortScope(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController(); let timeout = false;
  const forward = () => controller.abort();
  if (parent?.aborted) forward(); else parent?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, timeoutMs);
  return { signal: controller.signal, error: () => new ProviderError(timeout ? 'TIMEOUT' : 'CANCELLED', { submission: 'unknown' }),
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
        const scope = abortScope(total.signal, Math.min(this.settings.attemptTimeoutMs, totalMs));
        const record = { attempt, status: null as number | null, outcome: 'unknown' as const, tokens: emptyTokens() };
        usage.attempts.push(record);
        let failure: ProviderError | undefined;
        const scopeError = () => total.signal.aborted ? total.error() : scope.error();
        try {
          const response = await abortable(() => this.#fetch(`${this.#protocol.origin}${path}`, {
            method, headers: { ...this.#protocol.headers(key), 'Content-Type': 'application/json', Accept: 'application/json' },
            ...(encoded === undefined ? {} : { body: encoded }), signal: scope.signal, redirect: 'error',
          }), scope.signal, scopeError);
          record.status = response.status;
          if (!response.ok) {
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), Date.now());
            const refined = this.#protocol.refineError
              ? this.#protocol.refineError(response.status, await errorBody(response, scope.signal, scopeError), retryAfterMs)
              : (void response.body?.cancel().catch(() => {}), undefined);
            throw refined ?? classifyHttpError(response.status, retryAfterMs);
          }
          const data = await readJson(response, maxBytes, scope.signal, scopeError);
          record.tokens = this.#protocol.tokens(data);
          usage.attempts[usage.attempts.length - 1] = { ...record, outcome: 'response' };
          this.emit(usage.operation, attempt, 'response', response.status, null, start);
          return data;
        } catch (error) {
          const sanitized = safeError(error);
          failure = new ProviderError(sanitized.code, { ...(sanitized.status === null ? {} : { status: sanitized.status }),
            ...(sanitized.retryAfterMs === null ? {} : { retryAfterMs: sanitized.retryAfterMs }),
            submission: sanitized.submission === 'rejected' ? 'rejected' : 'unknown' });
          usage.attempts[usage.attempts.length - 1] = { ...record, outcome: failure.submission === 'rejected' ? 'rejected' : 'unknown' };
          this.emit(usage.operation, attempt, 'error', failure.status, failure.code, start);
        } finally { scope.dispose(); }
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
}

const googleProtocol: JsonProtocol = {
  adapter: 'google', origin: GOOGLE_ORIGIN,
  path: path => /^\/(v1|v1beta)\/(models\/[a-zA-Z0-9._-]+:(generateContent|predictLongRunning)|(?:models\/[a-zA-Z0-9._-]+\/)?operations\/[a-zA-Z0-9_-]+|interactions)$/.test(path),
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
