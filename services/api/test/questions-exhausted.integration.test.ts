import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { fixture } from './fixture.js';

// A learner who used every question of a lesson while no approved fresh family covers what is
// missing (no recovery registry here) is at a dead end. The learner app reports it; the server
// checks the state itself, records it once and tells the staff who can add questions.
const origin = 'http://localhost:4310', schema = `course_questions_exhausted_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspaceId: string, releaseId: string, owner: string, ownerHeaders: Record<string, string>;
async function signIn(user: string) {
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  return { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken as string };
}
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  const compiled = compileCourse(fixture());
  owner = randomUUID(); workspaceId = randomUUID(); releaseId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `exhausted:${owner}`, 'Owner']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `exhausted-${workspaceId}`, 'Exhausted questions']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
  await db.query('INSERT INTO admin_course_catalog(id,workspace_id,course_key,title) VALUES($1,$2,$3,$4)', [randomUUID(), workspaceId, compiled.server.id, 'Ordering']);
  ownerHeaders = await signIn(owner);
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function learner() {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `exhausted:${user}`, 'Learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspaceId, user]);
  const headers = await signIn(user);
  const id = (await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } })).json().id as string;
  const post = async (path: string, body: Record<string, unknown>) => {
    const revision = (await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision;
    return app.inject({ method: 'POST', url: `/api/enrollments/${id}/${path}`, headers, payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...body } });
  };
  return { id, headers, post };
}
const staffNotices = async () => (await app.inject({ method: 'GET', url: `/api/admin/workspaces/${workspaceId}/notifications`, headers: ownerHeaders })).json()
  .items.filter((item: { kind: string }) => item.kind === 'questions_exhausted');

it('records a lesson that ran out of questions once, tells the staff, and refuses a lesson that has questions left', async () => {
  const a = await learner();
  const report = () => app.inject({ method: 'POST', url: `/api/enrollments/${a.id}/recovery/exhausted`, headers: a.headers, payload: { episodeId: 'min' } });
  // Questions are left: nothing to report.
  expect((await report()).statusCode).toBe(409);
  expect(await staffNotices()).toHaveLength(0);
  // Read the lesson, then use both of its questions ("I don't know yet").
  expect((await a.post('read', { episodeId: 'min', blockId: 'min-text' })).statusCode).toBe(200);
  for (const assessmentId of ['min-a', 'min-b']) {
    const challenge = await a.post('challenges', { episodeId: 'min', mode: 'independent', assessmentId });
    expect(challenge.statusCode, challenge.body).toBe(200);
    const challengeId = (await db.query('SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND assessment_id=$2', [a.id, assessmentId])).rows[0].id;
    expect((await a.post('answers', { challengeId, abstain: true })).statusCode).toBe(200);
  }
  const snapshot = (await app.inject({ method: 'GET', url: `/api/enrollments/${a.id}`, headers: a.headers })).json();
  expect(snapshot.recovery).toEqual([expect.objectContaining({ episodeId: 'min', required: true, freshCheck: null })]);
  // Reported twice (a reload): recorded and notified once.
  expect((await report()).json()).toEqual({ told: true });
  expect((await report()).json()).toEqual({ told: true });
  expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='assessment.questions_exhausted'", [a.id])).rows[0].n).toBe(1);
  const [notice] = await staffNotices();
  expect(notice).toMatchObject({ kind: 'questions_exhausted', params: { learners: 1, lessons: 1 } });
  expect(JSON.stringify(notice)).not.toContain(a.id);
  // Another learner cannot report for this enrollment.
  const b = await learner();
  expect((await app.inject({ method: 'POST', url: `/api/enrollments/${a.id}/recovery/exhausted`, headers: b.headers, payload: { episodeId: 'min' } })).statusCode).toBe(404);
});
