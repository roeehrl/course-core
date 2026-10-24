import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { ProviderError, type ProviderAdapter, type TextRequest, type UsageReceipt } from '@course-core/providers';
import type { ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { eraseWithin } from '../src/data-lifecycle.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { fixture } from './fixture.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';

// Streamed companion replies (T01): real PostgreSQL, real HTTP and SSE; only the model is a
// scripted streaming adapter. No live provider call is made.
const schema = `course_streamed_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), ownerId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const origin = 'http://127.0.0.1';
let db: Database, app: Awaited<ReturnType<typeof createServer>>, base: string, bridge: PostgresSupervisorBridge, testDatabase: TestDatabase | undefined;
const usage = (): UsageReceipt => ({ accounting: { accountingKey: 'stream-call' }, providerId: 'stream-provider', modelId: 'model', operation: 'tutor',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 200, output: 20, total: 220, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 1000, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null });
/** The script of the next streamed answer: pieces, an optional hold before the last, and how it ends. */
let script: { pieces: string[]; hold?: Promise<void>; holding?: () => void; end?: 'refuse' } = { pieces: [] };
const adapter: ProviderAdapter = { providerId: 'stream-provider', validateModel: () => {}, ports: { tutoring: {
  async tutor(_request: TextRequest) { return { output: { text: script.pieces.join('') }, usage: usage() }; },
  async tutorStream(_request: TextRequest, _options, onText) {
    const { pieces, hold, holding, end } = script;
    for (let i = 0; i < pieces.length; i++) {
      if (i === pieces.length - 1 && hold) { holding?.(); await hold; }
      onText(pieces[i]!);
    }
    if (end === 'refuse') { const error = new ProviderError('BLOCKED', { submission: 'unknown' }); error.usage = usage(); throw error; }
    return { output: { text: pieces.join('') }, usage: usage() };
  },
} } };

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture());
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [ownerId, `test:${ownerId}`, 'Owner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `streamed-${workspaceId}`, 'Streamed']);
  await allowUnpricedPaidWork(db, workspaceId);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, ownerId]);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), ownerId]);
  const providers = composeProviders({ registry: { revision: 'stream-registry', models: [{ id: 'model', providerId: 'stream-provider', remoteModel: 'stream/model', providerConfig: {}, enabled: true,
    capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'stream-provider', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }], roles: { companion: { modelId: 'model', maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
    () => 'fake-key-only-in-test', { test: () => adapter });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId] };
  // A long poll interval: anything that arrives fast here arrived by a push or a wake-up.
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor, providers, eventStream: { pollMs: 5000, heartbeatMs: 60_000 } });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 10_000_000 });
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function session(userId: string) {
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(login.statusCode, login.body).toBe(200);
  return { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken as string };
}
async function prepare() {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Streamed learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Streaming' }), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, 'How do I compare the numbers?', JSON.stringify({ episodeId: 'min' })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested',
    payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 1_000_000, tokens: 100_000 });
  const claim = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
  expect(claim.effect).toBe('invoke');
  const snapshot = claim.snapshot, operation = snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: snapshot.specification.key, role: 'companion', checkpoint: snapshot.specification.checkpoints[0]!, fence: snapshot.specification.fence };
  return { ref: ref!, request, operation, enrollmentId, messageId, studentId, learner: await session(studentId) };
}
const invoke = (body: ProviderRequest) => app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
type Frame = { jobId: string; messageId: string; offset: number; text: string; state: string; reason?: string };
/** Follows a real SSE response; `frames` and `events` fill as they arrive. */
function follow(headers: { cookie: string }, enrollmentId: string) {
  const controller = new AbortController(), frames: Frame[] = [], events: { type: string; at: number }[] = [];
  let text = '', resolveOpen!: () => void;
  const opened = new Promise<void>(resolve => { resolveOpen = resolve; });
  const done = (async () => {
    const response = await fetch(`${base}/api/enrollments/${enrollmentId}/events/stream`, { headers: { cookie: headers.cookie }, signal: controller.signal });
    resolveOpen();
    if (!response.ok || !response.body) return response.status;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, cut); text = text.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === 'companion-draft' && data) frames.push(JSON.parse(data));
          if (event === 'learning-event' && data) events.push({ type: JSON.parse(data).event_type, at: performance.now() });
        }
      }
    } catch { /* closed by the test */ }
    return response.status;
  })();
  return { frames, events, opened, close: async () => { controller.abort(); await done.catch(() => undefined); } };
}
async function until(read: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!read()) { if (Date.now() > deadline) throw new Error('condition not met in time'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function holdLast(pieces: string[], end?: 'refuse') {
  let release!: () => void, holding!: () => void;
  const reached = new Promise<void>(resolve => { holding = resolve; });
  script = { pieces, hold: new Promise<void>(resolve => { release = resolve; }), holding, ...(end ? { end } : {}) };
  return { reached, release };
}

describe('streamed companion replies', () => {
  it('pushes released text to the learner while the model answers, never to staff, and the receipt still settles the call', async () => {
    const job = await prepare(), staff = follow({ cookie: (await session(ownerId)).cookie }, job.enrollmentId), mine = follow(job.learner, job.enrollmentId);
    await Promise.all([mine.opened, staff.opened]);
    const step = holdLast(['Compare the values on a number line. ', 'The one farther left ', 'is smaller.']);
    const call = invoke(job.request);
    await step.reached;
    // Before the provider finished: the first sentence is on the learner's stream, the unfinished one is held.
    await until(() => mine.frames.length > 0);
    expect(mine.frames[0]).toEqual({ jobId: job.ref.jobId, messageId: job.messageId, offset: 0, text: 'Compare the values on a number line. ', state: 'streaming' });
    step.release();
    const outcome = (await call).json();
    expect(outcome.status).toBe('succeeded');
    expect(outcome.usage).toEqual({ microUsd: 100000, tokens: 220 });
    await until(() => mine.frames.at(-1)?.state === 'complete');
    let rebuilt = '';
    for (const frame of mine.frames.filter(f => f.state === 'streaming')) rebuilt = rebuilt.slice(0, frame.offset) + frame.text;
    expect(rebuilt).toBe('Compare the values on a number line. The one farther left is smaller.');
    // A stream opened now gets the whole draft at once.
    const late = follow(job.learner, job.enrollmentId);
    await until(() => late.frames.length > 0);
    expect(late.frames[0]).toMatchObject({ offset: 0, text: rebuilt, state: 'complete' });
    expect(staff.frames).toEqual([]);
    const receipt = (await db.query("SELECT state,provider_usage FROM provider_dispatches WHERE operation_id=$1", [job.request.operationId])).rows[0];
    expect(receipt.state).toBe('completed'); expect(receipt.provider_usage.attempts[0].tokens.total).toBe(220);
    await Promise.all([mine.close(), staff.close(), late.close()]);
  });

  it('withdraws a draft the provider refuses mid-stream; nothing of it is kept', async () => {
    const job = await prepare(), mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    const step = holdLast(['A first sentence was shown. ', 'then refused'], 'refuse');
    const call = invoke(job.request);
    await step.reached; await until(() => mine.frames.length > 0);
    step.release();
    expect((await call).json().status).not.toBe('succeeded');
    await until(() => mine.frames.at(-1)?.state === 'withdrawn');
    expect(mine.frames.at(-1)).toMatchObject({ reason: 'provider_refused', text: '', offset: 0 });
    expect((await db.query('SELECT count(*) FROM supervisor_artifacts WHERE job_id=$1', [job.ref.jobId])).rows[0].count).toBe('0');
    expect((await db.query("SELECT candidate FROM provider_dispatches WHERE operation_id=$1", [job.request.operationId])).rows[0].candidate).toBeNull();
    await mine.close();
  });

  it('the learner stops a streaming reply: the draft stops at once and the job is cancelled as a learner cancellation', async () => {
    const job = await prepare(), mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    const step = holdLast(['Started explaining here. ', 'never shown']);
    const call = invoke(job.request);
    await step.reached; await until(() => mine.frames.length > 0);
    const revision = Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [job.enrollmentId])).rows[0].revision);
    const other = await prepare();
    const foreign = await app.inject({ method: 'POST', url: `/api/enrollments/${job.enrollmentId}/companion/messages/${job.messageId}/cancel`, headers: other.learner,
      payload: { expectedRevision: revision, idempotencyKey: randomUUID() } });
    expect(foreign.statusCode).toBe(404);
    const cancel = await app.inject({ method: 'POST', url: `/api/enrollments/${job.enrollmentId}/companion/messages/${job.messageId}/cancel`, headers: job.learner,
      payload: { expectedRevision: revision, idempotencyKey: randomUUID() } });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json()).toMatchObject({ messageId: job.messageId, jobId: job.ref.jobId, cancelled: true });
    await until(() => mine.frames.at(-1)?.state === 'cancelled');
    step.release(); await call;
    expect(mine.frames.filter(f => f.state === 'streaming').map(f => f.text)).toEqual(['Started explaining here. ']);
    const flagged = (await db.query('SELECT cancellation_requested FROM supervisor_jobs WHERE id=$1', [job.ref.jobId])).rows[0];
    expect(flagged.cancellation_requested).toBe(true);
    const delivery = (await db.query('SELECT reason,jobs FROM supervisor_job_cancellations WHERE enrollment_id=$1', [job.enrollmentId])).rows;
    expect(delivery).toEqual([expect.objectContaining({ reason: 'learner_cancelled', jobs: [expect.objectContaining({ jobId: job.ref.jobId })] })]);
    // The question stays, marked as stopped; the conversation read shows it.
    const read = (await app.inject({ method: 'GET', url: `/api/enrollments/${job.enrollmentId}/companion`, headers: job.learner })).json();
    expect(read.messages.find((m: { id: string }) => m.id === job.messageId)).toMatchObject({ content: 'How do I compare the numbers?', cancel_requested: true });
    // A question without a job, or an unknown one, cannot be stopped.
    const unknown = await app.inject({ method: 'POST', url: `/api/enrollments/${job.enrollmentId}/companion/messages/${randomUUID()}/cancel`, headers: job.learner,
      payload: { expectedRevision: revision + 1, idempotencyKey: randomUUID() } });
    expect(unknown.statusCode).toBe(404);
    await Promise.all([mine.close(), other.learner && Promise.resolve()]);
  });

  it('erasure drops the draft: nothing more is relayed and no new draft opens', async () => {
    const job = await prepare(), mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    const step = holdLast(['Private explanation. ', 'more private text. ']);
    const call = invoke(job.request);
    await step.reached; await until(() => mine.frames.length > 0);
    const before = mine.frames.length;
    await transaction(db, client => eraseWithin(client, { id: job.enrollmentId, workspace_id: workspaceId }));
    step.release(); await call;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(mine.frames).toHaveLength(before);
    await mine.close();
  });

  it('new events reach an open stream at commit, not at the next poll', async () => {
    const job = await prepare(), mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    await new Promise(resolve => setTimeout(resolve, 200));
    const started = performance.now();
    await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId: job.enrollmentId, actorId: job.studentId, actorKind: 'learner', type: 'lesson.viewed',
      payload: {}, idempotencyKey: randomUUID() }));
    await until(() => mine.events.some(e => e.type === 'lesson.viewed'));
    // The stream polls every 5 s here; the wake-up delivered it well before that.
    expect(mine.events.find(e => e.type === 'lesson.viewed')!.at - started).toBeLessThan(1500);
    await mine.close();
  });
});

describe("dispatcher long poll (bridge 'outbox.wait')", () => {
  const wait = (after: number | null, timeoutMs: number) => fetch(`${base}/v1/supervisor/bridge`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'outbox.wait', after, timeoutMs }) }).then(r => r.json());
  it('answers at the commit of new work, not after its timeout; a rollback wakes nothing; a stale sequence answers at once', async () => {
    const first = await wait(null, 200);
    expect(first).toMatchObject({ woke: false, listening: true });
    const pending = wait(first.sequence, 10_000), started = performance.now();
    await new Promise(resolve => setTimeout(resolve, 100));
    const job = await prepare();
    const answer = await pending;
    expect(answer.woke).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
    // A rolled-back insert is never announced.
    const quiet = wait(answer.sequence, 400);
    await transaction(db, async client => {
      await appendEvent(client, { workspaceId, enrollmentId: job.enrollmentId, actorId: job.studentId, actorKind: 'learner', type: 'companion.requested',
        payload: { messageId: randomUUID(), episodeId: 'min' }, idempotencyKey: randomUUID(), supervise: true });
      throw new Error('rolled back');
    }).catch(() => undefined);
    expect((await quiet).woke).toBe(false);
    const stale = performance.now();
    expect((await wait(answer.sequence + 1000, 5000)).woke).toBe(true);
    expect(performance.now() - stale).toBeLessThan(1000);
    const refused = await fetch(`${base}/v1/supervisor/bridge`, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'outbox.wait', after: null, timeoutMs: 100 }) });
    expect(refused.status).toBe(401);
  });
});
