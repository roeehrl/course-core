import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The API serves the pinned Pyodide files and the learner app refuses any other bytes. Both pin
// the same version and the same SHA-256/size per file, and the API module locks that version.
const root = new URL('../', import.meta.url);
const read = (relative) => readFile(new URL(relative, root), 'utf8');
const pins = (text) => [...text.matchAll(/"?([a-z_.-]+\.(?:js|mjs|wasm|zip|json))"?\s*[:,]\s*\{?\s*(?:name:\s*'[^']+',\s*)?sha256:\s*['"]([a-f0-9]{64})['"],\s*size:\s*([\d_]+)/g)]
  .map(([, name, sha256, size]) => ({ name, sha256, size: Number(size.replaceAll('_', '')) }));
const apiPins = (text) => [...text.matchAll(/\{ name: '([^']+)', sha256: '([a-f0-9]{64})', size: ([\d_]+) \}/g)]
  .map(([, name, sha256, size]) => ({ name, sha256, size: Number(size.replaceAll('_', '')) }));

test('API and learner pin the same Pyodide release and files', async () => {
  const api = await read('services/api/src/python-runner.ts'), learner = await read('apps/learner/src/connected/pythonRunner.ts');
  const served = apiPins(api), accepted = pins(learner);
  assert.equal(served.length, 5);
  assert.deepEqual(accepted, served);
  const version = /PYODIDE_VERSION = '([^']+)'/.exec(api)?.[1];
  assert.equal(/version: "([^"]+)"/.exec(learner)?.[1], version);
  const manifest = JSON.parse(await read('services/api/package.json')), lock = JSON.parse(await read('services/api/package-lock.json'));
  assert.equal(manifest.dependencies.pyodide, version, 'the API depends on the exact pinned version');
  const locked = lock.packages['node_modules/pyodide'];
  assert.equal(locked.version, version);
  assert.match(locked.resolved, /^https:\/\/registry\.npmjs\.org\/pyodide\/-\/pyodide-[\d.]+\.tgz$/);
  assert.match(locked.integrity, /^sha512-/);
  assert.equal(locked.license, 'MPL-2.0');
});
