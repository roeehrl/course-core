import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { releaseCheckStatistics } from '../src/admin-routes.js';
import { svgRenderer, visualCheckStatistics } from '../src/svg-renderer.js';
import { checkVisual } from '../src/visual-check.js';
import type { RuntimeExtension } from '../src/publication.js';
import { largeCourse, largeVisual } from './large-course-fixture.js';

// Regression for review transitions that timed out on large courses. Every transition ran
// the installed renderer's check of every visual twice (the transition's own runtime gate,
// then the release checks in the returned workspace view), synchronously on the event loop.
// On a ~2 MB course with 39 overlays that was about 9 s per pass, so each transition took
// 15-34 s against a 15 s client timeout, and GET of the course took about 8 s. Real
// PostgreSQL only.
const origin = 'http://localhost:4310', schema = `course_transition_${randomUUID().replaceAll('-', '')}`;
const VISUALS = 40;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, renderer: RuntimeExtension, workspaceId: string;

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  // A fresh renderer has no recorded checks, as after a process start.
  renderer = await svgRenderer();
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [renderer] });
  workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, 'transition-latency', 'Transition latency']);
}, 30000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function owner() {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `transition:${user}`, 'Test owner']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, user, 'owner']);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  expect(login.statusCode, login.body).toBe(200);
  return { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken as string };
}
async function timed<T>(work: () => Promise<T>) {
  const delay = monitorEventLoopDelay({ resolution: 10 }), start = performance.now();
  delay.enable();
  try { const result = await work(); return { result, ms: performance.now() - start, blockedMs: delay.max / 1e6 }; }
  finally { delay.disable(); }
}

it('review and publication of a ~2 MB course with 40 visuals stay fast on a fresh database', async () => {
  const headers = await owner(), course = largeCourse(`large-${randomUUID().slice(0, 8)}`, renderer, VISUALS);
  expect(JSON.stringify(course).length).toBeGreaterThan(1_900_000);
  const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/releases`, headers, payload: course });
  expect(imported.statusCode, imported.body).toBe(200);
  const releaseId = imported.json().id as string;
  const catalog = (await db.query('SELECT id,revision FROM admin_course_catalog WHERE workspace_id=$1', [workspaceId])).rows[0];
  const before = visualCheckStatistics(), releasesBefore = releaseCheckStatistics(), timings: Record<string, number> = {}, blocked: Record<string, number> = {};
  const transition = (action: string, revision: string) => timed(() => app.inject({ method: 'POST', url: `/api/admin/courses/${catalog.id}/releases/${releaseId}/transitions`,
    headers: { ...headers, 'if-match': revision, 'idempotency-key': randomUUID() }, payload: { action } }));

  // Cold: nothing has checked these visuals yet in this process.
  const cold = await transition('submit-review', String(catalog.revision));
  expect(cold.result.statusCode, cold.result.body).toBe(200);
  timings['submit-review'] = cold.ms; blocked['submit-review'] = cold.blockedMs;
  const afterCold = visualCheckStatistics();
  // Each visual was checked in full exactly once, off the event loop.
  expect(afterCold.offloadedChecks - before.offloadedChecks).toBe(VISUALS);
  expect(afterCold.checks - before.checks).toBe(0);

  // Warm, as the private acceptance and the admin app call them: read the course, then transition.
  for (const action of ['approve', 'publish']) {
    const view = await timed(() => app.inject({ method: 'GET', url: `/api/admin/courses/${catalog.id}`, headers }));
    expect(view.result.statusCode, view.result.body).toBe(200);
    expect(view.result.json().releases[0].checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
    const done = await transition(action, view.result.json().revision);
    expect(done.result.statusCode, done.result.body).toBe(200);
    timings[`GET before ${action}`] = view.ms; timings[action] = done.ms;
    blocked[`GET before ${action}`] = view.blockedMs; blocked[action] = done.blockedMs;
  }
  const after = visualCheckStatistics();
  // Later requests reused the recorded results for these exact bytes; nothing was re-run. Each
  // transition's own runtime gate reuses every visual's result; the course reads reuse the
  // release's recorded checks without reading its bundle (course-view-scaling.integration.test.ts).
  expect(after.offloadedChecks).toBe(afterCold.offloadedChecks);
  expect(after.checks).toBe(afterCold.checks);
  expect(after.reused - afterCold.reused).toBeGreaterThanOrEqual(2 * VISUALS);
  expect(releaseCheckStatistics().reused - releasesBefore.reused).toBeGreaterThanOrEqual(2);
  expect((await db.query('SELECT status FROM course_releases WHERE id=$1', [releaseId])).rows[0].status).toBe('published');

  // Bounds relative to one in-process pass over every visual on this machine (the old path
  // ran two per transition and one per read, all on the event loop), so they hold on slow or
  // busy CI runners too. Sampled on a fifth of the visuals to keep the test short.
  const sample = course.visuals.slice(0, VISUALS / 5), start = performance.now();
  for (const visual of sample) checkVisual(visual);
  const pass = (performance.now() - start) * 5;
  const rounded = (row: Record<string, number>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Math.round(v)]));
  console.log(JSON.stringify({ onePassMs: Math.round(pass), transitionLatencyMs: rounded(timings), eventLoopBlockedMs: rounded(blocked) }));
  // Cold: under the two passes the old path ran on the event loop. On a shared 4-CPU CI
  // runner, with other test files running, the workers gain little (0.8-0.9 of a pass was
  // measured), so the time bound allows slack; the event-loop bound is the strict one.
  expect(timings['submit-review']).toBeLessThan(1.6 * pass);
  for (const ms of Object.values(blocked)) expect(ms).toBeLessThan(0.25 * pass);
  // Warm: no visual work at all, so a small fraction of a pass, and under 3 s in absolute terms
  // whenever a pass itself fits a client timeout (as on developer machines and the private host).
  for (const [step, ms] of Object.entries(timings)) if (step !== 'submit-review') expect(ms, step).toBeLessThan(Math.max(3_000, 0.2 * pass));
}, 300000);

async function draft(visuals: number) {
  const headers = await owner(), course = largeCourse(`tamper-${randomUUID().slice(0, 8)}`, renderer, visuals);
  const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/releases`, headers, payload: course });
  expect(imported.statusCode, imported.body).toBe(200);
  const releaseId = imported.json().id as string;
  const catalogId = (await db.query('SELECT catalog_id FROM admin_release_reviews WHERE release_id=$1', [releaseId])).rows[0].catalog_id as string;
  const transition = async (action: string) => {
    const revision = String((await db.query('SELECT revision FROM admin_course_catalog WHERE id=$1', [catalogId])).rows[0].revision);
    return app.inject({ method: 'POST', url: `/api/admin/courses/${catalogId}/releases/${releaseId}/transitions`,
      headers: { ...headers, 'if-match': revision, 'idempotency-key': randomUUID() }, payload: { action } });
  };
  return { course, releaseId, transition };
}
const state = async (releaseId: string) => (await db.query('SELECT state FROM admin_release_reviews WHERE release_id=$1', [releaseId])).rows[0].state;

