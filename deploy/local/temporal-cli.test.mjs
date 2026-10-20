import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TEMPORAL_CLI, installTemporalCli, temporalBuild, verifyTemporalCli, main } from './temporal-cli.mjs';
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
