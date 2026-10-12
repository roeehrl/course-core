import { loadPacks, validatePack, simulateRecovery, episodes } from './lib.mjs';
import assert from 'node:assert/strict';
const reports = [];
for (const course of await loadPacks()) {
  const report = validatePack(course);
  for (const episode of episodes(course)) {
    assert(simulateRecovery(course, episode, { firstFailures: 1, assisted: 1 }).passed);
    assert(simulateRecovery(course, episode, { firstFailures: 3, assisted: 2 }).passed);
  }
  reports.push({ ...report, wrongAnswerAndHelpRecovery: true, learnerProjectionHasNoAnswerBank: true });
}
console.log(JSON.stringify({ sdk: '@course-core/sdk', courses: reports }, null, 2));
