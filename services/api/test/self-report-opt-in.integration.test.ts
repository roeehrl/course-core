import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { teachingContext } from '../src/provider-context.js';
import { fixture } from './fixture.js';

const origin = 'http://localhost:4310', schema = `course_self_report_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, workspaceId: string, releaseId: string;
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  const compiled = compileCourse(fixture()), owner = randomUUID();
  workspaceId = randomUUID(); releaseId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `self-report:${owner}`, 'Author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `self-report-${workspaceId}`, 'Self-report tests']);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function learner(canary: string, optIn: boolean) {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `self-report:${user}`, 'Learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspaceId, user]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  const headers = { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
  const id = (await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } })).json().id as string;
  const post = async (url: string, body: Record<string, unknown>) => {
    const revision = (await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision;
    const response = await app.inject({ method: 'POST', url, headers, payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...body } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  await post(`/api/enrollments/${id}/learner-model/profile`, { profile: { preferences: { pace: 'focused', explanationStyle: 'worked_example', goal: `GOAL_${canary}` },
    priorKnowledge: [{ objectiveId: 'minimum', statement: `PRIOR_${canary}` }], thoughts: `THOUGHTS_${canary}` } });
  if (optIn) await post(`/api/enrollments/${id}/supervision`, { adaptiveTeaching: true });
  const message = await post(`/api/enrollments/${id}/companion`, { episodeId: 'min', content: `QUESTION_${canary}` });
  return { id, message };
}
async function contextFor(enrollmentId: string, role: 'companion' | 'supervisor', message?: { messageId: string; eventId: string }) {
  const jobId = randomUUID();
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES($1,$2,$3,$4,$5,'running',1,'{}')`,
    [jobId, enrollmentId, workspaceId, `self-report-${jobId}`, role]);
  return JSON.stringify(await teachingContext(db, { jobId, workspaceId, enrollmentId, generation: 1 }, { kind: 'learning_event', eventId: message?.eventId ?? randomUUID(),
    eventType: role === 'companion' ? 'companion.requested' : 'learning.updated', courseReleaseId: releaseId, episodeId: 'min', ...(message ? { messageId: message.messageId } : {}) }));
}

it('a companion turn uses the learner\'s own self-report; autonomous supervision needs the opt-in; nothing crosses learners', async () => {
  const a = await learner('CANARY_A', true), b = await learner('CANARY_B', false);
  const statements = (canary: string) => [`GOAL_${canary}`, `PRIOR_${canary}`];
  // B never opted in: the companion answering B's own question uses B's statements; the supervisor gets none.
  const companionB = await contextFor(b.id, 'companion', b.message), supervisorB = await contextFor(b.id, 'supervisor');
  for (const text of statements('CANARY_B')) { expect(companionB).toContain(text); expect(supervisorB).not.toContain(text); }
  expect(supervisorB).toContain('supervision_opt_in_required');
  expect(supervisorB).not.toContain('worked_example');
  // A opted in: both roles receive A's statements.
  const companionA = await contextFor(a.id, 'companion', a.message), supervisorA = await contextFor(a.id, 'supervisor');
  for (const text of statements('CANARY_A')) { expect(companionA).toContain(text); expect(supervisorA).toContain(text); }
  // Private thoughts never reach a model, and no context carries the other learner's words.
  for (const context of [companionA, supervisorA, companionB, supervisorB]) expect(context).not.toMatch(/THOUGHTS_CANARY/);
  for (const context of [companionA, supervisorA]) expect(context).not.toContain('CANARY_B');
  for (const context of [companionB, supervisorB]) expect(context).not.toContain('CANARY_A');
  // Withdrawing the opt-in takes the statements back out of new supervisor work.
  const revision = (await db.query('SELECT revision FROM enrollments WHERE id=$1', [a.id])).rows[0].revision;
  await db.query('UPDATE supervisor_permissions SET adaptive_teaching=false,revision=revision+1 WHERE enrollment_id=$1', [a.id]);
  expect(revision).toBeGreaterThan(0);
  for (const text of statements('CANARY_A')) expect(await contextFor(a.id, 'supervisor')).not.toContain(text);
});
