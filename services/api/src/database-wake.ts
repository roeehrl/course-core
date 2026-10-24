import pg from 'pg';
import { connectionErrorCode, type Database } from './database.js';

/** Channels raised at COMMIT by migration triggers (115_streamed_replies.sql). */
export type WakeChannel = 'course_outbox' | 'course_events';
const CHANNELS: readonly WakeChannel[] = ['course_outbox', 'course_events'];
type Listener = (payload: string) => void;

/**
 * One LISTEN connection per server for wake-ups delivered when a transaction commits: new
 * supervisor work (the dispatcher's long poll) and new learning events of an enrollment (open
 * event streams). It only shortens waits; every waiter keeps its own timeout, so a lost
 * connection or a missed notification costs at most the old poll interval. Connects on first
 * use and reconnects with backoff; errors are logged as codes only.
 */
export class DatabaseWake {
  private client: pg.Client | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private retryMs = 500;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Map<WakeChannel, Set<Listener>>();
  private readonly sequences = new Map<WakeChannel, number>();
  constructor(private readonly options: pg.ClientConfig) {}
  static forDatabase(db: Database) { return new DatabaseWake({ ...db.options } as pg.ClientConfig); }
  /** Whether notifications are currently being received (waits are timeouts only otherwise). */
  get listening() { return this.client !== null; }
  private start() {
    if (this.closed || this.client || this.connecting) return this.connecting ?? Promise.resolve();
    const client = new pg.Client(this.options);
    this.connecting = (async () => {
      try {
        client.on('error', error => this.lost(client, error));
        client.on('notification', message => {
          if (!(CHANNELS as readonly string[]).includes(message.channel)) return;
          this.sequences.set(message.channel as WakeChannel, this.sequence(message.channel as WakeChannel) + 1);
          for (const listener of this.listeners.get(message.channel as WakeChannel) ?? []) try { listener(message.payload ?? ''); } catch { /* a waiter's own problem */ }
        });
        await client.connect();
        for (const channel of CHANNELS) await client.query(`LISTEN ${channel}`);
        if (this.closed) { await client.end().catch(() => undefined); return; }
        this.client = client; this.retryMs = 500;
      } catch (error) { this.lost(client, error); }
      finally { this.connecting = null; }
    })();
    return this.connecting;
  }
  private lost(client: pg.Client, error: unknown) {
    if (this.client === client) this.client = null;
    void client.end().catch(() => undefined);
    if (this.closed) return;
    process.stderr.write(`${JSON.stringify({ event: 'db.wake_listener_lost', code: connectionErrorCode(error) })}\n`);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.start(), this.retryMs);
    this.timer.unref();
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }
  /** Calls `listener` for each notification on `channel` until the returned function is called. */
  subscribe(channel: WakeChannel, listener: Listener): () => void {
    void this.start();
    const set = this.listeners.get(channel) ?? new Set<Listener>();
    set.add(listener); this.listeners.set(channel, set);
    return () => { set.delete(listener); };
  }
  /** Resolves true at the first matching notification, false after `ms` or when `signal` aborts. */
  wait(channel: WakeChannel, ms: number, options: { match?: (payload: string) => boolean; signal?: AbortSignal } = {}): Promise<boolean> {
    return new Promise(resolve => {
      let done = false;
      const finish = (woke: boolean) => {
        if (done) return; done = true;
        clearTimeout(timer); unsubscribe(); options.signal?.removeEventListener('abort', aborted);
        resolve(woke);
      };
      const aborted = () => finish(false);
      const unsubscribe = this.subscribe(channel, payload => { if (!options.match || options.match(payload)) finish(true); });
      const timer = setTimeout(() => finish(false), ms);
      if (options.signal?.aborted) finish(false); else options.signal?.addEventListener('abort', aborted, { once: true });
    });
  }
  /** How many notifications this process has received on `channel`. */
  sequence(channel: WakeChannel) { return this.sequences.get(channel) ?? 0; }
  /**
   * The dispatcher's long poll: answers at once when a notification arrived since `after` (a
   * sequence an earlier answer returned; a different value means this process restarted), else
   * at the next notification or after `ms`. `listening` false tells the caller to poll instead.
   */
  async waitAfter(channel: WakeChannel, after: number | null, ms: number, signal?: AbortSignal) {
    const listening = await Promise.race([this.ready(), new Promise<boolean>(resolve => setTimeout(() => resolve(false), Math.min(ms, 2_000)).unref())]);
    if (!listening) return { woke: false, sequence: this.sequence(channel), listening: false };
    if (after !== null && after !== this.sequence(channel)) return { woke: true, sequence: this.sequence(channel), listening: true };
    const woke = await this.wait(channel, ms, signal ? { signal } : {});
    return { woke, sequence: this.sequence(channel), listening: true };
  }
  /** Connects now (startup readiness); resolves whether the listener is up. */
  async ready() { await this.start(); return this.listening; }
  async close() {
    this.closed = true; clearTimeout(this.timer);
    await this.connecting?.catch(() => undefined);
    const client = this.client; this.client = null;
    await client?.end().catch(() => undefined);
  }
}
