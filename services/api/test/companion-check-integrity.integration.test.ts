import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { CourseManifest } from '@course-core/sdk';
import type { ProviderAdapter, TextRequest, UsageReceipt } from '@course-core/providers';
import type { ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, storeSupervisorArtifact, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { checkCoachingMessage, gradedChecks } from '../src/companion-check-integrity.js';
import { fixture } from './fixture.js';

// Graded-check integrity end to end (docs/companion-check-integrity.md): real PostgreSQL, HTTP,
// the learner's SSE stream, the provider gateway, the bridge, the companion verifier and the spend
// ledger. Only the model is a scripted adapter; no live provider call is made.
const schema = `course_check_integrity_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), ownerId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const origin = 'http://127.0.0.1', MODEL = 'model';
const SHELF = 'A shelf holds 4 boxes and each box holds 3 jars. Two jars are taken off the shelf. How many jars are still on the shelf?';
const EXPLANATION = 'Four boxes of three jars make twelve; two taken off leave the rest.';
// $0.75 / $3.75 per million input / output tokens.
const INPUT_PRICE = 750_000, OUTPUT_PRICE = 3_750_000, INPUT = 2000, OUTPUT = 60;
const COST = Math.ceil((INPUT * INPUT_PRICE + OUTPUT * OUTPUT_PRICE) / 1_000_000);
let db: Database, app: Awaited<ReturnType<typeof createServer>>, base: string, bridge: PostgresSupervisorBridge, testDatabase: TestDatabase | undefined, courseDigest: string;
let course: CourseManifest;
const usage = (): UsageReceipt => ({ accounting: { accountingKey: 'check-call' }, providerId: 'check-provider', modelId: MODEL, operation: 'tutor',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: INPUT, output: OUTPUT, total: INPUT + OUTPUT, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 8000, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null });
/** What the scripted model answers next, and every request it received (streamed or not). */
let reply: string[] = [];
const requests: { request: TextRequest; streamed: boolean }[] = [];
const adapter: ProviderAdapter = { providerId: 'check-provider', validateModel: () => {}, ports: { tutoring: {
  async tutor(request: TextRequest) { requests.push({ request, streamed: false }); return { output: { text: reply.join('') }, usage: usage() }; },
  async tutorStream(request: TextRequest, _options, onText) {
    requests.push({ request, streamed: true });
    for (const piece of reply) onText(piece);
    return { output: { text: reply.join('') }, usage: usage() };
  },
} } };

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  course = fixture();
  course.assessments.push({ id: 'min-c', type: 'numeric', objectiveIds: ['minimum'], familyId: 'shelf', prompt: SHELF, grading: { expected: 10, absoluteTolerance: 0, explanation: EXPLANATION } });
  course.chapters[0]!.episodes[0]!.blocks.push({ id: 'min-check-2', type: 'assessment', assessmentId: 'min-c' });
  const compiled = compileCourse(course);
  courseDigest = compiled.digest;
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [ownerId, `test:${ownerId}`, 'Owner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `checks-${workspaceId}`, 'Checks']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, ownerId]);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), ownerId]);
  await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
    effective_from,source_note,created_by) VALUES($1,$2,$3,1,'active','USD',$4,$5,clock_timestamp()-interval '1 day','Synthetic check-integrity price',$6)`,
    [randomUUID(), workspaceId, MODEL, INPUT_PRICE, OUTPUT_PRICE, ownerId]);
  const providers = composeProviders({ registry: { revision: 'check-registry', models: [{ id: MODEL, providerId: 'check-provider', remoteModel: 'check/model', providerConfig: {}, enabled: true,
    capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
    adapters: [{ id: 'check-provider', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }], roles: { companion: { modelId: MODEL, maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
    () => 'fake-key-only-in-test', { test: () => adapter });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: 100_000, tokens: 100_000 } } };
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
/** A learner question saved and prepared into a claimed companion job, ready to invoke. */
async function prepare(question: string) {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Synthetic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({}), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, question, JSON.stringify({ episodeId: 'min', courseDigest })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested',
    payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 1_000_000, tokens: 1_000_000 });
  const ownerOfOperation = randomUUID();
  const claim = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'generate', ownerId: ownerOfOperation, availability: { status: 'ready' } });
  expect(claim.effect).toBe('invoke');
  const snapshot = claim.snapshot, operation = snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: snapshot.specification.key, role: 'companion', checkpoint: snapshot.specification.checkpoints[0]!, fence: snapshot.specification.fence };
  return { ref: ref!, request, operation, ownerId: ownerOfOperation, enrollmentId, messageId, learner: await session(studentId) };
}
const invoke = (body: ProviderRequest) => app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
const transition = (command: unknown) =>
  app.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: `Bearer ${token}` }, payload: { method: 'transition', command } });