it('a stored bundle changed after its visuals passed is still rejected by digest', async () => {
  const { releaseId, transition } = await draft(4);
  expect((await transition('submit-review')).statusCode).toBe(200);
  await db.query("UPDATE course_releases SET server_bundle=jsonb_set(server_bundle,'{visuals,0,scene,title}','\"Tampered\"') WHERE id=$1", [releaseId]);
  const refused = await transition('approve');
  expect(refused.statusCode, refused.body).toBe(409);
  expect(refused.json()).toMatchObject({ error: 'RELEASE_DIGEST_MISMATCH' });
  expect(await state(releaseId)).toBe('pending_review');
}, 120000);

it('a stored bundle re-digested around an invalid visual is checked in full and rejected', async () => {
  const { course, releaseId, transition } = await draft(4);
  expect((await transition('submit-review')).statusCode).toBe(200);
  // Same visual id, new bytes the renderer rejects; bundle and digest replaced consistently.
  const invalid = structuredClone(largeVisual(0)) as unknown as { scene: { nodes: { width: unknown }[] } };
  invalid.scene.nodes[0]!.width = { state: 'missing' };
  course.visuals[0] = invalid as unknown as typeof course.visuals[number];
  const compiled = compileCourse(course), before = visualCheckStatistics();
  await db.query('UPDATE course_releases SET server_bundle=$2,learner_bundle=$3,digest=$4 WHERE id=$1',
    [releaseId, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), compiled.digest]);
  const refused = await transition('approve');
  expect(refused.statusCode, refused.body).toBe(409);
  expect(refused.json()).toMatchObject({ error: 'PUBLISH_VISUAL_INVALID' });
  // The changed visual was checked in full on the request path; the unchanged ones were reused.
  expect(visualCheckStatistics().checks - before.checks).toBe(1);
  expect(await state(releaseId)).toBe('pending_review');
}, 120000);
