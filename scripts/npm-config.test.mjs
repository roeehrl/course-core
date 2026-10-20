import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MODULES, ROOT } from './modules.mjs';
import { requireIgnoreScripts } from './public-policy.mjs';

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
