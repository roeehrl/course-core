import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from './modules.mjs';
import { compareReleases, compareVersions, compatibilityMatrix, directorySource, forwardDifferences, nodeRange, packageAcceptance,
  previousReleaseTag, publishedReleaseTags, rollbackDifferences, supportedSdkRange } from './release-compat.mjs';

const sdkUrl = version => `https://github.com/roeehrl/course-sdk/releases/download/v${version}/course-core-sdk-${version}.tgz`;
/** An in-memory source tree over the real one, with selected files replaced. */
function overlay(changes) {
  const real = directorySource(ROOT);
  return { label: 'overlay', read: file => Object.hasOwn(changes, file) ? changes[file] : real.read(file), list: real.list };
}

test('compatibility versions follow semantic version order and the API package rule', async () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareVersions('1.0', '1.0.0'));
  assert.deepEqual(supportedSdkRange('0.5.3'), { min: '0.5.0', maxExclusive: '0.6.0' });
  assert.deepEqual(supportedSdkRange('2.1.0'), { min: '2.1.0', maxExclusive: '3.0.0' });
  assert.equal(packageAcceptance('0.5.0', '0.5.9'), 'supported');
  assert.equal(packageAcceptance('0.6.0', '0.5.0'), 'install_with_warning');
  assert.equal(packageAcceptance('1.0.0', '0.5.0'), 'refused');
  // A newer 0.x minor than the pin is refused: its bundle may use contracts this Core cannot check.
  assert.equal(packageAcceptance('0.5.0', '0.6.0'), 'refused');
  assert.equal(packageAcceptance('0.5.3', '0.5.0'), 'supported');
  assert.equal(packageAcceptance('0.6.0', '0.6.4'), 'supported');
  assert.equal(packageAcceptance('0.6.0', '0.7.0'), 'refused');
  // A pre-release of the upper bound already carries that version's data (the API's sdkPackageStatus agrees).
  assert.equal(packageAcceptance('0.6.0', '0.7.0-rc.1'), 'refused');
  assert.equal(packageAcceptance('0.6.0', '0.6.5-rc.1'), 'supported');
  assert.equal(packageAcceptance('1.2.0', '1.9.0'), 'supported');
  assert.equal(packageAcceptance('1.2.0', '2.0.0'), 'refused');
  assert.equal(packageAcceptance('1.2.0', '1.1.0'), 'install_with_warning');
  // The same rule as the API's package preview; keep both in step.
  const api = await readFile(new URL('../services/api/src/course-package-routes.ts', import.meta.url), 'utf8');
  assert.ok(api.includes("maxExclusive: major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`"), 'supportedSdkRange in the API changed');
  assert.deepEqual(nodeRange('>=26 <27'), { min: 26, maxExclusive: 27 });
  assert.deepEqual(nodeRange('>=24'), { min: 24 });
  assert.throws(() => nodeRange('^26'));
});

test('the compatibility matrix describes this tree and refuses inconsistent pins', async () => {
  const matrix = await compatibilityMatrix(directorySource(ROOT));
  const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(matrix.core, root.version);
  assert.equal(matrix.node.engines, root.engines.node);
  assert.equal(matrix.postgres.major, 17);
  assert.match(matrix.sdk.release, /^\d+\.\d+\.\d+$/);
  assert.match(matrix.migrations.last, /^\d{3}_[a-z0-9_]+\.sql$/);
  const api = JSON.parse(await readFile(new URL('../services/api/package.json', import.meta.url), 'utf8'));
  const mixed = overlay({ 'services/api/package.json': JSON.stringify({ ...api, dependencies: { ...api.dependencies, '@course-core/sdk': sdkUrl('0.4.0') } }) });
  await assert.rejects(compatibilityMatrix(mixed), /same SDK release/);
  const unpinned = overlay({ 'services/api/package.json': JSON.stringify({ ...api, dependencies: { ...api.dependencies, '@course-core/sdk': 'file:../../../course-sdk' } }) });
  await assert.rejects(compatibilityMatrix(unpinned), /released SDK archive/);
  const oldNode = overlay({ 'services/api/package.json': JSON.stringify({ ...api, engines: { node: '>=27' } }) });
  await assert.rejects(compatibilityMatrix(oldNode), /supported Node/);
});

test('a candidate fails against the previous release on edited migrations, refused packages or no version bump', () => {
  const matrix = (core, sdk, postgres = 17) => ({ core, sdk: { release: sdk }, postgres: { major: postgres }, node: { engines: '>=26 <27' } });
  const ok = compareReleases(matrix('0.1.0', '0.5.0'), matrix('0.2.0', '0.6.0'), { '001_a.sql': 'x' }, { '001_a.sql': 'x', '002_b.sql': 'y' });
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.coursePackagesFromPreviousSdk, 'install_with_warning');
  assert.deepEqual(ok.addedMigrations, ['002_b.sql']);
  const bad = compareReleases(matrix('0.2.0', '0.5.0', 17), matrix('0.2.0', '1.0.0', 16), { '001_a.sql': 'x', '002_b.sql': 'y' }, { '001_a.sql': 'changed' });
  assert.equal(bad.findings.length, 5);
  for (const pattern of [/not newer/, /would be refused/, /PostgreSQL 16/, /001_a\.sql was edited/, /002_b\.sql was removed/])
    assert.ok(bad.findings.some(finding => pattern.test(finding)), String(pattern));
  assert.ok(compareReleases(matrix('0.1.0', '0.5.0'), matrix('0.2.0', '0.4.0'), {}, {}).findings.some(f => /backwards/.test(f)));
});

