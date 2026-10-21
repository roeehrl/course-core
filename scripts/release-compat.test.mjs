import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ROOT } from './modules.mjs';
import { compareReleases, compareVersions, compatibilityMatrix, directorySource, forwardDifferences, nodeRange, packageAcceptance,
  previousReleaseTag, rollbackDifferences, supportedSdkRange } from './release-compat.mjs';

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

test('the previous release is the newest older stable tag', () => {
  assert.equal(previousReleaseTag(['v0.1.9', 'v0.1.10', 'v0.1.11', 'v0.2.0-rc.1', 'nightly'], '0.1.11'), 'v0.1.10');
  assert.equal(previousReleaseTag(['v0.1.9', 'v0.1.10'], '0.2.0'), 'v0.1.10');
  assert.throws(() => previousReleaseTag(['v0.2.0'], '0.1.0'), /No released tag/);
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
