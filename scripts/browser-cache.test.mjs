import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { aptSelector, cacheKey, githubOutput, installedArchives, parseAptRecords, parseArchiveName, playwrightVersions, verifyArchives } from './browser-cache.mjs';

const runner = { imageOS: 'ubuntu24', imageVersion: '20261019.1.0', arch: 'X64' };
const digest = (text) => createHash('sha256').update(text).digest('hex');

test('a browser cache key names the runner image, architecture, job and locked Playwright version', () => {
  assert.deepEqual(cacheKey({ ...runner, label: 'api-engines', versions: ['1.64.0'] }), {
    key: 'browsers-v1-ubuntu24-X64-api-engines-pw1.64.0-20261019.1.0',
    // A new runner image starts from the newest entry for the same Playwright version, then from any entry for the job.
    restoreKeys: ['browsers-v1-ubuntu24-X64-api-engines-pw1.64.0-', 'browsers-v1-ubuntu24-X64-api-engines-'],
  });
  assert.equal(cacheKey({ ...runner, label: 'web-admin', versions: ['1.65.0', '1.64.0', '1.64.0'] }).key, 'browsers-v1-ubuntu24-X64-web-admin-pw1.64.0+1.65.0-20261019.1.0');
  for (const [change, message] of [
    [{ label: 'API engines' }, /label/], [{ label: '' }, /label/], [{ label: 'web-' }, /label/],
    [{ imageOS: undefined }, /GitHub-hosted runner image/], [{ imageVersion: '' }, /GitHub-hosted runner image/], [{ arch: 'x86' }, /GitHub-hosted runner image/],
    [{ versions: [] }, /Playwright version/], [{ versions: ['^1.64.0'] }, /Playwright version/], [{ versions: ['latest'] }, /Playwright version/],
  ]) assert.throws(() => cacheKey({ ...runner, label: 'api-core', versions: ['1.64.0'], ...change }), message, JSON.stringify(change));
});

test('the cache key reads the exact Playwright version each browser module locks', async () => {
  const versions = await playwrightVersions(['api', 'learner', 'admin', 'visuals']);
  assert.equal(versions.length >= 1, true);
  for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+$/);
  await assert.rejects(playwrightVersions([]), /at least one module/);
  await assert.rejects(playwrightVersions(['policy']), /not a registered browser module/);
  await assert.rejects(playwrightVersions(['constructor']), /not a registered browser module/);
});

test('step outputs keep multi-line restore keys inside a delimiter', () => {
  assert.equal(githubOutput({ key: 'k', 'restore-keys': ['a-', 'b-'] }, 'EOF_1'), 'key=k\nrestore-keys<<EOF_1\na-\nb-\nEOF_1\n');
  assert.throws(() => githubOutput({ key: 'k\nother=1' }), /single line/);
  assert.throws(() => githubOutput({ keys: ['a', 'EOF_1'] }, 'EOF_1'), /single lines/);
});

test('apt archive names decode to the exact package version apt reuses them for', () => {
  assert.deepEqual(parseArchiveName('libwoff1_1.0.2-2build1_amd64.deb'), { package: 'libwoff1', version: '1.0.2-2build1', architecture: 'amd64' });
  assert.deepEqual(parseArchiveName('libx264-164_2%3a0.164.3108+git31e19f9-1_amd64.deb'), { package: 'libx264-164', version: '2:0.164.3108+git31e19f9-1', architecture: 'amd64' });
  assert.deepEqual(parseArchiveName('fonts-ipafont-gothic_00303-21ubuntu1_all.deb'), { package: 'fonts-ipafont-gothic', version: '00303-21ubuntu1', architecture: 'all' });
  assert.equal(aptSelector(parseArchiveName('libgtk-4-1_4.14.2+ds-1ubuntu1_amd64.deb')), 'libgtk-4-1:amd64=4.14.2+ds-1ubuntu1');
  for (const name of ['lock', 'partial', 'libwoff1_1.0.2_amd64.tar', 'libwoff1_1.0.2-2build1.deb', 'lib_woff1_1.0.2_amd64.deb', '../libwoff1_1.0.2_amd64.deb',
    'libwoff1_1.0.2%2f..%2fx_amd64.deb', 'libwoff1_..%2f1_amd64.deb', 'Libwoff1_1.0.2_amd64.deb', 'libwoff1_1.0.2_amd%2e64.deb', 'libwoff1__amd64.deb'])
    assert.equal(parseArchiveName(name), null, name);
});

