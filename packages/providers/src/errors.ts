import type { UsageReceipt, VideoJob } from './contracts.js';

export type ErrorCode = 'INVALID_INPUT' | 'INVALID_CONFIG' | 'UNKNOWN_MODEL' | 'CAPABILITY_MISMATCH' | 'ADAPTER_UNAVAILABLE'
  | 'MISSING_CREDENTIAL' | 'AUTHENTICATION' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'THROTTLED'
  | 'UPSTREAM_UNAVAILABLE' | 'UPSTREAM_REJECTED' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED'
  | 'INVALID_RESPONSE' | 'OUTPUT_TOO_LARGE' | 'BLOCKED' | 'INCOMPLETE_OUTPUT' | 'OPERATION_FAILED'
  | 'POLL_LIMIT' | 'SERVER_ONLY';
const messages: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Invalid provider input.', INVALID_CONFIG: 'Invalid provider configuration.', UNKNOWN_MODEL: 'Model is not registered.',
  ADAPTER_UNAVAILABLE: 'The configured provider adapter is not registered.',
  CAPABILITY_MISMATCH: 'Configured model or adapter does not permit this capability.', MISSING_CREDENTIAL: 'Server credential is unavailable.',
  AUTHENTICATION: 'Provider authentication failed.', PERMISSION_DENIED: 'Provider denied permission.', NOT_FOUND: 'Provider resource was not found.',
  THROTTLED: 'Provider throttled the request.', UPSTREAM_UNAVAILABLE: 'Provider is temporarily unavailable.', UPSTREAM_REJECTED: 'Provider rejected the request.',
  NETWORK_ERROR: 'Provider transport failed.', TIMEOUT: 'Provider request timed out.', CANCELLED: 'Local provider request was aborted.',
  INVALID_RESPONSE: 'Provider response failed validation.', OUTPUT_TOO_LARGE: 'Provider output exceeds the configured bound.',
  BLOCKED: 'Provider blocked generation.', INCOMPLETE_OUTPUT: 'Provider output did not finish successfully.', OPERATION_FAILED: 'Remote media operation failed.',
  POLL_LIMIT: 'Bounded polling ended before the remote operation completed.', SERVER_ONLY: 'Provider credentials may only be used on a Node server.',
};

/** No upstream body, URL, header, abort reason, schema diagnostics or cause. */
export class ProviderError extends Error {
  readonly code: ErrorCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly submission: 'not_sent' | 'rejected' | 'unknown';
  usage?: UsageReceipt;
  job?: VideoJob;
  pollUsage?: UsageReceipt[];
  constructor(code: ErrorCode, details: { status?: number; retryAfterMs?: number; submission?: 'not_sent' | 'rejected' | 'unknown' } = {}) {
    super(messages[code]); this.name = 'ProviderError'; this.code = code;
    this.status = details.status ?? null; this.retryAfterMs = details.retryAfterMs ?? null;
    this.submission = details.submission ?? 'not_sent';
  }
  toJSON() { return { name: this.name, code: this.code, message: this.message, status: this.status,
    retryAfterMs: this.retryAfterMs, submission: this.submission }; }
}
export function ensure(condition: unknown, code: ErrorCode = 'INVALID_INPUT'): asserts condition {
  if (!condition) throw new ProviderError(code);
}
export function safeError(error: unknown): ProviderError {
  return error instanceof ProviderError ? error : new ProviderError('NETWORK_ERROR', { submission: 'unknown' });
}
export function classifyHttpError(status: number, retryAfterMs?: number): ProviderError {
  ensure(Number.isInteger(status) && status >= 100 && status <= 599);
  const code: ErrorCode = status === 401 ? 'AUTHENTICATION' : status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND'
    : status === 429 ? 'THROTTLED' : status === 408 || status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_REJECTED';
  return new ProviderError(code, { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    submission: status >= 500 || status === 408 ? 'unknown' : 'rejected' });
}
export function classifyRetry(error: ProviderError, method: 'GET' | 'POST') {
  const transient = ['THROTTLED', 'UPSTREAM_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code);
  return { transient, automaticRetryAllowed: transient && (method === 'GET' || error.code === 'THROTTLED'),
    mayDuplicateGeneration: method === 'POST' && error.submission === 'unknown' };
}
