import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueLoginCode, type Actor } from '../src/auth.js';
import { createDatabase, type Database } from '../src/database.js';
import { createServer } from '../src/server.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { fixture } from './fixture.js';

const origin = 'http://localhost:4310';
const schema = `course_evidence_disputes_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID();
type Session = { actor: Actor; cookie: string; csrf: string };
let testDatabase: TestDatabase | undefined, db: Database, app: FastifyInstance;
let releaseId: string, otherReleaseId: string, catalogId: string, otherCatalogId: string;
let owner: Session, reviewer: Session, observer: Session, foreignAdmin: Session;

const headers = (session: Session) => ({ cookie: session.cookie, origin, 'x-csrf-token': session.csrf });
async function session(workspace: string, role: string, name = 'Synthetic person'): Promise<Session> {
  const actor = { id: randomUUID(), displayName: name };
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES ($1,$2,$3)', [actor.id, `evidence-disputes:${actor.id}`, name]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspace, actor.id, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  expect(login.statusCode, login.body).toBe(200);
  return { actor, csrf: login.json().csrfToken, cookie: login.cookies.map(row => `${row.name}=${row.value}`).join('; ') };
}
async function revision(id: string) { return Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision); }
async function command(who: Session, id: string, path: string, fields: object) {
  const response = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/${path}`, headers: headers(who),
    payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), ...fields } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function enroll(release = releaseId, learner?: Session) {
  learner ??= await session(workspaceId, 'learner', `Learner ${randomUUID().slice(0, 6)}`);
  const response = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId: release } });
  expect(response.statusCode, response.body).toBe(200);
  return { learner, id: response.json().id as string };
}
async function answer(learner: Session, id: string, assessmentId: string, value: unknown) {
  const issued = await command(learner, id, 'challenges', { episodeId: 'min', assessmentId, mode: 'independent' });
  await command(learner, id, 'answers', { challengeId: issued.challengeId, answer: value });
  return (await db.query<{ id: string }>('SELECT e.id FROM evidence e JOIN attempts a ON a.id=e.attempt_id WHERE e.enrollment_id=$1 AND a.assessment_id=$2 ORDER BY e.created_at DESC LIMIT 1', [id, assessmentId])).rows[0]!.id;
}
async function dispute(learner: Session, id: string, evidenceId: string, reason: string) {
  return command(learner, id, `learner-model/evidence/${evidenceId}/control`, { action: 'dispute', reason });
}
const queue = (who: Session, course = catalogId) => app.inject({ url: `/api/admin/courses/${course}/evidence-disputes`, headers: headers(who) });
const resolve = (who: Session, disputeId: string, body: Record<string, unknown>, course = catalogId) =>
  app.inject({ method: 'POST', url: `/api/admin/courses/${course}/evidence-disputes/${disputeId}/resolve`, headers: headers(who),
    payload: { idempotencyKey: `dispute-${randomUUID()}`, ...body } });
