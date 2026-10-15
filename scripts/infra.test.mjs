import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditDependencies, auditFilename, auditNpmrc, auditRepositoryReferences, auditText } from './public-policy.mjs';
import { readModule, requireReleasedSdk, sdkReleaseUrl, targets, testDatabaseUrl } from './modules.mjs';
import { browserPortEnv, preflight, withCheckoutLock } from './orchestrate.mjs';

const owner = 'roeehrl';
const internal = 'synthetic-internal-example';
const release = `https://github.com/${owner}/course-sdk/releases/download/v0.1.0/course-core-sdk-0.1.0.tgz`;

test('owner repository allowlist covers URL forms without denying other owners or profiles', () => {
  for (const repository of ['course-core', 'course-sdk', internal, 'course-core-backup']) {
    const urls = [
      `https://github.com/${owner}/${repository}`, `git@github.com:${owner}/${repository}.git`,
      `git+ssh://git@github.com/${owner}/${repository}.git`, `ssh://git@github.com:22/${owner}/${repository}.git`,
      `https://raw.githubusercontent.com/${owner}/${repository}/main/example.json`,
      `https://api.github.com/repos/${owner}/${repository}/contents/example.json`,
      `https://codeload.github.com/${owner}/${repository}/tar.gz/main`,
      `https://github.com/${owner}/course-core/%2E%2E/${repository}`,
    ];
    for (const url of urls.flatMap((value) => [value, value.toUpperCase(), value.replaceAll('-', '%2D'), value.replaceAll('/', '\\/')])) {
      if (repository === internal || repository.endsWith('-backup')) assert.throws(() => auditRepositoryReferences('synthetic', url), /allowlist/);
      else assert.doesNotThrow(() => auditRepositoryReferences('synthetic', `[repo](${url}).`));
    }
  }
  for (const url of [`https://github.com/${owner}`, `https://github.com/another-owner/${internal}`,
    `https://notgithub.com/${owner}/${internal}`, `https://example.invalid/github.com/${owner}/${internal}`]) {
    assert.doesNotThrow(() => auditRepositoryReferences('synthetic', url));
  }
});

test('sensitive content fails with redacted diagnostics; ordinary contracts remain valid', () => {
  for (const secret of ['ghp_' + 'a'.repeat(36), 'npm_' + 'a'.repeat(36),
    '-----BEGIN ' + 'PRIVATE KEY-----', '/Users/' + 'someone/project/file', 'https://user:' + 'secret@example.invalid/']) {
    assert.throws(() => auditText('synthetic', secret), (error) => error.message.includes('redacted') && !error.message.includes(secret));
  }
  assert.doesNotThrow(() => auditText('synthetic', 'interface Profile { learnerId: string; apiKey?: string }'));
  assert.doesNotThrow(() => auditText('synthetic', 'https://user:password@example.org'));
  const rejectedMediaUrl = ['https://user:', 'key@storage.googleapis.com/video'].join('');
  assert.doesNotThrow(() => auditText('test/negative.test.mjs', rejectedMediaUrl));
  assert.throws(() => auditText('src/client.mjs', rejectedMediaUrl), /credential/);
  assert.doesNotThrow(() => auditText('synthetic', 'postgres://course_ci:course_ci_test_only@127.0.0.1:5432/course_core_ci'));
  assert.throws(() => auditText('synthetic', ['postgres://', 'real:credential@db.example.invalid/live'].join('')), /credential/);
});

test('private configuration and unsafe npm settings are rejected', () => {
  for (const name of ['.env', 'services/api/.env.production', 'private.pem', 'records.sqlite', '.gitmodules']) assert.throws(() => auditFilename(name));
  assert.doesNotThrow(() => auditFilename('services/api/.env.example'));
  assert.doesNotThrow(() => auditNpmrc('synthetic', 'workspaces=false\ncache=.npm-cache\nregistry=https://registry.npmjs.org/\ninstall-links=true\n'));
  for (const config of ['registry=https://example.invalid/', '//registry.npmjs.org/:_authToken=value', 'cache=../../outside', 'ignore-scripts=false', 'install-links=arbitrary']) assert.throws(() => auditNpmrc('synthetic', config));
});

test('SDK dependency requires a versioned release asset and no moving ref', () => {
  assert.equal(sdkReleaseUrl(release), true);
  for (const value of [release.replace('/v0.1.0/', '/latest/'), release + '?token=example', release.replace('sdk-0.1.0.tgz', 'sdk-0.2.0.tgz'), 'file:../sdk']) assert.equal(sdkReleaseUrl(value), false);
  assert.throws(() => requireReleasedSdk({ dependencies: {} }), /requires/);
  assert.doesNotThrow(() => requireReleasedSdk({ dependencies: { '@course-core/sdk': release } }));
});

