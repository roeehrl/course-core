import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PilotError, ensure, absolute, delay } from './runtime.mjs';

const exec = promisify(execFile);
/** Known-good official Temporal CLI builds. `archive` digests are the release's
 * own checksums.txt entries (temporalio/cli GitHub release, verified 2026-10-20);
 * `binary` digests are of the `temporal` executable inside each verified archive.
 * Adding a version requires repeating both checks; never copy a digest from a
 * binary you have not extracted from a checksum-verified official archive. */
export const TEMPORAL_CLI = Object.freeze({
  version: '1.9.1',
  builds: Object.freeze({
    'darwin-arm64': Object.freeze({ archive: '41e0425378fcb4fb5766340b97435e20fe47bbff2d7bf644ec2d51f7662b7c56', binary: '33c298d41f6eefebf01a28a3511f444480e939e21d3518cb0c12a4abad467c4b' }),
    'darwin-x64': Object.freeze({ archive: '48cdd6c84c56e27ae8e4d9a47052b89289a9c552dee029b49dd312c6fb72873f', binary: 'd5776986d343fb789f49e4e7b6d3faca931c0877b71c6d4a7ac39dba467155cc' }),
    'linux-x64': Object.freeze({ archive: '09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5', binary: '712217694cac9f786a72d4b6c876cd15f3dcf1bf31434d9fed6af25242a327a0' }),
    'linux-arm64': Object.freeze({ archive: '6c57c352d52fc3df34412376fd9ba6f74b7e3ace8e426e6cba8600156d36a145', binary: '667e9403cb2faaf439ecaa7eb7190e0d08521de6c9118da7fd26ad594281271d' }),
  }),
});
const GOARCH = { x64: 'amd64', arm64: 'arm64' };
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function temporalBuild(platform = process.platform, arch = process.arch) {
  const build = TEMPORAL_CLI.builds[`${platform}-${arch}`];
  ensure(build, 'temporal_cli_platform_unsupported');
  return { ...build, url: `https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI.version}/temporal_cli_${TEMPORAL_CLI.version}_${platform}_${GOARCH[arch]}.tar.gz` };
}
export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** Refuses a Temporal CLI whose bytes are not a pinned known-good build. An
 * operator may accept exactly one other build only through the explicit
 * `temporalCliSha256` pilot configuration value; it replaces the pinned list
 * rather than extending it, so a stale override also fails. */
export async function verifyTemporalCli(file, override) {
  ensure(override === undefined || (typeof override === 'string' && DIGEST.test(override)), 'invalid_temporal_cli_sha256');
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') throw new PilotError('temporal_cli_missing'); throw error; });
  ensure(info.isFile() && !info.isSymbolicLink(), 'temporal_cli_not_regular_file');
  const digest = await sha256File(file);
  if (override !== undefined) { ensure(digest === override, 'temporal_cli_digest_mismatch'); return { digest, source: 'configured_override' }; }
  const known = Object.entries(TEMPORAL_CLI.builds).find(([, build]) => build.binary === digest);
  ensure(known, 'temporal_cli_digest_unknown');
  return { digest, source: 'pinned', version: TEMPORAL_CLI.version, platform: known[0] };
}
/** Bounded retries for the archive download. Only network-class failures are retried:
 * a connection reset (also mid-body), a timeout, a DNS failure, an HTTP 5xx, and an HTTP
 * 429 that carries Retry-After. A 4xx, a size or a digest mismatch is a definitive answer
 * and fails at once. The partial archive is removed before every retry. */
export const TEMPORAL_DOWNLOAD_RETRY = Object.freeze({
  attempts: 4, delays: Object.freeze([2_000, 10_000, 30_000]), maxRetryAfterMs: 120_000, timeoutMs: 300_000,
});
const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
class TransientDownloadError extends Error {
  constructor(reason, retryAfterMs) { super(reason); this.retryAfterMs = retryAfterMs; }
}
/** The network-class reason for a failed fetch or body read (reset, timeout, DNS), or
 * undefined when the failure is not network-class. */
