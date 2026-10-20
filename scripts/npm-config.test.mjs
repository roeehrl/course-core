import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MODULES, ROOT } from './modules.mjs';
import { requireFetchRetries, requireIgnoreScripts } from './public-policy.mjs';

test('every module .npmrc disables install scripts on its own', async () => {
  for (const { directory } of Object.values(MODULES)) {
    const label = `${directory}/.npmrc`;
    let text;
    try { text = await readFile(path.join(ROOT, label), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.doesNotThrow(() => requireIgnoreScripts(label, text), label);
  }
});

test('a module .npmrc without an active ignore-scripts=true is refused', () => {
  assert.throws(() => requireIgnoreScripts('m/.npmrc', undefined), /missing; it must set ignore-scripts=true/);
  assert.throws(() => requireIgnoreScripts('m/.npmrc', ''), /must set ignore-scripts=true/);
  assert.throws(() => requireIgnoreScripts('m/.npmrc', 'install-links=false\n'), /must set ignore-scripts=true/);
  assert.throws(() => requireIgnoreScripts('m/.npmrc', '# ignore-scripts=true\n;ignore-scripts=true\n'), /must set ignore-scripts=true/);
  assert.throws(() => requireIgnoreScripts('m/.npmrc', 'ignore-scripts=false\n'), /install hooks must remain disabled/);
  assert.throws(() => requireIgnoreScripts('m/.npmrc', 'ignore-scripts=true\nignore-scripts=false\n'), /install hooks must remain disabled/);
  assert.throws(() => requireIgnoreScripts('m/.npmrc', 'ignore-scripts=true\n//registry.npmjs.org/:_authToken=x\n'), /credentials/);
  assert.doesNotThrow(() => requireIgnoreScripts('m/.npmrc', 'install-links=true\r\n ignore-scripts = true \r\n'));
});

test('every module .npmrc retries transient download failures with bounded backoff', async () => {
  for (const { directory } of Object.values(MODULES)) {
    const label = `${directory}/.npmrc`;
    const text = await readFile(path.join(ROOT, label), 'utf8');
    assert.doesNotThrow(() => requireFetchRetries(label, text), label);
    // Retries never replace the install-hook rule.
    assert.doesNotThrow(() => requireIgnoreScripts(label, text), label);
  }
});

test('a module .npmrc without bounded fetch retries is refused', () => {
  const retries = 'fetch-retries=5\nfetch-retry-mintimeout=10000\nfetch-retry-maxtimeout=60000\n';
  assert.doesNotThrow(() => requireFetchRetries('m/.npmrc', `ignore-scripts=true\n${retries}`));
  assert.throws(() => requireFetchRetries('m/.npmrc', undefined), /missing; it must set fetch retries/);
  assert.throws(() => requireFetchRetries('m/.npmrc', 'ignore-scripts=true\n'), /must set fetch-retries/);
  assert.throws(() => requireFetchRetries('m/.npmrc', 'ignore-scripts=true\nfetch-retries=5\n'), /must set fetch-retry-mintimeout/);
  assert.throws(() => requireFetchRetries('m/.npmrc', '# fetch-retries=5\nfetch-retry-mintimeout=10000\nfetch-retry-maxtimeout=60000\n'), /must set fetch-retries/);
  for (const bad of ['fetch-retries=0', 'fetch-retries=11', 'fetch-retries=five', 'fetch-retries=-1', 'fetch-retries=2.5', 'fetch-retry-mintimeout=0', 'fetch-retry-maxtimeout=999999'])
    assert.throws(() => requireFetchRetries('m/.npmrc', `${retries}${bad}\n`), /must be an integer/, bad);
  assert.throws(() => requireFetchRetries('m/.npmrc', 'fetch-retries=5\nfetch-retry-mintimeout=60000\nfetch-retry-maxtimeout=10000\n'), /must not exceed/);
  // Retries never relax the install-hook rule or permit credentials.
  assert.throws(() => requireIgnoreScripts('m/.npmrc', retries), /must set ignore-scripts=true/);
  assert.throws(() => requireFetchRetries('m/.npmrc', `ignore-scripts=false\n${retries}`), /install hooks must remain disabled/);
  assert.throws(() => requireFetchRetries('m/.npmrc', `${retries}//registry.npmjs.org/:_authToken=x\n`), /credentials/);
});

test('no locked dependency is allowed to need an install script', async () => {
  // Locks may declare hooks (esbuild, @swc/core, protobufjs, fsevents); none may be required,
  // because every install path runs with scripts disabled. This records the reviewed set.
  const reviewed = new Set(['esbuild', '@swc/core', 'protobufjs', 'fsevents']);
  for (const { directory } of Object.values(MODULES)) {
    const lock = JSON.parse(await readFile(path.join(ROOT, directory, 'package-lock.json'), 'utf8'));
    for (const [key, entry] of Object.entries(lock.packages ?? {})) {
      if (!entry.hasInstallScript) continue;
      const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      assert.ok(reviewed.has(name), `${directory}: ${name} declares an install script; review whether it works with scripts disabled`);
    }
  }
});