const understanding = async (learner: Session, id: string) =>
  (await app.inject({ url: `/api/enrollments/${id}/learner-model?episodeId=min`, headers: headers(learner) })).json().understanding[0];

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceId, `disputes-${workspaceId}`, 'Dispute tests', foreignWorkspaceId, `disputes-${foreignWorkspaceId}`, 'Other workspace']);
  owner = await session(workspaceId, 'owner', 'Course owner');
  reviewer = await session(workspaceId, 'reviewer', 'Evidence reviewer');
  observer = await session(workspaceId, 'observer', 'Observer');
  foreignAdmin = await session(foreignWorkspaceId, 'admin', 'Foreign admin');
  const publish = async (course: ReturnType<typeof fixture>) => {
    const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/releases`, headers: headers(owner), payload: course });
    expect(imported.statusCode, imported.body).toBe(200);
    const id = imported.json().id as string;
    expect((await app.inject({ method: 'POST', url: `/api/releases/${id}/publish`, headers: headers(owner) })).statusCode).toBe(200);
    return id;
  };
  releaseId = await publish(fixture());
  const other = fixture();
  other.id = `${other.id}-other`;
  otherReleaseId = await publish(other);
  const courses = (await app.inject({ url: '/api/admin/session', headers: headers(owner) })).json().courses as { id: string; title: string }[];
  const catalogs = (await db.query<{ id: string; course_key: string }>('SELECT id,course_key FROM admin_course_catalog WHERE workspace_id=$1', [workspaceId])).rows;
  catalogId = catalogs.find(row => row.course_key === fixture().id)!.id;
  otherCatalogId = catalogs.find(row => row.course_key === other.id)!.id;
  expect(courses.map(course => course.id).sort()).toEqual([catalogId, otherCatalogId].sort());
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('staff evidence-dispute queue', () => {
  it('lists open disputes for the course without the learner reason, and resolves by reviewing the evidence', async () => {
    const a = await enroll(), b = await enroll(), elsewhere = await enroll(otherReleaseId);
    const reason = `DISPUTE_REASON_CANARY_${randomUUID()}`;
    const valid = await answer(a.learner, a.id, 'min-a', 'two');
    const wrong = await answer(b.learner, b.id, 'min-a', 'five');
    const foreignCourse = await answer(elsewhere.learner, elsewhere.id, 'min-a', 'two');
    await dispute(a.learner, a.id, valid, reason);
    await dispute(b.learner, b.id, wrong, reason);
    await dispute(elsewhere.learner, elsewhere.id, foreignCourse, reason);

    const listed = await queue(reviewer);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain(reason);
    expect(listed.body).not.toContain('"reason"');
    const rows = listed.json().disputes as Record<string, any>[];
    // Only this course's disputes, oldest first.
    expect(rows.map(row => row.evidence.evidenceId)).toEqual([valid, wrong]);
    expect(rows[0]).toMatchObject({ state: 'open', enrollmentId: a.id, objectiveId: 'minimum', ageDays: 0, canResolve: true, canUphold: true,
      evidence: { evidenceId: valid, assessmentId: 'min-a', passed: true, independent: true, mode: 'independent' } });
    expect(Date.parse(rows[0]!.raisedAt)).toBeGreaterThan(Date.now() - 60_000);
    // A failed answer cannot be upheld as valid; only invalidating closes it.
    expect(rows[1]).toMatchObject({ canResolve: true, canUphold: false, evidence: { passed: false } });
    expect(listed.json().truncated).toBe(false);
    expect((await queue(reviewer, otherCatalogId)).json().disputes.map((row: any) => row.evidence.evidenceId)).toEqual([foreignCourse]);

    // Uphold: acknowledged, the grade is unchanged, and the dispute is closed as #83 defines it.
    const disputeA = rows[0]!.disputeId as string, key = `dispute-${randomUUID()}`;
    const upheld = await resolve(reviewer, disputeA, { decision: 'accept', note: 'Checked against the answer key.', idempotencyKey: key });
    expect(upheld.statusCode, upheld.body).toBe(200);
    expect(upheld.json()).toMatchObject({ disputeId: disputeA, state: 'resolved', decision: 'accept', evidenceId: valid, invalidated: false, replayed: false });
    expect((await db.query('SELECT invalidated_at FROM evidence WHERE id=$1', [valid])).rows[0].invalidated_at).toBeNull();
    expect(await understanding(a.learner, a.id)).toMatchObject({ openDisputes: 0 });
    expect((await db.query("SELECT decision,actor_id FROM admin_evidence_reviews WHERE evidence_id=$1", [valid])).rows).toEqual([{ decision: 'accept', actor_id: reviewer.actor.id }]);
    // Audited: the enrollment event names the dispute, and the course-level audit event records who decided.
    const events = (await db.query<{ event_type: string; actor_id: string; payload: any }>(
      "SELECT event_type,actor_id,payload FROM learning_events WHERE workspace_id=$1 AND (payload->>'disputeId')=$2 ORDER BY sequence", [workspaceId, disputeA])).rows;
    expect(events).toEqual([
      { event_type: 'evidence.review_acknowledged', actor_id: reviewer.actor.id, payload: expect.objectContaining({ evidenceId: valid, decision: 'accept', disputeId: disputeA }) },
      { event_type: 'admin.evidence_dispute.resolved', actor_id: reviewer.actor.id, payload: { catalogId, disputeId: disputeA, evidenceId: valid, decision: 'accept' } },
    ]);
    // A retry replays; the same key with another decision conflicts; a new key finds the dispute closed.
    const replay = await resolve(reviewer, disputeA, { decision: 'accept', note: 'Checked against the answer key.', idempotencyKey: key });
    expect(replay.json()).toEqual({ ...upheld.json(), replayed: true });
    expect((await resolve(reviewer, disputeA, { decision: 'reject', note: 'Changed my mind.', idempotencyKey: key })).json().error).toBe('IDEMPOTENCY_CONFLICT');
    const closed = await resolve(owner, disputeA, { decision: 'reject', note: 'Too late.' });
    expect([closed.statusCode, closed.json().error]).toEqual([409, 'EVIDENCE_DISPUTE_CLOSED']);
    expect((await db.query('SELECT count(*)::int AS n FROM admin_evidence_reviews WHERE evidence_id=$1', [valid])).rows[0].n).toBe(1);

    // Uphold is refused for evidence Core cannot acknowledge; invalidating resolves it.
    const disputeB = rows[1]!.disputeId as string;
    expect((await resolve(owner, disputeB, { decision: 'accept', note: 'Looks fine.' })).json().error).toBe('REVIEW_CANNOT_GRANT_MASTERY');
    const invalidated = await resolve(owner, disputeB, { decision: 'reject', note: 'The answer was recorded against the wrong item.' });
    expect(invalidated.statusCode, invalidated.body).toBe(200);
    expect(invalidated.json()).toMatchObject({ state: 'resolved', decision: 'reject', invalidated: true });
    expect((await db.query('SELECT invalidation_reason FROM evidence WHERE id=$1', [wrong])).rows[0].invalidation_reason).toBe('The answer was recorded against the wrong item.');
    expect((await queue(reviewer)).json().disputes).toEqual([]);
    // The learner can dispute again after a review; it reappears in the queue.
    await dispute(a.learner, a.id, valid, 'Still unsure.');
    expect((await queue(reviewer)).json().disputes.map((row: any) => row.evidence.evidenceId)).toEqual([valid]);
  });

  it('enforces evidence.review on the course, course scope, self-review and input bounds', async () => {
    const { learner, id } = await enroll();
    const evidenceId = await answer(learner, id, 'min-b', 4);
    await dispute(learner, id, evidenceId, 'Please check this one.');
    const disputeId = (await queue(owner)).json().disputes.find((row: any) => row.evidence.evidenceId === evidenceId).disputeId as string;
    // No evidence.review: observer, learner, another workspace's admin.
    for (const who of [observer, learner, foreignAdmin]) {
      expect((await queue(who)).statusCode).toBe(403);
      expect((await resolve(who, disputeId, { decision: 'reject', note: 'Not allowed.' })).statusCode).toBe(403);
    }
    // Course-scoped grants (permit through catalogFor): a reviewer grant opens this course only;
    // an observer grant, or an expired or revoked grant, opens nothing.
    const grant = async (role: string, catalog: string, expires = "now() + interval '1 day'") => {
      const who = await session(workspaceId, 'course_scoped', `Scoped ${role}`);
      await db.query(`INSERT INTO course_access_grants(id,workspace_id,catalog_id,user_id,role,reason_code,granted_by,expires_at)
        VALUES ($1,$2,$3,$4,$5,'synthetic_test',$6,${expires})`, [randomUUID(), workspaceId, catalog, who.actor.id, role, owner.actor.id]);
      return who;
    };
    const scopedReviewer = await grant('reviewer', catalogId);
    expect((await queue(scopedReviewer)).json().disputes.map((row: any) => row.disputeId)).toContain(disputeId);
    expect((await queue(scopedReviewer, otherCatalogId)).statusCode).toBe(403);
    const otherCourseReviewer = await grant('reviewer', otherCatalogId);
    expect((await queue(otherCourseReviewer)).statusCode).toBe(403);
    expect((await resolve(otherCourseReviewer, disputeId, { decision: 'reject', note: 'Other course.' })).statusCode).toBe(403);
    expect((await resolve(otherCourseReviewer, disputeId, { decision: 'reject', note: 'Other course.' }, otherCatalogId)).json().error).toBe('EVIDENCE_DISPUTE_NOT_FOUND');
    const scopedObserver = await grant('observer', catalogId);
    expect((await queue(scopedObserver)).statusCode).toBe(403);
    expect((await resolve(scopedObserver, disputeId, { decision: 'reject', note: 'Observer.' })).statusCode).toBe(403);
    const expired = await grant('reviewer', catalogId, "clock_timestamp() + interval '50 milliseconds'");
    await new Promise(done => setTimeout(done, 100));
    expect((await queue(expired)).statusCode).toBe(403);
    const revoked = await grant('reviewer', catalogId);
    await db.query("UPDATE course_access_grants SET revoked_at=clock_timestamp(),revoked_by=$2,revoke_reason_code='synthetic_test' WHERE user_id=$1", [revoked.actor.id, owner.actor.id]);
    expect((await queue(revoked)).statusCode).toBe(403);
    // A dispute is only reachable through its own course.
    expect((await resolve(owner, disputeId, { decision: 'reject', note: 'Wrong course.' }, otherCatalogId)).json().error).toBe('EVIDENCE_DISPUTE_NOT_FOUND');
    expect((await resolve(owner, randomUUID(), { decision: 'reject', note: 'Unknown.' })).statusCode).toBe(404);
    expect((await queue(owner, randomUUID())).statusCode).toBe(404);
    for (const body of [{ decision: 'accept' }, { decision: 'accept', note: '   ' }, { decision: 'grant', note: 'No.' }, { decision: 'accept', note: 'x'.repeat(601) },
      { decision: 'accept', note: 'Fine.', reason: 'extra' }, { decision: 'accept', note: 'Fine.', idempotencyKey: 'bad key!' }])
      expect((await resolve(owner, disputeId, body)).statusCode, JSON.stringify(body)).toBe(400);
    // A learner later made a reviewer never resolves their own dispute.
    const dual = await session(workspaceId, 'learner', 'Learner turned reviewer');
    const own = await enroll(releaseId, dual);
    const ownEvidence = await answer(dual, own.id, 'min-b', 4);
    await dispute(dual, own.id, ownEvidence, 'My own dispute.');
    await db.query("UPDATE memberships SET role='reviewer' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, dual.actor.id]);
    const ownRow = (await queue(dual)).json().disputes.find((row: any) => row.evidence.evidenceId === ownEvidence);
    expect(ownRow).toMatchObject({ canResolve: false, canUphold: false });
    expect((await resolve(dual, ownRow.disputeId, { decision: 'accept', note: 'Mine is fine.' })).json().error).toBe('SELF_REVIEW_FORBIDDEN');
    // The course-scoped reviewer resolves on the granted course.
    const second = await answer(learner, id, 'min-a', 'five');
    await dispute(learner, id, second, 'Second dispute.');
    const secondId = (await queue(scopedReviewer)).json().disputes.find((row: any) => row.evidence.evidenceId === second).disputeId;
    const byScoped = await resolve(scopedReviewer, secondId, { decision: 'reject', note: 'Wrong item, invalidated.' });
    expect(byScoped.statusCode, byScoped.body).toBe(200);
    // Erased learners leave the queue and their disputes cannot be resolved.
    const erased = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/erase`, headers: headers(learner), payload: { confirmation: `ERASE ${id.slice(0, 8)}`, reason: 'Synthetic erasure request.' } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await queue(owner)).json().disputes.map((row: any) => row.disputeId)).not.toContain(disputeId);
    expect((await resolve(owner, disputeId, { decision: 'reject', note: 'After erasure.' })).statusCode).toBe(410);
  });
});
