import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { fixture } from './fixture.js';
import { tablesContaining } from './table-scan.js';

// The learner's feedback on a companion reply (Q4): Helpful or Not helpful, an optional comment and
// "Report a problem". Only the learner's own replies; it bumps no revision, records no event, goes
// with a deleted question, is in their own export only and goes on erasure. Replies are stored rows,
// as the supervisor stores them; no provider is involved.
const origin = 'http://localhost:4312', schema = `course_companion_feedback_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, workspaceId: string, releaseId: string;
let testDatabase: TestDatabase | undefined;

type Person = { user: string; headers: Record<string, string> };
type Learner = Person & { id: string };
async function person(role: string): Promise<Person> {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `feedback:${user}`, `Test ${role}`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, user, role]);
  const signed = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  expect(signed.statusCode, signed.body).toBe(200);
  return { user, headers: { origin, cookie: signed.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': signed.json().csrfToken } };
}
async function fresh(): Promise<Learner> {
  const learner = await person('learner');
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: learner.headers, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  return { ...learner, id: enrolled.json().id };
}
const revision = async (id: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
const events = async (id: string) => Number((await db.query('SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1', [id])).rows[0].n);
/** A question asked through the API and a stored reply to it. */
async function answered(f: Learner, question = 'Why is 2 the smallest?', text = 'Because no other value is smaller.') {
  const asked = await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion`, headers: f.headers,
    payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), episodeId: 'min', content: question } });
  expect(asked.statusCode, asked.body).toBe(200);
  const job = randomUUID(), reply = randomUUID();
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES ($1,$2,$3,$4,'companion','applied',1,'{}')`,
    [job, f.id, workspaceId, `feedback-${job}`]);
  await db.query('UPDATE companion_messages SET job_id=$2 WHERE id=$1', [asked.json().messageId, job]);
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,'{\"episodeId\":\"min\"}',$4)", [reply, f.id, text, job]);
  return { question: asked.json().messageId as string, reply };
}
async function feedback(f: Learner, messageId: string, body: Record<string, unknown>, who: Person = f, key = randomUUID()) {
  return app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/messages/${messageId}/feedback`, headers: who.headers,
    payload: { expectedRevision: await revision(f.id), idempotencyKey: key, ...body } });
}
const stored = async (messageId: string) =>
  (await db.query('SELECT vote,comment,reported FROM companion_reply_feedback WHERE message_id=$1', [messageId])).rows;
const conversation = async (f: Learner) => (await app.inject({ url: `/api/enrollments/${f.id}/companion`, headers: f.headers })).json() as {
  messages: { id: string; role: string; feedback?: unknown; content: string }[];
};

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  const compiled = compileCourse(fixture()), owner = randomUUID();
  workspaceId = randomUUID(); releaseId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `feedback:${owner}`, 'Test author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `feedback-${workspaceId}`, 'Companion feedback tests']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, 'ordering', '1.0.0', compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

