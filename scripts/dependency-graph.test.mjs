import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveModuleGraph } from './dependency-graph.mjs';
import { MODULES, localModuleTarget, testDatabaseUrl } from './modules.mjs';
import { auditDependencies } from './public-policy.mjs';

async function fixture(body) {
  const root = await mkdtemp(path.join(tmpdir(), 'course-core-graph-test-'));
  const seed = async (name, fields = {}) => {
    const config = MODULES[name];
    const directory = path.join(root, config.directory);
    await mkdir(directory, { recursive: true });
    const scripts = Object.fromEntries([config.build, config.typecheck, 'test', 'test:web', 'check:expo', 'test:browser', 'test:temporal', 'test:docker', 'test:practical'].map((key) => [key, 'node synthetic-check.mjs']));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name: `@course-core/${name}`, version: '0.1.0', private: true, license: 'Apache-2.0', scripts, ...fields,
    }));
    await writeFile(path.join(directory, 'package-lock.json'), '{}');
  };
  try { await body(root, seed); } finally { await rm(root, { recursive: true, force: true }); }
}

test('recursive graph orders API and learner dependencies and deduplicates shared prerequisites', async () => {
  await fixture(async (root, seed) => {
    await seed('policy');
    await seed('providers', { dependencies: { '@course-core/policy': 'file:../policy' } });
    await seed('supervisor', { devDependencies: { '@course-core/providers': 'file:../../packages/providers' } });
    await seed('api', { dependencies: { '@course-core/supervisor': 'file:../supervisor', '@course-core/providers': 'file:../../packages/providers', '@course-core/policy': 'file:../../packages/policy' } });
    await seed('visuals', { optionalDependencies: { '@course-core/providers': 'file:../providers' } });
    await seed('learner', { dependencies: { '@course-core/visuals': 'file:../../packages/visuals' } });
    const graph = await resolveModuleGraph(['api', 'api'], { root, extraRoots: ['learner'] });
    assert.deepEqual(new Set(graph.order), new Set(['policy', 'providers', 'supervisor', 'api', 'visuals', 'learner']));
    assert.equal(graph.order.length, new Set(graph.order).size);
    for (const [consumer, dependencies] of graph.dependencies) {
      for (const dependency of dependencies) assert.ok(graph.order.indexOf(dependency) < graph.order.indexOf(consumer));
    }
    assert.deepEqual(graph.dependencies.get('api'), ['policy', 'providers', 'supervisor']);
    assert.deepEqual(graph.dependencies.get('learner'), ['visuals']);
  });
});

test('web selection includes local peers and does not select unrelated service modules', async () => {
  await fixture(async (root, seed) => {
    await seed('visuals');
    await seed('learner', { dependencies: { '@course-core/visuals': 'file:../../packages/visuals' } });
    await seed('admin', { peerDependencies: { '@course-core/visuals': 'file:../../packages/visuals' } });
    const graph = await resolveModuleGraph(['learner', 'admin'], { root });
    assert.deepEqual(graph.order, ['visuals', 'learner', 'admin']);
  });
});

test('a first-party module without explicit license metadata fails before any dependency build', async()=>{
  await fixture(async(root,seed)=>{await seed('policy',{license:undefined});await assert.rejects(resolveModuleGraph(['policy'],{root}),/identity\/license/);});
});

test('sandbox participates in the same local dependency DAG and requires Docker qualification metadata', async () => {
  await fixture(async (root, seed) => {
    await seed('sandbox');
    await seed('api', { dependencies: { '@course-core/sandbox': 'file:../../packages/sandbox' } });
    const graph = await resolveModuleGraph(['api'], { root });
    assert.deepEqual(graph.order, ['sandbox', 'api']);
    assert.equal(graph.modules.get('sandbox').docker, 'test:docker');
    await seed('sandbox', { scripts: { typecheck: 'tsc', build: 'tsc', test: 'node synthetic.mjs' } });
    await assert.rejects(resolveModuleGraph(['api'], { root }), /required npm script test:docker is missing/);
  });
});

test('browser artifact roots do not fabricate a reverse package edge', async () => {
  await fixture(async (root, seed) => {
    await seed('api');
    await seed('learner', { dependencies: { '@course-core/api': 'file:../../services/api' } });
    const graph = await resolveModuleGraph(['api'], { root, extraRoots: ['learner'] });
    assert.deepEqual(graph.order, ['api', 'learner']);
    assert.deepEqual(graph.dependencies.get('api'), []);
  });
});

