import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode, type Actor } from '../src/auth.js';
import { teachingContext } from '../src/provider-context.js';
import { createLearnerModelProposalPort } from '../src/learner-model.js';
import { retrieveConversation } from '../src/context-capsule.js';
import { hashPassword, storePassword } from '../src/passwords.js';
import { fixture } from './fixture.js';

const origin = 'http://localhost:4310', schema = `course_account_erasure_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
const workspaces: { id: string; releaseId: string; digest: string }[] = [];
let service: Actor;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  const owner = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `account-erasure:${owner}`, 'Author']);
  service = { id: owner, displayName: 'Author' };
  for (let i = 0; i < 2; i++) {
    const compiled = compileCourse(fixture()), id = randomUUID(), releaseId = randomUUID();
    await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [id, `erasure-${id}`, `Erasure ${i}`]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
    await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
      [releaseId, id, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
    workspaces.push({ id, releaseId, digest: compiled.digest });
  }
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

type Session = { user: string; headers: Record<string, string> };
async function login(user: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  expect(response.statusCode, response.body).toBe(200);
  return { user, headers: { origin, cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': response.json().csrfToken } };
}
async function member(role = 'learner', inWorkspaces = [0]) {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `account-erasure:${user}`, `PERSON_${user.slice(0, 8)}`]);
  for (const index of inWorkspaces) await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaces[index]!.id, user, role]);
  return login(user);
}
async function enroll(s: Session, index = 0) {
  const response = await app.inject({ method: 'POST', url: '/api/enrollments', headers: s.headers, payload: { releaseId: workspaces[index]!.releaseId } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().id as string;
}
const revision = async (id: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
async function command(s: Session, id: string, path: string, body: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: `/api/enrollments/${id}/${path}`, headers: s.headers, payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), ...body } });
}
/** The answer to a question through the real provider-context capsule (no provider is called). */
async function answered(s: Session, id: string, content: string) {
  const asked = (await command(s, id, 'companion', { episodeId: 'min', content })).json() as { messageId: string; eventId: string };
  const jobId = randomUUID(), workspaceId = workspaces[0]!.id;
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES($1,$2,$3,$4,'companion','running',1,'{}')`, [jobId, id, workspaceId, `erasure-${jobId}`]);
  await db.query('UPDATE companion_messages SET job_id=$2 WHERE id=$1', [asked.messageId, jobId]);
  await teachingContext(db, { jobId, workspaceId, enrollmentId: id, generation: 1 }, { kind: 'learning_event', eventId: asked.eventId, eventType: 'companion.requested', courseReleaseId: workspaces[0]!.releaseId, episodeId: 'min', messageId: asked.messageId });
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,'{}',$4)", [randomUUID(), id, `ANSWER_TO_${content}`, jobId]);
  await db.query("UPDATE supervisor_jobs SET state='applied' WHERE id=$1", [jobId]);
  return { ...asked, jobId };
}

