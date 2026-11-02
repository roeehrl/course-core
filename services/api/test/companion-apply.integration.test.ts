import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { HostBridge, RunRef } from '@course-core/supervisor';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, recordSupervisorVerification, storeSupervisorArtifact } from '../src/supervisor-bridge.js';
import { fixture } from './fixture.js';

// What Core stores with a companion turn for the learner's app: a check the learner attached to
// their message (with its number in the lesson), whether the stored reply asks the learner
// something, and the ids a reply-ready notification carries. Scripted replies only; no provider.
const origin = 'http://localhost:4311', schema = `course_companion_apply_${randomUUID().replaceAll('-', '')}`;
const serviceToken = 'synthetic-test-service-token-not-a-credential';
let db: Database, app: Awaited<ReturnType<typeof createServer>>, workspaceId: string, releaseId: string;
let testDatabase: TestDatabase | undefined;

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  const compiled = compileCourse(fixture()), owner = randomUUID();
  workspaceId = randomUUID(); releaseId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `apply:${owner}`, 'Test author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `apply-${workspaceId}`, 'Companion apply tests']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, 'ordering', '1.0.0', compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

type Learner = { id: string; user: string; headers: Record<string, string> };
async function fresh(): Promise<Learner> {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `apply:${user}`, 'Test learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspaceId, user]);
  const signed = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  expect(signed.statusCode, signed.body).toBe(200);
  const headers = { origin, cookie: signed.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': signed.json().csrfToken };
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  return { id: enrolled.json().id, user, headers };
}
const revision = async (id: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
async function command(f: Learner, action: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/${action}`, headers: f.headers, payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), ...body } });
}
async function issue(f: Learner, assessmentId: string) {
  const issued = await command(f, 'challenges', { episodeId: 'min', assessmentId, mode: 'independent' });
  expect(issued.statusCode, issued.body).toBe(200);
  return issued.json().challengeId as string;
}
const learnerMessages = async (f: Learner) =>
  (await db.query<{ content: string; context: Record<string, unknown> }>("SELECT content,context FROM companion_messages WHERE enrollment_id=$1 AND role='learner' ORDER BY created_at", [f.id])).rows;

/** The learner's question becomes a companion job; a scripted reply is verified and applied. */
async function reply(f: Learner, eventId: string, text: string) {
  const b: HostBridge = createPostgresSupervisorBridge(db, { serviceToken, workspaceIds: [workspaceId],
    jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
  const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === eventId)!;
  expect(lease).toBeDefined();
  const ref: RunRef = (await b.prepareOutbox(lease))[0]!; await b.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId, enrollmentId: f.id }, { microUsd: 10_000, tokens: 10_000 });
  const claimed = await b.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
  expect(claimed.effect).toBe('invoke');
  const op = claimed.snapshot.operations[0]!;
  const output = await storeSupervisorArtifact(db, ref, op.id, op.ownerId, { kind: 'companion_message', text });
  await b.transition({ type: 'settle', ref, operationId: op.id, ownerId: op.ownerId, outcome: { status: 'succeeded', artifact: output, usage: { microUsd: 5, tokens: 5 } } });
  const verifier = randomUUID();
  await db.query(`INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,'Synthetic verifier',true,false)`, [verifier, workspaceId]);
  await recordSupervisorVerification(db, ref, verifier, 'verified');
  await b.transition({ type: 'verify', ref });
  expect((await b.transition({ type: 'apply', ref })).snapshot.state).toBe('applied');
  return (await db.query<{ id: string; context: Record<string, unknown> }>("SELECT id,context FROM companion_messages WHERE job_id=$1 AND role='assistant'", [ref.jobId])).rows[0]!;
}

describe('a check attached to a companion message', () => {
  it('is stored with its number in the lesson', async () => {
    const f = await fresh();
    expect((await command(f, 'read', { episodeId: 'min', blockId: 'min-text' })).statusCode).toBe(200);
    const first = await issue(f, 'min-a');
    expect((await command(f, 'answers', { challengeId: first, answer: 'two' })).statusCode).toBe(200);
    const open = await issue(f, 'min-b');
    const asked = await command(f, 'companion', { episodeId: 'min', content: 'Why compare them one at a time?', challengeId: open, allowAssessmentAssistance: true });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({ state: 'queued', downgradedChallengeIds: [open] });
    // One independent success counted (the compare family): the open question is the second.
    expect((await learnerMessages(f)).at(-1)!.context).toMatchObject({ attachedCheck: { challengeId: open, ordinal: 2 } });
    // Without one, nothing is stored about a check.
    const plain = await command(f, 'companion', { episodeId: 'min', content: 'And in general?', allowAssessmentAssistance: true });
    expect(plain.statusCode, plain.body).toBe(200);
    expect((await learnerMessages(f)).at(-1)!.context).not.toHaveProperty('attachedCheck');
  });

  it("refuses another learner's or an answered question, and fields outside the contract, storing nothing", async () => {
    const f = await fresh(), other = await fresh();
    await command(f, 'read', { episodeId: 'min', blockId: 'min-text' });
    await command(other, 'read', { episodeId: 'min', blockId: 'min-text' });
    const foreign = await issue(other, 'min-a');
    const answered = await issue(f, 'min-a');
    expect((await command(f, 'answers', { challengeId: answered, answer: 'five' })).statusCode).toBe(200);
    for (const challengeId of [foreign, answered, randomUUID()]) {
      const refused = await command(f, 'companion', { episodeId: 'min', content: 'About that question?', challengeId, allowAssessmentAssistance: true });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json().error).toBe('INVALID_REQUEST');
    }
    expect((await command(f, 'companion', { episodeId: 'min', content: 'About that?', challengeId: 'not-a-uuid' })).statusCode).toBe(400);
    expect((await command(f, 'companion', { episodeId: 'min', content: 'About that?', grantCredit: true })).statusCode).toBe(400);
    expect(await learnerMessages(f)).toEqual([]);
    // The other learner's question kept its credit.
    expect((await db.query('SELECT independent_eligible FROM assessment_challenges WHERE id=$1', [foreign])).rows[0].independent_eligible).toBe(true);
  });
});

describe('a stored companion reply', () => {
  it('records that it asks the learner something only when it does', async () => {
    const f = await fresh();
    const asking = await command(f, 'companion', { episodeId: 'min', content: 'How do I start?' });
    expect(asking.statusCode, asking.body).toBe(200);
    expect((await reply(f, asking.json().eventId, 'List both values first.\n\nWhich one is smaller?')).context).toMatchObject({ asksLearner: true });
    const telling = await command(f, 'companion', { episodeId: 'min', content: 'And then?' });
    expect((await reply(f, telling.json().eventId, 'Then keep the smaller one. That is the minimum.')).context).not.toHaveProperty('asksLearner');
  });

  it("names the lesson, the part, the question and the reply in a reply-ready notification", async () => {
    const f = await fresh();
    const asked = await command(f, 'companion', { episodeId: 'min', blockId: 'min-text', content: 'Is 2 the minimum?' });
    expect(asked.statusCode, asked.body).toBe(200);
    // The learner left after asking, so the reply waits in their notifications.
    await db.query("UPDATE learner_sessions SET last_activity_at=clock_timestamp()-interval '10 minutes' WHERE enrollment_id=$1", [f.id]);
    const stored = await reply(f, asked.json().eventId, 'Yes: nothing in the list is below 2.');
    const notification = (await db.query("SELECT kind,params,link FROM notifications WHERE user_id=$1 AND audience='learner'", [f.user])).rows;
    expect(notification).toEqual([{ kind: 'reply_ready', link: `/enrollments/${f.id}/companion`,
      params: { episodeId: 'min', blockId: 'min-text', questionMessageId: asked.json().messageId, replyMessageId: stored.id } }]);
  });
});
