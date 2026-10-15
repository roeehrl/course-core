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

/**
 * A reviewed prior visuals build, bound to the exact server-side headless runtime it was
 * reviewed against. `headlessExecuted` is that runtime's executed identity (below); the
 * legacy `headless` digest is kept as the recorded value from released-digests.json.
 */
export interface ReviewedPriorBuild extends BuildIdentity { readonly headless: string; readonly headlessExecuted: string }

/**
 * Prior `course-core-svg-v1` builds still served for already published, pinned courses.
 *
 * 0.1.0 is the build shipped identically with Core v0.1.3 through v0.1.25. 0.1.1 changed
 * only the React client wrapper (dist/react.js); the server-side headless entry, every
 * module it imports and the pins of the packages they import at run time are
 * byte-identical. Server-side validation and interactive context therefore behave
 * exactly as they did for 0.1.0.
 *
 * Each entry applies only while the installed headless executed identity equals its
 * `headlessExecuted` value (see acceptedPriorBuilds), so a later runtime change disables
 * it instead of silently widening it. Values match packages/visuals/released-digests.json.
 * Adding an entry requires the same review. Never add a build whose headless runtime differs.
 */
export const REVIEWED_PRIOR_SVG_BUILDS: readonly ReviewedPriorBuild[] = Object.freeze([
  Object.freeze({
    version: '0.1.0',
    integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24',
    headless: 'sha256-c479f10e2def81707919764494e52a86cbe35ae8b4245af0faff1788d9cc94ea',
    headlessExecuted: 'sha256-83c3eadd80dd766223aa5f8681e10470bde70cb3fb224d328429600b6ad01c8b',
  }),
]);

/** A released visuals version: the fingerprint courses declare for it, and what it executes. */
export interface RecordedSvgRelease extends BuildIdentity { readonly executed: string }

/**
 * Released builds, keyed by executed identity. An installed build that executes exactly
 * what a released version executes is that release and advertises its recorded
 * fingerprint, even when its manifest pins a different version of a package no dist file
 * imports (the legacy fingerprint hashes every dependency pin). Values match
 * packages/visuals/released-digests.json, whose test re-derives each legacy fingerprint
 * from the released bytes.
 */
export const RECORDED_SVG_RELEASES: readonly RecordedSvgRelease[] = Object.freeze([
  Object.freeze({
    version: '0.1.0',
    integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24',
    executed: 'sha256-1a09d61ca893b409b738d34ad1858a13ccfa3fec7938c3ced97894b2f852819c',
  }),
  Object.freeze({
    version: '0.1.1',
    integrity: 'sha256-d64441db68463ba2c62d36d04fc9c60a3378b4a2f783d5f156238b6aa6e2dcd6',
    executed: 'sha256-80582f47e2a684f4563b5f11c8520dfa726812aacf58dfa86a6f47bc30d12a61',
  }),
]);

/** What the installed visuals build is: its advertised identity and the declarations that name it exactly. */
export interface InstalledVisualsIdentity extends BuildIdentity {
  /** The installed build's executed identity, also accepted as a declaration of this version. */
  readonly executedAlias?: BuildIdentity;
}

/**
 * The installed build's identity, decided by what it executes. A recorded release with the
 * same version and executed identity supplies the fingerprint courses declare for it.
 * Any other analysable build advertises its executed identity: never its computed legacy
 * fingerprint, which ignores manifest fields such as `exports` and could therefore equal a
 * recorded fingerprint for a build that loads different code. Only a build whose module
 * loading cannot be analysed falls back to the legacy fingerprint, as before.
 */
export function installedVisualsIdentity(recorded: readonly RecordedSvgRelease[], installed: VisualsDigests): InstalledVisualsIdentity {
  if (installed.executed === undefined) return Object.freeze({ version: installed.version, integrity: installed.integrity });
  const release = recorded.find(build => build.version === installed.version && build.executed === installed.executed);
  if (!release) return Object.freeze({ version: installed.version, integrity: installed.executed });
  return Object.freeze({ version: installed.version, integrity: release.integrity,
    executedAlias: Object.freeze({ version: installed.version, integrity: installed.executed }) });
}

/** Reviewed prior builds that apply to this exact installed build. */
export function acceptedPriorBuilds(reviewed: readonly ReviewedPriorBuild[], installed: BuildIdentity & { headlessExecuted?: string | undefined }): readonly BuildIdentity[] {
  return Object.freeze(reviewed
    .filter(build => installed.headlessExecuted !== undefined && build.headlessExecuted === installed.headlessExecuted
      && build.version !== installed.version && build.integrity !== installed.integrity)
    .map(({ version, integrity }) => Object.freeze({ version, integrity })));
}