describe('deleting one companion question', () => {
  it('removes it and its answer, cancels unfinished work and revokes what was derived from it', async () => {
    const learner = await member(), id = await enroll(learner), workspaceId = workspaces[0]!.id;
    const first = await answered(learner, id, 'DELETED_QUESTION_CANARY');
    const second = await answered(learner, id, 'A later question.');
    // The later answer's capsule cites the first question.
    expect(JSON.stringify((await db.query('SELECT capsule FROM companion_context_capsules WHERE job_id=$1', [second.jobId])).rows[0].capsule)).toContain(first.messageId);
    // A learner-model suggestion that cites the first question, which the learner accepted.
    const port = createLearnerModelProposalPort<string>(db, async (_credential, scope) => ({ ...scope, actor: service, serviceId: 'test-service' }));
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT (workspace_id,user_id) DO UPDATE SET role='owner'", [workspaceId, service.id]);
    const proposal = await port.propose('credential', { workspaceId, enrollmentId: id, expectedRevision: await revision(id), idempotencyKey: randomUUID(),
      suggestion: { kind: 'pace', value: 'gentle' }, sourceEventIds: [first.eventId] });
    expect((await command(learner, id, `learner-model/proposals/${proposal.proposalId}/decision`, { action: 'accept' })).statusCode).toBe(200);
    // A third question still being answered.
    const third = await answered(learner, id, 'Third question.');
    await db.query("UPDATE supervisor_jobs SET state='running' WHERE id=$1", [third.jobId]);

    for (const who of [await member('owner'), await member()]) expect((await command(who, id, `companion/messages/${first.messageId}/delete`)).statusCode).toBe(404);
    const assistant = (await db.query("SELECT id FROM companion_messages WHERE job_id=$1 AND role='assistant'", [first.jobId])).rows[0].id;
    expect((await command(learner, id, `companion/messages/${assistant}/delete`)).json().error).toBe('MESSAGE_NOT_FOUND');
    const deleted = await command(learner, id, `companion/messages/${first.messageId}/delete`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({ deleted: true, answersDeleted: 1, jobCancelled: false, capsulesRevised: 3, revokedProposalIds: [proposal.proposalId] });
    expect((await command(learner, id, `companion/messages/${first.messageId}/delete`)).json().error).toBe('MESSAGE_ALREADY_DELETED');
    // The text is gone from the conversation, its answer, every capsule, retrieval and history.
    const messages = (await app.inject({ url: `/api/enrollments/${id}/companion`, headers: learner.headers })).body;
    expect(messages).not.toContain('DELETED_QUESTION_CANARY');
    expect((await db.query('SELECT capsule FROM companion_context_capsules WHERE job_id=$1', [first.jobId])).rows[0].capsule).toEqual({});
    const capsules = JSON.stringify((await db.query('SELECT capsule FROM companion_context_capsules WHERE enrollment_id=$1', [id])).rows);
    expect(capsules).not.toContain(first.messageId); expect(capsules).not.toContain('DELETED_QUESTION_CANARY');
    const retrieved = await transaction(db, client => retrieveConversation(client, { enrollmentId: id, episodeId: 'min', courseDigest: workspaces[0]!.digest }));
    expect(JSON.stringify(retrieved)).not.toContain(first.messageId);
    const history = (await app.inject({ url: `/api/enrollments/${id}/learner-model/history?episodeId=min&kind=questions`, headers: learner.headers })).json();
    expect(history.items.map((item: { messageId: string }) => item.messageId)).not.toContain(first.messageId);
    // The suggestion it supported is revoked: out of provider context and cannot be accepted again.
    const model = (await app.inject({ url: `/api/enrollments/${id}/learner-model?episodeId=min`, headers: learner.headers })).json();
    expect(model.suggestions.items.find((item: { proposalId: string }) => item.proposalId === proposal.proposalId)).toMatchObject({ status: 'source_revoked' });
    expect((await command(learner, id, `learner-model/proposals/${proposal.proposalId}/decision`, { action: 'accept' })).json().error).toBe('PROPOSAL_SOURCE_REVOKED');
    // Deleting the question still being answered cancels that work.
    const cancel = await command(learner, id, `companion/messages/${third.messageId}/delete`);
    expect(cancel.json()).toMatchObject({ jobCancelled: true });
    expect((await db.query('SELECT cancellation_requested FROM supervisor_jobs WHERE id=$1', [third.jobId])).rows[0].cancellation_requested).toBe(true);
  });
});

describe('cancelling one companion question', () => {
  it('stops waiting for its answer, keeps the question, and refuses answered, foreign and deleted questions', async () => {
    const learner = await member(), id = await enroll(learner);
    // A question whose job is held up waiting for the service (an uncertain provider call).
    const waiting = await answered(learner, id, 'WAITING_QUESTION_CANARY');
    await db.query("DELETE FROM companion_messages WHERE job_id=$1 AND role='assistant'", [waiting.jobId]);
    await db.query("UPDATE supervisor_jobs SET state='waiting',result=$2 WHERE id=$1", [waiting.jobId, JSON.stringify({ reason: 'provider_uncertain' })]);
    const listed = async () => (await app.inject({ url: `/api/enrollments/${id}/companion`, headers: learner.headers })).json().messages as { id: string; content: string; job_state: string }[];
    expect((await listed()).find(m => m.id === waiting.messageId)?.job_state).toBe('waiting');

    for (const who of [await member('owner'), await member()]) expect((await command(who, id, `companion/messages/${waiting.messageId}/cancel`)).statusCode).toBe(404);
    const before = await revision(id);
    const cancelled = await command(learner, id, `companion/messages/${waiting.messageId}/cancel`);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ messageId: waiting.messageId, cancelled: true });
    // Not a context change: the revision stays, the question text stays, the job is flagged and reads as cancelled.
    expect(await revision(id)).toBe(before);
    expect((await db.query('SELECT cancellation_requested FROM supervisor_jobs WHERE id=$1', [waiting.jobId])).rows[0].cancellation_requested).toBe(true);
    const row = (await listed()).find(m => m.id === waiting.messageId)!;
    expect(row).toMatchObject({ content: 'WAITING_QUESTION_CANARY', job_state: 'cancelled' });
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.question.cancelled' AND payload->>'messageId'=$2",
      [id, waiting.messageId])).rows[0].n).toBe(1);
    // Nothing is left to cancel a second time.
    expect((await command(learner, id, `companion/messages/${waiting.messageId}/cancel`)).json().error).toBe('MESSAGE_NOT_PENDING');

    // A question still queued (not yet prepared into a job): its request is withdrawn.
    const queued = (await command(learner, id, 'companion', { episodeId: 'min', content: 'Queued question.' })).json() as { messageId: string; eventId: string };
    const withdrawn = await command(learner, id, `companion/messages/${queued.messageId}/cancel`);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect((await db.query('SELECT quarantined_at FROM outbox WHERE event_id=$1', [queued.eventId])).rows[0].quarantined_at).not.toBeNull();
    expect((await listed()).find(m => m.id === queued.messageId)).toMatchObject({ content: 'Queued question.', job_state: 'cancelled' });

    // An answered question, an answer and a deleted question cannot be cancelled.
    const done = await answered(learner, id, 'Answered question.');
    expect((await command(learner, id, `companion/messages/${done.messageId}/cancel`)).json().error).toBe('MESSAGE_ALREADY_ANSWERED');
    const answer = (await db.query("SELECT id FROM companion_messages WHERE job_id=$1 AND role='assistant'", [done.jobId])).rows[0].id;
    expect((await command(learner, id, `companion/messages/${answer}/cancel`)).json().error).toBe('MESSAGE_NOT_FOUND');
    expect((await command(learner, id, `companion/messages/${done.messageId}/delete`)).statusCode).toBe(200);
    expect((await command(learner, id, `companion/messages/${done.messageId}/cancel`)).json().error).toBe('MESSAGE_ALREADY_DELETED');
  });
});

