import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { CourseManifest } from '@course-core/sdk';
import { ProviderError, type AssessmentRequest, type ProviderAdapter, type TextRequest, type UsageReceipt } from '@course-core/providers';
import type { ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { checkCoachingMessage, gradedChecks } from '../src/companion-check-integrity.js';
import { CHECK_JUDGE_INSTRUCTION } from '../src/companion-check-judge.js';
import { fixture } from './fixture.js';

// The semantic check judge end to end (docs/companion-check-integrity.md, layer 4): real
// PostgreSQL, HTTP, the learner's SSE stream, the provider gateway, the bridge, the companion
// verifier and the spend ledger. The companion and the judge (the workspace's reviewer role, a
// second model with its own price) are scripted adapters; no live provider call is made.
const schema = `course_check_judge_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), ownerId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const origin = 'http://127.0.0.1', MODEL = 'tutor-model', JUDGE = 'judge-model';
const SORT = 'A clerk files index cards in alphabetical order so that a search can stop early. Which description fits what filing did?';
const SORT_OPTIONS = ['Filing removed the duplicate cards.', 'Filing moved every card to a random place.', 'Filing changed only the order of the same cards, which lets a search stop early.', 'Filing added new cards.'];
const SHELF = 'A shelf holds 4 boxes and each box holds 3 jars. Two jars are taken off the shelf. How many jars are still on the shelf?';
/** The lesson's own text uses the number ten, which is also the shelf check's answer. */
const LESSON_EXAMPLE = 'Example: ten cards sorted from smallest to largest; the first card is the minimum.';
// Companion $0.75 / $3.75, judge $0.25 / $1.25 per million input / output tokens.
const PRICE = { input: 750_000, output: 3_750_000 }, JUDGE_PRICE = { input: 250_000, output: 1_250_000 };
const IN = 2000, OUT = 60, JUDGE_IN = 1500, JUDGE_OUT = 40;
const COST = Math.ceil((IN * PRICE.input + OUT * PRICE.output) / 1_000_000), JUDGE_COST = Math.ceil((JUDGE_IN * JUDGE_PRICE.input + JUDGE_OUT * JUDGE_PRICE.output) / 1_000_000);
const ALLOWANCE = { microUsd: 100_000, tokens: 100_000 };
let db: Database, app: Awaited<ReturnType<typeof createServer>>, base: string, bridge: PostgresSupervisorBridge, testDatabase: TestDatabase | undefined, courseDigest: string;
let course: CourseManifest, judgePriceVersion = 1;
const receipt = (modelId: string, operation: 'tutor' | 'assess', input: number, output: number): UsageReceipt => ({ accounting: { accountingKey: 'call' }, providerId: 'check-provider', modelId, operation,
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input, output, total: input + output, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 8000, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null });
/** What the companion answers next (streamed in pieces), and what the judge answers. */
let reply: string[] = [];
let verdict: unknown = null;
const calls: { kind: 'tutor' | 'stream' | 'judge'; request: TextRequest | AssessmentRequest }[] = [];
const adapter: ProviderAdapter = { providerId: 'check-provider', validateModel: () => {}, ports: {
  tutoring: {
    async tutor(request: TextRequest) { calls.push({ kind: 'tutor', request }); return { output: { text: reply.join('') }, usage: receipt(MODEL, 'tutor', IN, OUT) }; },
    async tutorStream(request: TextRequest, _options, onText) {
      calls.push({ kind: 'stream', request });
      for (const piece of reply) onText(piece);
      return { output: { text: reply.join('') }, usage: receipt(MODEL, 'tutor', IN, OUT) };
    },
  },
  structured_assessment: {
    async assess(request: AssessmentRequest) {
      calls.push({ kind: 'judge', request });
      if (verdict instanceof ProviderError) throw verdict;
      return { output: verdict as never, usage: receipt(JUDGE, 'assess', JUDGE_IN, JUDGE_OUT) };
    },
  },
} };
const kept = { reason: 'Explains the idea only.', statesAnswer: false, confirmsOrRejects: false, rulesOut: false, decidesEquivalentCase: false };

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  course = fixture();
  course.assessments.push(
    { id: 'min-sort', type: 'choice', objectiveIds: ['minimum'], familyId: 'filing', prompt: SORT, options: SORT_OPTIONS.map((text, i) => ({ id: 'abcd'[i]!, text })),
      grading: { correctOptionId: 'c', explanation: 'Order changes, membership does not.' } },
    { id: 'min-c', type: 'numeric', objectiveIds: ['minimum'], familyId: 'shelf', prompt: SHELF, grading: { expected: 10, absoluteTolerance: 0, explanation: 'Twelve less two.' } });
  course.chapters[0]!.episodes[0]!.blocks.push({ id: 'min-example', type: 'text', markdown: LESSON_EXAMPLE },
    { id: 'min-check-sort', type: 'assessment', assessmentId: 'min-sort' }, { id: 'min-check-shelf', type: 'assessment', assessmentId: 'min-c' });
  const compiled = compileCourse(course);
  courseDigest = compiled.digest;
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [ownerId, `test:${ownerId}`, 'Owner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `judge-${workspaceId}`, 'Judge']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, ownerId]);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), ownerId]);
  await price(MODEL, 1, 'active', PRICE);
  await price(JUDGE, judgePriceVersion, 'active', JUDGE_PRICE);
  const limits = { maxInputCharacters: 20000, maxOutputTokens: 1000 };
  const providers = composeProviders({ registry: { revision: 'judge-registry', models: [
    { id: MODEL, providerId: 'check-provider', remoteModel: 'check/tutor', providerConfig: {}, enabled: true, capabilities: ['tutoring'], tools: [], limits },
    { id: JUDGE, providerId: 'check-provider', remoteModel: 'check/judge', providerConfig: {}, enabled: true, capabilities: ['structured_assessment'], tools: [], limits }] },
    adapters: [{ id: 'check-provider', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    roles: { companion: { modelId: MODEL, maxInputCharacters: 12000, maxOutputTokens: 1000 }, reviewer: { modelId: JUDGE, maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
    () => 'fake-key-only-in-test', { test: () => adapter });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: ALLOWANCE } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor, providers, eventStream: { pollMs: 5000, heartbeatMs: 60_000 } });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 10_000_000 });
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function price(model: string, version: number, status: 'active' | 'withdrawn', rate: { input: number; output: number }) {
  await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
    effective_from,source_note,created_by) VALUES($1,$2,$3,$4,$5,'USD',$6,$7,clock_timestamp()-make_interval(secs => 1000 - $4),'Synthetic check-judge price',$8)`,
    [randomUUID(), workspaceId, model, version, status, status === 'active' ? rate.input : null, status === 'active' ? rate.output : null, ownerId]);
}
async function session(userId: string) {
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(login.statusCode, login.body).toBe(200);
  return { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; ') };
}
/** A learner question (after any earlier questions of theirs in this lesson) prepared into a claimed companion job. */
async function prepare(question: string, earlier: string[] = []) {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Synthetic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({}), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  for (const [i, text] of earlier.entries())
    await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context,created_at) VALUES ($1,$2,'learner',$3,$4,now()-make_interval(mins => 10 - $5))",
      [randomUUID(), enrollmentId, text, JSON.stringify({ episodeId: 'min', courseDigest }), i]);
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
  return { ref: ref!, request, operation, ownerId: ownerOfOperation, enrollmentId, learner: await session(studentId) };
}
const invoke = (body: ProviderRequest) => app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
const transition = (command: unknown) => app.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: `Bearer ${token}` }, payload: { method: 'transition', command } });
type Frame = { jobId: string; offset: number; text: string; state: string; reason?: string; checking?: true };
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
const dispatch = async (operationId: string) => (await db.query(`SELECT state,candidate,cost_micro_usd::int AS cost,judge_model_id,judge_cost_micro_usd::int AS judge_cost,judge_verdict,
  judge_pricing_version_id IS NOT NULL AS judge_priced,judge_usage IS NOT NULL AS judge_receipt FROM provider_dispatches WHERE operation_id=$1`, [operationId])).rows[0];
