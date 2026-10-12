import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCourse } from '@course-core/sdk/compiler';
import { validateCourse } from '@course-core/sdk';
import { directory, loadPacks, episodes, validatePack, simulateRecovery, correctAnswer, wrongAnswer, grade, assertNoGrading, assertNoBank } from '../scripts/lib.mjs';
import { auditText, auditFilename, auditDependencies } from '../../../scripts/public-policy.mjs';
const packs = await loadPacks();

test('three self-contained courses compile through the released SDK and expose only supported runtime features', () => {
  assert.equal(packs.length, 3);
  assert.equal(new Set(packs.map(p => p.id)).size, 3);
  for (const pack of packs) assert.equal(validatePack(pack).episodes, 3);
  assert.equal(packs.flatMap(p => episodes(p)).length, 9);
  assert.equal(packs.flatMap(p => p.assessments).length, 72);
});
test('wrong first answers, helped items and corrected repeats leave a fresh two-family path', () => {
  for (const pack of packs) for (const episode of episodes(pack)) {
    const recovered = simulateRecovery(pack, episode);
    assert(recovered.passed && recovered.unused > 0);
    assert.equal(new Set(recovered.families).size, 2);
    assert(recovered.events.some(e => !e.passed));
    assert(recovered.events.some(e => e.passed && !e.independent));
    assert(simulateRecovery(pack, episode, { firstFailures: 3, assisted: 2 }).passed);
    assert(!simulateRecovery(pack, episode, { firstFailures: 8, assisted: 0 }).passed);
  }
});
test('the complete learner projection has no grading keys, bank prompts or explanations', () => {
  for (const pack of packs) {
    const learner = compileCourse(pack).learner;
    assertNoBank(learner, pack);
    assert.throws(() => assertNoGrading({ question: { grading: { expected: 12 } } }));
    assert.throws(() => assertNoBank({ ...learner, leaked: pack.assessments[0].prompt }, pack));
  }
  assertNoGrading({ question: { type: 'choice', prompt: 'A current question', options: [{ id: 'a', text: 'An option' }] } });
});
test('numeric teaching keys are independently recomputed from the stated inputs', () => {
  const expected = new Map([
    ['nl-position-scale-1', -4 + 4], ['nl-position-scale-2', -2 + 2],
    ['nl-position-scale-3', 7 + (4 - 1)], ['nl-position-scale-4', 0 + (0 - (-0.5))],
    ['nl-moves-endpoint-1', -3 + 7 - 2], ['nl-moves-endpoint-2', 5 - 9],
    ['nl-moves-endpoint-3', -6 - 2 + 5], ['nl-moves-endpoint-4', 2 + 3 - 8],
    ['nl-distance-gap-1', Math.abs(3 - (-5))], ['nl-distance-gap-2', Math.abs(-2 - (-8))],
    ['nl-distance-gap-3', Math.abs(6 - 1) + Math.abs(2 - 6)], ['nl-distance-gap-4', Math.abs(1 - (-3)) * 2],
    ['pj-measure-difference-1', 11 - 8], ['pj-measure-difference-2', 14 - 12.5],
    ['pj-measure-difference-3', 90 / 10 - 9], ['pj-measure-difference-4', 8.5 - 7.5],
    ['pj-compare-summary-1', 10 - 6], ['pj-compare-summary-2', 6 - 3],
    ['pj-compare-summary-3', [12, 14, 13, 15].filter(n => n >= 14).length], ['pj-compare-summary-4', (12 - 9) / 6],
  ]);
  const numeric = packs.flatMap(p => p.assessments).filter(a => a.type === 'numeric');
  assert.equal(numeric.length, expected.size);
  for (const item of numeric) {
    assert.equal(item.grading.expected, expected.get(item.id));
    assert(grade(item, expected.get(item.id)));
    for (const wrong of [wrongAnswer(item), String(correctAnswer(item)), NaN, Infinity, null]) assert(!grade(item, wrong));
  }
  assert.equal(Math.abs(4 - (-2)), 6);
  assert.equal(Math.abs(5 - 0) + Math.abs(2 - 5), 8);
  assert.equal(12 - 10.5, 1.5);
  assert.equal((11 - 8) / 5, 0.6);
});
test('invalid authoring variants are rejected, including a missing family and an invented objective', () => {
  const broken = structuredClone(packs[0]);
  for (const item of broken.assessments.filter(a => broken.gates[0].assessmentIds.includes(a.id))) item.familyId = 'one-family';
  const result = validateCourse(broken);
  assert(!result.valid && result.issues.some(i => i.code === 'INSUFFICIENT_ITEM_FAMILIES'));
  const unknown = structuredClone(packs[1]); unknown.assessments[0].objectiveIds = ['not-declared'];
  assert(!validateCourse(unknown).valid);
  const weak = structuredClone(packs[2]); weak.gates[0].assessmentIds = weak.gates[0].assessmentIds.slice(0, 2);
  assert.throws(() => validatePack(weak), /8/);
});
test('published examples and standalone dependency lock pass the repository public-source audit', async () => {
  async function walk(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (['node_modules', 'reports'].includes(item.name)) continue;
      const name = path.join(folder, item.name);
      if (item.isDirectory()) await walk(name);
      else {
        const relative = path.relative(directory, name);
        auditFilename(relative); auditText(relative, await readFile(name, 'utf8'));
      }
    }
  }
  await walk(directory);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  auditDependencies(manifest, lock, directory, root, 'examples/courses');
});
