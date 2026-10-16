import { beforeAll, expect, it } from 'vitest';
import { svgRenderer, visualCheckStatistics } from '../src/svg-renderer.js';
import { assertCourseRunnable, prepareCourseRunnable, type RuntimeExtension } from '../src/publication.js';
import { largeCourse, largeVisual } from './large-course-fixture.js';

// Each test validates large scenes (and some in worker threads); loaded CI runners can
// exceed vitest's 5 s default, so the hook and every test carry an explicit timeout.
const TIMEOUT_MS = 30_000;
let renderer: RuntimeExtension;
beforeAll(async () => { renderer = await svgRenderer(); }, TIMEOUT_MS);
const delta = (work: () => unknown) => {
  const before = visualCheckStatistics();
  work();
  const after = visualCheckStatistics();
  return { checks: after.checks - before.checks, reused: after.reused - before.reused };
};
/** A visual the renderer rejects: a node references undeclared state. */
function broken(index: number) {
  const visual = structuredClone(largeVisual(index)) as unknown as { scene: { nodes: { width: unknown }[] } };
  visual.scene.nodes[0]!.width = { state: 'missing' };
  return visual as unknown as ReturnType<typeof largeVisual>;
}

it('identical bytes are checked once; changed bytes are checked in full', () => {
  const visual = largeVisual(101);
  expect(delta(() => renderer.validateVisual!(visual))).toEqual({ checks: 1, reused: 0 });
  expect(delta(() => renderer.validateVisual!(structuredClone(visual)))).toEqual({ checks: 0, reused: 1 });
  const changed = structuredClone(visual);
  changed.scene.title = `${String(changed.scene.title)} (edited)`;
  expect(delta(() => renderer.validateVisual!(changed))).toEqual({ checks: 1, reused: 0 });
}, TIMEOUT_MS);

it('a failing visual is never recorded and fails every time', () => {
  const visual = broken(102);
  for (let i = 0; i < 2; i++) expect(delta(() => expect(() => renderer.validateVisual!(visual)).toThrow())).toEqual({ checks: 1, reused: 0 });
}, TIMEOUT_MS);

it('values that are not plain JSON are always checked in full', () => {
  const visual = largeVisual(103);
  renderer.validateVisual!(visual);
  // Same JSON text as a visual that passed, but the renderer rejects accessors: never reuse.
  const accessor = structuredClone(visual);
  Object.defineProperty(accessor, 'rendererId', { get: () => visual.rendererId, enumerable: true });
  expect(JSON.stringify(accessor)).toBe(JSON.stringify(visual));
  expect(delta(() => expect(() => renderer.validateVisual!(accessor)).toThrowError(/Accessors are not allowed/))).toEqual({ checks: 1, reused: 0 });
}, TIMEOUT_MS);

it('another renderer instance keeps its own record', async () => {
  const visual = largeVisual(104), other = await svgRenderer();
  renderer.validateVisual!(visual);
  expect(delta(() => other.validateVisual!(visual))).toEqual({ checks: 1, reused: 0 });
}, TIMEOUT_MS);

it('preparation checks off the event loop and never decides publication', async () => {
  const course = largeCourse('prepared', renderer, 4), bad = broken(105);
  course.visuals[2] = { ...bad, id: course.visuals[2]!.id };
  const before = visualCheckStatistics();
  await expect(prepareCourseRunnable(course, [renderer])).resolves.toBeUndefined();
  const prepared = visualCheckStatistics();
  expect(prepared.offloadedChecks - before.offloadedChecks).toBe(3);
  expect(prepared.checks - before.checks).toBe(0);
  // The synchronous gate still decides: valid visuals are reused, the invalid one is re-run and rejected.
  expect(delta(() => expect(() => assertCourseRunnable(course, [renderer])).toThrowError(/PUBLISH_VISUAL_INVALID/))).toEqual({ checks: 1, reused: 2 });
}, TIMEOUT_MS);

it('preparation skips renderers whose build the course does not declare', async () => {
  const course = largeCourse('undeclared', { version: renderer.version, integrity: `sha256-${'f'.repeat(64)}` }, 2), before = visualCheckStatistics();
  await prepareCourseRunnable(course, [renderer]);
  expect(visualCheckStatistics().offloadedChecks).toBe(before.offloadedChecks);
  expect(() => assertCourseRunnable(course, [renderer])).toThrowError(/PUBLISH_CAPABILITY_MISSING/);
}, TIMEOUT_MS);