test('cycles and self-dependencies fail before any install or build', async () => {
  await fixture(async (root, seed) => {
    await seed('policy', { dependencies: { '@course-core/providers': 'file:../providers' } });
    await seed('providers', { dependencies: { '@course-core/policy': 'file:../policy' } });
    await assert.rejects(resolveModuleGraph(['policy'], { root }), /Local dependency cycle: policy -> providers -> policy/);
    await seed('policy', { dependencies: { '@course-core/policy': 'file:.' } });
    await assert.rejects(resolveModuleGraph(['policy'], { root }), /Local dependency cycle: policy -> policy/);
  });
});

test('unknown names, substituted paths, outside paths, and a local SDK are rejected', async () => {
  await fixture(async (root, seed) => {
    await seed('policy');
    const directory = path.join(root, 'services/api');
    for (const [name, spec] of [
      ['@course-core/unknown', 'file:../../packages/policy'],
      ['@course-core/providers', 'file:../../packages/policy'],
      ['@course-core/policy', 'file:../../../another-repository'],
      ['@course-core/policy', 'file:' + path.join(root, 'packages/policy')],
      ['@course-core/sdk', 'file:../../packages/policy'],
    ]) {
      assert.equal(localModuleTarget(name, spec, directory, root), undefined);
      await seed('api', { dependencies: { [name]: spec } });
      await assert.rejects(resolveModuleGraph(['api'], { root }), /unapproved local dependency/);
    }
  });
});

test('missing or symlinked dependency modules fail instead of falling back to stale dist', async () => {
  await fixture(async (root, seed) => {
    await seed('learner', { dependencies: { '@course-core/visuals': 'file:../../packages/visuals' } });
    await assert.rejects(resolveModuleGraph(['learner'], { root }), /Required integration file is missing/);
    await seed('providers');
    await symlink(path.join(root, 'packages/providers'), path.join(root, 'packages/visuals'));
    await assert.rejects(resolveModuleGraph(['learner'], { root }), /must not redirect through a symlink/);
  });
});

test('local lock entries use their own relative paths and can declare a transitive SDK release', () => {
  const root = path.join(tmpdir(), 'course-core-transitive-lock');
  const directory = path.join(root, 'services/api');
  const manifest = { name: '@course-core/api', version: '0.1.0', dependencies: { '@course-core/providers': 'file:../../packages/providers' } };
  const release = 'https://github.com/roeehrl/course-sdk/releases/download/v0.1.0/course-core-sdk-0.1.0.tgz';
  const lock = { ...manifest, lockfileVersion: 3, packages: {
    '': manifest,
    // Deliberately before the declaring local package: object insertion order must not matter.
    'node_modules/@course-core/sdk': { resolved: release, integrity: 'sha512-' + 'A'.repeat(86) + '==' },
    'node_modules/@course-core/providers': { resolved: '../../packages/providers', link: true },
    '../../packages/providers': { name: '@course-core/providers', dependencies: { '@course-core/policy': 'file:../policy', '@course-core/sdk': release } },
    'node_modules/@course-core/policy': { resolved: '../../packages/policy', link: true },
    '../../packages/policy': { name: '@course-core/policy' },
  } };
  assert.doesNotThrow(() => auditDependencies(manifest, lock, directory, root, 'synthetic'));
  const wrong = structuredClone(lock);
  wrong.packages['../../packages/providers'].dependencies['@course-core/policy'] = 'file:../visuals';
  assert.throws(() => auditDependencies(manifest, wrong, directory, root, 'synthetic'), /name and path/);
});

test('the dedicated loopback test-name format supports passwordless local development without opening a connection', () => {
  assert.equal(testDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://test_runner@127.0.0.1:5432/course_core_test_parent' }).pathname, '/course_core_test_parent');
});

test('install-links copied packages are allowed only for matching registered names and paths', () => {
  const root = path.join(tmpdir(), 'course-core-copied-lock');
  const directory = path.join(root, 'apps/learner');
  const manifest = { name: '@course-core/learner', version: '0.1.0', dependencies: { '@course-core/visuals': 'file:../../packages/visuals' } };
  const release = 'https://github.com/roeehrl/course-sdk/releases/download/v0.1.0/course-core-sdk-0.1.0.tgz';
  const lock = { ...manifest, lockfileVersion: 3, packages: {
    '': manifest,
    'node_modules/@course-core/visuals': { version: '0.1.0', resolved: 'file:../../packages/visuals', dependencies: { '@course-core/sdk': release } },
    'node_modules/@course-core/sdk': { resolved: release, integrity: 'sha512-' + 'A'.repeat(86) + '==' },
  } };
  assert.doesNotThrow(() => auditDependencies(manifest, lock, directory, root, 'synthetic'));
  for (const resolved of ['file:../../packages/providers', 'file:../../../another-repository']) {
    const changed = structuredClone(lock);
    changed.packages['node_modules/@course-core/visuals'].resolved = resolved;
    assert.throws(() => auditDependencies(manifest, changed, directory, root, 'synthetic'), /unexpected local/);
  }
});
