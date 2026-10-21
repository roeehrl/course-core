import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEMPORAL_CLI, TEMPORAL_DOWNLOAD_RETRY, downloadTemporalArchive, installTemporalCli, networkFailureReason, retryAfterMs, temporalBuild, verifyTemporalCli, main } from './temporal-cli.mjs';
import { loadConfiguration, runPilot } from './pilot.mjs';
import { writePrivate } from './runtime.mjs';

const fake = '#!/bin/sh\nexit 0\n', fakeDigest = createHash('sha256').update(fake).digest('hex');
async function fixture(run) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'temporal-cli-test-')));
  try { return await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('pins exist for every supported pilot host, with distinct archive and binary digests', () => {
  for (const key of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
    const build = TEMPORAL_CLI.builds[key];
    assert.match(build.archive, /^[a-f0-9]{64}$/); assert.match(build.binary, /^[a-f0-9]{64}$/); assert.notEqual(build.archive, build.binary);
  }
  assert.equal(new Set(Object.values(TEMPORAL_CLI.builds).map(b => b.binary)).size, 4);
  assert.equal(temporalBuild('linux', 'x64').url, `https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI.version}/temporal_cli_${TEMPORAL_CLI.version}_linux_amd64.tar.gz`);
  assert.throws(() => temporalBuild('win32', 'x64'), /temporal_cli_platform_unsupported/);
});

test('an unpinned CLI is refused unless its exact digest is configured', () => fixture(async directory => {
  const file = path.join(directory, 'temporal');
  await assert.rejects(verifyTemporalCli(file), /temporal_cli_missing/);
  await writeFile(file, fake, { mode: 0o700 });
  await assert.rejects(verifyTemporalCli(file), /temporal_cli_digest_unknown/);
  assert.deepEqual(await verifyTemporalCli(file, fakeDigest), { digest: fakeDigest, source: 'configured_override' });
  // An override replaces the pinned list; a stale or different digest fails, even for a pinned build.
  await assert.rejects(verifyTemporalCli(file, TEMPORAL_CLI.builds['linux-x64'].binary), /temporal_cli_digest_mismatch/);
  for (const bad of ['', 'A'.repeat(64), fakeDigest.slice(1), 64]) await assert.rejects(verifyTemporalCli(file, bad), /invalid_temporal_cli_sha256/);
  await writeFile(file, fake + '# changed\n');
  await assert.rejects(verifyTemporalCli(file, fakeDigest), /temporal_cli_digest_mismatch/);
  const link = path.join(directory, 'linked');
  await symlink(file, link);
  await assert.rejects(verifyTemporalCli(link, createHash('sha256').update(await readFile(file)).digest('hex')), /temporal_cli_not_regular_file/);
}));

test('install refuses a tampered or failed download and never replaces an unverified target', () => fixture(async directory => {
  const target = path.join(directory, 'bin', 'temporal');
  const served = [];
  const fetchImpl = async url => { served.push(url); return new Response(Buffer.from('not the official archive')); };
  await assert.rejects(installTemporalCli(target, { fetchImpl, platform: 'linux', arch: 'x64' }), /temporal_cli_archive_digest_mismatch/);
  assert.deepEqual(served, [temporalBuild('linux', 'x64').url]);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
  await assert.rejects(installTemporalCli(target, { fetchImpl: async () => new Response('', { status: 404 }), platform: 'linux', arch: 'x64' }), /temporal_cli_download_failed/);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, fake, { mode: 0o700 });
  await assert.rejects(installTemporalCli(target, { fetchImpl, platform: 'linux', arch: 'x64' }), /temporal_cli_digest_unknown/);
  assert.equal(await readFile(target, 'utf8'), fake);
  assert.equal(served.length, 1, 'an existing target is verified, not re-downloaded');
  await assert.rejects(main(['install', '--to', 'relative/temporal']), /invalid_path/);
  await assert.rejects(main(['verify', '--to', target]), /invalid_arguments/);
}));

