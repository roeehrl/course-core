import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { PRACTICE_REASONS, practiceReason } from '../src/learner-snapshot.js';
import { fixture } from './fixture.js';

// Why an open question counts as practice (activeChallenges[].practiceReason) and each lesson's
// recap counts (checkSummaries), as the learner snapshot sends them. Real PostgreSQL and HTTP.
const origin = 'http://localhost:4310';
const schema = `course_practice_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined, workspaceId: string, releaseId: string;
interface Session { userId: string; cookie: string; csrf: string }

async function person(role: string): Promise<Session> {
  const userId = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `test:${userId}`, 'Synthetic person']);
  await db.query('INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspaceId, userId, role]);
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(response.statusCode, response.body).toBe(200);
  return { userId, cookie: response.cookies.map(row => `${row.name}=${row.value}`).join('; '), csrf: response.json().csrfToken };
}
const call = (who: Session, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: who.cookie, origin, 'x-csrf-token': who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function command(who: Session, enrollmentId: string, action: string, data: object) {
  const snapshot = await call(who, 'GET', `/api/enrollments/${enrollmentId}`);
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  const response = await call(who, 'POST', `/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: snapshot.json().revision, idempotencyKey: randomUUID(), ...data });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function learner() {
  const who = await person('learner');
  const enrolled = await call(who, 'POST', '/api/enrollments', { releaseId });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  return { who, enrollmentId: enrolled.json().id as string };
}
const issue = async (who: Session, enrollmentId: string, assessmentId: string) =>
  (await command(who, enrollmentId, 'challenges', { episodeId: 'min', assessmentId, mode: 'independent' })).challengeId as string;
async function reasonOf(who: Session, enrollmentId: string, challengeId: string) {
  const snapshot = (await call(who, 'GET', `/api/enrollments/${enrollmentId}`)).json();
  return snapshot.activeChallenges.find((row: { challengeId: string }) => row.challengeId === challengeId).practiceReason;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `practice-${workspaceId}`, 'Practice reasons']);
  const owner = await person('owner');
  const release = await call(owner, 'POST', `/api/workspaces/${workspaceId}/releases`, fixture());
  expect(release.statusCode, release.body).toBe(200); releaseId = release.json().id;
  expect((await call(owner, 'POST', `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('why a question is practice', () => {
  it('is null while it counts, and the companion when the learner asked it for help', async () => {
    const { who, enrollmentId } = await learner();
    const id = await issue(who, enrollmentId, 'min-a');
    expect(await reasonOf(who, enrollmentId, id)).toBeNull();
    await command(who, enrollmentId, 'companion', { episodeId: 'min', content: 'Why is 2 smaller?', allowAssessmentAssistance: true });
    expect(await reasonOf(who, enrollmentId, id)).toBe('companion');
  });

  it('is the explanation once the learner opened it', async () => {
    const { who, enrollmentId } = await learner();
    const id = await issue(who, enrollmentId, 'min-a');
    await command(who, enrollmentId, 'solution', { challengeId: id });
    expect(await reasonOf(who, enrollmentId, id)).toBe('solution');
    expect((await db.query('SELECT assistance,assistance_reason FROM assessment_challenges WHERE id=$1', [id])).rows[0]).toEqual({ assistance: 'solution', assistance_reason: 'solution' });
  });

  it('is "seen before" for a question shown again, with no help given', async () => {
    const { who, enrollmentId } = await learner();
    const first = await issue(who, enrollmentId, 'min-a');
    await command(who, enrollmentId, 'answers', { challengeId: first, answer: 'two' });
    const again = await issue(who, enrollmentId, 'min-a');
    expect(await reasonOf(who, enrollmentId, again)).toBe('seen_before');
  });

  it('is a fresh question when one was asked for, and null for questions downgraded before reasons were stored', async () => {
    const { who, enrollmentId } = await learner();
    const fresh = await issue(who, enrollmentId, 'min-a'), legacy = await issue(who, enrollmentId, 'min-b');
    // The fresh-question path (adaptation-store.ts) writes this reason with its downgrade.
    await db.query("UPDATE assessment_challenges SET assistance='hint',assistance_reason='fresh_question',independent_eligible=false WHERE id=$1", [fresh]);
    // A row from before migration 127: downgraded, no reason recorded. Never guessed.
    await db.query("UPDATE assessment_challenges SET assistance='hint',independent_eligible=false WHERE id=$1", [legacy]);
    expect(await reasonOf(who, enrollmentId, fresh)).toBe('fresh_question');
    expect(await reasonOf(who, enrollmentId, legacy)).toBeNull();
    await expect(db.query("UPDATE assessment_challenges SET assistance_reason='guess' WHERE id=$1", [legacy])).rejects.toThrow(/check constraint/);
  });

  it('is derived the same way for every stored row', () => {
    const row = { independent_eligible: false, assistance: 'none', assistance_reason: null, mode: 'independent' };
    expect(practiceReason({ ...row, independent_eligible: true })).toBeNull();
    expect(practiceReason(row)).toBe('seen_before');
    expect(practiceReason({ ...row, mode: 'placement' })).toBe('seen_before');
    expect(practiceReason({ ...row, mode: 'practice' })).toBeNull();
    expect(practiceReason({ ...row, assistance: 'hint', assistance_reason: 'hint' })).toBe('hint');
    expect(practiceReason({ ...row, assistance: 'hint' })).toBeNull();
    expect(PRACTICE_REASONS).toEqual(['companion', 'hint', 'solution', 'fresh_question', 'seen_before']);
  });
});

describe("a lesson's recap counts", () => {
  it('counts submitted answers on your own and as practice, never "I don\'t know yet"', async () => {
    const { who, enrollmentId } = await learner();
    expect((await call(who, 'GET', `/api/enrollments/${enrollmentId}`)).json().checkSummaries).toEqual({});
    // On your own.
    await command(who, enrollmentId, 'answers', { challengeId: await issue(who, enrollmentId, 'min-a'), answer: 'two' });
    // Seen before, answered: practice.
    await command(who, enrollmentId, 'answers', { challengeId: await issue(who, enrollmentId, 'min-a'), answer: 'two' });
    // Help from the companion, then answered: practice.
    const helped = await issue(who, enrollmentId, 'min-b');
    await command(who, enrollmentId, 'companion', { episodeId: 'min', content: 'How do I find a minimum?', allowAssessmentAssistance: true });
    await command(who, enrollmentId, 'answers', { challengeId: helped, answer: 4 });
    // "I don't know yet": not counted either way.
    await command(who, enrollmentId, 'answers', { challengeId: await issue(who, enrollmentId, 'min-b'), abstain: true });
    expect((await call(who, 'GET', `/api/enrollments/${enrollmentId}`)).json().checkSummaries).toEqual({ min: { own: 1, practice: 2 } });
  });
});
