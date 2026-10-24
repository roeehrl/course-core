import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCourse } from '@course-core/sdk/compiler';
import { validateCourse } from '@course-core/sdk';
import { createHash } from 'node:crypto';
import { directory, loadPacks, episodes, validatePack, simulateRecovery, correctAnswer, wrongAnswer, grade, assertNoGrading, assertNoBank, codeFixtureFiles, CORE_EXTENSIONS } from '../scripts/lib.mjs';
import { code as codeAnswers, roleplays, reviewFindings } from '../scripts/reference-answers.mjs';
import { auditText, auditFilename, auditDependencies } from '../../../scripts/public-policy.mjs';
const packs = await loadPacks();

const byId = id => packs.find(p => p.id === id);
const lab = byId('search-lab'), spanish = byId('spanish-greetings');
test('four self-contained courses compile through the released SDK and expose only supported runtime features', () => {
  assert.equal(packs.length, 4);
  assert.equal(new Set(packs.map(p => p.id)).size, 4);
  assert.deepEqual(packs.map(pack => validatePack(pack).episodes), [3, 4, 3, 3]);
  assert.equal(packs.flatMap(p => episodes(p)).length, 13);
  assert.equal(packs.flatMap(p => p.assessments).length, 104);
});
test('the algorithms lab uses visuals, an interactive activity and sandboxed code tasks', async () => {
  const report = validatePack(lab);
  assert.deepEqual(report.itemTypes, ['choice', 'code', 'numeric']);
  assert.equal(report.visuals, 2); assert.equal(report.activities, 1);
  assert.deepEqual(report.extensions, ['course-core-declarative-activity', 'course-core-svg-v1', 'search-lab-code']);
  const blocks = episodes(lab).flatMap(e => e.blocks);
  for (const visual of lab.visuals) assert(blocks.some(b => b.type === 'visual' && b.visualId === visual.id));
  assert(blocks.some(b => b.type === 'activity' && b.activityId === 'predict-comparisons'));
  // The activity is practice: no evaluator, so an observation can never become evidence.
  assert.equal(lab.activities[0].evaluatorRef, undefined);
  const codeItems = lab.assessments.filter(a => a.type === 'code');
  assert.equal(codeItems.length, 4);
  assert(codeItems.every(item => item.language === 'python' && item.starterCode.includes('def solve(data):') && codeAnswers[item.id]));
  // The code gate starts with a code task, so the real HTTP gate submits a wrong and a corrected program.
  assert.equal(lab.assessments.find(a => a.id === lab.gates[2].assessmentIds[0]).type, 'code');
});
test('code fixtures ship beside the pack, match the declared integrity and agree with independent reference implementations', async () => {
  const [file] = await codeFixtureFiles(lab);
  const bytes = await readFile(file), registry = JSON.parse(bytes.toString('utf8'));
  const declared = lab.extensions.find(e => e.id === 'search-lab-code');
  assert.equal(declared.integrity, `sha256-${createHash('sha256').update(bytes).digest('hex')}`);
  const reference = {
    'linear-index': ({ values, target }) => { for (let i = 0; i < values.length; i++) if (values[i] === target) return i; return -1; },
    'binary-midpoints': ({ values, target }) => {
      const checked = []; let low = 0, high = values.length - 1;
      while (low <= high) { const middle = (low + high) >> 1; checked.push(middle); if (values[middle] === target) break; if (values[middle] < target) low = middle + 1; else high = middle - 1; }
      return checked;
    },
    'lower-bound': ({ values, target }) => { let i = 0; while (i < values.length && values[i] < target) i++; return i; },
    'count-in-range': ({ values, low, high }) => values.reduce((n, v) => n + (v >= low && v <= high ? 1 : 0), 0),
  };
  assert.deepEqual(registry.fixtures.map(f => f.id).sort(), Object.keys(reference).sort());
  for (const fixture of registry.fixtures) {
    assert(fixture.cases.length >= 5, `${fixture.id} needs edge cases`);
    assert(fixture.cases.some(c => (c.input.values ?? []).length === 0), `${fixture.id} needs an empty list`);
    for (const c of fixture.cases) assert.deepEqual(c.expected, reference[fixture.id](c.input), `${fixture.id}/${c.id}`);
  }
  for (const item of lab.assessments.filter(a => a.type === 'code')) assert(registry.fixtures.some(f => f.id === item.grading.fixtureRef));
  // A tampered registry no longer matches the pack's declaration, so the host would refuse to publish it.
  const tampered = structuredClone(registry); tampered.fixtures[0].cases[0].expected = 99;
  assert.notEqual(declared.integrity, `sha256-${createHash('sha256').update(`${JSON.stringify(tampered, null, 2)}\n`).digest('hex')}`);
});
test('the Spanish role-play is a reviewed rubric item: good answers can be cited for every required criterion, weak ones cannot', () => {
  const report = validatePack(spanish);
  assert.deepEqual(report.itemTypes, ['choice', 'rubric', 'trace']);
  assert.deepEqual(report.extensions, ['course-core-reviewed-rubric']);
  const rolePlays = spanish.assessments.filter(a => a.type === 'rubric');
  assert.equal(rolePlays.length, 4);
  for (const item of rolePlays) {
    assert.equal(item.grading.evaluatorId, 'course-core-reviewed-rubric');
    const rubric = item.grading.rubric, required = rubric.filter(c => c.required).map(c => c.id);
    assert.deepEqual(required, ['greets', 'name', 'thanks', 'farewell']);
    const { good, weak } = roleplays[item.id];
    for (const sample of [good, weak]) assert(sample.response.length >= 20 && sample.response.length <= 8000);
    const findings = reviewFindings(rubric, good.quotes);
    assert(findings.filter(f => required.includes(f.criterionId)).every(f => f.met));
    // Core accepts a met criterion only with a quote of at least 10 characters found in the learner's words.
    for (const f of findings.filter(f => f.met)) assert(f.quote.length >= 10 && good.response.includes(f.quote), `${item.id}/${f.criterionId}`);
    assert(!reviewFindings(rubric, weak.quotes).filter(f => required.includes(f.criterionId)).every(f => f.met));
  }
  // The role-play episode needs the earlier courtesy objective first.
  assert.deepEqual(spanish.objectives.find(o => o.id === 'sg-roleplay-objective').prerequisites, ['sg-courtesy-objective']);
});
test('Core has no branch for any example course: no pack, episode or extension ID appears in Core runtime sources', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const ids = new Set(packs.flatMap(p => [p.id, ...episodes(p).map(e => e.id), ...p.extensions.map(e => e.id).filter(id => !Object.hasOwn(CORE_EXTENSIONS, id)), ...(p.activities ?? []).map(a => a.id)]));
  const hits = [];
  // Agent-eval dialogues under services/api/src/agent-evals/public quote pack text as eval material; they are data, not runtime branches.
  const skip = new Set(['node_modules', 'dist', 'public', 'test', 'tests', 'browser', 'e2e', '.expo', 'web-build']);
  async function scan(folder) {
    let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const item of entries) {
      const name = path.join(folder, item.name);
      if (item.isDirectory()) { if (!skip.has(item.name)) await scan(name); continue; }
      if (!/\.(?:[cm]?[jt]sx?|sql|json)$/.test(item.name)) continue;
      const text = await readFile(name, 'utf8');
      for (const id of ids) if (new RegExp(`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`).test(text)) hits.push(`${path.relative(root, name)}: ${id}`);
    }
  }
  for (const area of ['services/api/src', 'services/api/migrations', 'services/supervisor/src', 'packages', 'apps/learner/src', 'apps/learner/app', 'apps/admin/src']) await scan(path.join(root, area));
  assert.deepEqual(hits, []);
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
/** The lab's numeric keys, recomputed by simulating the scans and searches the prompts describe. */
function searchKeys() {
  const shelf = [3, 8, 12, 17, 21, 26, 30, 35];
  const scan = (target, stopEarly = false) => { let n = 0; for (const v of shelf) { n++; if (v === target || (stopEarly && v > target)) break; } return n; };
  const binary = target => { const seen = []; let low = 0, high = shelf.length - 1; while (low <= high) { const m = Math.floor((low + high) / 2); seen.push(m); if (shelf[m] === target) break; if (shelf[m] < target) low = m + 1; else high = m - 1; } return seen; };
  let windowSize = 1000, worst = 0; while (windowSize >= 1) { worst++; windowSize = Math.floor(windowSize / 2); }
  return [['ls-count-1', scan(21)], ['ls-count-2', scan(3)], ['ls-count-3', scan(20)], ['ls-count-4', scan(20, true)],
    ['bs-mid-1', binary(12)[0]], ['bs-mid-2', binary(12)[1]], ['bs-mid-3', binary(30).length], ['bs-mid-4', worst]];
}
test('numeric teaching keys are independently recomputed from the stated inputs', () => {
  const expected = new Map([
    ['nl-position-scale-1', -4 + 4], ['nl-position-scale-2', -2 + 2],
    ['nl-position-scale-3', 7 + (4 - 1)], ['nl-position-scale-4', 0 + (0 - (-0.5))],
    ['nl-moves-endpoint-1', -3 + 7 - 2], ['nl-moves-endpoint-2', 5 - 9],
    ['nl-moves-endpoint-3', -6 - 2 + 5], ['nl-moves-endpoint-4', 2 + 3 - 8],
    ['nl-distance-gap-1', Math.abs(3 - (-5))], ['nl-distance-gap-2', Math.abs(-2 - (-8))],
    ['nl-distance-gap-3', Math.abs(6 - 1) + Math.abs(2 - 6)], ['nl-distance-gap-4', Math.abs(1 - (-3)) * 2],
    ['pj-notice-record-1', 6], ['pj-notice-record-2', 7 - 5], ['pj-notice-record-3', 3 * 2], ['pj-notice-record-4', 9],
    ['pj-measure-difference-1', 11 - 8], ['pj-measure-difference-2', 14 - 12.5],
    ['pj-measure-difference-3', 90 / 10 - 9], ['pj-measure-difference-4', 8.5 - 7.5],
    ['pj-compare-summary-1', 10 - 6], ['pj-compare-summary-2', 6 - 3],
    ['pj-compare-summary-3', [12, 14, 13, 15].filter(n => n >= 14).length], ['pj-compare-summary-4', (12 - 9) / 6],
    ...searchKeys(),
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
      if (['node_modules', 'reports', '.local'].includes(item.name)) continue;
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