test('the pilot refuses to start an unpinned Temporal CLI and rejects a malformed configured digest', () => fixture(async state => {
  const root = path.join(state, 'root');
  for (const filename of ['.local/bin/temporal', 'services/api/dist/main.js', 'services/supervisor/dist/src/cli.js', 'apps/learner/dist/index.html', 'apps/admin/dist/index.html']) {
    await mkdir(path.dirname(path.join(root, filename)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, filename), filename.endsWith('.html') ? '<!doctype html>' : fake, { mode: 0o700 });
  }
  const config = { schemaVersion: 1, publicOrigin: 'http://127.0.0.1:44410', databaseUrl: 'postgresql://test_runner@127.0.0.1/course_core_test', temporalPort: 44411, temporalUiPort: 44412,
    temporalTaskQueue: 'fixture-queue', serviceToken: 'a'.repeat(64), workspaceIds: [], codeFixtureFiles: [] };
  await writePrivate(path.join(state, 'config.json'), JSON.stringify(config));
  await assert.rejects(runPilot({ root, state }), /temporal_cli_digest_unknown/);
  await assert.rejects(lstat(path.join(state, 'owner.json')), { code: 'ENOENT' });
  await writePrivate(path.join(state, 'config.json'), JSON.stringify({ ...config, temporalCliSha256: 'not-a-digest' }), true);
  await assert.rejects(loadConfiguration(root, state), /invalid_temporal_cli_sha256/);
  await writePrivate(path.join(state, 'config.json'), JSON.stringify({ ...config, temporalCliSha256: TEMPORAL_CLI.builds['darwin-arm64'].binary }), true);
  await assert.rejects(runPilot({ root, state }), /temporal_cli_digest_mismatch/);
}));

