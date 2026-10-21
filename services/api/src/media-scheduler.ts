import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { MEDIA_CHANNEL, type MediaJobService } from './media-jobs.js';

/**
 * Durable wake-ups for media jobs (O08), in place of a fixed polling interval.
 *
 * Every job keeps its own next due time in the database (`next_attempt_at`: a submission, a
 * provider poll after its interval or Retry-After backoff, a render, a lapsed lease) and every
 * attachment its expiry. The scheduler sleeps until the earliest of them, runs one bounded pass,
 * and computes the next one again. A transaction that makes new work (an admission, a render
 * request, a transition) notifies `course_media_jobs` on commit, which wakes every scheduler at
 * once, in any process. Nothing is kept in memory: after a restart the first pass resumes from the
 * stored due times, and a job whose worker died is picked up when its lease lapses. The longest
 * sleep is bounded, so a missed notification only delays work by `maxSleepMs`.
 */
export interface MediaSchedulerOptions {
  /** Upper bound on one sleep, a backstop for a lost notification or connection. */
  maxSleepMs?: number;
  /** Lower bound between passes, so a burst of notifications cannot spin. */
  minSleepMs?: number;
  /** Jobs per pass. */
  limit?: number;
  now?: () => Date;
  /** A failed pass, as a stable code only (no provider data, scripts or learner content). */
  onError?: (code: string) => void;
}
export interface MediaScheduler { stop(): Promise<void>; nudge(): void; passes(): number }

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'INTERNAL_ERROR';
};

export function startMediaScheduler(db: Database, service: Pick<MediaJobService, 'run' | 'nextDueAt'>, options: MediaSchedulerOptions = {}): MediaScheduler {
  const maxSleepMs = options.maxSleepMs ?? 300_000, minSleepMs = options.minSleepMs ?? 250, limit = options.limit ?? 5;
  if (!Number.isSafeInteger(maxSleepMs) || maxSleepMs < 1_000 || maxSleepMs > 3_600_000 || !Number.isSafeInteger(minSleepMs) || minSleepMs < 10 || minSleepMs > maxSleepMs)
    throw new Error('Invalid media scheduler options.');
  const now = options.now ?? (() => new Date());
  let stopped = false, timer: NodeJS.Timeout | null = null, wake: (() => void) | null = null, listener: PoolClient | null = null, count = 0, pending = false;
  const nudge = () => { pending = true; wake?.(); };
  async function listen() {
    if (stopped || listener) return;
    try {
      const client = await db.connect();
      client.on('notification', (message) => { if (message.channel === MEDIA_CHANNEL) nudge(); });
      // A lost connection falls back to the bounded sleep and reconnects on the next pass.
      client.on('error', () => { if (listener === client) { listener = null; client.release(true); } });
      await client.query(`LISTEN ${MEDIA_CHANNEL}`);
      if (stopped) { client.release(); return; }
      listener = client;
    } catch (error) { options.onError?.(codeOf(error)); }
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    if (pending) { pending = false; resolve(); return; }
    wake = () => { wake = null; pending = false; if (timer) clearTimeout(timer); resolve(); };
    timer = setTimeout(() => { wake = null; resolve(); }, ms);
    timer.unref();
  });
  const loop = (async () => {
    while (!stopped) {
      await listen();
      let next: Date | null = null;
      try {
        pending = false;
        const result = await service.run({ now: now(), limit });
        count++;
        // A full pass may have left more due work: go again at once.
        next = result.claimed >= limit ? now() : await service.nextDueAt();
      } catch (error) { options.onError?.(codeOf(error)); }
      if (stopped) break;
      const until = next ? next.getTime() - now().getTime() : maxSleepMs;
      await sleep(Math.min(maxSleepMs, Math.max(minSleepMs, until)));
    }
  })();
  return {
    passes: () => count,
    nudge,
    async stop() {
      stopped = true; wake?.();
      await loop;
      if (listener) { const client = listener; listener = null; await client.query(`UNLISTEN ${MEDIA_CHANNEL}`).catch(() => undefined); client.release(); }
    },
  };
}
