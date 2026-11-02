import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CourseManifest } from '@course-core/sdk';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { findCheckAnswerLeak, gradedChecks } from '../src/companion-check-integrity.js';
import { questionCheckCoaching } from '../src/companion-check-scope.js';
import { companionCreditScope } from '../src/companion-ask-route.js';
import { fixture } from './fixture.js';
import { enablePlacement } from './placement-admin-fixture.js';

// Which open counted questions a companion message makes practice (docs/companion-check-integrity.md):
// the lesson's own and the attached one, never another lesson's, which stays counted while the
// withheld-answer gate still keeps its answer from the learner. Real PostgreSQL and HTTP; no model.
const origin = 'http://localhost:4310';
const schema = `course_credit_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
interface Session { userId: string; cookie: string; csrf: string }

/** The ordering course with both lessons open at once: "min" optional, "max" without a prerequisite. */
function twoOpenLessons(placement?: Record<string, unknown>): CourseManifest {
  const course = fixture();
  course.version = `2.0.${Math.floor(Math.random() * 1e6)}`;
  course.objectives[1]!.prerequisites = [];
  course.chapters[0]!.episodes[0]!.requirement = 'optional';
  course.chapters[0]!.episodes[1]!.blocks.push({ id: 'max-check', type: 'assessment', assessmentId: 'max-a' });
  if (placement) Object.assign(course.placement!, placement);
  return course;
}

async function person(workspaceId: string, role: string): Promise<Session> {
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
  return call(who, 'POST', `/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: snapshot.json().revision, idempotencyKey: randomUUID(), ...data });
}
/** A workspace with the course published, its owner and one enrolled learner. */
async function course(manifest: CourseManifest, placement?: Record<string, unknown>) {
  const workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `credit-${workspaceId}`, 'Credit scope']);
  const owner = await person(workspaceId, 'owner'), learner = await person(workspaceId, 'learner');
  const release = await call(owner, 'POST', `/api/workspaces/${workspaceId}/releases`, manifest);
  expect(release.statusCode, release.body).toBe(200);
  expect((await call(owner, 'POST', `/api/releases/${release.json().id}/publish`)).statusCode).toBe(200);
  if (placement) await enablePlacement(app, owner, origin, workspaceId, placement);
  const enrolled = await call(learner, 'POST', '/api/enrollments', { releaseId: release.json().id });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  return { learner, enrollmentId: enrolled.json().id as string, releaseId: release.json().id as string };
}
async function open(who: Session, enrollmentId: string, episodeId: string) {
  const issued = await command(who, enrollmentId, 'challenges', { episodeId, mode: 'independent' });
  expect(issued.statusCode, issued.body).toBe(200);
  expect(issued.json().independentEligible).toBe(true);
  return issued.json().challengeId as string;
}
const challenge = async (id: string) =>
  (await db.query<{ independent_eligible: boolean; assistance: string; assistance_reason: string | null }>('SELECT independent_eligible,assistance,assistance_reason FROM assessment_challenges WHERE id=$1', [id])).rows[0];
