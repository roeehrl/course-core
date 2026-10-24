// Makes the disposable browser test host fail loudly instead of going quiet. Under heavy load
// the host once stopped answering partway through a run, and every later test then waited
// for its own timeout with nothing in the log to say why. With the watchdog:
// - an unhandled rejection or uncaught exception is logged with its stack and ends the host;
// - an event loop that was blocked for longer than `stallWarnMs` is logged with how long;
// - the host asks itself for /health every `probeEveryMs`; if no answer comes within
//   `probeTimeoutMs` (or the answer is not 200), it logs what it was doing (requests in
//   flight and the oldest of them, database pool use, event-loop delay) and ends with exit
//   code 1, so Playwright reports the web server as gone instead of timing out test by test.
// Test-only: it is imported by browser/start.ts and nothing in the API build.
import { monitorEventLoopDelay } from "node:perf_hooks";

export interface WatchdogApp {
  /** Asks the host for /health in-process (Fastify's inject). */
  health(): PromiseLike<{ statusCode: number }>;
}
export interface WatchdogPool {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}
export interface WatchdogOptions {
  probeEveryMs?: number;
  probeTimeoutMs?: number;
  stallWarnMs?: number;
  /** Where diagnostics go; one line each. */
  log?: (line: string) => void;
  /** Ends the host. Called once. */
  exit?: (code: number) => void;
  /** Whether to listen for process-wide unhandled errors (off in unit tests). */
  processHandlers?: boolean;
}
const defaults = { probeEveryMs: 5_000, probeTimeoutMs: 20_000, stallWarnMs: 2_000 };

export function installHostWatchdog(app: WatchdogApp, pool: WatchdogPool, options: WatchdogOptions = {}) {
  const limits = { ...defaults, ...options };
  const log = options.log ?? ((line: string) => console.error(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const inFlight = new Map<string, { method: string; url: string; since: number }>();
  /** Wired to the host's onRequest/onResponse hooks, so a failure can say what was in flight. */
  const requestStarted = (id: string, method: string, url: string) =>
    // A request URL can carry a sign-in token in its query; only the path is kept.
    inFlight.set(id, { method, url: url.split("?")[0]!, since: Date.now() });
  const requestEnded = (id: string) => inFlight.delete(id);
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const state = () => {
    const oldest = [...inFlight.values()].sort((a, b) => a.since - b.since)[0];
    return {
      inFlight: inFlight.size,
      oldest: oldest ? { method: oldest.method, path: oldest.url, ageMs: Date.now() - oldest.since } : null,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      eventLoopDelayMs: { p99: Math.round(delay.percentile(99) / 1e6), max: Math.round(delay.max / 1e6) },
      memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  };
  let stopped = false;
  const fail = (reason: string, error?: unknown) => {
    if (stopped) return;
    stopped = true;
    stop();
    const detail = error instanceof Error ? error.stack ?? error.message : error === undefined ? undefined : String(error);
    log(`[browser-host] FAILED: ${reason} ${JSON.stringify(state())}${detail ? `\n${detail}` : ""}`);
    exit(1);
  };
  // Blocked event loop: a timer that fires late by more than stallWarnMs.
  let expected = Date.now() + 1_000;
  const tick = setInterval(() => {
    const late = Date.now() - expected;
    expected = Date.now() + 1_000;
    if (late > limits.stallWarnMs) log(`[browser-host] event loop was blocked for ${late} ms ${JSON.stringify(state())}`);
  }, 1_000);
  tick.unref();
  // Self-probe: the same path every browser test depends on (routing, hooks, a database query).
  let probing = false;
  const probe = setInterval(() => {
    if (probing || stopped) return;
    probing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), limits.probeTimeoutMs);
    });
    void Promise.race([Promise.resolve(app.health()), timeout]).then(
      (result) => {
        clearTimeout(timer);
        probing = false;
        if (result === "timeout") fail(`/health did not answer within ${limits.probeTimeoutMs} ms`);
        else if (result.statusCode !== 200) fail(`/health answered ${result.statusCode}`);
      },
      (error: unknown) => {
        clearTimeout(timer);
        probing = false;
        fail("/health failed", error);
      },
    );
  }, limits.probeEveryMs);
  probe.unref();
  const onRejection = (reason: unknown) => fail("unhandled promise rejection", reason);
  const onException = (error: unknown) => fail("uncaught exception", error);
  if (options.processHandlers !== false) {
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
  }
  function stop() {
    clearInterval(tick);
    clearInterval(probe);
    delay.disable();
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
  return { stop, state, fail, requestStarted, requestEnded };
}