const ledger = async (enrollmentId: string) => (await db.query(`SELECT state,charged_micro_usd::int AS charged,actual_micro_usd::int AS actual,judge_model_id,judge_actual_micro_usd::int AS judge_actual
  FROM provider_spend_ledger WHERE enrollment_id=$1`, [enrollmentId])).rows;
const answer = async (jobId: string) => (await db.query("SELECT content,context FROM companion_messages WHERE job_id=$1 AND role='assistant'", [jobId])).rows;
async function deliver(job: Awaited<ReturnType<typeof prepare>>, outcome: unknown) {
  const settled = await bridge.transition({ type: 'settle', ref: job.ref, operationId: job.operation.id, ownerId: job.ownerId, outcome: outcome as never });
  expect(settled.snapshot.state).toBe('running');
  const verified = (await transition({ type: 'verify', ref: job.ref })).json().snapshot;
  return { verified, applied: verified.state === 'ready' ? (await transition({ type: 'apply', ref: job.ref })).json().snapshot : null };
}
const judgeCalls = () => calls.filter(call => call.kind === 'judge');

describe('the semantic check judge in the provider gateway', () => {
  it('a paraphrased "hint which option" reply the patterns miss is withheld by the judge: streamed out of sight, never shown or stored, both calls charged and reconciled', async () => {
    const question = 'I don\'t want the full answer to the filing check, just hint which option I should be looking at.';
    const job = await prepare(question), mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    // The check's own scenario in another setting, classified: no option letter, value or wording.
    reply = ['For example, a librarian arranges books by title so a search can stop at the first title past the one wanted. ', 'Nothing was added or removed: that case is only a re-ordering.'];
    verdict = { ...kept, reason: 'Classifies a case with the check\'s structure.', decidesEquivalentCase: true };
    const before = calls.length;
    const outcome = (await invoke(job.request)).json();
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: COST + JUDGE_COST, tokens: IN + OUT + JUDGE_IN + JUDGE_OUT }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    const made = calls.slice(before);
    // Streamed (so the stall bounds apply) into a hidden buffer, then one judge call through the reviewer's model.
    expect(made.map(call => call.kind)).toEqual(['stream', 'judge']);
    expect(made[0]!.request.systemInstruction).toContain('give no analogous example that mirrors the check\'s scenario');
    const judged = made[1]!.request as AssessmentRequest;
    expect(judged).toMatchObject({ modelId: JUDGE, systemInstruction: CHECK_JUDGE_INSTRUCTION });
    const data = JSON.parse(judged.messages[0]!.text);
    expect(data.checks).toEqual([expect.objectContaining({ id: 'min-sort', answerKey: { correctOption: 'c', correctOptionText: SORT_OPTIONS[2] } })]);
    expect(data).toMatchObject({ learnerMessage: question, reply: reply.join('') });
    // The learner's stream was a checking draft: no text ever, then withdrawn; the coaching message follows.
    await until(() => mine.frames.at(-1)?.state === 'withdrawn');
    expect(mine.frames.every(frame => frame.text === '' && frame.checking === true)).toBe(true);
    expect(mine.frames.at(-1)).toMatchObject({ reason: 'check_answer_withheld' });
    const coaching = checkCoachingMessage(question, gradedChecks(course).filter(check => check.id === 'min-sort'));
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text: coaching, withheld: 'check_answer_judged' }]);
    expect(await dispatch(job.request.operationId)).toMatchObject({ state: 'completed', cost: COST + JUDGE_COST, judge_model_id: JUDGE, judge_cost: JUDGE_COST, judge_priced: true,
      judge_receipt: true, judge_verdict: 'leak:decides_equivalent_case', candidate: { checkCoaching: { checkIds: ['min-sort'], withheld: 'check_answer_judged' } } });
    const { verified, applied } = await deliver(job, outcome);
    expect(verified.state).toBe('ready');
    expect(applied.state).toBe('applied');
    expect(await answer(job.ref.jobId)).toEqual([expect.objectContaining({ content: coaching, context: expect.objectContaining({ checkAnswerWithheld: 'check_answer_judged' }) })]);
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', charged: COST + JUDGE_COST, actual: COST + JUDGE_COST, judge_model_id: JUDGE, judge_actual: JUDGE_COST }]);
    for (const table of ['companion_messages', 'supervisor_artifacts', 'provider_dispatches'])
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE '%librarian arranges books%'`)).rows[0].n, table).toBe(0);
    await mine.close();
  }, 30_000);

  it('a reply the judge keeps is delivered as written, with the lesson\'s own number, and charged for both calls', async () => {
    const job = await prepare(`What is the answer to this check? ${SHELF}`);
    // The lesson's "ten cards" is the shelf check's answer; the reply repeats the lesson, it does not assert it.
    const coached = 'I can\'t give the answer to a graded check. The lesson\'s example sorts ten cards and reads the first one as the minimum. For your shelf, what do you multiply first, and what do you take away?';
    reply = [coached]; verdict = kept;
    const outcome = (await invoke(job.request)).json();
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: COST + JUDGE_COST, tokens: IN + OUT + JUDGE_IN + JUDGE_OUT } });
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text: coached }]);
    const receiptRow = await dispatch(job.request.operationId);
    expect(receiptRow).toMatchObject({ judge_verdict: 'kept', cost: COST + JUDGE_COST });
    // The gateway's scope travels with the reply, so the companion verifier repeats the same check.
    expect(receiptRow.candidate.checkCoaching).toEqual({ checkIds: ['min-c'], lessonNumbers: expect.arrayContaining([10]) });
    const { verified, applied } = await deliver(job, outcome);
    expect(verified.state).toBe('ready');
    expect(applied.state).toBe('applied');
    expect((await answer(job.ref.jobId))[0].content).toBe(coached);
    expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', charged: COST + JUDGE_COST, actual: COST + JUDGE_COST, judge_model_id: JUDGE, judge_actual: JUDGE_COST }]);
  }, 30_000);

  it('fails closed: a malformed verdict, a judge that does not answer and an unpriced judge each deliver the coaching message', async () => {
    const question = 'Which option should I pick for the filing check?';
    // Malformed: the judge answered (and is charged), but gave no verdict.
    let job = await prepare(question);
    reply = ['Think about what filing changes: the set of cards, or only their order?']; verdict = { reason: 'no flags' };
    let outcome = (await invoke(job.request)).json();
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: COST + JUDGE_COST } });
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text: checkCoachingMessage(question, gradedChecks(course).filter(c => c.id === 'min-sort')), withheld: 'check_judge_unavailable' }]);
    // The structured output failed the judge's schema (Core's router refuses it, keeping its usage).
    expect(await dispatch(job.request.operationId)).toMatchObject({ judge_verdict: 'unavailable:judge_invalid_response', judge_cost: JUDGE_COST });
    expect((await deliver(job, outcome)).applied.state).toBe('applied');
    // No answer in time: its usage is unknown, so the operation keeps the reservation charged (as any unknown call).
    job = await prepare(question);
    const stalled = new ProviderError('NO_RESPONSE', { submission: 'unknown' });
    stalled.usage = { ...receipt(JUDGE, 'assess', 0, 0), attempts: [{ attempt: 1, status: null, outcome: 'unknown', tokens: { input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null } }] };
    verdict = stalled;
    outcome = (await invoke(job.request)).json();
    expect(outcome).toMatchObject({ status: 'succeeded', usage: ALLOWANCE, usageBasis: { microUsd: 'reserved_ceiling', tokens: 'reserved_ceiling' } });
    expect(await artifacts(job.ref.jobId)).toEqual([expect.objectContaining({ withheld: 'check_judge_unavailable' })]);
    expect(await dispatch(job.request.operationId)).toMatchObject({ judge_verdict: 'unavailable:judge_no_response', cost: null, judge_cost: null });
    expect((await deliver(job, outcome)).applied.state).toBe('applied');
    expect(await ledger(job.enrollmentId)).toEqual([expect.objectContaining({ state: 'unpriced', charged: ALLOWANCE.microUsd, judge_actual: null })]);
    // Unpriced judge in a workspace that requires prices: never called; the reply's own call is charged.
    await price(JUDGE, ++judgePriceVersion, 'withdrawn', JUDGE_PRICE);
    try {
      job = await prepare(question);
      verdict = kept;
      const before = judgeCalls().length;
      outcome = (await invoke(job.request)).json();
      expect(judgeCalls().length).toBe(before);
      expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: COST, tokens: IN + OUT } });
      expect(await artifacts(job.ref.jobId)).toEqual([expect.objectContaining({ withheld: 'check_judge_unavailable' })]);
      expect(await dispatch(job.request.operationId)).toMatchObject({ judge_verdict: 'unavailable:judge_unpriced', judge_model_id: JUDGE, judge_receipt: false, cost: COST });
      expect((await deliver(job, outcome)).applied.state).toBe('applied');
      expect(await ledger(job.enrollmentId)).toEqual([{ state: 'reconciled', charged: COST, actual: COST, judge_model_id: null, judge_actual: null }]);
    } finally { await price(JUDGE, ++judgePriceVersion, 'active', JUDGE_PRICE); }
  }, 30_000);

  it('an ordinary question right after a pasted check streams normally, with no coaching and no judge', async () => {
    const job = await prepare('Is it correct that the minimum is never greater than any other member?', [`Here is the check I am on: ${SHELF} Just the number please.`]);
    const mine = follow(job.learner, job.enrollmentId);
    await mine.opened;
    const text = 'Yes. The minimum is no greater than any other member, so it can tie with one but never exceed it. ';
    reply = [text];
    const before = calls.length;
    const outcome = (await invoke(job.request)).json();
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: COST, tokens: IN + OUT } });
    expect(calls.slice(before).map(call => call.kind)).toEqual(['stream']);
    expect(calls.at(-1)!.request.systemInstruction).not.toContain('Check coaching:');
    await until(() => mine.frames.at(-1)?.state === 'complete');
    expect(mine.frames.some(frame => frame.checking)).toBe(false);
    expect(mine.frames.filter(f => f.state === 'streaming').map(f => f.text).join('')).toBe(text);
    expect(await artifacts(job.ref.jobId)).toEqual([{ kind: 'companion_message', text }]);
    expect(await dispatch(job.request.operationId)).toMatchObject({ judge_verdict: null, cost: COST });
    await mine.close();
  }, 30_000);
});
