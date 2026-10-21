import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { svgRenderer } from '../src/svg-renderer.js';
import type { RuntimeExtension } from '../src/publication.js';
import { fixture } from './fixture.js';
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

// S12 through real HTTP and PostgreSQL: Core refuses to publish a lesson visual whose renderer
// declares no keyboard support, even though SDK 0.5 bundles pass validation.
const origin = 'http://localhost:4310', schema = `course_visual_a11y_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, renderer: RuntimeExtension, workspaceId: string, testDatabase: TestDatabase | undefined;
let headers: Record<string, string>;

function course(accessibility: { keyboard: boolean; textAlternative: string }) {
  const visual = visualContextFixture(), source = fixture();
  source.id = `a11y-${randomUUID().slice(0, 8)}`;
  source.visuals.push(visual);
  source.chapters[0]!.episodes[0]!.blocks.push({ id: 'diagram-one', type: 'visual', visualId: visual.id });
  source.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: 'declarative', entrypoint: 'renderers/svg-v1.js',
    platforms: ['web'], capabilities: ['visual.render'], accessibility: { reducedMotion: true, ...accessibility } });
  return source;
}
async function importAndPublish(source: ReturnType<typeof course>) {
  const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/releases`, headers, payload: source });
  expect(imported.statusCode, imported.body).toBe(200);
  const releaseId = imported.json().id as string;
  return { releaseId, publish: await app.inject({ method: 'POST', url: `/api/releases/${releaseId}/publish`, headers }) };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  renderer = await svgRenderer();
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [renderer] });
  workspaceId = randomUUID();
  const owner = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `a11y:${owner}`, 'Test author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `a11y-${workspaceId}`, 'Visual accessibility']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, owner, 'owner']);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, owner) } });
  expect(login.statusCode, login.body).toBe(200);
  headers = { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
}, 30000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

it('refuses publication of a keyboard:false renderer and leaves the release unpublished', async () => {
  const { releaseId, publish } = await importAndPublish(course({ keyboard: false, textAlternative: 'A meter with a value.' }));
  expect(publish.statusCode, publish.body).toBe(409);
  expect(publish.json()).toMatchObject({ error: 'PUBLISH_VISUAL_INACCESSIBLE' });
  expect((await db.query('SELECT status FROM course_releases WHERE id=$1', [releaseId])).rows[0].status).not.toBe('published');
});

it('refuses a blank renderer text alternative', async () => {
  const { publish } = await importAndPublish(course({ keyboard: true, textAlternative: '   ' }));
  expect(publish.statusCode, publish.body).toBe(409);
  expect(publish.json()).toMatchObject({ error: 'PUBLISH_VISUAL_INACCESSIBLE' });
});

it('publishes the same course once the renderer is accessible', async () => {
  const { publish } = await importAndPublish(course({ keyboard: true, textAlternative: 'A meter with a value.' }));
  expect(publish.statusCode, publish.body).toBe(200);
});

// L11: the debug inspector's learner view carries each visual's renderer build identity.
it('the learner view reports the declared and installed renderer build of each visual, to owners only', async () => {
  const source = course({ keyboard: true, textAlternative: 'A meter with a value.' });
  const { releaseId, publish } = await importAndPublish(source);
  expect(publish.statusCode, publish.body).toBe(200);
  const learnerId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [learnerId, `a11y:${learnerId}`, 'Test learner']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, learnerId, 'learner']);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, learnerId) } });
  const learner = { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: learner, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const url = `/api/admin/enrollments/${enrolled.json().id}/learner-view`;
  const view = await app.inject({ url, headers });
  expect(view.statusCode, view.body).toBe(200);
  const build = { version: renderer.version, integrity: renderer.integrity };
  expect(view.json().visualRenderers).toEqual([{ visualId: source.visuals[0]!.id, rendererId: renderer.id, declared: build, installed: build, served: 'installed' }]);
  expect((await app.inject({ url, headers: learner })).statusCode).toBe(403);
});
