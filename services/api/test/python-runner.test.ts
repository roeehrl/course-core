import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PYODIDE_FILES, PYODIDE_LICENSE, PYODIDE_VERSION, PYTHON_RUN_LIMITS, loadPyodideAssets, pythonRunnerFromEnvironment } from '../src/python-runner.js';
import { RUNNER_FRAME_SCRIPT, RUNNER_LIMITS_SOURCE, RUNNER_WORKER_SOURCE, runnerFrameContentSecurityPolicy, runnerFrameDocument } from '../src/python-runner-frame.js';

// The exact text the frame runs, evaluated here: these tests exercise the shipped bytes.
type Timers = { set(callback: () => void, ms: number): number; clear(handle: number): void };
interface Watchdog { start(): void; finish(): boolean; active(): boolean }
interface Budget { take(text: string): { text: string; exceeded: boolean }; used(): number; exceeded(): boolean }
const limits = new Function(`${RUNNER_LIMITS_SOURCE}; return { createRunWatchdog, createOutputBudget, boundedInteger };`)() as {
  createRunWatchdog(timeoutMs: number, onExpire: () => void, timers: Timers): Watchdog;
  createOutputBudget(limitBytes: number): Budget;
  boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number): number;
};
function fakeTimers() {
  let now = 0, next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: { set: (callback: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, callback }); return id; }, clear: (id: number) => { pending.delete(id); } } as Timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) if (timer.at <= now) { pending.delete(id); timer.callback(); }
    },
    pending: () => pending.size,
  };
}

describe('run watchdog', () => {
  it('fires once at the wall-clock limit and reports the run as expired', () => {
    const clock = fakeTimers(); let fired = 0;
    const watchdog = limits.createRunWatchdog(5000, () => { fired++; }, clock.timers);
    watchdog.start();
    clock.advance(4999);
    expect(fired).toBe(0);
    expect(watchdog.active()).toBe(true);
    clock.advance(1);
    expect(fired).toBe(1);
    expect(watchdog.active()).toBe(false);
    expect(watchdog.finish()).toBe(false);
    clock.advance(60_000);
    expect(fired).toBe(1);
  });
  it('is cancelled by a run that finishes in time, and a restart gets a fresh full limit', () => {
    const clock = fakeTimers(); let fired = 0;
    const watchdog = limits.createRunWatchdog(1000, () => { fired++; }, clock.timers);
    watchdog.start();
    clock.advance(900);
    expect(watchdog.finish()).toBe(true);
    expect(clock.pending()).toBe(0);
    clock.advance(5000);
    expect(fired).toBe(0);
    watchdog.start();
    clock.advance(600);
    watchdog.start();
    clock.advance(600);
    expect(fired).toBe(0);
    expect(clock.pending()).toBe(1);
    clock.advance(400);
    expect(fired).toBe(1);
  });
  it('clamps host-supplied numbers and ignores anything that is not a safe integer', () => {
    expect(limits.boundedInteger(5, 100, 60_000, 10_000)).toBe(100);
    expect(limits.boundedInteger(10 ** 9, 100, 60_000, 10_000)).toBe(60_000);
    for (const value of ['5000', 1.5, NaN, Infinity, null, undefined, {}]) expect(limits.boundedInteger(value, 100, 60_000, 10_000)).toBe(10_000);
  });
});

