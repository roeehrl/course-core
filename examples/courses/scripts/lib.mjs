import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateCourse } from '@course-core/sdk';
import { compileCourse, verifyCompiledCourse } from '@course-core/sdk/compiler';

export const directory = fileURLToPath(new URL('../', import.meta.url));
export const filenames = ['number-line.json', 'spanish-greetings.json', 'plant-journal.json'];
export async function loadPacks() {
  return Promise.all(filenames.map(async filename => JSON.parse(await readFile(path.join(directory, 'packs', filename), 'utf8'))));
}
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
    assert(!text.includes(item.grading.explanation), `Bootstrap exposes a grading explanation: ${item.id}`);
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
  for (const key of ['extensions', 'visuals', 'media']) assert.deepEqual(course[key], []);
  assert(episodes(course).length >= 2 && episodes(course).length <= 3);
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
        assert(['choice', 'numeric'].includes(item.type));
        familyCounts.set(item.familyId, (familyCounts.get(item.familyId) ?? 0) + 1);
        assert(grade(item, correctAnswer(item)));
        assert(!grade(item, wrongAnswer(item)));
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
  return { id: course.id, title: course.title, episodes: episodes(course).length, assessments: course.assessments.length,
    lessonWords: wordCount, digest: compiled.digest, calendarDays: course.policy.window.calendarDays };
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
