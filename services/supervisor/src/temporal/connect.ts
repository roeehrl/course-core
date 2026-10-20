/** Thrown when Temporal could not be reached before the connection deadline (or a stop signal). */
export class TemporalUnavailableError extends Error {
  constructor(readonly attempts: number, readonly reason: 'deadline' | 'stopped') { super('temporal_unavailable'); }
}
export interface ConnectRetryOptions {
  /** Overall budget for every attempt and wait together. */
  deadlineMs: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before each wait with the failed attempt number and the wait. Never given the error. */
  onRetry?: (attempt: number, delayMs: number) => void;
}

const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener('abort', finish, { once: true });
  if (signal?.aborted) finish();
});

/**
 * First connection to Temporal, retried with doubling waits (capped) until the deadline. Temporal
 * may still be starting when the worker or dispatcher starts, or briefly restarting. The last wait
 * is shortened so no attempt starts after the deadline; then it fails with TemporalUnavailableError.
 * Errors are not inspected or logged: a misconfiguration also ends at the deadline. `connect` gets
 * the remaining budget so it can bound its own attempt; a single attempt may still overrun it.
 */
export async function connectWithRetry<T>(connect: (remainingMs: number) => Promise<T>, options: ConnectRetryOptions): Promise<T> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? abortableSleep;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const deadline = now() + options.deadlineMs;
  let delayMs = options.initialDelayMs ?? 250;
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw new TemporalUnavailableError(attempt - 1, 'stopped');
    try { return await connect(Math.max(deadline - now(), 0)); }
    catch {
      const remaining = deadline - now();
      if (remaining <= 0) throw new TemporalUnavailableError(attempt, 'deadline');
      const wait = Math.min(delayMs, remaining);
      options.onRetry?.(attempt, wait);
      await sleep(wait, options.signal);
      if (options.signal?.aborted) throw new TemporalUnavailableError(attempt, 'stopped');
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }
}
