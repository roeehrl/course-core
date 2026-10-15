import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MODULES, ROOT, readJson } from './modules.mjs';
import { auditLocalInstallMode } from './public-policy.mjs';

const release = 'https://github.com/roeehrl/course-sdk/releases/download/v0.1.0/course-core-sdk-0.1.0.tgz';
const copied = { version: '0.1.0', resolved: 'file:../policy' };
const linked = { resolved: '../policy', link: true };

test('only copiesLocal app modules may install local modules as copies', () => {
  const lock = (entry) => ({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@course-core/policy': entry,
    'node_modules/@course-core/sdk': { resolved: release, integrity: 'sha512-' + 'A'.repeat(86) + '==' } } });
  assert.doesNotThrow(() => auditLocalInstallMode('adaptation', lock(linked), 'install-links=false\n'));
  assert.doesNotThrow(() => auditLocalInstallMode('adaptation', lock(linked)));
  assert.throws(() => auditLocalInstallMode('adaptation', lock(copied), 'install-links=false\n'), /copied local module/);
  assert.throws(() => auditLocalInstallMode('adaptation', lock(linked), 'install-links=true\n'), /must be linked/);
  assert.throws(() => auditLocalInstallMode('api', lock(linked), 'cache=.npm-cache\n install-links = true \n'), /must be linked/);
  // The Expo/Metro apps keep copies; their lock form is unchanged.
  assert.doesNotThrow(() => auditLocalInstallMode('learner', lock(copied), 'install-links=true\n'));
  assert.doesNotThrow(() => auditLocalInstallMode('admin', lock(copied), 'install-links=true\n'));
  assert.throws(() => auditLocalInstallMode('unknown', lock(linked)), /unknown module/);
});

test('repository modules link local prerequisites; adaptation links policy', async () => {
  for (const [name, config] of Object.entries(MODULES)) {
    const directory = path.join(ROOT, config.directory);
    let npmrc = '';
    try { npmrc = await readFile(path.join(directory, '.npmrc'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lock = await readJson(path.join(directory, 'package-lock.json'));
    assert.doesNotThrow(() => auditLocalInstallMode(name, lock, npmrc), name);
  }
  const lock = await readJson(path.join(ROOT, MODULES.adaptation.directory, 'package-lock.json'));
  assert.deepEqual(lock.packages['node_modules/@course-core/policy'], linked);
  assert.equal(lock.packages['../policy'].name, '@course-core/policy');
});

// Real npm, no network: a consumer using adaptation's own .npmrc sees a rebuilt
// prerequisite immediately, while the install-links=true control keeps a stale copy.
test('adaptation npm configuration resolves a rebuilt local module without reinstalling', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'course-core-local-links-'));
  try {
    const config = path.join(root, 'npm-config');
    await mkdir(config);
    await writeFile(path.join(config, 'user.npmrc'), 'ignore-scripts=true\naudit=false\nfund=false\nworkspaces=false\n');
    await writeFile(path.join(config, 'global.npmrc'), '');
    const env = { PATH: process.env.PATH, HOME: root, NPM_CONFIG_USERCONFIG: path.join(config, 'user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: path.join(config, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(config, 'cache'),
      NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_OFFLINE: 'true' };
    const policy = path.join(root, 'packages/policy');
    await mkdir(path.join(policy, 'dist'), { recursive: true });
    await writeFile(path.join(policy, 'package.json'), JSON.stringify({ name: '@course-core/policy', version: '0.1.0', type: 'module',
      exports: './dist/index.js', files: ['dist'] }));
    const build = (value) => writeFile(path.join(policy, 'dist/index.js'), `export const revision = ${value};\n`);
    await build(1);
    const consumer = async (name, npmrc) => {
      const directory = path.join(root, 'packages', name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, '.npmrc'), npmrc);
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `@course-core/${name}`, version: '0.1.0', private: true,
        type: 'module', dependencies: { '@course-core/policy': 'file:../policy' } }));
      const install = spawnSync('npm', ['install', '--ignore-scripts', '--workspaces=false'], { cwd: directory, env, encoding: 'utf8', timeout: 60000 });
      assert.equal(install.status, 0, install.stderr);
      return directory;
    };
    const revision = (directory) => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import('@course-core/policy').then((m) => console.log(m.revision))"],
        { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return Number(result.stdout.trim());
    };
    const adaptation = await consumer('adaptation', await readFile(path.join(ROOT, MODULES.adaptation.directory, '.npmrc'), 'utf8'));
    const control = await consumer('control', 'install-links=true\n');
    assert.equal((await lstat(path.join(adaptation, 'node_modules/@course-core/policy'))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(control, 'node_modules/@course-core/policy'))).isSymbolicLink(), false);
    assert.deepEqual((await readJson(path.join(adaptation, 'package-lock.json'))).packages['node_modules/@course-core/policy'], linked);
    const controlLock = await readJson(path.join(control, 'package-lock.json'));
    assert.throws(() => auditLocalInstallMode('adaptation', controlLock), /copied local module/);
    await build(2);
    assert.equal(revision(adaptation), 2, 'linked consumer sees the rebuilt prerequisite');
    assert.equal(revision(control), 1, 'control: an install-links copy stays stale until reinstalled');
  } finally { await rm(root, { recursive: true, force: true }); }
});