test('the previous release is the newest older published release, never a dead tag', async () => {
  const all = (tags) => new Set(tags);
  assert.equal(previousReleaseTag(['v0.1.9', 'v0.1.10', 'v0.1.11', 'v0.2.0-rc.1', 'nightly'], '0.1.11', all(['v0.1.9', 'v0.1.10', 'v0.1.11'])), 'v0.1.10');
  assert.equal(previousReleaseTag(['v0.1.9', 'v0.1.10'], '0.2.0', all(['v0.1.9', 'v0.1.10'])), 'v0.1.10');
  assert.throws(() => previousReleaseTag(['v0.2.0'], '0.1.0', all(['v0.2.0'])), /No published release/);
  // Dead tags (a failed release workflow, never published or re-tagged) are skipped: 0.1.52
  // follows 0.1.50, not the dead v0.1.51.
  const tags = ['v0.1.36', 'v0.1.37', 'v0.1.49', 'v0.1.50', 'v0.1.51'];
  assert.equal(previousReleaseTag(tags, '0.1.52', all(['v0.1.49', 'v0.1.50'])), 'v0.1.50');
  assert.equal(previousReleaseTag(['v0.1.35', ...tags], '0.1.38', all(['v0.1.35', 'v0.1.49'])), 'v0.1.35');
  assert.throws(() => previousReleaseTag(tags, '0.1.52', all([])), /No published release/);
  // Without the published list there is no guessing from git tags.
  assert.throws(() => previousReleaseTag(tags, '0.1.52'), /published releases are required/);
  assert.deepEqual([...await publishedReleaseTags(ROOT, { COURSE_PUBLISHED_RELEASES: 'v0.1.49, v0.1.50\nv0.1.48' })], ['v0.1.49', 'v0.1.50', 'v0.1.48']);
  // No list and no usable GitHub CLI: an error, never a guess from git tags.
  await assert.rejects(publishedReleaseTags(ROOT, { PATH: '/nonexistent' }), /Cannot list the published releases/);
});

test('rehearsal comparisons catch dropped schema, lost rows and an inexact rollback', () => {
  const before = { columns: { users: ['id', 'name'], schema_migrations: ['digest', 'name'] }, counts: { users: 2, schema_migrations: 1 }, digests: { users: 'a', schema_migrations: 'm' } };
  const added = { columns: { users: ['id', 'name', 'locale'], audit: ['id'], schema_migrations: ['digest', 'name'] }, counts: { users: 2, audit: 0, schema_migrations: 2 }, digests: {} };
  assert.deepEqual(forwardDifferences(before, added), []);
  assert.deepEqual(forwardDifferences(before, { ...added, columns: { ...added.columns, users: ['id'] } }), ['column users.name was dropped']);
  assert.deepEqual(forwardDifferences(before, { ...added, counts: { ...added.counts, users: 1 } }), ['table users has 1 rows, expected 2']);
  assert.deepEqual(forwardDifferences(before, { columns: { schema_migrations: ['digest', 'name'] }, counts: { schema_migrations: 2 } }), ['table users was dropped']);
  assert.deepEqual(rollbackDifferences(before, structuredClone(before)), []);
  assert.deepEqual(rollbackDifferences(before, { ...before, digests: { ...before.digests, users: 'b' } }), ['table users rows differ']);
  assert.deepEqual(rollbackDifferences(before, added), ['table users columns differ', 'table schema_migrations rows differ', 'table audit columns differ']);
});

test('the published-release listing retries a transient GitHub CLI failure, and not a sign-in or 4xx failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'release-compat-gh-'));
  try {
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    // Fake gh: each run takes the next scripted stderr from outcomes.json; 'ok' lists two tags.
    await writeFile(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs'), outcomes = JSON.parse(fs.readFileSync('outcomes.json', 'utf8'));
fs.appendFileSync('runs', 'x');
const outcome = outcomes[fs.readFileSync('runs', 'utf8').length - 1];
if (outcome === 'ok') { process.stdout.write('v0.1.50\\nv0.1.49\\n'); process.exit(0); }
process.stderr.write(outcome); process.exit(1);
`);
    await chmod(path.join(bin, 'gh'), 0o755);
    const environment = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const list = async outcomes => {
      await writeFile(path.join(directory, 'outcomes.json'), JSON.stringify(outcomes)); await rm(path.join(directory, 'runs'), { force: true });
      const waits = [];
      const result = publishedReleaseTags(directory, environment, { wait: async ms => { waits.push(ms); }, log: () => {} });
      return { result, waits, runs: async () => (await readFile(path.join(directory, 'runs'), 'utf8')).length };
    };
    let attempt = await list(['HTTP 502: Bad Gateway (https://api.github.com/graphql)', 'ok']);
    assert.deepEqual([...await attempt.result], ['v0.1.50', 'v0.1.49']);
    assert.equal(await attempt.runs(), 2); assert.equal(attempt.waits.length, 1);
    for (const failure of ['HTTP 401: Bad credentials (https://api.github.com/graphql)', 'To get started with GitHub CLI, please run:  gh auth login']) {
      attempt = await list([failure, 'ok']);
      await assert.rejects(attempt.result, /Cannot list the published releases/);
      assert.equal(await attempt.runs(), 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