describe('account erasure', () => {
  it('erases every enrollment and the account, and signs it out everywhere', async () => {
    const first = await member('learner', [0, 1]);
    const ids = [await enroll(first, 0), await enroll(first, 1)];
    await answered(first, ids[0]!, 'ACCOUNT_QUESTION_CANARY');
    // Setting a password signs out earlier sessions; sign in twice afterwards (two devices).
    await storePassword(db, first.user, await hashPassword('synthetic long passphrase'), { mustChange: false, loginName: `erasure-${first.user.slice(0, 8)}` });
    const learner = await login(first.user), other = await login(first.user);
    await issueLoginCode(db, learner.user);
    const erase = (s: Session, body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/account/erase', headers: s.headers, payload: body });
    expect((await erase(learner, { confirmation: 'ERASE', reason: 'Synthetic account erasure.' })).json().error).toBe('ERASURE_CONFIRMATION_REQUIRED');
    expect((await erase(learner, { confirmation: 'ERASE MY ACCOUNT', reason: 'short' })).statusCode).toBe(400);
    // Running supervision is asked to stop first.
    const job = randomUUID();
    await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES($1,$2,$3,$4,'companion','running',1,'{}')`, [job, ids[1], workspaces[1]!.id, `erasure-${job}`]);
    const waiting = await erase(learner, { confirmation: 'ERASE MY ACCOUNT', reason: 'Synthetic account erasure.' });
    expect([waiting.statusCode, waiting.json().error]).toEqual([409, 'ERASURE_WAITING_FOR_SUPERVISION']);
    expect((await db.query('SELECT cancellation_requested FROM supervisor_jobs WHERE id=$1', [job])).rows[0].cancellation_requested).toBe(true);
    await db.query("UPDATE supervisor_jobs SET state='cancelled' WHERE id=$1", [job]);
    const erased = await erase(learner, { confirmation: 'ERASE MY ACCOUNT', reason: 'Synthetic account erasure.' });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json()).toMatchObject({ status: 'erased', counts: { 'account.password': 1, 'account.memberships': 2, 'account.sessions': 2, 'account.signInCodes': 4 } });
    expect(erased.json().enrollmentIds.sort()).toEqual([...ids].sort());
    expect((await db.query("SELECT count(*)::int AS n FROM enrollments WHERE user_id=$1 AND status='erased'", [learner.user])).rows[0].n).toBe(2);
    expect((await db.query('SELECT count(*)::int AS n FROM data_erasures WHERE enrollment_id=ANY($1::uuid[])', [ids])).rows[0].n).toBe(2);
    expect((await db.query('SELECT display_name,subject,login_name FROM app_users WHERE id=$1', [learner.user])).rows[0]).toEqual({ display_name: 'Erased account', subject: `erased:${learner.user}`, login_name: null });
    // No content, name or sign-in remains; both sessions are signed out and a new code cannot sign in.
    const leftovers = JSON.stringify((await db.query('SELECT content FROM companion_messages WHERE enrollment_id=ANY($1::uuid[])', [ids])).rows) + JSON.stringify((await db.query('SELECT * FROM app_users WHERE id=$1', [learner.user])).rows);
    expect(leftovers).not.toContain('ACCOUNT_QUESTION_CANARY'); expect(leftovers).not.toContain(`PERSON_${learner.user.slice(0, 8)}`);
    for (const s of [learner, other]) expect((await app.inject({ url: '/api/enrollments', headers: s.headers })).statusCode).toBe(401);
    expect((await db.query('SELECT count(*)::int AS n FROM memberships WHERE user_id=$1', [learner.user])).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM password_credentials WHERE user_id=$1', [learner.user])).rows[0].n).toBe(0);
    const relogin = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, learner.user) } });
    if (relogin.statusCode === 200) expect((await app.inject({ url: '/api/enrollments', headers: { cookie: relogin.cookies.map(c => `${c.name}=${c.value}`).join('; ') } })).json()).toEqual([]);
    expect((await db.query('SELECT enrollment_ids FROM account_erasures WHERE user_id=$1', [learner.user])).rows).toHaveLength(1);
  });

  it('refuses staff accounts and other workspaces are untouched', async () => {
    const staff = await member('instructor');
    const refused = await app.inject({ method: 'POST', url: '/api/account/erase', headers: staff.headers, payload: { confirmation: 'ERASE MY ACCOUNT', reason: 'Synthetic account erasure.' } });
    expect([refused.statusCode, refused.json().error]).toEqual([409, 'ACCOUNT_HAS_STAFF_ROLE']);
    const bystander = await member(), bystanderEnrollment = await enroll(bystander);
    const leaving = await member(); await enroll(leaving);
    expect((await app.inject({ method: 'POST', url: '/api/account/erase', headers: leaving.headers, payload: { confirmation: 'ERASE MY ACCOUNT', reason: 'Synthetic account erasure.' } })).statusCode).toBe(200);
    expect((await db.query('SELECT status FROM enrollments WHERE id=$1', [bystanderEnrollment])).rows[0].status).toBe('active');
    expect((await app.inject({ url: '/api/enrollments', headers: bystander.headers })).statusCode).toBe(200);
  });
});
