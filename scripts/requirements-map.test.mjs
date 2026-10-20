import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { coverage, danglingReferences, requirementIds, validateMap } from './requirements-map.mjs';

const commit = 'a'.repeat(40);
const map = (requirements, extra = {}) => ({ schemaVersion: 1, ids: ['A01', 'A02', 'R07'], excludedPrefixes: { V: 'Private curriculum is verified elsewhere.' },
  repositories: { sdk: { commit } }, requirements, ...extra });
const sources = (core, sdk = {}) => Object.fromEntries(Object.entries({ core, sdk }).map(([name, files]) =>
  [name, { files: new Set(Object.keys(files)), read: async file => files[file] }]));

test('requirement IDs are read from definitions, not heading or in-text cross-references', () => {
  const list = '# List (see A09)\n## A. Things (§1, P15)\nA01 First thing.\nA02 Second, unlike F09 in the design.\n\nS01 Dup. S02 Stale. S03 False mastery.\n';
  assert.deepEqual(requirementIds(list), ['A01', 'A02', 'S01', 'S02', 'S03']);
});

test('the map is structurally valid, uses only known IDs and well-formed test references', () => {
  const refs = validateMap(map({ A01: ['core:scripts/x.test.mjs', 'sdk:tests/y.test.ts::exact title'] }));
  assert.deepEqual(refs.map(r => [r.repository, r.file, r.title]), [['core', 'scripts/x.test.mjs', undefined], ['sdk', 'tests/y.test.ts', 'exact title']]);
  const bad = [
    [map({ Z99: ['core:scripts/x.test.mjs'] }), /Unknown requirement ID Z99/],
    [map({ V01: ['core:scripts/x.test.mjs'] }), /V01 belongs to an excluded group/],
    [map({ A01: [] }), /at least one test reference/],
    [map({ A01: ['core:b.test.mjs', 'core:a.test.mjs'] }), /sorted and unique/],
    [map({ A01: ['course:tests/private.test.ts'] }), /Invalid test reference/],
    [map({ A01: ['core:scripts/../secret.test.mjs'] }), /Unsafe test path/],
    [map({ A01: ['core:src/server.ts'] }), /is not a test file/],
    [map({}, { ids: ['A02', 'A01'] }), /sorted and unique/],
    [map({}, { ids: ['A01', 'V01'] }), /excluded prefix is also listed/],
    [map({}, { repositories: { sdk: { commit: 'main' } } }), /pin a full SDK commit/],
    [map({}, { excludedPrefixes: { V: 'short' } }), /stated reason/],
    [{ ...map({}), schemaVersion: 2 }, /schemaVersion 1/],
  ];
  for (const [value, message] of bad) assert.throws(() => validateMap(value), message);
});

test('dangling references fail: missing files in either repository and missing titles', async () => {
  const refs = validateMap(map({
    A01: ['core:scripts/present.test.mjs::covers the thing', 'sdk:tests/present.test.ts'],
    A02: ['core:scripts/gone.test.mjs', 'core:scripts/present.test.mjs::renamed title', 'sdk:tests/gone.test.ts'],
  }));
  const dangling = await danglingReferences(refs, sources({ 'scripts/present.test.mjs': "test('covers the thing', () => {});" }, { 'tests/present.test.ts': '' }));
  assert.deepEqual(dangling, ['A02: core:scripts/gone.test.mjs (no such tracked file)', 'A02: core:scripts/present.test.mjs::renamed title (title not found)',
    'A02: sdk:tests/gone.test.ts (no such tracked file)']);
});

test('uncovered IDs are reported, not failed', () => {
  assert.deepEqual(coverage(map({ A01: ['core:scripts/x.test.mjs'] })), { total: 3, covered: 1, uncovered: ['A02', 'R07'] });
});

test('the committed map is valid and references only public test paths', async () => {
  const committed = JSON.parse(await readFile(new URL('../requirements-map.json', import.meta.url), 'utf8'));
  const refs = validateMap(committed);
  assert.ok(committed.ids.length >= 200 && refs.length > 0);
  assert.ok(committed.ids.every(id => id[0] !== 'V'));
  for (const id of ['R04', 'R05', 'R06', 'R07']) assert.ok(committed.requirements[id], `${id} has test references`);
  assert.doesNotMatch(JSON.stringify(committed), /course-llms|planning\/|\/Users\//);
});
