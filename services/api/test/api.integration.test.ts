import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { fixture } from './fixture.js';

const origin = 'http://localhost:4310';
const schema = `course_test_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let admin: Session, learner: Session, other: Session, foreign: Session, releaseId: string, workspaceId: string;
interface Session { userId: string; cookie: string; csrf: string }

async function seedSession(workspace: string, role: string): Promise<Session> {
  const userId = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `test:${userId}`, 'Test learner']);
  await db.query('INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspace, userId, role]);
  const token = await issueLoginCode(db, userId);
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token } });
  expect(response.statusCode, response.body).toBe(200);
  return { userId, cookie: response.cookies.map(row => `${row.name}=${row.value}`).join('; '), csrf: response.json().csrfToken };
}

function request(session: Session, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { cookie: session.cookie, origin, 'x-csrf-token': session.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function enrollment(session = learner) {
  const response = await request(session, 'POST', '/api/enrollments', { releaseId });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().id as string;
}
async function command(session: Session, enrollmentId: string, action: string, data: object, key = randomUUID()) {
  const snapshot = await request(session, 'GET', `/api/enrollments/${enrollmentId}`);
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  return request(session, 'POST', `/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: snapshot.json().revision, idempotencyKey: key, ...data });
}
async function answer(session: Session, enrollmentId: string, assessmentId: string, value: unknown, mode = 'independent') {
  const issued = await command(session, enrollmentId, 'challenges', { episodeId: 'min', assessmentId, mode });
  expect(issued.statusCode, issued.body).toBe(200);
  const response = await command(session, enrollmentId, 'answers', { challengeId: issued.json().challengeId, answer: value });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema, { migrated: false });
  db = createDatabase(testDatabase.url);
  const directory = fileURLToPath(new URL('../migrations', import.meta.url));
  expect((await migrate(db, directory)).length).toBeGreaterThanOrEqual(2);
  expect(await migrate(db, directory)).toEqual([]);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  workspaceId = randomUUID();
  const foreignId = randomUUID();
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceId, 'test', 'Test', foreignId, 'foreign', 'Foreign']);
  admin = await seedSession(workspaceId, 'admin'); learner = await seedSession(workspaceId, 'learner'); other = await seedSession(workspaceId, 'learner'); foreign = await seedSession(foreignId, 'admin');
  const release = await request(admin, 'POST', `/api/workspaces/${workspaceId}/releases`, fixture());
  expect(release.statusCode, release.body).toBe(200); releaseId = release.json().id;
  expect((await request(admin, 'POST', `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
}, 30000);

afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('authentication and tenant boundaries', () => {
  it('requires authentication, exact origin and session-bound CSRF', async () => {
    expect((await app.inject({ url: '/api/workspaces' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/enrollments', headers: { cookie: learner.cookie, origin: 'https://evil.invalid', 'x-csrf-token': learner.csrf }, payload: { releaseId } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/enrollments', headers: { cookie: learner.cookie, origin, 'x-csrf-token': admin.csrf }, payload: { releaseId } })).statusCode).toBe(403);
    const malformed = await app.inject({ method: 'POST', url: '/api/enrollments', headers: { cookie: learner.cookie, origin, 'x-csrf-token': learner.csrf, 'content-type': 'application/json' }, payload: '{"releaseId":' });
    expect(malformed.statusCode).toBe(400); expect(malformed.json()).toEqual({ error: 'INVALID_REQUEST' });
  });
  it('atomically consumes a login code only once under contention', async () => {
    const token = await issueLoginCode(db, learner.userId);
    const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token } })));
    expect(results.map(row => row.statusCode).sort()).toEqual([200, 401, 401, 401, 401, 401]);
  });
  it('denies author actions to learners and cross-workspace administrators', async () => {
    expect((await request(learner, 'POST', `/api/workspaces/${workspaceId}/releases`, fixture())).statusCode).toBe(403);
    expect((await request(foreign, 'POST', `/api/releases/${releaseId}/publish`)).statusCode).toBe(403);
    const id = await enrollment();
    expect((await request(other, 'GET', `/api/enrollments/${id}`)).statusCode).toBe(404);
    expect((await request(foreign, 'GET', `/api/enrollments/${id}`)).statusCode).toBe(403);
  });
  it('never returns answer keys or bank prompts in an enrollment bootstrap', async () => {
    const id = await enrollment();
    const result = await request(learner, 'GET', `/api/enrollments/${id}`);
    expect(result.body).not.toContain('correctOptionId'); expect(result.body).not.toContain('Which is smaller?');
    expect(result.json().course.assessments[0]).toEqual({ id: 'min-a', type: 'choice', objectiveIds: ['minimum'] });
  });
});

describe('transactional evidence and progression', () => {
  it('creates exactly one enrollment and start event during concurrent enrollment retries', async () => {
    const fresh = await seedSession(workspaceId, 'learner');
    const responses = await Promise.all(Array.from({ length: 8 }, () => enrollment(fresh)));
    expect(new Set(responses).size).toBe(1);
    const counts = await db.query("SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'", [responses[0]]);
    expect(Number(counts.rows[0].count)).toBe(1);
  });
  it('refuses skipped lessons and a fabricated mastery field', async () => {
    const id = await enrollment();
    expect((await command(learner, id, 'complete', { episodeId: 'min' })).json().error).toBe('EVIDENCE_REQUIRED');
    expect((await command(learner, id, 'read', { episodeId: 'max', blockId: 'max-text' })).json().error).toBe('PREREQUISITE_NOT_READY');
    expect((await command(learner, id, 'answers', { challengeId: randomUUID(), answer: 4, passed: true })).statusCode).toBe(400);
  });
  it('replays one committed response and rejects changed semantics under the same key', async () => {
    const id = await enrollment(), key = randomUUID();
    const state = (await request(learner, 'GET', `/api/enrollments/${id}`)).json();
    const payload = { expectedRevision: state.revision, idempotencyKey: key, episodeId: 'min', blockId: 'min-text' };
    const results = await Promise.all(Array.from({ length: 8 }, () => request(learner, 'POST', `/api/enrollments/${id}/read`, payload)));
    expect(results.every(row => row.statusCode === 200)).toBe(true);
    expect(new Set(results.map(row => row.body)).size).toBe(1);
    const counts = await db.query('SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND idempotency_key=$2', [id, `${id}:${key}`]);
    expect(Number(counts.rows[0].count)).toBe(1);
    expect((await request(learner, 'POST', `/api/enrollments/${id}/read`, { ...payload, blockId: 'max-text' })).json().error).toBe('IDEMPOTENCY_CONFLICT');
    expect((await request(learner, 'POST', `/api/enrollments/${id}/read`, { ...payload, idempotencyKey: randomUUID() })).json().error).toBe('STALE_REVISION');
  });
  it('deduplicates evidence and outbox records for a retried answer, then opens the next episode only after two families', async () => {
    const id = await enrollment();
    const issued = await command(learner, id, 'challenges', { episodeId: 'min', assessmentId: 'min-a', mode: 'independent' });
    expect(issued.statusCode, issued.body).toBe(200);
    const payload = { expectedRevision: issued.json().revision, idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer: 'two' };
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(learner, 'POST', `/api/enrollments/${id}/answers`, payload)));
    expect(responses.every(row => row.statusCode === 200)).toBe(true);
    expect(new Set(responses.map(row => row.body)).size).toBe(1);
    expect(Number((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1', [id])).rows[0].count)).toBe(1);
    expect(Number((await db.query("SELECT count(*) FROM outbox o JOIN learning_events e ON e.id=o.event_id WHERE e.enrollment_id=$1 AND e.event_type='assessment.submitted'", [id])).rows[0].count)).toBe(1);
    expect((await command(learner, id, 'complete', { episodeId: 'min' })).json().error).toBe('EVIDENCE_REQUIRED');
    await answer(learner, id, 'min-b', 4);
    const result = await command(learner, id, 'complete', { episodeId: 'min' });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().lessons.map((row: { status: string }) => row.status)).toEqual(['completed', 'available']);
  });
  it('practice and corrected repeats remain ineligible for independent mastery', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    expect((await answer(student, id, 'min-a', 'five')).result.passed).toBe(false);
    const corrected = await answer(student, id, 'min-a', 'two');
    expect(corrected.result.passed).toBe(true); expect(corrected.result.independent).toBe(false);
    expect((await answer(student, id, 'min-b', 4, 'practice')).result.independent).toBe(false);
    expect((await command(student, id, 'complete', { episodeId: 'min' })).json().error).toBe('EVIDENCE_REQUIRED');
  });
  it('checks deadline at commit even if the question was issued earlier', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    const issued = await command(student, id, 'challenges', { episodeId: 'min', assessmentId: 'min-a', mode: 'independent' });
    const snapshot = (await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [id])).rows[0].snapshot;
    snapshot.scopes[0].hardDeadline = { at: new Date(Date.now() - 1000).toISOString(), timeZone: 'UTC', disambiguation: 'reject' };
    await db.query('UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1', [id, JSON.stringify(snapshot)]);
    const response = await command(student, id, 'answers', { challengeId: issued.json().challengeId, answer: 'two' });
    expect(response.json().error).toBe('DEADLINE_REACHED');
    expect(Number((await db.query('SELECT count(*) FROM attempts WHERE enrollment_id=$1', [id])).rows[0].count)).toBe(0);
  });
  it('rolls back answers, evidence, challenge consumption and revision if the event append fails', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    const issued = await command(student, id, 'challenges', { episodeId: 'min', assessmentId: 'min-a', mode: 'independent' });
    const payload = { expectedRevision: issued.json().revision, idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer: 'two' };
    await db.query(`CREATE FUNCTION reject_assessment_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='assessment.submitted' THEN RAISE EXCEPTION 'injected storage failure'; END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER reject_assessment_event BEFORE INSERT ON learning_events FOR EACH ROW EXECUTE FUNCTION reject_assessment_event()');
    try {
      const failed = await request(student, 'POST', `/api/enrollments/${id}/answers`, payload);
      expect(failed.statusCode).toBe(500); expect(failed.body).not.toContain('injected');
      expect(Number((await db.query('SELECT count(*) FROM attempts WHERE enrollment_id=$1', [id])).rows[0].count)).toBe(0);
      expect(Number((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1', [id])).rows[0].count)).toBe(0);
      expect((await db.query('SELECT attempt_id FROM assessment_challenges WHERE id=$1', [payload.challengeId])).rows[0].attempt_id).toBeNull();
      expect((await request(student, 'GET', `/api/enrollments/${id}`)).json().revision).toBe(payload.expectedRevision);
    } finally {
      await db.query('DROP TRIGGER reject_assessment_event ON learning_events');
      await db.query('DROP FUNCTION reject_assessment_event()');
    }
    const retried = await request(student, 'POST', `/api/enrollments/${id}/answers`, payload);
    expect(retried.statusCode, retried.body).toBe(200); expect(retried.json().result.independent).toBe(true);
  });
  it('records solution help before returning it and downgrades subsequent evidence', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    const issued = await command(student, id, 'challenges', { episodeId: 'min', mode: 'independent' });
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().question.id).toBe('min-a');
    const help = await command(student, id, 'solution', { challengeId: issued.json().challengeId });
    expect(help.statusCode, help.body).toBe(200); expect(help.json().independentEligible).toBe(false);
    const result = await command(student, id, 'answers', { challengeId: issued.json().challengeId, answer: 'two' });
    expect(result.json().result.passed).toBe(true); expect(result.json().result.independent).toBe(false);
  });
  it('records placement distinctly and still enforces prerequisite order', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    expect((await command(student, id, 'challenges', { episodeId: 'min', assessmentId: 'min-a', mode: 'placement' })).json().error).toBe('PLACEMENT_RUN_REQUIRED');
    expect((await command(student, id, 'placement/start', {})).statusCode).toBe(200);
    await answer(student, id, 'min-a', 'two', 'placement'); await answer(student, id, 'min-b', 4, 'placement');
    expect((await command(student, id, 'complete', { episodeId: 'min', placement: true })).json().error).toBe('PLACEMENT_REQUIRES_RUN_ACCEPTANCE');
    expect((await command(student, id, 'placement/finish', {})).statusCode).toBe(200);
    const accepted = await command(student, id, 'placement/accept', { startEpisodeId: 'max' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const result = await request(student, 'GET', '/api/enrollments/' + id);
    expect(result.json().lessons[0].status).toBe('placed');
    expect(result.json().lessons[0].completedBlockIds).toEqual([]);
  });
  it('requires explicit switch to practice before companion help on an active independent check', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    const issued = await command(student, id, 'challenges', { episodeId: 'min', mode: 'independent' });
    const message = { episodeId: 'min', content: 'Explain how to compare these values.' };
    const refused = await command(student, id, 'companion', message);
    expect(refused.json().error).toBe('ASSESSMENT_HELP_CONSENT_REQUIRED');
    expect((await db.query('SELECT count(*) FROM companion_messages WHERE enrollment_id=$1', [id])).rows[0].count).toBe('0');
    const accepted = await command(student, id, 'companion', { ...message, allowAssessmentAssistance: true });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().downgradedChallengeIds).toEqual([issued.json().challengeId]);
    const answerResult = await command(student, id, 'answers', { challengeId: issued.json().challengeId, answer: 'two' });
    expect(answerResult.json().result.independent).toBe(false);
    const history = await request(student, 'GET', `/api/enrollments/${id}/companion`);
    expect(history.json().messages).toHaveLength(1); expect(history.json().messages[0].role).toBe('learner');
    expect((await request(other, 'GET', `/api/enrollments/${id}/companion`)).statusCode).toBe(404);
  });
  it('anchors assigned windows on eligibility and started windows on engagement; refresh and repeated reading never reset clocks', async () => {
    const course = fixture(); course.version = '1.1.0';
    course.chapters[0]!.policy = { mode: 'bounded', window: { calendarDays: 15, timeZone: 'America/New_York', anchor: 'scope_assigned', pauseRule: 'never' }, existingMaterialAccess: 'read_only' };
    course.chapters[0]!.episodes[0]!.policy = { mode: 'bounded', window: { calendarDays: 2, timeZone: 'America/New_York', anchor: 'scope_started', pauseRule: 'never' }, existingMaterialAccess: 'read_only' };
    const imported = await request(admin, 'POST', `/api/workspaces/${workspaceId}/releases`, course);
    expect(imported.statusCode, imported.body).toBe(200);
    await request(admin, 'POST', `/api/releases/${imported.json().id}/publish`);
    const student = await seedSession(workspaceId, 'learner');
    const enrolled = await request(student, 'POST', '/api/enrollments', { releaseId: imported.json().id });
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const id = enrolled.json().id;
    const initial = (await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [id])).rows[0].snapshot;
    expect(initial.scopes.find((scope: any) => scope.scopeId === 'chapter:order').window.anchor).toBe('scope_assigned');
    expect(initial.scopes.find((scope: any) => scope.scopeId === 'episode:min').window).toBeUndefined();
    expect((await request(student, 'GET', `/api/enrollments/${id}`)).statusCode).toBe(200);
    const read = await command(student, id, 'read', { episodeId: 'min', blockId: 'min-text' });
    expect(read.statusCode, read.body).toBe(200);
    const anchored = (await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [id])).rows[0].snapshot;
    const window = anchored.scopes.find((scope: any) => scope.scopeId === 'episode:min').window;
    expect(window.anchor).toBe('scope_started');
    await command(student, id, 'read', { episodeId: 'min', blockId: 'min-text' });
    const reloaded = (await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [id])).rows[0].snapshot;
    expect(reloaded.scopes.find((scope: any) => scope.scopeId === 'episode:min').window).toEqual(window);
    expect((await db.query('SELECT count(*) FROM scope_anchors WHERE enrollment_id=$1', [id])).rows[0].count).toBe('2');
  });
  it('closes completed work with a separate mastery report and prevents silent continuation', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    for (const [episodeId, pairs] of [['min', [['min-a', 'two'], ['min-b', 4]]], ['max', [['max-a', 9], ['max-b', -3]]]] as const) {
      expect((await command(student, id, 'read', { episodeId, blockId: `${episodeId}-text` })).statusCode).toBe(200);
      for (const [assessmentId, value] of pairs) {
        const issued = await command(student, id, 'challenges', { episodeId, assessmentId, mode: 'independent' });
        expect(issued.statusCode, issued.body).toBe(200);
        const result = await command(student, id, 'answers', { challengeId: issued.json().challengeId, answer: value });
        expect(result.statusCode, result.body).toBe(200);
      }
      const completed = await command(student, id, 'complete', { episodeId });
      expect(completed.statusCode, completed.body).toBe(200);
    }
    const snapshot = (await request(student, 'GET', `/api/enrollments/${id}`)).json();
    expect(snapshot.status).toBe('completed');
    expect(snapshot.closureReport.coverage).toBe('complete');
    expect(snapshot.closureReport.mastery).toBe('demonstrated');
    expect(snapshot.closureReport.continuation).toBe('explicit_opt_in_separate_track');
    const more = await command(student, id, 'challenges', { episodeId: 'max', assessmentId: 'max-a', mode: 'practice' });
    expect(more.json().error).toBe('ENROLLMENT_INACTIVE');
    const readOnly = await command(student, id, 'read', { episodeId: 'min', blockId: 'min-text' });
    expect(readOnly.statusCode, readOnly.body).toBe(200);
  });
});

