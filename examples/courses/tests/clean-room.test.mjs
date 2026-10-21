import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileCourse } from '@course-core/sdk/compiler';
import { ACTIVITY_ID, CHECKER_ID, EVALUATOR_ID, RUNTIME_ID, buildLab } from '../src/clean-room-lab.mjs';

// The clean-room author's source may depend on the released SDK and Node built-ins only.
const source = await readFile(new URL('../src/clean-room-lab.mjs', import.meta.url), 'utf8');
const advertised = [
  { id: RUNTIME_ID, version: '1.0.0', integrity: `sha256-${'a'.repeat(64)}`, acceptedPriorBuild: false },
  { id: CHECKER_ID, version: '1.0.0', integrity: `sha256-${'b'.repeat(64)}`, acceptedPriorBuild: false },
];

test('the clean-room author source imports only the released SDK', () => {
  const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map(match => match[1] ?? match[2] ?? match[3]);
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) assert.match(specifier, /^(?:@course-core\/sdk(?:\/[a-z-]+)?|node:[a-z/]+)$/, specifier);
  // No path into Course Core or a sibling SDK checkout, even as text.
  assert.doesNotMatch(source, /services\/api|packages\/|apps\/|course-sdk\/src|\.\.\//);
});

test('the SDK is the public release asset, pinned by the lockfile', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const url = manifest.dependencies['@course-core/sdk'];
  assert.match(url, /^https:\/\/github\.com\/roeehrl\/course-sdk\/releases\/download\/v\d+\.\d+\.\d+\/course-core-sdk-\d+\.\d+\.\d+\.tgz$/);
  assert.equal(lock.packages['node_modules/@course-core/sdk'].resolved, url);
  assert.match(lock.packages['node_modules/@course-core/sdk'].integrity, /^sha512-/);
  // The only Course Core package this directory installs is the SDK.
  assert.deepEqual(Object.keys(lock.packages).filter(name => name.includes('@course-core/')), ['node_modules/@course-core/sdk']);
});

test('the lab adds a custom activity, an evaluator and an admin setting with SDK definitions', () => {
  const course = buildLab(advertised);
  assert.equal(course.activities.length, 1);
  assert.equal(course.activities[0].evaluatorRef, EVALUATOR_ID);
  assert.deepEqual(course.evaluators.map(row => [row.id, row.extensionId, row.method, row.humanConfirmation]), [[EVALUATOR_ID, CHECKER_ID, 'deterministic', 'none']]);
  assert.deepEqual(course.adminSections[0].settings.map(row => [row.id, row.type, row.default]), [['show-mismatched-controls', 'boolean', false]]);
  // The key is two ordinary items named after the activity's controls.
  assert.deepEqual(course.assessments.filter(row => row.id.startsWith(`${ACTIVITY_ID}.`)).map(row => row.type), ['numeric', 'choice']);
  assert.throws(() => buildLab(advertised.slice(0, 1)), /does not advertise course-core-declarative-evaluator/);
});

test('the learner projection carries no key, evaluator wiring or admin settings', () => {
  const learner = JSON.stringify(compileCourse(buildLab(advertised)).learner);
  for (const secret of ['21.5', 'Thermometer lab reading', 'correctOptionId', EVALUATOR_ID, CHECKER_ID, 'show-mismatched-controls']) assert.ok(!learner.includes(secret), secret);
});