export interface RuntimePin { dependency?: string; peer?: string; optional?: string }
export interface VisualsDigests {
  version: string;
  /** Legacy fingerprint: every dist file plus version, dependencies and peerDependencies. */
  integrity: string;
  /** Legacy headless digest: the headless closure plus dependencies and peerDependencies. */
  headless: string;
  /** Executed identity of the whole package; undefined when its module loading cannot be analysed. */
  executed?: string;
  /** Executed identity of the headless closure; undefined when it cannot be analysed. */
  headlessExecuted?: string;
  files?: Record<string, string>;
  headlessFiles: Record<string, string>;
  runtime?: Record<string, RuntimePin>;
  headlessRuntime?: Record<string, RuntimePin>;
}

type VisualsManifest = { version: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; [field: string]: unknown };

// Keep in step with packages/visuals/scripts/dist-digest.ts; renderer-compatibility.test.ts
// checks both against packages/visuals/released-digests.json.
const LOADING_FIELDS = ['type', 'main', 'module', 'browser', 'exports', 'imports', 'sideEffects'] as const;
const EXECUTED_SCHEME = 'course-core-visuals-executed-v1';
const SPECIFIER = /(?:\bfrom|\bimport)\s*["']([^"']*)["']/g;
const UNANALYSABLE = /\b(?:from|import)\s*(?:\/\*|\/\/)|\bimport\s*\(|\brequire\s*\(|\bimport\.meta\b|\bcreateRequire\b|\bimportScripts\b|\bnew\s+Worker\b/;
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.-]+)*$/;
class Unanalysable extends Error {}
const declaredPackages = (manifest: VisualsManifest) => [...new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])];
const pinOf = (pkg: string, manifest: VisualsManifest) =>
  JSON.parse(canonicalJson({ dependency: manifest.dependencies?.[pkg], peer: manifest.peerDependencies?.[pkg], optional: manifest.optionalDependencies?.[pkg] })) as RuntimePin;
