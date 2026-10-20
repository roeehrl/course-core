import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PilotError, ensure, absolute } from './runtime.mjs';

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
/** Downloads the pinned official archive for this host, checks the archive and
 * then the extracted binary against the pins, and installs it at `target`. An
 * existing target is verified and kept, never replaced. */
export async function installTemporalCli(target, { fetchImpl = fetch, platform = process.platform, arch = process.arch } = {}) {
  target = absolute(target);
  const build = temporalBuild(platform, arch);
  try { await lstat(target); await verifyTemporalCli(target); return { target, state: 'already_verified', version: TEMPORAL_CLI.version }; }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'temporal_cli_missing') throw error; }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(tmpdir(), 'temporal-cli-'));
  try {
    const response = await fetchImpl(build.url, { redirect: 'follow' });
    ensure(response.ok, 'temporal_cli_download_failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    ensure(bytes.length > 0 && bytes.length <= MAX_ARCHIVE_BYTES, 'temporal_cli_download_size');
    ensure(createHash('sha256').update(bytes).digest('hex') === build.archive, 'temporal_cli_archive_digest_mismatch');
    const archive = path.join(scratch, 'temporal.tar.gz');
    await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' });
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
