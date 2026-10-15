import type { UsageReceipt, VideoJob } from './contracts.js';

export type ErrorCode = 'INVALID_INPUT' | 'INVALID_CONFIG' | 'UNKNOWN_MODEL' | 'CAPABILITY_MISMATCH' | 'ADAPTER_UNAVAILABLE'
  | 'MISSING_CREDENTIAL' | 'AUTHENTICATION' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'THROTTLED'
  | 'UPSTREAM_UNAVAILABLE' | 'UPSTREAM_REJECTED' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED'
  | 'INVALID_RESPONSE' | 'OUTPUT_TOO_LARGE' | 'BLOCKED' | 'INCOMPLETE_OUTPUT' | 'OPERATION_FAILED'
  | 'POLL_LIMIT' | 'SERVER_ONLY' | 'SUBSCRIPTION_EXPIRED' | 'SUBSCRIPTION_QUOTA_EXHAUSTED' | 'SUBSCRIPTION_OVERAGE_REQUIRED';
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
  SUBSCRIPTION_EXPIRED: 'Provider subscription has expired.', SUBSCRIPTION_QUOTA_EXHAUSTED: 'Provider subscription allowance is exhausted.',
  SUBSCRIPTION_OVERAGE_REQUIRED: 'This operation requires an additional charge; subscription access did not authorize it.',
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
/**
 * HTTP statuses that both supported providers document as a refusal of the request itself
 * (validation, authentication, permission, billing, unknown model, size, rate limit), so the
 * model did not run and nothing is billed. Every other status after a request was sent,
 * including 408/409/499/5xx/529 and any undocumented 4xx, leaves the outcome unknown.
 * Google: https://ai.google.dev/gemini-api/docs/api-errors and the billing FAQ ("If your
 * request fails with a 400 or 500 error, you won't be charged"); 5xx stay unknown here even
 * so, because a server-side failure or deadline gives no proof that generation did not run.
 * Anthropic: https://platform.claude.com/docs/en/api/errors (no billing statement for errors;
 * 413 is rejected before the request reaches the API servers).
 */
export const DEFINITE_REJECTION_STATUSES: readonly number[] = Object.freeze([400, 401, 402, 403, 404, 413, 429]);
export function classifyHttpError(status: number, retryAfterMs?: number): ProviderError {
  ensure(Number.isInteger(status) && status >= 100 && status <= 599);
  const code: ErrorCode = status === 401 ? 'AUTHENTICATION' : status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND'
    : status === 429 ? 'THROTTLED' : status === 408 || status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_REJECTED';
  return new ProviderError(code, { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    submission: DEFINITE_REJECTION_STATUSES.includes(status) ? 'rejected' : 'unknown' });
}
export interface DefiniteRejection {
  /** The final rejecting status. */
  status: number;
  /** Only a rate limit may succeed later unchanged; the other refusals need an operator fix. */
  retryable: boolean;
  /** The provider's Retry-After hint for a rate limit, when it sent one. */
  retryAfterMs: number | null;
}
/**
 * A failed call whose every attempt the provider refused with a documented rejection status:
 * the model never ran, so nothing was generated or billed and a reservation may be released.
 * Null when any attempt could have reached the model (a response, an unknown outcome, a
 * timeout, a 5xx or 529, an unlisted status) or when the attempts were not recorded.
 */
export function definiteRejection(error: unknown): DefiniteRejection | null {
  if (!(error instanceof ProviderError) || error.submission !== 'rejected' || error.status === null
    || !DEFINITE_REJECTION_STATUSES.includes(error.status)) return null;
  const attempts = error.usage?.attempts ?? [];
  if (!attempts.length || attempts.some(a => a.outcome !== 'rejected' || a.status === null || !DEFINITE_REJECTION_STATUSES.includes(a.status))) return null;
  const retryable = error.code === 'THROTTLED' && error.status === 429;
  return { status: error.status, retryable, retryAfterMs: retryable ? error.retryAfterMs : null };
}
export function classifyRetry(error: ProviderError, method: 'GET' | 'POST') {
  const transient = ['THROTTLED', 'UPSTREAM_UNAVAILABLE', 'NETWORK_ERROR', 'TIMEOUT'].includes(error.code);
  return { transient, automaticRetryAllowed: transient && (method === 'GET' || error.code === 'THROTTLED'),
    mayDuplicateGeneration: method === 'POST' && error.submission === 'unknown' };
}
