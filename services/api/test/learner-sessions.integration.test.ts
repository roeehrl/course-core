import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { ensureCatalog } from '../src/admin-routes.js';
import { scanWakeups } from '../src/wakeups.js';
import { hypothesisCourse } from './hypothesis-fixture.js';
import { canonicalJson } from '@course-core/sdk/compiler';

/**
 * Trigger T10's "session ended" (requirement B03) over HTTP and PostgreSQL: a study session opens
 * with the learner's own events and ends once, when the app reports the learner left or after a
 * quiet period; with the learner's supervision opt-in that starts preparing the next lesson.
 */
const schema = 'learner_sessions_' + randomUUID().replaceAll('-', ''), workspace = randomUUID(), releaseId = randomUUID();
const origin = 'http://localhost:4310';
type Session = { id: string; cookie: string; csrf: string };
let db: Database, testDatabase: TestDatabase | undefined, app: Awaited<ReturnType<typeof createServer>>;
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
async function login(role = 'learner'): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, 'test:' + id, 'Synthetic person']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
}
async function command(learner: Session, id: string, path: string, body: Record<string, unknown>) {
  const revision = (await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision as number;
  const r = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/${path}`, headers: headers(learner), payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...body } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function enroll(consent: boolean) {
  const learner = await login();
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id as string;
  await command(learner, id, 'supervision', { adaptiveTeaching: consent });
  return { learner, id };
}
/** A learner event of this session: a practice question issued and answered. */
async function study(learner: Session, id: string) {
  const issued = await command(learner, id, 'challenges', { episodeId: 'min', assessmentId: 'min-practice', mode: 'practice' });
  await command(learner, id, 'answers', { challengeId: issued.challengeId, answer: 'three' });
}
const end = (learner: Session, id: string) => app.inject({ method: 'POST', url: `/api/enrollments/${id}/session/end`, headers: headers(learner), payload: {} });
const session = async (id: string) => (await db.query('SELECT sessions,ended_at IS NOT NULL AS ended,end_reason FROM learner_sessions WHERE enrollment_id=$1', [id])).rows[0];
const actions = async (id: string) => (await db.query("SELECT action,rule_id,objective_ids,state FROM teaching_actions WHERE enrollment_id=$1 ORDER BY created_at", [id])).rows;
const endedEvents = async (id: string) => (await db.query("SELECT actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='session.ended' ORDER BY sequence", [id])).rows;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error('Disposable TEST_DATABASE_URL required');
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'learner-sessions', 'Learner sessions qualification']);
  const owner = await login('owner');
  const course = hypothesisCourse();
  const digest = createHash('sha256').update(canonicalJson(course.server)).digest('hex');
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [releaseId, workspace, course.server.id, course.server.version, digest, JSON.stringify(course.server), JSON.stringify(course.learner), owner.id]);
  await ensureCatalog(db, releaseId);
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('study sessions and trigger T10 "session ended" (B03)', () => {
  it('the learner leaving ends the session once and, with the opt-in, starts preparing the next lesson', async () => {
    const { learner, id } = await enroll(true);
    await study(learner, id);
    expect(await session(id)).toEqual({ sessions: 1, ended: false, end_reason: null });
    const first = await end(learner, id);
    expect([first.statusCode, first.json()]).toEqual([200, { ended: true, session: 1 }]);
    // Another tab, a retry or the idle scan finds it already ended.
    expect((await end(learner, id)).json()).toEqual({ ended: false });
    await scanWakeups(db, { batchSize: 1000, sessionIdleMs: 0 });
    expect(await session(id)).toEqual({ sessions: 1, ended: true, end_reason: 'learner_left' });
    const events = await endedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_kind: 'learner', payload: { reason: 'learner_left', session: 1 } });
    // The next unfinished lesson's objectives, prepared once by T10.
    expect((await actions(id)).filter(a => a.rule_id === 'T10')).toEqual([{ action: 'prepare_review', rule_id: 'T10', objective_ids: ['minimum'], state: 'started' }]);
    const signal = (await db.query("SELECT rule_ids,restraints FROM teaching_signals WHERE enrollment_id=$1 AND signal_kind='session.ended'", [id])).rows;
    expect(signal).toHaveLength(1);
    expect(signal[0].rule_ids).toEqual(['T10']);
    expect(signal[0].restraints).toEqual(expect.arrayContaining(['notifications_follow_explicit_preferences', 'one_preparation_per_session']));
  });

  it('a quiet session ends on the wake-up scan; new activity opens the next session; a second end inside the cooldown is not repeated', async () => {
    const { learner, id } = await enroll(true);
    await study(learner, id);
    // Still active within the idle window: nothing ends.
    await scanWakeups(db, { batchSize: 1000 });
    expect((await session(id)).ended).toBe(false);
    await db.query("UPDATE learner_sessions SET last_activity_at=clock_timestamp()-interval '31 minutes' WHERE enrollment_id=$1", [id]);
    const scan = await scanWakeups(db, { batchSize: 1000 });
    expect(scan.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(await session(id)).toEqual({ sessions: 1, ended: true, end_reason: 'idle' });
    expect((await endedEvents(id))[0]).toMatchObject({ actor_kind: 'system', payload: { reason: 'idle', session: 1 } });
    await study(learner, id);
    expect(await session(id)).toEqual({ sessions: 2, ended: false, end_reason: null });
    expect((await end(learner, id)).json()).toEqual({ ended: true, session: 2 });
    // The second session's preparation for the same objectives is inside the cooldown: one action.
    expect((await actions(id)).filter(a => a.rule_id === 'T10')).toHaveLength(1);
    const skipped = (await db.query("SELECT skipped FROM teaching_signals WHERE enrollment_id=$1 AND signal_kind='session.ended' ORDER BY created_at", [id])).rows.at(-1).skipped;
    expect(skipped.some((s: { reason: string }) => s.reason === 'recommendation_cooldown' || s.reason === 'already_open')).toBe(true);
  });

  it('without the opt-in the session still ends, but nothing is inferred or started', async () => {
    const { learner, id } = await enroll(false);
    await study(learner, id);
    expect((await end(learner, id)).json()).toEqual({ ended: true, session: 1 });
    expect(await actions(id)).toEqual([]);
    expect((await db.query("SELECT count(*)::int AS n FROM teaching_signals WHERE enrollment_id=$1", [id])).rows[0].n).toBe(0);
  });

  it('only the enrollment\'s own learner may end it; an ended session has nothing more to end', async () => {
    const { learner, id } = await enroll(true);
    const other = await login();
    expect((await end(other, id)).statusCode).toBe(404);
    const staff = await login('owner');
    expect((await end(staff, id)).statusCode).toBe(404);
    // Enrolling and the opt-in were the learner's own events; once that session ends there is none open.
    expect((await end(learner, id)).json()).toEqual({ ended: true, session: 1 });
    expect((await end(learner, id)).json()).toEqual({ ended: false });
    const anonymous = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/session/end`, headers: { origin }, payload: {} });
    expect(anonymous.statusCode).toBe(401);
    const extra = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/session/end`, headers: headers(learner), payload: { reason: 'idle' } });
    expect(extra.statusCode).toBe(400);
  });
});