const quotedSpecifier = (pkg: string) => new RegExp(`["'\`]${pkg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["'\`/]`);

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/** JSON with object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Package -> manifest pin for every run-time import of these files. Throws Unanalysable on anything it cannot follow. */
function runtimeImports(texts: ReadonlyMap<string, string>, manifest: VisualsManifest): Record<string, RuntimePin> {
  const pins: Record<string, RuntimePin> = {};
  for (const [name, text] of texts) {
    if (name.endsWith('.json')) continue;
    if (name.endsWith('.css')) { if (/@import\b/.test(text)) throw new Unanalysable(name); continue; }
    if (UNANALYSABLE.test(text)) throw new Unanalysable(name);
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1]!;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        if (!texts.has(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)))) throw new Unanalysable(name);
        continue;
      }
      if (specifier.startsWith('node:')) { pins[specifier] = {}; continue; }
      if (!PACKAGE_SPECIFIER.test(specifier)) throw new Unanalysable(name);
      const parts = specifier.split('/'), pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
      if (!declaredPackages(manifest).includes(pkg)) throw new Unanalysable(name);
      pins[pkg] = pinOf(pkg, manifest);
    }
    // Over-approximate: a declared package named by any quoted specifier-like string is bound.
    for (const pkg of declaredPackages(manifest)) if (quotedSpecifier(pkg).test(text)) pins[pkg] = pinOf(pkg, manifest);
  }
  return Object.fromEntries(Object.entries(pins).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const executedDigest = (input: { part: 'package' | 'headless'; version?: string; files: Record<string, string>; runtime: Record<string, RuntimePin>; loading: Record<string, unknown> }) =>
  `sha256-${sha256(canonicalJson({ scheme: EXECUTED_SCHEME, ...input }))}`;

/**
 * Digests of a visuals dist directory. `integrity`/`headless` are the legacy svgRenderer
 * fingerprints (they hash every dependency pin). `executed`/`headlessExecuted` identify
 * what runs: each runtime dist file's bytes, the pins of the packages those files import
 * at run time, and the manifest fields that decide how they load.
 */
export async function visualsDistDigests(directory: string, manifest: VisualsManifest): Promise<VisualsDigests> {
  const files: string[] = [];
  async function collect(relative: string) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await collect(name);
      else if (entry.isFile() && /\.(?:js|css|json)$/.test(entry.name)) files.push(name.replaceAll(path.sep, '/'));
    }
  }
  await collect('');
  files.sort();
  const bytes = new Map<string, Buffer>();
  for (const name of files) bytes.set(name, await readFile(path.join(directory, name)));

  const hash = createHash('sha256');
  for (const name of files) hash.update(name).update('\0').update(bytes.get(name)!).update('\0');
  hash.update(JSON.stringify({ version: manifest.version, dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies }));

  // headless.js and every dist module it reaches through relative imports.
  const closure = new Set<string>();
  async function follow(name: string) {
    if (closure.has(name)) return;
    closure.add(name);
    const text = bytes.get(name)?.toString('utf8') ?? await readFile(path.join(directory, name), 'utf8');
    for (const match of text.matchAll(/(?:\bfrom|\bimport)\s*["'](\.\/[^"']+)["']/g))
      await follow(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1]!)));
  }
  await follow('headless.js');
  const headlessNames = [...closure].sort();
  const headless = createHash('sha256');
  for (const name of headlessNames) headless.update(name).update('\0').update(bytes.get(name) ?? await readFile(path.join(directory, name))).update('\0');
  headless.update(JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies }));

  const digests = (names: readonly string[]) => Object.fromEntries(names.map(name => [name, sha256(bytes.get(name)!)]));
  const texts = (names: readonly string[]) => new Map(names.map(name => [name, bytes.get(name)!.toString('utf8')]));
  const legacy = { version: manifest.version, integrity: `sha256-${hash.digest('hex')}`, headless: `sha256-${headless.digest('hex')}` };
  const headlessFiles = Object.fromEntries(headlessNames.filter(name => bytes.has(name)).map(name => [name, sha256(bytes.get(name)!)]));
  // A closure member outside the runtime file set cannot be identified; leave the executed identity undefined.
  if (headlessNames.some(name => !bytes.has(name))) return { ...legacy, headlessFiles };
  const loading = Object.fromEntries(LOADING_FIELDS.map(field => [field, manifest[field]]));
  const whole = digests(files);
  let runtime: Record<string, RuntimePin>, headlessRuntime: Record<string, RuntimePin>;
  try { runtime = runtimeImports(texts(files), manifest); headlessRuntime = runtimeImports(texts(headlessNames), manifest); }
  catch (error) { if (error instanceof Unanalysable) return { ...legacy, headlessFiles }; throw error; }
  return { ...legacy, files: whole, headlessFiles, runtime, headlessRuntime,
    executed: executedDigest({ part: 'package', version: manifest.version, files: whole, runtime, loading }),
    headlessExecuted: executedDigest({ part: 'headless', files: headlessFiles, runtime: headlessRuntime, loading }) };
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

/**
 * The identity a visuals dist directory advertises: its version and fingerprint, plus the
 * exact declarations it also serves (reviewed prior builds with the same headless runtime,
 * and its own executed identity).
 */
export async function visualsRendererIdentity(directory: string, manifest: VisualsManifest): Promise<BuildIdentity & { acceptedPriorBuilds: readonly BuildIdentity[] }> {
  const installed = await visualsDistDigests(directory, manifest);
  const identity = installedVisualsIdentity(RECORDED_SVG_RELEASES, installed);
  return { version: identity.version, integrity: identity.integrity,
    acceptedPriorBuilds: Object.freeze([...acceptedPriorBuilds(REVIEWED_PRIOR_SVG_BUILDS, { ...identity, headlessExecuted: installed.headlessExecuted }),
      ...(identity.executedAlias ? [identity.executedAlias] : [])]) };
}

/** Fingerprint the installed implementation rather than trusting a course-supplied name. */
export async function svgRenderer(): Promise<RuntimeExtension> {
  const entry = fileURLToPath(import.meta.resolve('@course-core/visuals/headless'));
  const directory = path.dirname(entry), packageRoot = path.dirname(directory);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const { version, integrity, acceptedPriorBuilds: accepted } = await visualsRendererIdentity(directory, manifest);
  const checks = visualChecks();
  return { id: RENDERER_ID, version, integrity, capabilities: ['visual.render'], platforms: ['web'],
    acceptedPriorBuilds: accepted,
    // Parses and runs the scene at both layouts, with and without reduced motion
    // (visual-check.ts). Identical bytes that already passed are not re-run.
    validateVisual: visual => checks.check(visual),
    prepareVisuals: visuals => checks.prepare(visuals),
  };
}