export function networkFailureReason(error) {
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {
    if (current.name === 'TimeoutError') return 'timeout';
    if (NETWORK_ERROR_CODES.has(current.code)) return current.code;
  }
  return undefined;
}
/** Retry-After as milliseconds from `now` (delta seconds or an HTTP date), or undefined. */
export function retryAfterMs(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = /^[A-Za-z]{3}, /.test(text) ? Date.parse(text) : NaN; // an HTTP date
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
async function downloadOnce(url, file, sha256, { fetchImpl, timeoutMs, maxBytes }) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const after = retryAfterMs(response.headers.get('retry-after'));
    if (response.status >= 500) throw new TransientDownloadError(`HTTP ${response.status}`, after);
    if (response.status === 429 && after !== undefined) throw new TransientDownloadError('HTTP 429', after);
    throw new PilotError('temporal_cli_download_failed');
  }
  ensure(!(Number(response.headers.get('content-length')) > maxBytes), 'temporal_cli_download_size');
  const hash = createHash('sha256');
  let size = 0;
  const handle = await open(file, 'wx', 0o600);
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      ensure(size <= maxBytes, 'temporal_cli_download_size');
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally { await handle.close(); }
  ensure(size > 0, 'temporal_cli_download_size');
  ensure(hash.digest('hex') === sha256, 'temporal_cli_archive_digest_mismatch');
}
/** Streams `url` into `file` (which must not exist), checking its size and SHA-256, with
 * the TEMPORAL_DOWNLOAD_RETRY policy. On any failure no partial file is left behind.
 * Resolves to the number of attempts used. */
export async function downloadTemporalArchive(url, file, sha256, {
  fetchImpl = fetch, retry = TEMPORAL_DOWNLOAD_RETRY, wait = delay, maxBytes = MAX_ARCHIVE_BYTES,
  log = message => console.error(message),
} = {}) {
  const { attempts, delays, maxRetryAfterMs, timeoutMs } = { ...TEMPORAL_DOWNLOAD_RETRY, ...retry };
  for (let attempt = 1; ; attempt++) {
    let reason, after;
    try { await downloadOnce(url, file, sha256, { fetchImpl, timeoutMs, maxBytes }); return attempt; }
    catch (error) {
      await rm(file, { force: true });
      if (error instanceof TransientDownloadError) ({ message: reason, retryAfterMs: after } = error);
      else reason = networkFailureReason(error);
      // A digest, size or 4xx failure, or any other error, is definitive.
      if (reason === undefined) throw error;
    }
    const base = delays[Math.min(attempt - 1, delays.length - 1)];
    if (attempt >= attempts || after > maxRetryAfterMs) {
      log(`temporal_cli_download: ${reason}; giving up after attempt ${attempt} of ${attempts}`);
      throw new PilotError('temporal_cli_download_failed');
    }
    const pause = Math.max(base, after ?? 0);
    log(`temporal_cli_download: ${reason}; retrying in ${Math.round(pause / 1000)} s (attempt ${attempt + 1} of ${attempts})`);
    await wait(pause);
  }
}
/** Downloads the pinned official archive for this host (with bounded network retries),
 * checks the archive and then the extracted binary against the pins, and installs it at
 * `target`. An existing target is verified and kept, never replaced. */
export async function installTemporalCli(target, { fetchImpl = fetch, platform = process.platform, arch = process.arch, retry, wait, log } = {}) {
  target = absolute(target);
  const build = temporalBuild(platform, arch);
  try { await lstat(target); await verifyTemporalCli(target); return { target, state: 'already_verified', version: TEMPORAL_CLI.version }; }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'temporal_cli_missing') throw error; }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(tmpdir(), 'temporal-cli-'));
  try {
    const archive = path.join(scratch, 'temporal.tar.gz');
    await downloadTemporalArchive(build.url, archive, build.archive, { fetchImpl, retry, wait, log });
    await exec('tar', ['-xzf', archive, '-C', scratch, 'temporal']);
    const extracted = path.join(scratch, 'temporal');
    ensure(await sha256File(extracted) === build.binary, 'temporal_cli_binary_digest_mismatch');
    await chmod(extracted, 0o755);
    const staged = path.join(path.dirname(target), `.temporal-${randomUUID()}`);
    await writeFile(staged, await readFile(extracted), { mode: 0o755, flag: 'wx' });
    try {
      ensure(await sha256File(staged) === build.binary, 'temporal_cli_binary_digest_mismatch');
      await lstat(target).then(() => { throw new PilotError('temporal_cli_target_appeared'); }, error => { if (error.code !== 'ENOENT') throw error; });
      await rename(staged, target);
    } finally { await rm(staged, { force: true }); }
    return { target, state: 'installed', version: TEMPORAL_CLI.version };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function main(args = process.argv.slice(2)) {
  const [mode, flag, value, ...rest] = args;
  ensure(['install', 'verify'].includes(mode) && flag === (mode === 'install' ? '--to' : '--file') && value && rest.length === 0, 'invalid_arguments');
  return mode === 'install' ? installTemporalCli(value) : verifyTemporalCli(absolute(value));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(result => console.log(JSON.stringify(result)), error => { console.error(error instanceof PilotError ? error.code : 'temporal_cli_failed'); process.exitCode = 1; });
}