describe('output budget', () => {
  it('passes output through until the byte limit, then keeps only what fits', () => {
    const budget = limits.createOutputBudget(10);
    expect(budget.take('hello')).toEqual({ text: 'hello', exceeded: false });
    expect(budget.take('world')).toEqual({ text: 'world', exceeded: false });
    expect(budget.used()).toBe(10);
    expect(budget.take('!')).toEqual({ text: '', exceeded: true });
    expect(budget.exceeded()).toBe(true);
    expect(budget.take('more')).toEqual({ text: '', exceeded: true });
  });
  it('counts UTF-8 bytes and never splits a character', () => {
    const budget = limits.createOutputBudget(7);
    // "é" is 2 bytes and "😀" is 4: 2 + 4 = 6 fits, the next "é" would make 8.
    expect(budget.take('é😀é')).toEqual({ text: 'é😀', exceeded: true });
    expect(budget.used()).toBe(6);
  });
  it('bounds the work done on one huge chunk', () => {
    const budget = limits.createOutputBudget(65_536), huge = 'x'.repeat(20_000_000);
    const started = performance.now();
    const taken = budget.take(huge);
    expect(taken.exceeded).toBe(true);
    expect(taken.text.length).toBe(65_536);
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it('a chunk that lands exactly on the limit is not an overflow', () => {
    const budget = limits.createOutputBudget(4);
    expect(budget.take('abcd')).toEqual({ text: 'abcd', exceeded: false });
    expect(budget.exceeded()).toBe(false);
  });
});

describe('runner frame document', () => {
  const csp = runnerFrameContentSecurityPolicy();
  const directive = (name: string) => csp.split('; ').find(part => part.startsWith(`${name} `));
  it('has an opaque origin, no network and only its own hashed script', () => {
    expect(directive('sandbox')).toBe('sandbox allow-scripts');
    expect(csp).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-top-navigation|allow-modals/);
    expect(directive('connect-src')).toBe("connect-src 'none'");
    expect(directive('default-src')).toBe("default-src 'none'");
    expect(directive('worker-src')).toBe('worker-src blob:');
    for (const name of ['frame-src', 'child-src', 'object-src', 'form-action', 'img-src', 'style-src', 'font-src', 'media-src', 'base-uri'])
      expect(directive(name)).toBe(`${name} 'none'`);
    expect(csp).not.toMatch(/'unsafe-inline'|'unsafe-eval'|https?:|data:|\*/);
    const hash = createHash('sha256').update(RUNNER_FRAME_SCRIPT, 'utf8').digest('base64');
    expect(directive('script-src')).toBe(`script-src 'sha256-${hash}' blob: 'wasm-unsafe-eval'`);
    expect(runnerFrameDocument()).toContain(`<script>${RUNNER_FRAME_SCRIPT}</script>`);
  });
  it('embeds the worker exactly once, as data, and both scripts parse', () => {
    expect(RUNNER_FRAME_SCRIPT).toContain(JSON.stringify(RUNNER_WORKER_SOURCE).replace(/</g, '\\u003c'));
    expect(() => new Function(RUNNER_FRAME_SCRIPT)).not.toThrow();
    expect(() => new Function(RUNNER_WORKER_SOURCE)).not.toThrow();
    expect(RUNNER_FRAME_SCRIPT).not.toMatch(/<\/script|<!--/i);
  });
  it('the worker closes every network and storage route before learner code runs', () => {
    for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel'])
      expect(RUNNER_WORKER_SOURCE).toContain(`"${name}"`);
    expect(RUNNER_WORKER_SOURCE.indexOf('closeNetwork();')).toBeLessThan(RUNNER_WORKER_SOURCE.indexOf('post({ type: "loaded"'));
  });
});

describe('pinned Pyodide files', () => {
  const installed = path.dirname(createRequire(import.meta.url).resolve('pyodide/package.json'));
  it('the installed package is exactly the pinned release', async () => {
    const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'pyodide', version: PYODIDE_VERSION, license: 'MPL-2.0' });
    const assets = await loadPyodideAssets(installed);
    expect(assets.status).toBe('ready');
    if (assets.status !== 'ready') return;
    for (const pin of PYODIDE_FILES) {
      const bytes = assets.files.get(pin.name)!.bytes;
      expect(bytes.length).toBe(pin.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
    }
  });
  it('no code in the process can change the pins, the licence or the default limits', () => {
    const pin = PYODIDE_FILES[0] as { sha256: string; size: number };
    expect(() => { pin.sha256 = 'f'.repeat(64); }).toThrow(TypeError);
    expect(() => { pin.size += 1; }).toThrow(TypeError);
    expect(() => { (PYODIDE_FILES as { name: string; sha256: string; size: number }[]).push({ name: 'extra.js', sha256: 'f'.repeat(64), size: 1 }); }).toThrow(TypeError);
    expect(() => { (PYODIDE_LICENSE as { source: string }).source = 'https://example.org/'; }).toThrow(TypeError);
    expect(() => { (PYTHON_RUN_LIMITS as { timeoutMs: number }).timeoutMs = 0; }).toThrow(TypeError);
    expect(PYODIDE_FILES).toHaveLength(5);
    expect(PYODIDE_FILES.every(file => Object.isFrozen(file))).toBe(true);
  });
  it('refuses a changed byte, a different version or a missing package', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'pyodide-pin-'));
    try {
      const tampered = path.join(scratch, 'tampered'), other = path.join(scratch, 'other');
      await cp(installed, tampered, { recursive: true });
      const lock = path.join(tampered, 'pyodide-lock.json'), text = await readFile(lock, 'utf8');
      await writeFile(lock, text.replace('{', '{ '));
      expect(await loadPyodideAssets(tampered)).toEqual({ status: 'unavailable', reason: 'integrity_mismatch' });
      await cp(installed, other, { recursive: true });
      const manifest = JSON.parse(await readFile(path.join(other, 'package.json'), 'utf8'));
      await writeFile(path.join(other, 'package.json'), JSON.stringify({ ...manifest, version: '0.0.1' }));
      expect(await loadPyodideAssets(other)).toEqual({ status: 'unavailable', reason: 'version_mismatch' });
      expect(await loadPyodideAssets(path.join(scratch, 'absent'))).toEqual({ status: 'unavailable', reason: 'not_installed' });
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});

describe('host configuration', () => {
  it('is on by default and only accepts the documented values', () => {
    expect(pythonRunnerFromEnvironment({})).toEqual({ enabled: true });
    expect(pythonRunnerFromEnvironment({ PYTHON_BROWSER_RUNS: 'disabled' })).toEqual({ enabled: false });
    expect(pythonRunnerFromEnvironment({ PYTHON_BROWSER_RUN_TIMEOUT_MS: '3000' })).toEqual({ enabled: true, timeoutMs: 3000 });
    for (const env of [{ PYTHON_BROWSER_RUNS: 'yes' }, { PYTHON_BROWSER_RUNS: '' }, { PYTHON_BROWSER_RUN_TIMEOUT_MS: '99' }, { PYTHON_BROWSER_RUN_TIMEOUT_MS: '60001' }, { PYTHON_BROWSER_RUN_TIMEOUT_MS: '5e3' }])
      expect(() => pythonRunnerFromEnvironment(env)).toThrow();
  });
});