test('the signed index records give every SHA-256 listed for a package version', () => {
  const records = parseAptRecords([
    'Package: libwoff1', 'Architecture: amd64', 'Version: 1.0.2-2build1', 'Description: WOFF2 font library', ' Continuation: not a field', `SHA256: ${'a'.repeat(64)}`, '',
    'Package: libwoff1', 'Architecture: amd64', 'Version: 1.0.2-2build1', `SHA256: ${'b'.repeat(64)}`, '',
    'Package: fonts-ipafont-gothic', 'Architecture: all', 'Version: 00303-21ubuntu1', `SHA256: ${'c'.repeat(64)}`, '',
    // Incomplete or malformed records are ignored, never trusted.
    'Package: libnohash', 'Architecture: amd64', 'Version: 1', '',
    'Package: libshort', 'Architecture: amd64', 'Version: 1', 'SHA256: abc', '',
  ].join('\n'));
  assert.deepEqual([...records.keys()].sort(), ['fonts-ipafont-gothic\0all\x0000303-21ubuntu1', 'libwoff1\0amd64\x001.0.2-2build1']);
  assert.deepEqual([...records.get('libwoff1\0amd64\x001.0.2-2build1')], ['a'.repeat(64), 'b'.repeat(64)]);
});

test('only cached packages whose SHA-256 matches the signed index reach apt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'course-browser-cache-'));
  try {
    const files = {
      'libgood_1.0-1_amd64.deb': 'good package',
      // Same name and size as the indexed file, different bytes: apt's own size check would reuse it.
      'libtampered_1.0-1_amd64.deb': 'evil package',
      'libsuperseded_1.0-1_amd64.deb': 'old package',
      'not-an-archive.deb': 'x',
    };
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(directory, name), content);
    const records = parseAptRecords([
      `Package: libgood\nArchitecture: amd64\nVersion: 1.0-1\nSHA256: ${digest('good package')}`,
      `Package: libtampered\nArchitecture: amd64\nVersion: 1.0-1\nSHA256: ${digest('real package')}`,
      `Package: libsuperseded\nArchitecture: amd64\nVersion: 1.0-2\nSHA256: ${digest('old package')}`,
    ].join('\n\n'));
    const { accepted, rejected } = await verifyArchives(directory, Object.keys(files), records);
    assert.deepEqual(accepted, ['libgood_1.0-1_amd64.deb']);
    assert.deepEqual(rejected, [
      { name: 'libtampered_1.0-1_amd64.deb', reason: 'SHA-256 differs from the signed package index' },
      { name: 'libsuperseded_1.0-1_amd64.deb', reason: 'not in the signed package index' },
      { name: 'not-an-archive.deb', reason: 'not an apt archive name' },
    ]);
    // With no index at all, nothing is trusted.
    assert.deepEqual((await verifyArchives(directory, Object.keys(files), new Map())).accepted, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the next run keeps only archives of the exact package versions dpkg has installed', () => {
  const dpkg = ['ii \tlibwoff1\tamd64\t1.0.2-2build1', 'ii \tlibglib2.0-0t64\tamd64\t2.80.0-6ubuntu3.10', 'rc \tlibremoved\tamd64\t1.0', 'ii \tfonts-ipafont-gothic\tall\t00303-21ubuntu1',
    'ii \tlibx264-164\tamd64\t2:0.164.3108+git31e19f9-1', 'un \tlibnever\tamd64\t'].join('\n');
  assert.deepEqual(installedArchives([
    'libwoff1_1.0.2-2build1_amd64.deb', 'libglib2.0-0t64_2.80.0-6ubuntu3.10_amd64.deb', 'libglib2.0-0t64_2.80.0-6ubuntu3.4_amd64.deb',
    'libremoved_1.0_amd64.deb', 'fonts-ipafont-gothic_00303-21ubuntu1_all.deb', 'libx264-164_2%3a0.164.3108+git31e19f9-1_amd64.deb', 'libwoff1_1.0.2-2build1_arm64.deb', 'lock',
  ], dpkg), ['libwoff1_1.0.2-2build1_amd64.deb', 'libglib2.0-0t64_2.80.0-6ubuntu3.10_amd64.deb', 'fonts-ipafont-gothic_00303-21ubuntu1_all.deb', 'libx264-164_2%3a0.164.3108+git31e19f9-1_amd64.deb']);
  assert.deepEqual(installedArchives(['libwoff1_1.0.2-2build1_amd64.deb'], ''), []);
});
