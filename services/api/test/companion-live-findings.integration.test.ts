import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { ProviderError } from '@course-core/providers';
import { GoogleProvider } from '@course-core/providers/google';
import type { Outcome, ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createServer } from '../src/server.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { appendEvent } from '../src/events.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { fixture } from './fixture.js';
import { credentialVault } from '../src/key-vault.js';
import { WorkspaceProviders } from '../src/provider-setup.js';
import { roleReservation } from '../src/role-reservation.js';
import { streamedIfAsked } from './streamed-provider-fixture.js';

// Findings of the first live companion run, reproduced with the real Google REST adapter, gateway
// route, bridge, verifier, spend ledger and PostgreSQL. Only the provider endpoint is scripted, with
// responses shaped like a thinking model's (thought parts, thoughtsTokenCount, MAX_TOKENS). These
// fixtures prove Core's handling, not real model quality.
const schema = `course_live_findings_${randomUUID().replaceAll('-', '')}`, workspaceId = randomUUID(), releaseId = randomUUID(), token = randomUUID();
const ALLOWANCE = 100_000, MODEL = 'gemini-test';
// $0.75 / $3.75 per million input / output tokens, as the pilot's operator price.
const INPUT_PRICE = 750_000, OUTPUT_PRICE = 3_750_000;
const priced = (input: number, output: number) => Math.ceil((input * INPUT_PRICE + output * OUTPUT_PRICE) / 1_000_000);
const LONG_REPLY = 'The weight goes up because gradient descent steps against the gradient: new w = 2 - 0.1 x (-6) = 2.6. '.repeat(3);
type Step = { reply: string | null; finish: 'STOP' | 'MAX_TOKENS' | 'SAFETY'; thoughts: number; visible: number } | 'hang';
const script: Step[] = [], requests: Record<string, unknown>[] = [], urls: string[] = [];
let testDatabase: TestDatabase | undefined, db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, operator: string, courseDigest: string;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
// Companion replies stream (docs/streamed-replies.md): a scripted answer is re-encoded as the
// streamGenerateContent SSE the adapter asked for, so these findings also cover the streamed path.
const scriptedFetch: typeof fetch = async (url, init) => streamedIfAsked(String(url), init, await scriptedAnswer(url, init));
const scriptedAnswer: typeof fetch = async (url, init) => {
  requests.push(JSON.parse(String(init?.body))); urls.push(String(url));
  const step = script.shift();
  if (!step) throw new Error('Unexpected provider request');
  if (step === 'hang') return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  return json({ candidates: [{ index: 0, finishReason: step.finish, content: { role: 'model', parts: [{ text: 'private reasoning', thought: true },
    ...(step.reply === null ? [] : [{ text: step.reply }])] } }],
    usageMetadata: { promptTokenCount: 2002, candidatesTokenCount: step.visible, thoughtsTokenCount: step.thoughts, totalTokenCount: 2002 + step.visible + step.thoughts } });
};

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const course = compileCourse(fixture());
  courseDigest = course.digest;
  operator = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [operator, `test:${operator}`, 'Operator']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `findings-${workspaceId}`, 'Findings']);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), operator]);
  // An operator price in force since before any call (so it also prices older receipts).
  await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
    effective_from,source_note,created_by) VALUES($1,$2,$3,1,'active','USD',$4,$5,clock_timestamp()-interval '1 day','Synthetic live-findings price',$6)`,
    [randomUUID(), workspaceId, MODEL, INPUT_PRICE, OUTPUT_PRICE, operator]);
  const providers = composeProviders({ registry: { revision: 'findings', models: [
    { id: MODEL, providerId: 'google-test', remoteModel: 'gemini-3.8-flash', enabled: true, capabilities: ['tutoring'], tools: [],
      providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1_000_000, thinking: { level: 'low' } },
      limits: { maxInputCharacters: 20000, maxOutputTokens: 4096 } }] },
    adapters: [{ id: 'google-test', kind: 'scripted-google', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    roles: { companion: { modelId: MODEL, maxInputCharacters: 12000, maxOutputTokens: 4096 } } },
  () => 'synthetic-key-only-in-test', {
    'scripted-google': options => new GoogleProvider({ providerId: options.providerId, registry: options.registry, fetch: scriptedFetch,
      getApiKey: () => { const value = options.getCredential(); if (!value) throw new ProviderError('MISSING_CREDENTIAL'); return value; },
      settings: { maxAttempts: 1, attemptTimeoutMs: 300, totalTimeoutMs: 1000, baseDelayMs: 500, maxDelayMs: 1000 } }),
  });
  const supervisor = { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: ALLOWANCE, tokens: 500_000 } } };
  app = await createServer(db, { loginCodes: true, origin: 'http://localhost:4310', secureCookies: false, supervisor, providers });
  bridge = createPostgresSupervisorBridge(db, supervisor);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 100_000_000, tokens: 100_000_000 });
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function prepare(history: { role: 'learner' | 'assistant'; content: string }[] = []) {
  const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), now = new Date().toISOString(), course = fixture();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Synthetic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
  await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({ goal: 'Synthetic' }), 'min']);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, now))]);
  for (const [index, message] of history.entries())
    await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context,created_at) VALUES ($1,$2,$3,$4,$5,clock_timestamp()-($6 * interval '1 second'))",
      [randomUUID(), enrollmentId, message.role, message.content, JSON.stringify({ episodeId: 'min', courseDigest }), history.length - index + 1]);
  await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
    [messageId, enrollmentId, 'CURRENT_QUESTION_CANARY: do frozen layers still affect the prediction?', JSON.stringify({ episodeId: 'min', courseDigest })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested',
    payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
  const lease = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(lease); await bridge.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 10_000_000, tokens: 10_000_000 });
  return { ref: ref!, enrollmentId, messageId };
}
type Job = Awaited<ReturnType<typeof prepare>>;
async function claim(job: Job) {
  const ownerId = randomUUID(), result = await bridge.transition({ type: 'claim', ref: job.ref, checkpointId: 'generate', ownerId, availability: { status: 'ready' } });
  const operation = result.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: result.snapshot.specification.key, role: 'companion',
    checkpoint: result.snapshot.specification.checkpoints[0]!, fence: result.snapshot.specification.fence };
  return { result, operation, request, ownerId };
}
async function invoke(body: ProviderRequest) {
  const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': body.operationId }, payload: body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Outcome;
}
async function once(step: Step, history?: Parameters<typeof prepare>[0]) {
  const job = await prepare(history), claimed = await claim(job);
  expect(claimed.result.effect).toBe('invoke');
  script.length = 0; script.push(step);
  const outcome = await invoke(claimed.request);
  const settled = await bridge.transition({ type: 'settle', ref: job.ref, operationId: claimed.operation.id, ownerId: claimed.ownerId, outcome });
  return { job, claimed, outcome, settled };
}
const transition = (command: unknown) =>
  app.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: `Bearer ${token}` }, payload: { method: 'transition', command } });
const used = async (enrollmentId: string) => Number((await db.query('SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [enrollmentId])).rows[0].used_micro_usd);
const ledger = async (enrollmentId: string) => (await db.query(`SELECT state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,actual_micro_usd::int AS actual,
  released_micro_usd::int AS released FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY attempt`, [enrollmentId])).rows;
const dispatch = async (operationId: string) => (await db.query('SELECT state,failure_code,cost_micro_usd::int AS cost,outcome FROM provider_dispatches WHERE operation_id=$1', [operationId])).rows[0];
const refusal = async (jobId: string) => (await db.query("SELECT content FROM supervisor_artifacts WHERE job_id=$1", [jobId])).rows.map(r => r.content);

describe('live companion findings', () => {
  it('sends the companion thinking level and delivers a reply cut short at the output limit, marked, priced at the reported usage', async () => {
    const { job, claimed, outcome, settled } = await once({ reply: LONG_REPLY, finish: 'MAX_TOKENS', thoughts: 3700, visible: 396 });
    // The streamed call carries the same thinking setting and cut-short handling as a whole reply.
    expect(urls.at(-1)).toContain(':streamGenerateContent?alt=sse');
    const sent = requests.at(-1) as { generationConfig: Record<string, unknown> };
    expect(sent.generationConfig).toMatchObject({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } });
    const cost = priced(2002, 396 + 3700);
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: cost, tokens: 2002 + 396 + 3700 }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    expect(settled.snapshot.state).toBe('running');
    expect(await refusal(job.ref.jobId)).toEqual([{ kind: 'companion_message', text: LONG_REPLY, cutShort: true }]);
    expect((await transition({ type: 'verify', ref: job.ref })).json().snapshot.state).toBe('ready');
    expect((await transition({ type: 'apply', ref: job.ref })).json().snapshot.state).toBe('applied');
    const answer = (await db.query("SELECT content,context FROM companion_messages WHERE job_id=$1 AND role='assistant'", [job.ref.jobId])).rows[0];
    expect(answer).toMatchObject({ content: LONG_REPLY, context: { cutShort: true } });
    expect(await used(job.enrollmentId)).toBe(cost);
    expect(await dispatch(claimed.operation.id)).toMatchObject({ state: 'completed', failure_code: null, cost });
  }, 60000);

  it('a reply cut off while thinking (too little visible text) is a definite priced failure: settled at usage, the rest released, the job rejected', async () => {
    const { job, claimed, outcome, settled } = await once({ reply: 'Frozen layers still', finish: 'MAX_TOKENS', thoughts: 947, visible: 49 });
    const cost = priced(2002, 49 + 947);
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: cost, tokens: 2002 + 49 + 947 }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    // No longer waiting for an operator with the whole reservation held.
    expect(settled.snapshot.state).not.toBe('waiting');
    expect(await used(job.enrollmentId)).toBe(cost);
    const [entry] = await ledger(job.enrollmentId);
    expect(entry).toMatchObject({ state: 'reconciled', charged: cost, actual: cost });
    expect(entry.released).toBe(entry.reserved - cost);
    expect(await dispatch(claimed.operation.id)).toMatchObject({ state: 'completed', failure_code: 'INCOMPLETE_OUTPUT', cost });
    // Only the reason is stored, never the cut-off text.
    expect(await refusal(job.ref.jobId)).toEqual([{ kind: 'output_refusal', role: 'companion', reason: 'provider_output_incomplete' }]);
    expect((await transition({ type: 'verify', ref: job.ref })).json().snapshot).toMatchObject({ state: 'failed', reason: 'verification_rejected' });
    expect((await db.query("SELECT count(*)::int AS n FROM companion_messages WHERE job_id=$1 AND role='assistant'", [job.ref.jobId])).rows[0].n).toBe(0);
    // A repeat of the request answers from the receipt: no second provider call.
    const before = requests.length;
    expect(await invoke(claimed.request)).toEqual(outcome);
    expect(requests.length).toBe(before);
  }, 60000);

  it('a streamed reply the provider refuses (safety stop) is settled at its reported usage and priced, and nothing of it is kept', async () => {
    const { job, claimed, outcome } = await once({ reply: 'Here is how to bypass', finish: 'SAFETY', thoughts: 120, visible: 6 });
    expect(urls.at(-1)).toContain(':streamGenerateContent?alt=sse');
    const cost = priced(2002, 6 + 120);
    expect(outcome).toMatchObject({ status: 'succeeded', usage: { microUsd: cost, tokens: 2002 + 6 + 120 }, usageBasis: { microUsd: 'reported', tokens: 'reported' } });
    expect(await used(job.enrollmentId)).toBe(cost);
    expect(await dispatch(claimed.operation.id)).toMatchObject({ state: 'completed', failure_code: 'BLOCKED', cost });
    expect(await refusal(job.ref.jobId)).toEqual([{ kind: 'output_refusal', role: 'companion', reason: 'provider_output_blocked' }]);
    expect((await transition({ type: 'verify', ref: job.ref })).json().snapshot).toMatchObject({ state: 'failed', reason: 'verification_rejected' });
  }, 60000);

  it('a timeout after sending still stays uncertain with the reservation held', async () => {
    const { job, outcome, settled } = await once('hang');
    expect(outcome).toEqual({ status: 'uncertain' });
    expect(settled.snapshot).toMatchObject({ state: 'waiting', reason: 'provider_uncertain' });
    expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
  }, 60000);

  it('long history: the context is trimmed with headroom, keeps the current question, and is sent instead of refused', async () => {
    const history = Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'learner' as const, content: `turn ${i} ` + 'long explanation '.repeat(230) }));
    const { outcome } = await once({ reply: 'Yes: frozen layers still compute the features the last layer reads.', finish: 'STOP', thoughts: 120, visible: 20 }, history);
    expect(outcome.status).toBe('succeeded');
    const sent = requests.at(-1) as { contents: { parts: { text: string }[] }[]; systemInstruction: { parts: { text: string }[] } };
    const text = sent.contents[0]!.parts[0]!.text, view = JSON.parse(text);
    expect(view.question).toContain('CURRENT_QUESTION_CANARY');
    expect(view.episode).toMatchObject({ id: 'min' });
    expect(view.historyTruncated).toBe(true);
    // Real headroom below the role's input bound (instruction included).
    expect(text.length + sent.systemInstruction.parts[0]!.text.length).toBeLessThan(12000 - 1500);
    // The companion prompt asks for concise, plain replies by default.
    expect(sent.systemInstruction.parts[0]!.text).toContain('Keep replies short and plain');
  }, 60000);

  it('reconciliation settles receipts an older gateway left uncertain after a refused but completed reply, without operator action', async () => {
    // Two jobs whose provider answered (MAX_TOKENS, usage reported) but which Core 0.1.52 recorded as
    // uncertain, holding the full reservation: reproduce that row shape exactly, then reconcile.
    const stuck = [];
    for (const visible of [274, 49]) {
      const { job, claimed, outcome, settled } = await once('hang');
      expect(outcome).toEqual({ status: 'uncertain' });
      expect(settled.snapshot.state).toBe('waiting');
      const thoughts = visible === 274 ? 722 : 947;
      const receipt = { accounting: { accountingKey: 'old' }, providerId: 'google-test', modelId: MODEL, operation: 'tutor', inputCharacters: 9000,
        requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
        attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 2380, output: visible, total: 2380 + visible + thoughts, cachedInput: null, thoughts, toolInput: null } }] };
      await db.query(`UPDATE provider_dispatches SET failure_code='INCOMPLETE_OUTPUT',provider_usage=$2,model_id=$3,cost_micro_usd=NULL,pricing_version_id=NULL
        WHERE operation_id=$1`, [claimed.operation.id, JSON.stringify(receipt), MODEL]);
      expect(await used(job.enrollmentId)).toBe(ALLOWANCE);
      stuck.push({ job, claimed, cost: priced(2380, visible + thoughts), tokens: 2380 + visible + thoughts });
    }
    // Rows that must stay uncertain: an attempt whose outcome is unknown, and a response without a total.
    const unknown = await once('hang');
    await db.query(`UPDATE provider_dispatches SET failure_code='INCOMPLETE_OUTPUT',provider_usage=$2,model_id=$3 WHERE operation_id=$1`,
      [unknown.claimed.operation.id, JSON.stringify({ attempts: [{ attempt: 1, status: null, outcome: 'unknown', tokens: { total: null } }] }), MODEL]);
    const untotalled = await once('hang');
    await db.query(`UPDATE provider_dispatches SET failure_code='INCOMPLETE_OUTPUT',provider_usage=$2,model_id=$3 WHERE operation_id=$1`,
      [untotalled.claimed.operation.id, JSON.stringify({ attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { total: null } }] }), MODEL]);

    const result = await bridge.reconcile(100);
    expect(result.settled).toBeGreaterThanOrEqual(2);
    for (const { job, claimed, cost, tokens } of stuck) {
      expect(await dispatch(claimed.operation.id)).toMatchObject({ state: 'completed', failure_code: 'INCOMPLETE_OUTPUT', cost,
        outcome: { status: 'succeeded', usage: { microUsd: cost, tokens }, usageBasis: { microUsd: 'reported', tokens: 'reported' } } });
      expect(await used(job.enrollmentId)).toBe(cost);
      const [entry] = await ledger(job.enrollmentId);
      expect(entry).toMatchObject({ state: 'reconciled', charged: cost, actual: cost, released: ALLOWANCE - cost });
      expect(await refusal(job.ref.jobId)).toEqual([{ kind: 'output_refusal', role: 'companion', reason: 'provider_output_incomplete' }]);
      // The job is resumed in a new generation, whose verification rejects the refusal.
      expect(result.resume.map(r => r.jobId)).toContain(job.ref.jobId);
      const next = result.resume.find(r => r.jobId === job.ref.jobId)!;
      expect((await transition({ type: 'verify', ref: next })).json().snapshot).toMatchObject({ state: 'failed', reason: 'verification_rejected' });
    }
    for (const left of [unknown, untotalled]) {
      expect(await dispatch(left.claimed.operation.id)).toMatchObject({ state: 'uncertain' });
      expect(await used(left.job.enrollmentId)).toBe(ALLOWANCE);
    }
    // A second pass changes nothing.
    expect((await bridge.reconcile(100)).settled).toBe(0);
  }, 120000);

  it('a setup saved by the old guide is read with thinking defaults, and the companion reservation is sized from its limits and price', async () => {
    const legacy = { registry: { revision: 'guide', models: [{ id: 'google:companion', providerId: 'google', remoteModel: 'gemini-3.8-flash', enabled: true,
        capabilities: ['tutoring'], tools: [], providerConfig: { transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1048576 },
        limits: { maxInputCharacters: 12000, maxOutputTokens: 1000 } }] },
      adapters: [{ id: 'google', kind: 'google', credentialEnv: 'GOOGLE_API_KEY' }],
      roles: { companion: { modelId: 'google:companion', maxInputCharacters: 12000, maxOutputTokens: 1000 } } };
    const jobPolicy = { allowance: { microUsd: ALLOWANCE, tokens: 500_000 }, durationMs: 300000, timeoutMs: 60000, maxAttempts: 3 };
    await db.query('INSERT INTO workspace_provider_versions(workspace_id,revision,configuration,job_policy,sealed_credentials,changed_by) VALUES($1,1,$2,$3,$4,$5)',
      [workspaceId, JSON.stringify(legacy), JSON.stringify(jobPolicy), '{}', operator]);
    await db.query('INSERT INTO workspace_provider_settings(workspace_id,revision) VALUES($1,1)', [workspaceId]);
    await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
      effective_from,source_note,created_by) VALUES($1,$2,'google:companion',1,'active','USD',$3,$4,clock_timestamp()-interval '1 day','Synthetic live-findings price',$5)`,
      [randomUUID(), workspaceId, INPUT_PRICE, OUTPUT_PRICE, operator]);
    const service = new WorkspaceProviders(db, credentialVault(randomBytes(32)));
    const version = (await service.version(db, workspaceId))!;
    const model = (version.configuration.registry as { models: { providerConfig: Record<string, unknown>; limits: Record<string, number> }[] }).models[0]!;
    expect(model.providerConfig.thinking).toEqual({ level: 'low' });
    expect(model.limits.maxOutputTokens).toBe(4096);
    expect(version.configuration.roles.companion).toMatchObject({ maxOutputTokens: 4096 });
    // The stored row is untouched (versions are append-only); the upgrade is applied on read.
    expect((await db.query('SELECT configuration FROM workspace_provider_versions WHERE workspace_id=$1 AND revision=1', [workspaceId])).rows[0].configuration).toEqual(legacy);
    const expected = roleReservation({ maxInputCharacters: 12000, maxOutputTokens: 4096 }, { versionId: 'x', currency: 'USD', inputMicroUsdPerMillionTokens: INPUT_PRICE,
      outputMicroUsdPerMillionTokens: OUTPUT_PRICE, cachedInputMicroUsdPerMillionTokens: null, microUsdPerRequest: null, microUsdPerOutputSecond: null }, jobPolicy.allowance)!;
    const bound = await transaction(db, client => service.bind(client, workspaceId));
    expect(bound!.roleAllowances).toEqual({ companion: expected });
    expect(expected.microUsd).toBeLessThan(ALLOWANCE / 2);
    // A companion question admitted under this setup reserves the sized amount, not the job allowance.
    const sized = createPostgresSupervisorBridge(db, { serviceToken: token, workspaceIds: [workspaceId], jobPolicy: jobPolicy,
      providerBinding: (client, workspace) => service.bind(client, workspace) });
    const enrollmentId = randomUUID(), messageId = randomUUID(), studentId = randomUUID(), course = fixture();
    await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [studentId, `test:${studentId}`, 'Synthetic learner']);
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, studentId]);
    await db.query('INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,profile,current_episode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [enrollmentId, workspaceId, releaseId, studentId, JSON.stringify(course.policy), JSON.stringify({}), 'min']);
    await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(initialPolicy(course, enrollmentId, studentId, new Date().toISOString()))]);
    await db.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)", [messageId, enrollmentId, 'A question?', JSON.stringify({ episodeId: 'min', courseDigest })]);
    const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: studentId, actorKind: 'learner', type: 'companion.requested',
      payload: { messageId, episodeId: 'min', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true }));
    const lease = (await sized.claimOutboxEvent(event.id, randomUUID(), 30000))!;
    const [ref] = await sized.prepareOutbox(lease); await sized.ackOutbox(lease);
    const spec = (await db.query('SELECT specification FROM supervisor_jobs WHERE id=$1', [ref!.jobId])).rows[0].specification;
    expect(spec.checkpoints[0].allowance).toEqual(expected);
    expect(spec.budget).toEqual(expected);
    await db.query('DELETE FROM workspace_provider_settings WHERE workspace_id=$1', [workspaceId]);
  }, 60000);
});