describe('feedback on a companion reply', () => {
  it('stores a vote, a comment and a report in place, without a revision, an event or a change to the reply', async () => {
    const f = await fresh();
    const { reply } = await answered(f);
    const before = { revision: await revision(f.id), events: await events(f.id) };
    const helpful = await feedback(f, reply, { vote: 'helpful' });
    expect(helpful.statusCode, helpful.body).toBe(200);
    expect(helpful.json()).toEqual({ messageId: reply, feedback: { vote: 'helpful', reported: false } });
    expect(await stored(reply)).toEqual([{ vote: 'helpful', comment: null, reported: false }]);
    // Changing the vote with a comment updates the one row; a later vote without a comment keeps it.
    expect((await feedback(f, reply, { vote: 'not_helpful', comment: '  It skipped a step.  ' })).json().feedback).toEqual({ vote: 'not_helpful', reported: false });
    expect(await stored(reply)).toEqual([{ vote: 'not_helpful', comment: 'It skipped a step.', reported: false }]);
    expect((await feedback(f, reply, { vote: 'not_helpful', report: true })).json().feedback).toEqual({ vote: 'not_helpful', reported: true });
    expect(await stored(reply)).toEqual([{ vote: 'not_helpful', comment: 'It skipped a step.', reported: true }]);
    // Taking the vote back keeps the report; an empty comment clears it.
    expect((await feedback(f, reply, { vote: null, comment: '' })).json().feedback).toEqual({ vote: null, reported: true });
    expect(await stored(reply)).toEqual([{ vote: null, comment: null, reported: true }]);
    // A vote fences nothing and is not learning evidence.
    expect({ revision: await revision(f.id), events: await events(f.id) }).toEqual(before);
    // The conversation shows the vote and the report on the reply, never the comment.
    await feedback(f, reply, { vote: 'helpful', comment: 'PRIVATE_COMMENT' });
    const read = await conversation(f);
    expect(read.messages.find(row => row.id === reply)?.feedback).toEqual({ vote: 'helpful', reported: true });
    expect(read.messages.find(row => row.role === 'learner')).not.toHaveProperty('feedback');
    expect(JSON.stringify(read)).not.toContain('PRIVATE_COMMENT');
  });

  it('replays an idempotent request and refuses the same key for another request', async () => {
    const f = await fresh();
    const { reply } = await answered(f);
    const key = randomUUID();
    const first = await feedback(f, reply, { vote: 'helpful' }, f, key);
    const again = await feedback(f, reply, { vote: 'helpful' }, f, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((await feedback(f, reply, { vote: 'not_helpful' }, f, key)).json().error).toBe('IDEMPOTENCY_CONFLICT');
    expect(await stored(reply)).toEqual([{ vote: 'helpful', comment: null, reported: false }]);
  });

  it('takes only the learner\'s own replies, a bounded comment and a current revision', async () => {
    const f = await fresh(), other = await fresh();
    const { question, reply } = await answered(f);
    const theirs = await answered(other, 'Another question', 'Another reply');
    // The learner's own question, another learner's reply and an unknown message are not replies of theirs.
    for (const id of [question, theirs.reply, randomUUID()]) {
      const refused = await feedback(f, id, { vote: 'helpful' });
      expect(refused.statusCode, refused.body).toBe(404);
      expect(refused.json().error).toBe('MESSAGE_NOT_FOUND');
    }
    // Nobody else may vote on the learner's reply: another learner, the workspace owner or a stranger.
    const owner = await person('owner');
    for (const who of [other, owner]) expect((await feedback(f, reply, { vote: 'helpful' }, who)).json().error).toBe('ENROLLMENT_NOT_FOUND');
    expect((await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/messages/${reply}/feedback`, headers: { origin },
      payload: { expectedRevision: 1, idempotencyKey: randomUUID(), vote: 'helpful' } })).statusCode).toBe(401);
    // Out-of-shape requests are refused before anything is stored.
    for (const body of [{ vote: 'great' }, { vote: 'helpful', comment: 'x'.repeat(501) }, { vote: 'helpful', extra: true }, {}, { vote: 'helpful', report: 'yes' }])
      expect((await feedback(f, reply, body)).json().error, JSON.stringify(body)).toBe('INVALID_REQUEST');
    expect((await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/messages/not-a-message/feedback`, headers: f.headers,
      payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), vote: 'helpful' } })).json().error).toBe('INVALID_REQUEST');
    const stale = await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/messages/${reply}/feedback`, headers: f.headers,
      payload: { expectedRevision: (await revision(f.id)) - 1, idempotencyKey: randomUUID(), vote: 'helpful' } });
    expect(stale.json().error).toBe('STALE_REVISION');
    // A 500-character comment is accepted.
    expect((await feedback(f, reply, { vote: 'not_helpful', comment: 'y'.repeat(500) })).statusCode).toBe(200);
    expect(await db.query('SELECT count(*)::int AS n FROM companion_reply_feedback WHERE enrollment_id=$1', [other.id]).then(r => r.rows[0].n)).toBe(0);
  });

  it('goes with a deleted question, and a deleted reply takes no more feedback', async () => {
    const f = await fresh();
    const kept = await answered(f, 'First question', 'First reply');
    const gone = await answered(f, 'Second question', 'Second reply');
    await feedback(f, kept.reply, { vote: 'helpful' });
    await feedback(f, gone.reply, { vote: 'not_helpful', comment: 'Wrong numbers', report: true });
    const deleted = await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/messages/${gone.question}/delete`, headers: f.headers,
      payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID() } });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await stored(gone.reply)).toEqual([]);
    expect(await stored(kept.reply)).toEqual([{ vote: 'helpful', comment: null, reported: false }]);
    expect((await feedback(f, gone.reply, { vote: 'helpful' })).json().error).toBe('MESSAGE_NOT_FOUND');
  });

  it('is in the learner\'s own export, withheld from a staff copy, and erased with the enrollment', async () => {
    const f = await fresh();
    const { reply } = await answered(f);
    const canary = `FEEDBACK_CANARY_${randomUUID().replaceAll('-', '')}`;
    expect((await feedback(f, reply, { vote: 'not_helpful', comment: canary, report: true })).statusCode).toBe(200);
    const own = await app.inject({ url: `/api/enrollments/${f.id}/export`, headers: f.headers });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().companionFeedback.items).toEqual([expect.objectContaining({ message_id: reply, vote: 'not_helpful', comment: canary, reported: true })]);
    const owner = await person('owner');
    const staff = await app.inject({ url: `/api/enrollments/${f.id}/export`, headers: owner.headers });
    expect(staff.statusCode, staff.body).toBe(200);
    expect(staff.json()).toMatchObject({ audience: 'staff', companionFeedback: null });
    expect(staff.json().withheld.map((row: { id: string }) => row.id)).toContain('companion');
    expect(staff.body).not.toContain(canary);
    const erased = await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/erase`, headers: f.headers,
      payload: { confirmation: `ERASE ${f.id.slice(0, 8)}`, reason: 'Learner asked for their course data to be removed.' } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts.companionReplyFeedback).toBe(1);
    expect(await stored(reply)).toEqual([]);
    expect(await tablesContaining(db, canary)).toEqual([]);
  });
});