test('public dependency sources and registered local module identities are enforced', () => {
  const root = path.join(tmpdir(), 'synthetic-public-core');
  const directory = path.join(root, 'services/api');
  const manifest = { name: '@course-core/api', version: '0.1.0', dependencies: { example: '^1.0.0', '@course-core/sdk': release, '@course-core/policy': 'file:../../packages/policy', '@course-core/supervisor': 'file:../supervisor' } };
  const integrity = 'sha512-' + 'A'.repeat(86) + '==';
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    '': manifest,
    'node_modules/example': { resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity },
    'node_modules/@course-core/sdk': { resolved: release, integrity },
    'node_modules/@course-core/policy': { resolved: '../../packages/policy', link: true },
    '../../packages/policy': { name: '@course-core/policy', version: '0.1.0' },
    'node_modules/@course-core/supervisor': { resolved: '../supervisor', link: true },
    '../supervisor': { name: '@course-core/supervisor', version: '0.1.0' },
  } };
  assert.doesNotThrow(() => auditDependencies(manifest, lock, directory, root, 'synthetic'));
  for (const change of [
    (copy) => { copy.packages['node_modules/example'].resolved = 'https://example.invalid/a.tgz'; },
    (copy) => { delete copy.packages['node_modules/example'].integrity; },
    (copy) => { copy.packages['node_modules/@course-core/sdk'].resolved = 'https://registry.npmjs.org/@course-core/sdk/-/sdk-0.1.0.tgz'; },
    (copy) => { copy.packages['node_modules/@course-core/policy'].resolved = '../../../another-repository'; },
    (copy) => { copy.packages['node_modules/@course-core/supervisor'].resolved = '../../packages/providers'; },
    (copy) => { copy.packages['../supervisor'].name = '@course-core/policy'; },
  ]) {
    const copy = structuredClone(lock); change(copy);
    assert.throws(() => auditDependencies(manifest, copy, directory, root, 'synthetic'));
  }
});

test('API guards require an explicit disposable loopback test database', () => {
  const value = 'postgres://course_ci:course_ci_test_only@127.0.0.1:5432/course_core_ci';
  assert.equal(testDatabaseUrl({ TEST_DATABASE_URL: value }).pathname, '/course_core_ci');
  for (const environment of [{}, { TEST_DATABASE_URL: value, DATABASE_URL: value },
    { TEST_DATABASE_URL: value.replace('127.0.0.1', 'db.example.invalid') },
    { TEST_DATABASE_URL: value.replace('/course_core_ci', '/application') },
    { TEST_DATABASE_URL: value + '?options=override' }]) assert.throws(() => testDatabaseUrl(environment));
});

test('required module selection never silently omits a module', () => {
  assert.deepEqual(targets('all'), ['policy', 'providers', 'adaptation', 'research', 'example-courses', 'sandbox', 'visuals', 'api', 'supervisor', 'learner', 'admin']);
  assert.deepEqual(targets('web'), ['learner', 'admin']);
  assert.throws(() => targets('unknown'));
});

test('a missing required module fails instead of being skipped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'course-core-missing-module-'));
  try { await assert.rejects(readModule('supervisor', root), /Required integration file is missing/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('API cannot pass preflight without its connected browser script, host, and suite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'course-core-api-browser-gate-'));
  const directory = path.join(root, 'services/api');
  const manifest = { name: '@course-core/api', version: '0.1.0', private: true, license: 'Apache-2.0',
    dependencies: { '@course-core/sdk': release }, scripts: { typecheck: 'tsc --noEmit', build: 'tsc', test: 'vitest run test' } };
  try {
    await mkdir(path.join(directory, 'test'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
    await writeFile(path.join(directory, 'package-lock.json'), '{}');
    await assert.rejects(readModule('api', root), /required npm script test:browser is missing/);
    manifest.scripts['test:browser'] = 'playwright test';
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(readModule('api', root), /required npm script test:practical is missing/);
    manifest.scripts['test:practical'] = 'tsx qualification/practical-flow.ts';
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest));
    const module = await readModule('api', root);
    await writeFile(path.join(directory, 'test', 'database.test.ts'), '// TEST_DATABASE_URL');
    await assert.rejects(preflight('api', module), /API disposable browser host/);
    await mkdir(path.join(directory, 'browser'));
    await writeFile(path.join(directory, 'browser', 'start.ts'), '// Synthetic host marker, not an application test.');
    await assert.rejects(preflight('api', module), /API connected learner browser suite/);
    await writeFile(path.join(directory, 'browser', 'learner.spec.ts'), '// Synthetic suite marker, not an application test.');
    await writeFile(path.join(directory, 'playwright.config.ts'), 'export default {};');
    await assert.rejects(preflight('api', module), /practical qualification/);
    await mkdir(path.join(directory, 'qualification'));
    await writeFile(path.join(directory, 'qualification', 'practical-flow.ts'), '// Synthetic presence check only.');
    await assert.doesNotReject(preflight('api', module));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkout lock rejects overlapping root commands and releases after a failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'course-core-lock-test-'));
  try {
    await withCheckoutLock(root, async () => {
      await assert.rejects(withCheckoutLock(root, async () => {}), /Another root command/);
    });
    await assert.rejects(withCheckoutLock(root, async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
    await withCheckoutLock(root, async () => {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('root commands pick browser-host ports from the caller, not the forced child CI flag', () => {
  assert.deepEqual(browserPortEnv({ CI: 'true' }), { COURSE_BROWSER_PORTS: 'fixed' });
  assert.deepEqual(browserPortEnv({}), { COURSE_BROWSER_PORTS: 'free' });
  assert.deepEqual(browserPortEnv({ CI: 'false' }), { COURSE_BROWSER_PORTS: 'free' });
  assert.deepEqual(browserPortEnv({ CI: 'true', COURSE_BROWSER_PORT: '5517', COURSE_BROWSER_PASSKEY_PORT: '5518', UNRELATED: 'x' }),
    { COURSE_BROWSER_PORTS: 'fixed', COURSE_BROWSER_PORT: '5517', COURSE_BROWSER_PASSKEY_PORT: '5518' });
  assert.deepEqual(browserPortEnv({ COURSE_BROWSER_PORTS: 'fixed', COURSE_BROWSER_PORT: '' }), { COURSE_BROWSER_PORTS: 'fixed' });
});
