import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { RENDERER_ID } from '@course-core/visuals/headless';
import type { CourseManifest } from '@course-core/sdk';
import type { BuildIdentity } from './extension-identity.js';
import type { RuntimeExtension } from './publication.js';
import { checkVisual } from './visual-check.js';

/** A reviewed prior visuals build, bound to the exact server-side headless runtime it was reviewed against. */
export interface ReviewedPriorBuild extends BuildIdentity { readonly headless: string }

/**
 * Prior `course-core-svg-v1` builds still served for already published, pinned courses.
 *
 * 0.1.0 is the build shipped identically with Core v0.1.3 through v0.1.25. 0.1.1 changed
 * only the React client wrapper (dist/react.js); the server-side headless entry and every
 * module it imports, plus the dependency manifest, are byte-identical. Server-side
 * validation and interactive context therefore behave exactly as they did for 0.1.0.
 *
 * Each entry applies only while the installed headless digest equals its `headless`
 * value (see acceptedPriorBuilds), so a later runtime change disables it instead of
 * silently widening it. Values match packages/visuals/released-digests.json. Adding an
 * entry requires the same review. Never add a build whose headless runtime differs.
 */
export const REVIEWED_PRIOR_SVG_BUILDS: readonly ReviewedPriorBuild[] = Object.freeze([
  Object.freeze({
    version: '0.1.0',
    integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24',
    headless: 'sha256-c479f10e2def81707919764494e52a86cbe35ae8b4245af0faff1788d9cc94ea',
  }),
]);

/** Reviewed prior builds that apply to this exact installed build. */
export function acceptedPriorBuilds(reviewed: readonly ReviewedPriorBuild[], installed: BuildIdentity & { headless: string }): readonly BuildIdentity[] {
  return Object.freeze(reviewed
    .filter(build => build.headless === installed.headless && build.version !== installed.version && build.integrity !== installed.integrity)
    .map(({ version, integrity }) => Object.freeze({ version, integrity })));
}

export interface VisualsDigests { version: string; integrity: string; headless: string }

/** The svgRenderer fingerprint of a visuals dist directory, plus its headless-entry digest. */
export async function visualsDistDigests(directory: string, manifest: { version: string; dependencies?: unknown; peerDependencies?: unknown }): Promise<VisualsDigests> {
  const hash = createHash('sha256');
  const files: string[] = [];
  async function collect(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && /\.(?:js|css|json)$/.test(entry.name)) files.push(name);
    }
  }
  await collect('');
  for (const name of files.sort()) hash.update(name.replaceAll(path.sep, '/')).update('\0').update(await readFile(path.join(directory, name))).update('\0');
  hash.update(JSON.stringify({ version: manifest.version, dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies }));

  // headless.js and every dist module it reaches through relative imports.
  const closure = new Set<string>();
  async function follow(name: string) {
    if (closure.has(name)) return;
    closure.add(name);
    const text = await readFile(path.join(directory, name), 'utf8');
    for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*["'](\.\/[^"']+)["']/g))
      await follow(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]!)));
  }
  await follow('headless.js');
  const headless = createHash('sha256');
  for (const name of [...closure].sort()) headless.update(name).update('\0').update(await readFile(path.join(directory, name))).update('\0');
  headless.update(JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies }));
  return { version: manifest.version, integrity: `sha256-${hash.digest('hex')}`, headless: `sha256-${headless.digest('hex')}` };
}

type Visual = CourseManifest['visuals'][number];

/** True when JSON.stringify(value) round-trips to an equal value: plain data only, so a
 * check that passed for the JSON text passed for the value itself. */
function plainJson(value: unknown, depth = 0): boolean {
  if (depth > 256) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !plainJson(value[i], depth + 1)) return false;
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || !descriptor.enumerable || key === 'toJSON') return false;
    if (!plainJson(descriptor.value, depth + 1)) return false;
  }
  return Object.getOwnPropertySymbols(value).length === 0;
}

/** Counters for tests and benchmarks; process-local. */
const statistics = { checks: 0, offloadedChecks: 0, reused: 0 };
export const visualCheckStatistics = () => ({ ...statistics });

const extension = path.extname(fileURLToPath(import.meta.url));
const WORKER = new URL(`./visual-check-worker${extension}`, import.meta.url), CHECK = new URL(`./visual-check${extension}`, import.meta.url).href;
const IDLE_MS = 30_000;

/**
 * A small pool of worker threads running the same checkVisual from the same installed
 * visuals build. It only ever answers "passed" for exact JSON text; anything else (a
 * failed check, a crashed or unavailable worker) answers false and the caller falls back
 * to the in-process check, which decides and reports the error.
 */
