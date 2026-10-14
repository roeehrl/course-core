import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { svgRenderer, visualCheckStatistics } from '../src/svg-renderer.js';
import type { RuntimeExtension } from '../src/publication.js';
import { largeCourse } from './large-course-fixture.js';

// Regression for review transitions that timed out on large courses. Every transition ran
// the installed renderer's check of every visual twice (the transition's own runtime gate,
// then the release checks in the returned workspace view), synchronously on the event loop.
// On a ~2 MB course with 39 overlays that was about 9 s per pass, so each transition took
// 15-34 s against a 15 s client timeout, and GET of the course took about 8 s. Real
// PostgreSQL only.
const origin = 'http://localhost:4310', schema = `course_transition_${randomUUID().replaceAll('-', '')}`;
const VISUALS = 40;
/** Generous for slow CI runners, yet well under a 15 s client timeout. The old path took
 * about 16 s for the cold transition and 8 s for each later request on a developer laptop. */
const COLD_MS = 10_000, WARM_MS = 3_000, EVENT_LOOP_MS = 2_000;
let db: Database, root: Database, app: Awaited<ReturnType<typeof createServer>>, renderer: RuntimeExtension, workspaceId: string;

beforeAll(async () => {
  if (process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL) throw new Error('Use the disposable TEST_DATABASE_URL only.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/course_core_(ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Disposable loopback database required.');
  root = createDatabase(url.href); await root.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-csearch_path=${schema}`); db = createDatabase(url.href);
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  // A fresh renderer has no recorded checks, as after a process start.
  renderer = await svgRenderer();
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [renderer] });
  workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, 'transition-latency', 'Transition latency']);
}, 30000);
afterAll(async () => { await app?.close(); await db?.end(); if (root) { await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await root.end(); } });

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
  const before = visualCheckStatistics(), timings: Record<string, number> = {};
  const transition = (action: string, revision: string) => timed(() => app.inject({ method: 'POST', url: `/api/admin/courses/${catalog.id}/releases/${releaseId}/transitions`,
    headers: { ...headers, 'if-match': revision, 'idempotency-key': randomUUID() }, payload: { action } }));

  // Cold: nothing has checked these visuals yet in this process.
  const cold = await transition('submit-review', String(catalog.revision));
  expect(cold.result.statusCode, cold.result.body).toBe(200);
  timings['submit-review'] = cold.ms;
  expect(cold.ms).toBeLessThan(COLD_MS);
  expect(cold.blockedMs).toBeLessThan(EVENT_LOOP_MS);
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
    for (const step of [view, done]) { expect(step.ms).toBeLessThan(WARM_MS); expect(step.blockedMs).toBeLessThan(EVENT_LOOP_MS); }
  }
  const after = visualCheckStatistics();
  // Later requests reused the recorded results for these exact bytes; nothing was re-run.
  expect(after.offloadedChecks).toBe(afterCold.offloadedChecks);
  expect(after.checks).toBe(afterCold.checks);
  expect(after.reused - afterCold.reused).toBeGreaterThanOrEqual(4 * VISUALS);
  expect((await db.query('SELECT status FROM course_releases WHERE id=$1', [releaseId])).rows[0].status).toBe('published');
  console.log(JSON.stringify({ transitionLatencyMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])) }));
}, 120000);
