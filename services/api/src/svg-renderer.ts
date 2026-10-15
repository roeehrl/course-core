import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { RENDERER_ID } from '@course-core/visuals/headless';
import type { CourseManifest } from '@course-core/sdk';
import type { BuildIdentity } from './extension-identity.js';
import type { RuntimeExtension } from './publication.js';
import { checkVisual } from './visual-check.js';
import { parseManifest, UnidentifiableBuildError, visualsPackageIdentity } from './visuals-identity.js';

/** A released visuals version: the fingerprint courses declare, its package identity, and its reviewed type-only dependencies. */
export interface RecordedSvgRelease extends BuildIdentity { readonly identity: string; readonly typeOnlyDependencies: readonly string[] }

/**
 * Released builds an installed build can be. An installed build is a recorded release only
 * when its package identity (visuals-identity.ts: every dist file and the whole manifest, in
 * key order, minus the pins of that release's reviewed type-only dependencies) equals the
 * recorded one. It then advertises the recorded fingerprint, so moving a type-only pin (the
 * SDK, imported with `import type` only and named by no dist file) changes nothing a course
 * can observe. Values match packages/visuals/released-digests.json, whose test re-derives
 * each legacy fingerprint from the released bytes.
 */
export const RECORDED_SVG_RELEASES: readonly RecordedSvgRelease[] = Object.freeze([
  Object.freeze({
    version: '0.1.1',
    integrity: 'sha256-d64441db68463ba2c62d36d04fc9c60a3378b4a2f783d5f156238b6aa6e2dcd6',
    identity: 'sha256-b1ff5f870feed056129e627dc69c35bac7db725384979f188bf420a67a4416b8',
    typeOnlyDependencies: Object.freeze(['@course-core/sdk']),
  }),
]);

/** A reviewed prior build and the recorded releases reviewed to serve it unchanged on the server. */
export interface ReviewedPriorBuild extends BuildIdentity { readonly headless: string; readonly servedBy: readonly string[] }

/**
 * Prior `course-core-svg-v1` builds still served for already published, pinned courses.
 *
 * 0.1.0 is the build shipped identically with Core v0.1.3 through v0.1.25. 0.1.1 changed
 * only the React client wrapper (dist/react.js); the server-side headless entry and every
 * module it imports are byte-identical (released-digests.json headlessFiles), so server-side
 * validation and interactive context behave exactly as they did for 0.1.0. The learner
 * client never takes renderer code from this install: it bundles its own copy at build time.
 *
 * An entry applies only while the installed build is one of the recorded releases in its
 * `servedBy` list, so any other build disables it instead of silently widening it. Adding
 * an entry or a server requires the same review. `headless` is the recorded legacy digest.
 */
export const REVIEWED_PRIOR_SVG_BUILDS: readonly ReviewedPriorBuild[] = Object.freeze([
  Object.freeze({
    version: '0.1.0',
    integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24',
    headless: 'sha256-c479f10e2def81707919764494e52a86cbe35ae8b4245af0faff1788d9cc94ea',
    servedBy: Object.freeze(['sha256-b1ff5f870feed056129e627dc69c35bac7db725384979f188bf420a67a4416b8']),
  }),
]);

/** What the installed visuals build is. */
export interface InstalledVisualsIdentity extends BuildIdentity {
  /** The recorded release it reproduces, if any. */
  readonly release?: RecordedSvgRelease;
  /** Every dist file's sha256 and the manifest text's sha256, for the check workers to verify what they load. */
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: string;
}

/**
 * The installed build's identity. A recorded release of the same version whose identity it
 * reproduces supplies the fingerprint. Any other build advertises its strict package
 * identity (no relaxation). A build the lint refuses has no identity: this throws
 * UnidentifiableBuildError and the renderer is not served.
 */
export async function installedVisualsIdentity(recorded: readonly RecordedSvgRelease[], directory: string, manifestText: string): Promise<InstalledVisualsIdentity> {
  const { version } = parseManifest(manifestText) as { version?: unknown };
  if (typeof version !== 'string') throw new UnidentifiableBuildError('package.json: no version');
  const manifestDigest = createHash('sha256').update(manifestText).digest('hex');
  for (const release of recorded.filter(build => build.version === version)) {
    let identity;
    try { identity = await visualsPackageIdentity(directory, manifestText, release.typeOnlyDependencies); }
    catch (error) { if (error instanceof UnidentifiableBuildError) continue; throw error; }
    if (identity.identity === release.identity) return Object.freeze({ version, integrity: release.integrity, release, files: Object.freeze(identity.files), manifest: manifestDigest });
  }
  const strict = await visualsPackageIdentity(directory, manifestText);
  return Object.freeze({ version, integrity: strict.identity, files: Object.freeze(strict.files), manifest: manifestDigest });
}

