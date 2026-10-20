import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { requireCondition } from './errors.js';
import { runnerFrameContentSecurityPolicy, runnerFrameDocument } from './python-runner-frame.js';

/**
 * Browser practice runs of Python with Pyodide (audit N02). The runtime is the unmodified
 * `pyodide` npm release pinned in this package's lockfile (sha512); Core serves those exact files
 * from its own origin and refuses any whose SHA-256 differs from the pins below. No CDN is used at
 * runtime. Pyodide is MPL-2.0 (README "Browser practice runs" records the licence and source).
 *
 * Browser runs are practice and feedback only: these routes are read-only, unauthenticated
 * public code with no learner data, and nothing a browser run produces is ever sent to the server.
 * Code assessments are graded only by the registered server evaluator (Docker sandbox).
 */
export const PYODIDE_VERSION = '314.0.7';
export const PYODIDE_LICENSE = { spdx: 'MPL-2.0', source: 'https://github.com/pyodide/pyodide/tree/314.0.7' } as const;
export const PYODIDE_FILES: readonly { name: string; sha256: string; size: number }[] = Object.freeze([
  { name: 'pyodide.js', sha256: '3141b814715a72e59b51b1b18b9ceae5bf19f7c852417e431bb0a34feadf825c', size: 18_912 },
  { name: 'pyodide.asm.mjs', sha256: 'f7cdc8ece80678ceb712f8e65ebe6d3a83203a180c399865f49612a051693635', size: 1_250_344 },
  { name: 'pyodide.asm.wasm', sha256: 'cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6', size: 9_598_218 },
  { name: 'python_stdlib.zip', sha256: 'fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a', size: 2_545_637 },
  { name: 'pyodide-lock.json', sha256: '5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010', size: 119_077 },
]);
/** Defaults a host may tighten. The frame clamps whatever it is sent to 0.1-60 s and 256 B-1 MiB. */
export const PYTHON_RUN_LIMITS = Object.freeze({ timeoutMs: 10_000, outputBytes: 65_536, memoryBytes: 256 * 1024 * 1024, sourceBytes: 64_000 });

export interface PythonRunnerOptions {
  /** Host switch (env PYTHON_BROWSER_RUNS=disabled turns it off). Default: enabled. */
  enabled?: boolean;
  /** Wall-clock limit of one run in ms (100-60 000). */
  timeoutMs?: number;
  /** Test seam: where the pinned package is installed. */
  packageDirectory?: string;
}
type Asset = { name: string; sha256: string; bytes: Buffer; gzip: Promise<Buffer | null> };
export type PyodideAssets = { status: 'ready'; files: Map<string, Asset> } | { status: 'unavailable'; reason: 'not_installed' | 'version_mismatch' | 'integrity_mismatch' };

const gzipAsync = promisify(gzip);
const loaded = new Map<string, Promise<PyodideAssets>>();
function installedDirectory() {
  try { return path.dirname(createRequire(import.meta.url).resolve('pyodide/package.json')); } catch { return null; }
}
/** Reads and verifies the pinned files once per directory. Mismatched bytes are never served. */
export function loadPyodideAssets(directory = installedDirectory()): Promise<PyodideAssets> {
  if (!directory) return Promise.resolve({ status: 'unavailable', reason: 'not_installed' });
  let pending = loaded.get(directory);
  if (!pending) {
    pending = verifyAssets(directory);
    loaded.set(directory, pending);
  }
  return pending;
}
async function verifyAssets(directory: string): Promise<PyodideAssets> {
  let manifest: { name?: unknown; version?: unknown };
  try { manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); } catch { return { status: 'unavailable', reason: 'not_installed' }; }
  if (manifest.name !== 'pyodide' || manifest.version !== PYODIDE_VERSION) return { status: 'unavailable', reason: 'version_mismatch' };
  const files = new Map<string, Asset>();
  for (const pin of PYODIDE_FILES) {
    let bytes: Buffer;
    try { bytes = await readFile(path.join(directory, pin.name)); } catch { return { status: 'unavailable', reason: 'not_installed' }; }
    if (bytes.length !== pin.size || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) return { status: 'unavailable', reason: 'integrity_mismatch' };
    // Compressed once, lazily, for clients that accept gzip (about 13 MB becomes about 6 MB).
    let compressed: Promise<Buffer | null> | undefined;
    files.set(pin.name, { name: pin.name, sha256: pin.sha256, bytes, get gzip() { return compressed ??= gzipAsync(bytes, { level: 6 }).catch(() => null); } });
  }
  return { status: 'ready', files };
}