const counted = { independent_eligible: true, assistance: 'none', assistance_reason: null };
const practice = { independent_eligible: false, assistance: 'hint', assistance_reason: 'companion' };

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('the credit scope of a companion message', () => {
  it('is the lesson\'s open questions and the attached one, never another lesson\'s', () => {
    const rows = [{ id: 'a', episode_id: 'min' }, { id: 'b', episode_id: 'max' }];
    expect(companionCreditScope(rows, 'min')).toEqual([rows[0]]);
    expect(companionCreditScope(rows, 'min', 'b')).toEqual(rows);
    expect(companionCreditScope(rows, 'other')).toEqual([]);
  });

  it('asking in lesson A downgrades only A\'s open question; B\'s stays counted and needs no consent', async () => {
    const { learner, enrollmentId } = await course(twoOpenLessons());
    const a = await open(learner, enrollmentId, 'min'), b = await open(learner, enrollmentId, 'max');
    // Consent is still required for the question in scope, and nothing is stored without it.
    const refused = await command(learner, enrollmentId, 'companion', { episodeId: 'min', content: 'Why is 2 smaller?' });
    expect(refused.json().error).toBe('ASSESSMENT_HELP_CONSENT_REQUIRED');
    expect((await db.query('SELECT count(*)::int AS n FROM companion_messages WHERE enrollment_id=$1', [enrollmentId])).rows[0].n).toBe(0);
    expect(await challenge(a)).toEqual(counted);
    const accepted = await command(learner, enrollmentId, 'companion', { episodeId: 'min', content: 'Why is 2 smaller?', allowAssessmentAssistance: true });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().downgradedChallengeIds).toEqual([a]);
    expect(await challenge(a)).toEqual(practice);
    expect(await challenge(b)).toEqual(counted);
    // The message remembers which question became practice, by its number in its lesson.
    const stored = (await db.query('SELECT context FROM companion_messages WHERE id=$1', [accepted.json().messageId])).rows[0].context;
    expect(stored.downgraded).toEqual([{ challengeId: a, ordinal: 1 }]);
    expect(stored.downgradedChallengeIds).toEqual([a]);
    // Asking from lesson B now still asks first: its own question counts.
    expect((await command(learner, enrollmentId, 'companion', { episodeId: 'max', content: 'What is a maximum?' })).json().error).toBe('ASSESSMENT_HELP_CONSENT_REQUIRED');
    // A message with no counted question in scope needs no consent and changes nothing.
    const snapshot = (await call(learner, 'GET', `/api/enrollments/${enrollmentId}`)).json();
    expect(snapshot.activeChallenges.find((row: { challengeId: string }) => row.challengeId === b)).toMatchObject({ independentEligible: true, practiceReason: null });
    expect(snapshot.activeChallenges.find((row: { challengeId: string }) => row.challengeId === a)).toMatchObject({ independentEligible: false, practiceReason: 'companion' });
    const free = await command(learner, enrollmentId, 'companion', { episodeId: 'min', content: 'And the largest?' });
    expect(free.statusCode, free.body).toBe(200);
    expect(free.json().downgradedChallengeIds).toEqual([]);
    expect((await db.query('SELECT context FROM companion_messages WHERE id=$1', [free.json().messageId])).rows[0].context.downgraded).toBeUndefined();
    expect(await challenge(b)).toEqual(counted);
  });

  it('a question attached from another lesson is in scope', async () => {
    const { learner, enrollmentId } = await course(twoOpenLessons());
    const a = await open(learner, enrollmentId, 'min'), b = await open(learner, enrollmentId, 'max');
    const message = { episodeId: 'min', content: 'Help with this one.', challengeId: b };
    expect((await command(learner, enrollmentId, 'companion', message)).json().error).toBe('ASSESSMENT_HELP_CONSENT_REQUIRED');
    const accepted = await command(learner, enrollmentId, 'companion', { ...message, allowAssessmentAssistance: true });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect([...accepted.json().downgradedChallengeIds].sort()).toEqual([a, b].sort());
    const stored = (await db.query('SELECT context FROM companion_messages WHERE id=$1', [accepted.json().messageId])).rows[0].context;
    expect(stored.attachedCheck).toEqual({ challengeId: b, ordinal: 1 });
    expect([...stored.downgraded].sort((x: { challengeId: string }, y: { challengeId: string }) => x.challengeId.localeCompare(y.challengeId)))
      .toEqual([{ challengeId: a, ordinal: 1 }, { challengeId: b, ordinal: 1 }].sort((x, y) => x.challengeId.localeCompare(y.challengeId)));
    expect(await challenge(a)).toEqual(practice);
    expect(await challenge(b)).toEqual(practice);
  });

  it('a placement item its author declared unassisted-only still refuses help from any lesson', async () => {
    const policy = { retestPolicy: { maxAttempts: 2, cooldownDays: 1 }, assistancePolicy: 'unassisted_only',
      evidenceThresholds: { minimumIndependentFamilies: 2, skipRequiresCriticalPrerequisites: true } };
    const { learner, enrollmentId } = await course(twoOpenLessons(policy), { maxRuns: 2, retestCooldownHours: 24 });
    expect((await command(learner, enrollmentId, 'placement/start', {})).statusCode).toBe(200);
    const next = (await call(learner, 'GET', `/api/enrollments/${enrollmentId}/placement`)).json().run.nextItem;
    const issued = await command(learner, enrollmentId, 'challenges', { episodeId: next.episodeId, assessmentId: next.assessmentId, mode: 'placement' });
    expect(issued.statusCode, issued.body).toBe(200);
    const elsewhere = next.episodeId === 'min' ? 'max' : 'min';
    const refused = await command(learner, enrollmentId, 'companion', { episodeId: elsewhere, content: 'A question about something else.', allowAssessmentAssistance: true });
    expect(refused.json().error).toBe('PLACEMENT_UNASSISTED_ONLY');
    expect((await db.query('SELECT assistance,independent_eligible FROM assessment_challenges WHERE id=$1', [issued.json().challengeId])).rows[0])
      .toEqual({ assistance: 'none', independent_eligible: true });
  });

  it('the withheld-answer gate still keeps B\'s answer from a question asked in lesson A', async () => {
    const { learner, enrollmentId, releaseId } = await course(twoOpenLessons());
    await open(learner, enrollmentId, 'min');
    const b = await open(learner, enrollmentId, 'max');
    const question = 'Maximum of 4 and 9? Is it 9?';
    const accepted = await command(learner, enrollmentId, 'companion', { episodeId: 'min', content: question, allowAssessmentAssistance: true });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await challenge(b)).toEqual(counted);
    const release = (await db.query<{ digest: string; server_bundle: unknown }>('SELECT digest,server_bundle FROM course_releases WHERE id=$1', [releaseId])).rows[0]!;
    // The turn is coached over B's open question, and a reply giving its answer would be withheld.
    const coaching = await transaction(db, client => questionCheckCoaching(client, { enrollmentId, courseDigest: release.digest, course: release.server_bundle,
      episodeId: 'min', blockId: null, messageId: accepted.json().messageId, question, before: new Date(), earlier: [] }));
    expect(coaching?.items.map(item => item.checkId)).toContain('max-a');
    const checks = gradedChecks(release.server_bundle).filter(check => check.id === 'max-a');
    expect(findCheckAnswerLeak('Yes, it is 9.', checks, question)).not.toBeNull();
  });
});