/** Reviewed prior builds that apply to this exact installed build. */
export function acceptedPriorBuilds(reviewed: readonly ReviewedPriorBuild[], installed: Pick<InstalledVisualsIdentity, 'version' | 'integrity' | 'release'>): readonly BuildIdentity[] {
  const release = installed.release;
  if (!release) return Object.freeze([]);
  return Object.freeze(reviewed
    .filter(build => build.servedBy.includes(release.identity) && build.version !== installed.version && build.integrity !== installed.integrity)
    .map(({ version, integrity }) => Object.freeze({ version, integrity })));
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

/** What a check worker must find loaded: the visuals dist directory and each file's sha256 at startup. */
export interface ExpectedVisualsBuild { readonly dist: string; readonly files: Readonly<Record<string, string>>; readonly manifest: string }

/**
 * A small pool of worker threads running the same checkVisual from the same installed
 * visuals build. Each worker verifies, before and again after loading the check, that the
 * visuals package it resolves is the expected directory and that every dist file and the
 * manifest still have the digests computed at startup; otherwise it exits without
 * answering and the pool stops. It only
 * ever answers "passed" for exact JSON text; anything else (a failed check, a refused,
 * crashed or unavailable worker) answers false and the caller falls back to the in-process
 * check, which decides and reports the error.
 */
export class VisualCheckPool {
  private idle: Worker[] = [];
  private busy = new Map<Worker, { json: string; resolve: (passed: boolean) => void }>();
  private queue: { json: string; resolve: (passed: boolean) => void }[] = [];
  private answered = new WeakSet<Worker>();
  private broken = false;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly size: number, private readonly expected: ExpectedVisualsBuild) {}

  run(json: string): Promise<boolean> {
    if (this.broken) return Promise.resolve(false);
    return new Promise(resolve => { this.queue.push({ json, resolve }); this.pump(); });
  }
  private spawn(): Worker | undefined {
    let worker: Worker;
    try { worker = new Worker(WORKER, { workerData: { check: CHECK, dist: this.expected.dist, files: this.expected.files, manifest: this.expected.manifest } }); }
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
const POOL_SIZE = Math.max(1, Math.min(4, availableParallelism() - 1));
const pools = new Map<string, VisualCheckPool>();
/** One pool per installed identity (renderers built for the same install share it). */
const poolFor = (expected: ExpectedVisualsBuild) => {
  const key = JSON.stringify([expected.dist, expected.files, expected.manifest]);
  let pool = pools.get(key);
  if (!pool) pools.set(key, pool = new VisualCheckPool(POOL_SIZE, expected));
  return pool;
};

/**
 * Visual checks that passed, keyed by SHA-256 of the visual's exact JSON text. A check is a
 * pure function of those bytes and of the installed build, and each renderer instance owns
 * its own record, so a repeated check of identical bytes is skipped. Changed bytes get a
 * different key and are checked in full. Failures are never recorded. Bounded LRU,
 * process-local.
 */
function visualChecks(pool: VisualCheckPool, limit = 4096) {
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

/**
 * The identity a visuals dist directory advertises: its version and fingerprint, plus the
 * exact declarations it also serves (reviewed prior builds, and a recorded release's own
 * package identity).
 */
export async function visualsRendererIdentity(directory: string, manifestText: string): Promise<BuildIdentity & { acceptedPriorBuilds: readonly BuildIdentity[]; installed: InstalledVisualsIdentity }> {
  const installed = await installedVisualsIdentity(RECORDED_SVG_RELEASES, directory, manifestText);
  return { version: installed.version, integrity: installed.integrity, installed,
    acceptedPriorBuilds: Object.freeze([...acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, installed),
      ...(installed.release ? [Object.freeze({ version: installed.version, integrity: installed.release.identity })] : [])]) };
}

/**
 * Fingerprint the installed implementation rather than trusting a course-supplied name.
 * The module graph was loaded when this process imported it; the identity is computed from
 * disk right after, and check workers verify that disk still matches before answering. A
 * writer who can swap files between those reads can also rewrite the API itself.
 */
export async function svgRenderer(): Promise<RuntimeExtension> {
  const entry = fileURLToPath(import.meta.resolve('@course-core/visuals/headless'));
  const directory = path.dirname(entry), packageRoot = path.dirname(directory);
  const { version, integrity, acceptedPriorBuilds: accepted, installed } = await visualsRendererIdentity(directory, await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const checks = visualChecks(poolFor({ dist: directory, files: installed.files, manifest: installed.manifest }));
  return { id: RENDERER_ID, version, integrity, capabilities: ['visual.render'], platforms: ['web'],
    acceptedPriorBuilds: accepted,
    // Parses and runs the scene at both layouts, with and without reduced motion
    // (visual-check.ts). Identical bytes that already passed are not re-run.
    validateVisual: visual => checks.check(visual),
    prepareVisuals: visuals => checks.prepare(visuals),
  };
}