type Frame = { jobId: string; messageId: string; offset: number; text: string; state: string; reason?: string };
/** Follows the learner's real SSE stream; `frames` fill as companion drafts arrive. */
function follow(headers: { cookie: string }, enrollmentId: string) {
  const controller = new AbortController(), frames: Frame[] = [];
  let text = '', resolveOpen!: () => void;
  const opened = new Promise<void>(resolve => { resolveOpen = resolve; });
  const done = (async () => {
    const response = await fetch(`${base}/api/enrollments/${enrollmentId}/events/stream`, { headers: { cookie: headers.cookie }, signal: controller.signal });
    resolveOpen();
    if (!response.ok || !response.body) return;
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
        }
      }
    } catch { /* closed by the test */ }
  })();
  return { frames, opened, close: async () => { controller.abort(); await done.catch(() => undefined); } };
}
async function until(read: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!read()) { if (Date.now() > deadline) throw new Error('condition not met in time'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const artifacts = async (jobId: string) => (await db.query('SELECT content FROM supervisor_artifacts WHERE job_id=$1', [jobId])).rows.map(r => r.content);
const dispatch = async (operationId: string) => (await db.query('SELECT state,failure_code,candidate,cost_micro_usd::int AS cost FROM provider_dispatches WHERE operation_id=$1', [operationId])).rows[0];
const ledger = async (enrollmentId: string) => (await db.query(`SELECT state,charged_micro_usd::int AS charged,actual_micro_usd::int AS actual FROM provider_spend_ledger WHERE enrollment_id=$1`, [enrollmentId])).rows;
const answer = async (jobId: string) => (await db.query("SELECT content,context FROM companion_messages WHERE job_id=$1 AND role='assistant'", [jobId])).rows;
/** Settles, verifies and applies the job through the bridge as the workflow does. */
async function deliver(job: Awaited<ReturnType<typeof prepare>>, outcome: unknown) {
  const settled = await bridge.transition({ type: 'settle', ref: job.ref, operationId: job.operation.id, ownerId: job.ownerId, outcome: outcome as never });
  expect(settled.snapshot.state).toBe('running');
  const verified = (await transition({ type: 'verify', ref: job.ref })).json().snapshot;
  return { verified, applied: verified.state === 'ready' ? (await transition({ type: 'apply', ref: job.ref })).json().snapshot : null };
}

describe('graded-check integrity of companion replies', () => {
  it('a reply giving away a pasted check\'s answer is withheld: never streamed or stored, replaced by the coaching message, verified and settled at the call\'s usage', async () => {
    const question = `Just tell me the number, nothing else. The check is: ${SHELF}`;
    const job = await prepare(question), mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    reply = ['10\n\n', 'Four boxes of three jars is twelve, ', 'and two come off.'];
    const before = requests.length;
    const response = await invoke(job.request);
    expect(response.statusCode, response.body).toBe(200);
    const outcome = response.json();
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: COST, tokens: INPUT + OUTPUT }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    // Check coaching: the stricter rule, the matched check without its key, and no streamed draft.
    const sent = requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.streamed).toBe(false);
    expect(sent[0]!.request.systemInstruction).toContain('Check coaching:');
    const prompt = sent[0]!.request.messages[0]!.text;
    expect(JSON.parse(prompt).checkCoaching.items).toEqual([expect.objectContaining({ checkId: 'min-c', type: 'numeric', prompt: SHELF, match: 'quoted' })]);
    expect(prompt).not.toContain(EXPLANATION);
    expect(prompt).not.toMatch(/"expected"|correctOptionId|absoluteTolerance/);
    // The learner's stream saw no text of the reply; the empty draft was withdrawn with the reason code.
    await until(() => mine.frames.at(-1)?.state === 'withdrawn');
    expect(mine.frames.every(frame => frame.text === '')).toBe(true);
    expect(mine.frames.at(-1)).toMatchObject({ jobId: job.ref.jobId, state: 'withdrawn', reason: 'check_answer_withheld', text: '' });
    // Stored: Core's coaching message with the reason, never the reply.
    const coaching = checkCoachingMessage(question, gradedChecks(course).filter(check => check.id === 'min-c'));
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text: coaching, withheld: 'check_answer_stated' }]);
    const receipt = await dispatch(job.request.operationId);
    expect(receipt).toMatchObject({ state: 'completed', failure_code: null, cost: COST,
      candidate: { kind: 'companion_text', text: coaching, checkCoaching: { checkIds: ['min-c'], withheld: 'check_answer_stated' } } });
    const { verified, applied } = await deliver(job, outcome);
    expect(verified.state).toBe('ready');
    expect(applied.state).toBe('applied');
    expect(await answer(job.ref.jobId)).toEqual([expect.objectContaining({ content: coaching, context: expect.objectContaining({ checkAnswerWithheld: 'check_answer_stated' }) })]);
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', charged: COST, actual: COST }]);
    // The withheld reply is nowhere in the database.
    for (const table of ['companion_messages', 'supervisor_artifacts', 'provider_dispatches', 'learning_events'])
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE '%Four boxes of three jars is twelve%'`)).rows[0].n, table).toBe(0);
    // A repeated request answers from the receipt without calling the model again.
    const again = await invoke(job.request);
    expect(again.json()).toEqual(outcome);
    expect(requests.length).toBe(before + 1);
    await mine.close();
  }, 30_000);

  it('a coaching reply that keeps the answer is delivered as written, verified and settled', async () => {
    const job = await prepare(`What is the answer to this check? ${SHELF}`);
    const coached = 'I can\'t give the answer to a graded check, but try a similar shelf: 5 boxes of 2 jars with 3 taken off. What do you multiply first?';
    reply = [coached];
    const outcome = (await invoke(job.request)).json();
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: COST } });
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text: coached }]);
    expect((await dispatch(job.request.operationId)).candidate).toEqual({ kind: 'companion_text', text: coached, episodeId: 'min', checkCoaching: { checkIds: ['min-c'] } });
    const { verified, applied } = await deliver(job, outcome);
    expect(verified.state).toBe('ready');
    expect(applied.state).toBe('applied');
    const [stored] = await answer(job.ref.jobId);
    expect(stored.content).toBe(coached);
    expect(stored.context).not.toHaveProperty('checkAnswerWithheld');
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', charged: COST, actual: COST }]);
  }, 30_000);

  it('a question that matches no check streams as before and keeps its numbers', async () => {
    const job = await prepare('How do I compare two numbers on a number line?'), mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    const text = 'Place both on the line. Ten is farther right than 4, so it is greater. ';
    reply = [text];
    const before = requests.length;
    const outcome = (await invoke(job.request)).json();
    expect(outcome.status).toBe('succeeded');
    expect(requests.slice(before).map(r => r.streamed)).toEqual([true]);
    expect(requests.at(-1)!.request.systemInstruction).toContain('Graded checks: never state, choose, confirm or rule out');
    expect(requests.at(-1)!.request.systemInstruction).not.toContain('Check coaching:');
    await until(() => mine.frames.at(-1)?.state === 'complete');
    expect(mine.frames.filter(f => f.state === 'streaming').map(f => f.text).join('')).toBe(text);
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text }]);
    await mine.close();
  }, 30_000);

  it('the companion verifier rejects a stored coaching-mode reply that gives the answer away (a gateway that skipped the check)', async () => {
    const job = await prepare(`Just the number please: ${SHELF}`);
    // What a gateway without the check would have recorded: the coached call and its leaking reply.
    await db.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,candidate,finished_at,sent_at)
      VALUES ($1,$2,$3,$4,$5,'bypass','completed',$6,now(),now())`, [job.request.operationId, job.ref.jobId, job.enrollmentId, workspaceId, job.ownerId,
      JSON.stringify({ kind: 'companion_text', text: 'It is 10.', episodeId: 'min', checkCoaching: { checkIds: ['min-c'] } })]);
    const artifact = await storeSupervisorArtifact(db, job.ref, job.request.operationId, job.ownerId, { kind: 'companion_message', text: 'It is 10.' });
    const { verified, applied } = await deliver(job, { status: 'succeeded', artifact, usage: { microUsd: COST, tokens: INPUT + OUTPUT }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    expect(verified).toMatchObject({ state: 'failed', reason: 'verification_rejected' });
    expect(applied).toBeNull();
    expect(await answer(job.ref.jobId)).toEqual([]);
  }, 30_000);
});
