import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateCourse } from '@course-core/sdk';
import { compileCourse, verifyCompiledCourse } from '@course-core/sdk/compiler';

export const directory = fileURLToPath(new URL('../', import.meta.url));
export const filenames = ['number-line.json', 'spanish-greetings.json', 'plant-journal.json', 'search-lab.json'];
export async function loadPacks() {
  return Promise.all(filenames.map(async filename => JSON.parse(await readFile(path.join(directory, 'packs', filename), 'utf8'))));
}
/** Extensions Core installs by default (services/api/src/main.ts), by ID. A pack may use these
 * on unchanged Core. Any other extension must be a data-only code fixture registry shipped
 * beside the pack, which the host operator installs with CODE_FIXTURE_FILES. */
export const CORE_EXTENSIONS = Object.freeze({
  'course-core-svg-v1': { execution: 'declarative', capabilities: ['visual.render'] },
  'course-core-declarative-activity': { execution: 'declarative', capabilities: ['state.read', 'state.patch', 'observation.emit'] },
  'course-core-reviewed-rubric': { execution: 'server', capabilities: ['assessment.evaluate'] },
});
/** Code fixture registries shipped beside a pack: packs/<course id>.code-fixtures.json. */
export async function codeFixtureFiles(course) {
  const files = [];
  for (const extension of course.extensions.filter(row => !Object.hasOwn(CORE_EXTENSIONS, row.id))) {
    const filename = path.join(directory, 'packs', `${course.id}.code-fixtures.json`), bytes = await readFile(filename);
    const registry = JSON.parse(bytes.toString('utf8'));
    assert.equal(registry.id, extension.id, `${course.id}: extension ${extension.id} has no fixture registry beside the pack`);
    assert.equal(registry.version, extension.version);
    assert.equal(`sha256-${createHash('sha256').update(bytes).digest('hex')}`, extension.integrity, `${course.id}: ${extension.id} integrity does not match its fixture file`);
    files.push(filename);
  }
  return files;
}
const GRADED_HERE = new Set(['choice', 'numeric']);
export const episodes = course => course.chapters.flatMap(chapter => chapter.episodes);
export function correctAnswer(item) {
  return item.type === 'numeric' ? item.grading.expected : item.grading.correctOptionId;
}
export function wrongAnswer(item) {
  return item.type === 'numeric' ? item.grading.expected + 1000 : item.options.find(option => option.id !== item.grading.correctOptionId).id;
}
export function grade(item, answer) {
  return item.type === 'numeric'
    ? typeof answer === 'number' && Number.isFinite(answer) && Math.abs(answer - item.grading.expected) <= item.grading.absoluteTolerance
    : typeof answer === 'string' && answer === item.grading.correctOptionId;
}
export function assertNoGrading(value) {
  const forbidden = new Set(['grading', 'correctOptionId', 'expected', 'absoluteTolerance', 'relativeTolerance', 'fixtureRef', 'evaluatorId', 'rubric', 'server_bundle']);
  const visit = input => {
    if (!input || typeof input !== 'object') return;
    for (const [key, child] of Object.entries(input)) {
      assert(!forbidden.has(key), `Learner payload exposes forbidden field: ${key}`);
      visit(child);
    }
  };
  visit(value);
}
export function assertNoBank(value, course) {
  assertNoGrading(value);
  const text = JSON.stringify(value);
  for (const item of course.assessments) {
    assert(!text.includes(item.prompt), `Bootstrap exposes an unissued prompt: ${item.id}`);
    if (item.grading.explanation) assert(!text.includes(item.grading.explanation), `Bootstrap exposes a grading explanation: ${item.id}`);
  }
}
export function validatePack(course) {
  const result = validateCourse(course);
  assert(result.valid, JSON.stringify(result.issues));
  assert.equal(course.schemaVersion, 1);
  assert.deepEqual(course.platforms, ['web']);
  assert(course.policy.mode === 'bounded' && course.policy.window.calendarDays > 0);
  assert.equal(course.policy.window.anchor, 'enrollment_started');
  assert.equal(course.policy.existingMaterialAccess, 'read_only');
  assert.equal(course.policy.extensions.enabled, false);
  assert.deepEqual(course.media, []);
  for (const extension of course.extensions) {
    const core = CORE_EXTENSIONS[extension.id];
    if (core) assert.equal(extension.execution, core.execution, `${extension.id} execution`);
    else assert(extension.execution === 'server' && extension.capabilities.join() === 'assessment.evaluate', `${extension.id}: only data-only code fixture registries may be added`);
    assert(extension.platforms.includes('web') && extension.accessibility.textAlternative.length >= 20);
  }
  for (const visual of course.visuals) {
    assert.equal(visual.rendererId, 'course-core-svg-v1');
    assert(visual.accessibility.description.length >= 80, `Visual needs a full text description: ${visual.id}`);
  }
  for (const activity of course.activities ?? []) {
    assert.equal(activity.executionAdapter, 'declarative');
    assert(activity.accessibleSemantics.keyboard && activity.accessibleSemantics.screenReader && activity.accessibleSemantics.nonPointerPath);
  }
  assert(episodes(course).length >= 2 && episodes(course).length <= 4);
  const known = new Map(course.assessments.map(item => [item.id, item]));
  let wordCount = 0;
  for (const episode of episodes(course)) {
    const text = episode.blocks.filter(block => block.type === 'text').map(block => block.markdown).join('\n');
    const words = text.trim().split(/\s+/).length;
    assert(words >= 200, `Episode needs substantive teaching: ${episode.id}`);
    assert(!/\b(?:TODO|TBD|placeholder)\b/.test(text));
    wordCount += words;
    const gate = course.gates.find(gate => gate.id === episode.gateId);
    assert(gate && gate.requireAllObjectives && gate.minimumIndependentFamilies === 2);
    assert.deepEqual(gate.objectiveIds, episode.objectiveIds);
    assert.equal(gate.assessmentIds.length, 8);
    for (const objective of episode.objectiveIds) {
      const familyCounts = new Map();
      for (const id of gate.assessmentIds) {
        const item = known.get(id); assert(item && item.objectiveIds.includes(objective));
        assert(['choice', 'numeric', 'code', 'rubric'].includes(item.type));
        familyCounts.set(item.familyId, (familyCounts.get(item.familyId) ?? 0) + 1);
        if (GRADED_HERE.has(item.type)) {
          assert(grade(item, correctAnswer(item)));
          assert(!grade(item, wrongAnswer(item)));
        }
      }
      assert.equal(familyCounts.size, 2);
      assert([...familyCounts.values()].every(count => count === 4));
      // Gate order alternates families: the UI can request the first unseen item.
      const order = gate.assessmentIds.map(id => known.get(id).familyId);
      assert(order.every((family, i) => family === order[i % 2]));
    }
    assert.equal(new Set(gate.assessmentIds.map(id => known.get(id).prompt)).size, 8);
    assert(episode.blocks.filter(block => block.type === 'assessment').every(block => gate.assessmentIds.includes(block.assessmentId)));
  }
  const compiled = compileCourse(course);
  assert(verifyCompiledCourse(compiled));
  assertNoBank(compiled.learner, course);
  for (const item of compiled.learner.assessments) assert.deepEqual(Object.keys(item).sort(), ['id', 'objectiveIds', 'type']);
  const types = [...new Set(course.assessments.map(item => item.type))].sort();
  return { id: course.id, title: course.title, episodes: episodes(course).length, assessments: course.assessments.length,
    lessonWords: wordCount, digest: compiled.digest, calendarDays: course.policy.window.calendarDays, itemTypes: types,
    visuals: course.visuals.length, activities: (course.activities ?? []).length, extensions: course.extensions.map(row => row.id).sort() };
}
export function simulateRecovery(course, episode, { firstFailures = 1, assisted = 1 } = {}) {
  const gate = course.gates.find(row => row.id === episode.gateId);
  const items = gate.assessmentIds.map(id => course.assessments.find(a => a.id === id));
  const exposed = new Set(), earned = new Set();
  const events = [];
  let failures = firstFailures, help = assisted;
  for (const item of items) {
    const independent = !exposed.has(item.id);
    exposed.add(item.id);
    if (failures > 0) {
      failures--; events.push({ id: item.id, passed: false, independent });
      // A later correction of this same exposed item cannot earn another family.
      events.push({ id: item.id, passed: true, independent: false });
      continue;
    }
    if (help > 0) { help--; events.push({ id: item.id, passed: true, independent: false }); continue; }
    events.push({ id: item.id, passed: true, independent });
    earned.add(item.familyId);
    if (earned.size >= gate.minimumIndependentFamilies) return { passed: true, events, families: [...earned], unused: items.length - exposed.size };
  }
  return { passed: false, events, families: [...earned], unused: 0 };
}