const ASSET_PREFIX = `/api/python-runner/assets/${PYODIDE_VERSION}/`;
export const IMMUTABLE_ASSET = 'public, max-age=31536000, immutable';
/** Runner metadata, frame document and pinned files. GET only, no session, no database. */
export async function registerPythonRunnerRoutes(app: FastifyInstance, options: PythonRunnerOptions = {}) {
  const enabled = options.enabled !== false;
  const assets = enabled ? await loadPyodideAssets(options.packageDirectory) : null;
  const timeoutMs = Math.min(60_000, Math.max(100, Math.trunc(options.timeoutMs ?? PYTHON_RUN_LIMITS.timeoutMs)));
  const ready = assets?.status === 'ready';
  app.get('/api/python-runner', async () => ({
    status: !enabled ? 'disabled' : ready ? 'ready' : 'unavailable',
    ...(assets?.status === 'unavailable' ? { reason: assets.reason } : {}),
    language: 'python', runtime: { name: 'pyodide', version: PYODIDE_VERSION, license: PYODIDE_LICENSE },
    // Practice only: a browser run is never evidence, never sent to the server and never graded.
    purpose: 'practice_only', evidence: 'none',
    ...(ready ? {
      frameUrl: '/api/python-runner/frame',
      assets: PYODIDE_FILES.map(file => ({ name: file.name, sha256: file.sha256, size: file.size, url: ASSET_PREFIX + file.name })),
      limits: { ...PYTHON_RUN_LIMITS, timeoutMs },
    } : {}),
  }));
  app.get('/api/python-runner/frame', async (_request, reply) => {
    requireCondition(ready, 'PYTHON_RUNNER_UNAVAILABLE', 404);
    return reply.header('Content-Security-Policy', runnerFrameContentSecurityPolicy()).header('Cross-Origin-Resource-Policy', 'same-origin')
      .header('Cross-Origin-Opener-Policy', 'same-origin').header('X-DNS-Prefetch-Control', 'off')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), clipboard-write=(), clipboard-read=(), usb=(), serial=(), bluetooth=(), payment=()')
      .type('text/html; charset=utf-8').send(runnerFrameDocument());
  });
  app.get(`${ASSET_PREFIX}:name`, { config: { immutableAsset: true }, schema: { params: { type: 'object', properties: { name: { type: 'string', maxLength: 64 } }, required: ['name'] } } }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const asset = assets?.status === 'ready' ? assets.files.get(name) : undefined;
    requireCondition(asset, 'PYTHON_RUNNER_ASSET_NOT_FOUND', 404);
    // Bytes, never a script or document of Core's origin: only the sandbox evaluates them.
    reply.header('Cross-Origin-Resource-Policy', 'same-origin').header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Vary', 'Accept-Encoding').header('ETag', `"${asset.sha256}"`).type('application/octet-stream');
    const compressed = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? '')) ? await asset.gzip : null;
    return compressed ? reply.header('Content-Encoding', 'gzip').send(compressed) : reply.send(asset.bytes);
  });
}

/** Host configuration: PYTHON_BROWSER_RUNS=enabled|disabled (default enabled) and
 * PYTHON_BROWSER_RUN_TIMEOUT_MS (100-60 000, default 10 000). Anything else refuses to start. */
export function pythonRunnerFromEnvironment(env: Record<string, string | undefined>): PythonRunnerOptions {
  const switchValue = env.PYTHON_BROWSER_RUNS ?? 'enabled';
  if (switchValue !== 'enabled' && switchValue !== 'disabled') throw new Error('PYTHON_BROWSER_RUNS must be enabled or disabled.');
  const timeout = env.PYTHON_BROWSER_RUN_TIMEOUT_MS;
  if (timeout !== undefined && !(/^\d{3,5}$/.test(timeout) && Number(timeout) >= 100 && Number(timeout) <= 60_000)) throw new Error('PYTHON_BROWSER_RUN_TIMEOUT_MS must be 100-60000.');
  return { enabled: switchValue === 'enabled', ...(timeout !== undefined ? { timeoutMs: Number(timeout) } : {}) };
}
