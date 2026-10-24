import { afterEach, describe, expect, it, vi } from "vitest";
import { installHostWatchdog } from "../browser/host-watchdog.js";

const pool = { totalCount: 8, idleCount: 0, waitingCount: 3 };
afterEach(() => vi.useRealTimers());

describe("browser test host watchdog", () => {
  it("ends the host with a diagnostic when /health stops answering", async () => {
    vi.useFakeTimers();
    const log = vi.fn(), exit = vi.fn();
    const watchdog = installHostWatchdog({ health: () => new Promise(() => {}) }, pool, {
      probeEveryMs: 1_000, probeTimeoutMs: 3_000, stallWarnMs: 60_000, log, exit, processHandlers: false,
    });
    watchdog.requestStarted("r1", "POST", "/api/enrollments/e/answers?token=secret");
    await vi.advanceTimersByTimeAsync(3_900);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const line = log.mock.calls.at(-1)![0] as string;
    expect(line).toContain("FAILED: /health did not answer within 3000 ms");
    expect(line).toContain('"inFlight":1');
    expect(line).toContain('"path":"/api/enrollments/e/answers"');
    expect(line).toContain('"waiting":3');
    // The query string (which can carry a sign-in token) is never logged.
    expect(line).not.toContain("secret");
    // Once failed, it stays quiet.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("ends the host when /health answers with an error or throws, and keeps running while it answers 200", async () => {
    vi.useFakeTimers();
    const exit = vi.fn(), log = vi.fn();
    const healthy = installHostWatchdog({ health: async () => ({ statusCode: 200 }) }, pool, { probeEveryMs: 1_000, log, exit, processHandlers: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).not.toHaveBeenCalled();
    healthy.stop();
    const failing = installHostWatchdog({ health: async () => ({ statusCode: 503 }) }, pool, { probeEveryMs: 1_000, log, exit, processHandlers: false });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.at(-1)![0]).toContain("/health answered 503");
    failing.stop();
    const throwing = installHostWatchdog({ health: async () => { throw new Error("pool closed"); } }, pool, { probeEveryMs: 1_000, log, exit, processHandlers: false });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(log.mock.calls.at(-1)![0]).toMatch(/FAILED: \/health failed[\s\S]*pool closed/);
    throwing.stop();
  });

  it("logs a blocked event loop, and an unhandled rejection ends the host with its stack", async () => {
    const log = vi.fn(), exit = vi.fn();
    const watchdog = installHostWatchdog({ health: async () => ({ statusCode: 200 }) }, pool, {
      probeEveryMs: 60_000, stallWarnMs: 200, log, exit, processHandlers: false,
    });
    // Block the loop for longer than the warning threshold, just before the next 1 s tick.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const until = Date.now() + 700;
    while (Date.now() < until) { /* busy */ }
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(log.mock.calls.some(([line]) => /event loop was blocked for \d+ ms/.test(line as string))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    watchdog.fail("unhandled promise rejection", new Error("lost answer"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.at(-1)![0]).toMatch(/FAILED: unhandled promise rejection[\s\S]*Error: lost answer/);
  });

  it("listens for unhandled errors process-wide and stops listening when stopped", () => {
    const before = process.listenerCount("unhandledRejection");
    const watchdog = installHostWatchdog({ health: async () => ({ statusCode: 200 }) }, pool, { log: vi.fn(), exit: vi.fn() });
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    watchdog.stop();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