class VisualCheckPool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, { json: string; resolve: (passed: boolean) => void }>();
  private queue: { json: string; resolve: (passed: boolean) => void }[] = [];
  private answered = new WeakSet<Worker>();
  private broken = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly size: number) {}

  run(json: string): Promise<boolean> {
    if (this.broken) return Promise.resolve(false);
    return new Promise(resolve => { this.queue.push({ json, resolve }); this.pump(); });
  }
  private spawn(): Worker | undefined {
    let worker: Worker;
    try { worker = new Worker(WORKER, { workerData: { check: CHECK } }); }
    catch { this.disable(); return undefined; }
    worker.unref();
    worker.on('message', (passed: unknown) => { this.answered.add(worker); worker.unref(); this.settle(worker, passed === true); this.idle.push(worker); this.pump(); });
    const lost = () => {
      // A worker that never answered cannot load the check here; stop using the pool.
      if (!this.answered.has(worker)) this.broken = true;
      this.idle = this.idle.filter(row => row !== worker);
      this.settle(worker, false);
      if (this.broken) this.disable(); else this.pump();
    };
    worker.on('error', lost); worker.on('exit', lost);
    return worker;
  }
  private settle(worker: Worker, passed: boolean) {
    const job = this.busy.get(worker);
    this.busy.delete(worker);
    job?.resolve(passed);
  }
  private disable() {
    this.broken = true;
    for (const job of this.queue.splice(0)) job.resolve(false);
    for (const worker of this.idle.splice(0)) void worker.terminate();
  }
  private pump() {
    clearTimeout(this.timer);
    while (this.queue.length && !this.broken) {
      const worker = this.idle.pop() ?? (this.idle.length + this.busy.size < this.size ? this.spawn() : undefined);
      if (!worker) break;
      const job = this.queue.shift()!;
      this.busy.set(worker, job);
      worker.ref(); // keep the process alive while a caller awaits this answer
      worker.postMessage(job.json);
    }
    if (!this.queue.length && !this.busy.size && this.idle.length)
      this.timer = setTimeout(() => { for (const worker of this.idle.splice(0)) void worker.terminate(); }, IDLE_MS).unref();
  }
}
const pool = new VisualCheckPool(Math.max(1, Math.min(4, availableParallelism() - 1)));

/**
 * Visual checks that passed, keyed by SHA-256 of the visual's exact JSON text. A check is a
 * pure function of those bytes and of the installed build, and each renderer instance owns
 * its own record, so a repeated check of identical bytes is skipped. Changed bytes get a
 * different key and are checked in full. Failures are never recorded. Bounded LRU,
 * process-local.
 */
function visualChecks(limit = 4096) {
  const passed = new Map<string, true>(), inflight = new Map<string, Promise<boolean>>();
  const entry = (visual: Visual) => {
    if (!plainJson(visual)) return undefined;
    const json = JSON.stringify(visual);
    return { json, key: createHash('sha256').update(json).digest('hex') };
  };
  const remember = (key: string) => {
    passed.delete(key); passed.set(key, true);
    if (passed.size > limit) passed.delete(passed.keys().next().value!);
  };
  return {
    check(visual: Visual) {
      const row = entry(visual);
      if (row && passed.has(row.key)) { statistics.reused++; remember(row.key); return; }
      statistics.checks++;
      checkVisual(visual);
      if (row) remember(row.key);
    },
    /** Runs pending checks off the event loop, in parallel. Never decides: a failed or
     * unavailable worker leaves the visual to the synchronous check. */
    async prepare(visuals: readonly Visual[]) {
      const pending = new Map<string, string>();
      for (const visual of visuals) {
        const row = entry(visual);
        if (row && !passed.has(row.key)) pending.set(row.key, row.json);
      }
      await Promise.all([...pending].map(async ([key, json]) => {
        let running = inflight.get(key);
        if (!running) {
          running = pool.run(json).then(ok => { if (ok) { statistics.offloadedChecks++; remember(key); } return ok; })
            .finally(() => inflight.delete(key));
          inflight.set(key, running);
        }
        await running;
      }));
    },
  };
}

/** Fingerprint the installed implementation rather than trusting a course-supplied name. */
export async function svgRenderer(): Promise<RuntimeExtension> {
  const entry = fileURLToPath(import.meta.resolve('@course-core/visuals/headless'));
  const directory = path.dirname(entry), packageRoot = path.dirname(directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const installed = await visualsDistDigests(directory, manifest);
  const checks = visualChecks();
  return { id: RENDERER_ID, version: installed.version, integrity: installed.integrity, capabilities: ['visual.render'], platforms: ['web'],
    acceptedPriorBuilds: acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, installed),
    // Parses and runs the scene at both layouts, with and without reduced motion
    // (visual-check.ts). Identical bytes that already passed are not re-run.
    validateVisual: visual => checks.check(visual),
    prepareVisuals: visuals => checks.prepare(visuals),
  };
}