describe('real extension ledger races and consent', () => {
  async function offer(student: Session, id: string) {
    const snapshot = (await request(student, 'GET', `/api/enrollments/${id}`)).json();
    const event = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'", [id])).rows[0];
    const response = await request(admin, 'POST', `/api/enrollments/${id}/extensions/propose`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), scopeId: 'course', days: 2,
      rationaleEventIds: [event.id], episodeIds: ['min'], planImpact: 'Two more days for independent practice.', alternatives: ['Finish on the existing date with an explicit gap report.'] });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  it('requires learner consent to exact terms; concurrent retries debit once with matching relational and snapshot ledgers', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student);
    const proposed = await offer(student, id);
    expect(proposed.balances[0].remaining).toBe(2);
    const payload = { expectedRevision: proposed.revision, idempotencyKey: randomUUID(), offerId: proposed.offer.terms.offerId, termsDigest: proposed.offer.termsDigest, explicitConsent: true };
    expect((await request(admin, 'POST', `/api/enrollments/${id}/extensions/accept`, payload)).statusCode).toBe(404);
    expect((await request(student, 'POST', `/api/enrollments/${id}/extensions/accept`, { ...payload, explicitConsent: false })).statusCode).toBe(400);
    expect((await request(student, 'POST', `/api/enrollments/${id}/extensions/accept`, { ...payload, termsDigest: '0'.repeat(64) })).json().error).toBe('CONSENT_REQUIRED');
    const responses = await Promise.all(Array.from({ length: 12 }, () => request(student, 'POST', `/api/enrollments/${id}/extensions/accept`, payload)));
    expect(responses.every(row => row.statusCode === 200), responses.map(row => row.body).join('\n')).toBe(true);
    expect(new Set(responses.map(row => row.body)).size).toBe(1);
    expect(responses[0]!.json().balances[0].remaining).toBe(0);
    const grants = await db.query('SELECT * FROM extension_grants WHERE enrollment_id=$1', [id]);
    expect(grants.rowCount).toBe(1);
    const snapshot = (await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1', [id])).rows[0].snapshot;
    expect(snapshot.grants).toHaveLength(1);
    expect(snapshot.grants[0].atomicLedgerTransactionId).toBe(grants.rows[0].ledger_transaction_id);
    expect(Number((await db.query("SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND event_type='extension.granted'", [id])).rows[0].count)).toBe(1);
    const denied = await request(student, 'POST', `/api/enrollments/${id}/extensions/preview`, { scopeId: 'course', days: 1 });
    expect(denied.json().error).toBe('ALLOWANCE_EXHAUSTED');
  });
  it('does not grant twice when simultaneous requests use different idempotency keys', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student), proposed = await offer(student, id);
    const responses = await Promise.all(Array.from({ length: 6 }, () => request(student, 'POST', `/api/enrollments/${id}/extensions/accept`, {
      expectedRevision: proposed.revision, idempotencyKey: randomUUID(), offerId: proposed.offer.terms.offerId, termsDigest: proposed.offer.termsDigest, explicitConsent: true,
    })));
    expect(responses.map(row => row.statusCode).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect((await db.query('SELECT count(*) FROM extension_grants WHERE enrollment_id=$1', [id])).rows[0].count).toBe('1');
  });
  it('declining preserves the full allowance and never creates a grant', async () => {
    const student = await seedSession(workspaceId, 'learner'), id = await enrollment(student), proposed = await offer(student, id);
    const declined = await command(student, id, 'extensions/decline', { offerId: proposed.offer.terms.offerId });
    expect(declined.statusCode, declined.body).toBe(200); expect(declined.json().balances[0].remaining).toBe(2);
    expect((await db.query('SELECT count(*) FROM extension_grants WHERE enrollment_id=$1', [id])).rows[0].count).toBe('0');
  });
});