// A local stub of the release host. Each request takes the next scripted behaviour.
const archive = Buffer.alloc(64 * 1024, 'synthetic temporal archive '), archiveDigest = createHash('sha256').update(archive).digest('hex');
async function stubServer(behaviours, run) {
  const requests = [];
  const server = createServer((request, response) => {
    const behaviour = behaviours[requests.length] ?? behaviours.at(-1);
    requests.push(behaviour.name ?? 'serve');
    behaviour(request, response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { return await run(`http://127.0.0.1:${server.address().port}/temporal.tar.gz`, requests); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const serve = (bytes = archive) => function serve(request, response) { response.writeHead(200, { 'Content-Length': bytes.length }); response.end(bytes); };
const status = (code, headers = {}) => Object.defineProperty((request, response) => { response.writeHead(code, headers); response.end('stub'); }, 'name', { value: `status ${code}` });
function resetMidBody(request, response) {
  response.writeHead(200, { 'Content-Length': archive.length });
  response.write(archive.subarray(0, archive.length / 2), () => setTimeout(() => request.socket.resetAndDestroy(), 20));
}
function download(url, file, digest = archiveDigest) {
  const waits = [], logs = [];
  return { waits, logs, run: downloadTemporalArchive(url, file, digest, { wait: async ms => { waits.push(ms); }, log: message => logs.push(message), retry: { timeoutMs: 10_000 } }) };
}

test('the archive download retries a connection reset mid-body, then succeeds with the verified bytes', () => fixture(async directory => {
  await stubServer([resetMidBody, serve()], async (url, requests) => {
    const file = path.join(directory, 'temporal.tar.gz'), attempt = download(url, file);
    assert.equal(await attempt.run, 2);
    assert.deepEqual(requests, ['resetMidBody', 'serve']);
    assert.deepEqual(attempt.waits, [TEMPORAL_DOWNLOAD_RETRY.delays[0]]);
    assert.match(attempt.logs[0], /ECONNRESET|UND_ERR_SOCKET/);
    assert.ok((await readFile(file)).equals(archive));
  });
}));

test('the archive download retries an HTTP 500, then succeeds', () => fixture(async directory => {
  await stubServer([status(500), serve()], async (url, requests) => {
    const file = path.join(directory, 'temporal.tar.gz'), attempt = download(url, file);
    assert.equal(await attempt.run, 2);
    assert.deepEqual(requests, ['status 500', 'serve']);
    assert.match(attempt.logs[0], /HTTP 500/);
    assert.ok((await readFile(file)).equals(archive));
  });
}));

test('the archive download fails at once on a 404, and on a 429 without Retry-After', () => fixture(async directory => {
  for (const code of [404, 403, 429]) {
    await stubServer([status(code), serve()], async (url, requests) => {
      const attempt = download(url, path.join(directory, 'temporal.tar.gz'));
      await assert.rejects(attempt.run, /temporal_cli_download_failed/);
      assert.equal(requests.length, 1, `HTTP ${code} is not retried`);
      assert.deepEqual(attempt.waits, []);
      assert.deepEqual(await readdir(directory), [], 'no partial archive is left');
    });
  }
}));

test('a 429 with Retry-After is retried after at least that long; an excessive Retry-After is not waited for', () => fixture(async directory => {
  await stubServer([status(429, { 'Retry-After': '7' }), serve()], async (url, requests) => {
    const attempt = download(url, path.join(directory, 'temporal.tar.gz'));
    assert.equal(await attempt.run, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(attempt.waits, [7_000]);
  });
  await rm(path.join(directory, 'temporal.tar.gz'));
  await stubServer([status(503, { 'Retry-After': '3600' }), serve()], async (url, requests) => {
    const attempt = download(url, path.join(directory, 'temporal.tar.gz'));
    await assert.rejects(attempt.run, /temporal_cli_download_failed/);
    assert.equal(requests.length, 1);
  });
}));

test('the archive download fails at once on a checksum mismatch and leaves no partial file', () => fixture(async directory => {
  await stubServer([serve(Buffer.from('tampered archive')), serve()], async (url, requests) => {
    const attempt = download(url, path.join(directory, 'temporal.tar.gz'));
    await assert.rejects(attempt.run, /temporal_cli_archive_digest_mismatch/);
    assert.equal(requests.length, 1, 'a digest mismatch is never retried');
    assert.deepEqual(await readdir(directory), []);
  });
}));

test('retries are bounded: persistent 5xx and resets give up after the configured attempts', () => fixture(async directory => {
  await stubServer([status(502)], async (url, requests) => {
    const attempt = download(url, path.join(directory, 'temporal.tar.gz'));
    await assert.rejects(attempt.run, /temporal_cli_download_failed/);
    assert.equal(requests.length, TEMPORAL_DOWNLOAD_RETRY.attempts);
    assert.deepEqual(attempt.waits, TEMPORAL_DOWNLOAD_RETRY.delays);
  });
  await stubServer([resetMidBody], async (url, requests) => {
    const attempt = download(url, path.join(directory, 'temporal.tar.gz'));
    await assert.rejects(attempt.run, /temporal_cli_download_failed/);
    assert.equal(requests.length, TEMPORAL_DOWNLOAD_RETRY.attempts);
    assert.deepEqual(await readdir(directory), [], 'each partial archive was removed');
  });
}));

test('only network-class errors count as transient', () => {
  const wrapped = code => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET']) assert.equal(networkFailureReason(wrapped(code)), code);
  assert.equal(networkFailureReason(new DOMException('timed out', 'TimeoutError')), 'timeout');
  for (const error of [wrapped('ECONNREFUSED'), wrapped('CERT_HAS_EXPIRED'), new Error('temporal_cli_archive_digest_mismatch'), undefined]) assert.equal(networkFailureReason(error), undefined);
  assert.equal(retryAfterMs('12'), 12_000);
  assert.equal(retryAfterMs(new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toUTCString(), Date.UTC(2026, 0, 1)), 30_000);
  for (const value of [null, '', 'soon', '-1']) assert.equal(retryAfterMs(value), undefined);
});

test('install retries a transient failure through the real HTTP stack and still refuses the wrong bytes', () => fixture(async directory => {
  const target = path.join(directory, 'bin', 'temporal');
  await stubServer([status(503), serve()], async (url, requests) => {
    const fetchImpl = (requested, init) => { assert.equal(requested, temporalBuild('linux', 'x64').url); return fetch(url, init); };
    const waits = [];
    await assert.rejects(installTemporalCli(target, { fetchImpl, platform: 'linux', arch: 'x64', wait: async ms => { waits.push(ms); }, log: () => {} }), /temporal_cli_archive_digest_mismatch/);
    assert.deepEqual(requests, ['status 503', 'serve']);
    assert.equal(waits.length, 1);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  });
}));
