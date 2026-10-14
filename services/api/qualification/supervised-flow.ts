import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import type { Client } from '@temporalio/client';
import type { ProviderAdapter, TextRequest, UsageReceipt } from '@course-core/providers';
import {
  HttpHostBridge, HttpProviderGateway, dispatchOnce, workflowId,
  type Activities, type HostBridge, type ProviderGateway, type RunRef, type Snapshot, type Summary, type WorkflowStarter,
} from '@course-core/supervisor';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { composeProviders } from '../src/provider-composition.js';
import { verifyCompanionBoundary } from '../src/companion-verifier.js';
import { configureSupervisorBudget } from '../src/supervisor-bridge.js';
import { fixture } from '../test/fixture.js';
import {qualifySupervisorTools,ToolsFlowFailure} from './supervisor-tools-flow.js';

// Required combined-system gate. Only the external model service and transport faults are synthetic.
// Errors/logs intentionally expose fixed checkpoint codes, never assertion values or raw HTTP bodies.
class GateFailure extends Error { constructor(readonly code: string) { super(code); } }
function check(value: unknown, code: string): asserts value { if (!value) throw new GateFailure(code); }
function equal(actual: unknown, expected: unknown, code: string) { check(isDeepStrictEqual(actual, expected), code); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new GateFailure(code)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function eventually(read: () => Promise<boolean>, code: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await read()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new GateFailure(code);
}
function testUrl(): URL {
  check(process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL, 'test_database_required');
  let url: URL;
  try { url = new URL(process.env.TEST_DATABASE_URL); } catch { throw new GateFailure('invalid_test_database_url'); }
  check(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && /^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) && !url.search && !url.hash, 'unsafe_test_database_url');
  return url;
}
interface Session { cookie: string; csrf: string; userId: string }
interface LearnerCase {
  name: string; workspaceId: string; userId: string; base: string; session: Session;
  enrollmentId: string; question: string; profile: string; eventId: string; messageId: string;
}
interface WorkerRun { worker: Worker; result: Promise<unknown | undefined>; stopped: boolean }
interface FakeCall { request: TextRequest; context: { question: string; learner: { profile: { goal?: string } } } }
const origin = 'http://localhost:4310';
const answer = 'Compare the values on a number line. The value farther left is smaller. This is advisory teaching, not an assessment result.';
const allowance = { microUsd: 100_000, tokens: 20_000 };
const observedUsage: UsageReceipt = {
  accounting: { accountingKey: 'qualification-reported-usage' }, providerId: 'qualification-provider', modelId: 'qualification-model', operation: 'tutor',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 20, output: 10, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 1000, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
};

async function main() {
  const url = testUrl(), schema = `course_supervised_${randomUUID().replaceAll('-', '')}`;
  const serviceToken = `SERVICE_CANARY_${randomUUID()}`, providerSecret = `PROVIDER_CANARY_${randomUUID()}`;
  const forbidden = new Set<string>([serviceToken, providerSecret, answer]), oracleCanaries = new Set<string>();
  const admin = createDatabase(url.toString());
  let db: Database | undefined, scratch: string | undefined, env: TestWorkflowEnvironment | undefined, fake: Server | undefined;
  const apps: Awaited<ReturnType<typeof createServer>>[] = [], workers: WorkerRun[] = [];
  const refs = new Map<string, RunRef>(), snapshots = new Map<string, Snapshot>(), fakeCalls: FakeCall[] = [];
  const verifiedJobs = new Set<string>(), passed: string[] = [];
  const pendingExternal = new Set<ReturnType<typeof deferred<void>>>();
  let activeBlock: { marker: string; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
  let schemaCreated = false, phase = 'preflight', failure: string | undefined;
  const cleanupFailures: string[] = [];
  let decodedPayloads = 0, replayedHistories = 0, workerRestarts = 0, lostStartAcks = 0, lostSettleAcks = 0;
  let supervisorToolModelCalls = 0, supervisorToolWorkerRestarts = 0, supervisorApplyAckLoss = 0;
  const pass = (name: string) => { passed.push(name); process.stdout.write(`${JSON.stringify({ gate: 'supervised-flow', check: name, status: 'passed' })}\n`); };
  try {
    const version = Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    check(version >= 170000 && version < 180000, 'postgres_17_required');
    // Resolve installed/built package artifacts, never sibling TypeScript source.
    const supervisorRoot = new URL(import.meta.resolve('@course-core/supervisor'));
    check(supervisorRoot.protocol === 'file:' && supervisorRoot.pathname.includes('/dist/'), 'built_supervisor_required');
    const workflowsPath = fileURLToPath(new URL('./temporal/workflows.js', supervisorRoot));
    await access(workflowsPath);
    const { temporalActivities } = await import(new URL('./temporal/activities.js', supervisorRoot).href) as {
      temporalActivities: (bridge: HostBridge, provider: ProviderGateway) => Activities;
    };
    const { temporalStarter } = await import(new URL('./temporal/client.js', supervisorRoot).href) as {
      temporalStarter: (client: Client, queue: string) => WorkflowStarter;
    };
    Runtime.install({ logger: new DefaultLogger('ERROR', () => {}) });
    scratch = await mkdtemp(path.join(tmpdir(), 'course-supervised-'));
    await mkdir(path.join(scratch, 'temporal'));
    phase = 'temporal_test_server';
    env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', ui: false,
      executable: { type: 'cached-download', downloadDir: path.join(scratch, 'temporal') }, log: { format: 'json', level: 'error' } } });
    const bundle = await bundleWorkflowCode({ workflowsPath, logger: new DefaultLogger('ERROR', () => {}) });
    phase = 'database_schema';
    await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
    url.searchParams.set('options', `-csearch_path=${schema}`); db = createDatabase(url.toString());
    const database = db;
    const migrated = await migrate(database, fileURLToPath(new URL('../migrations', import.meta.url)));
    check(migrated.includes('004_supervisor_runtime.sql') && migrated.includes('005_provider_gateway.sql'), 'runtime_migrations_required');
    equal(await migrate(database, fileURLToPath(new URL('../migrations', import.meta.url))), [], 'migration_replay_changed');
    phase = 'fake_external_provider';
    fake = createHttpServer((req, res) => {
      void (async () => {
        check(req.method === 'POST' && req.url === '/tutor' && req.headers.authorization === `Bearer ${providerSecret}`, 'fake_provider_auth');
        const parts: Buffer[] = []; let size = 0;
        for await (const raw of req) { const part = Buffer.from(raw); size += part.length; check(size <= 65_536, 'fake_provider_body_limit'); parts.push(part); }
        const request = JSON.parse(Buffer.concat(parts).toString('utf8')) as TextRequest;
        const context = JSON.parse(request.messages[0]!.text) as FakeCall['context'];
        check(typeof context.question === 'string', 'fake_provider_context_shape');
        fakeCalls.push({ request, context });
        const block = activeBlock;
        if (block && context.question.includes(block.marker)) {
          pendingExternal.add(block.release); block.entered.resolve();
          await bounded(block.release.promise, 25_000, 'fake_provider_hold_timeout'); pendingExternal.delete(block.release);
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ output: { text: answer }, usage: observedUsage }));
      })().catch(() => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"qualification_provider_failed"}'); });
    });
    await new Promise<void>((resolve, reject) => { fake!.once('error', reject); fake!.listen(0, '127.0.0.1', resolve); });
    const fakeAddress = fake.address(); check(fakeAddress && typeof fakeAddress === 'object', 'fake_provider_bind');
    const fakeBase = `http://127.0.0.1:${fakeAddress.port}`;
    const providers = composeProviders({
      registry: { revision: 'qualification-registry', models: [{ id: 'qualification-model', providerId: 'qualification-provider', remoteModel: 'synthetic-http-model',
        providerConfig: {}, enabled: true, capabilities: ['tutoring'], tools: [], limits: { maxInputCharacters: 20_000, maxOutputTokens: 1000 } }] },
      adapters: [{ id: 'qualification-provider', kind: 'qualification-http', credentialEnv: 'COURSE_PROVIDER_QUALIFICATION_API_KEY' }],
      roles: { companion: { modelId: 'qualification-model', maxInputCharacters: 12_000, maxOutputTokens: 1000 } },
    }, () => providerSecret, { 'qualification-http': ({ providerId, getCredential }) => ({ providerId, validateModel() {},
      ports: { tutoring: { async tutor(request, options) {
        const response = await fetch(`${fakeBase}/tutor`, { method: 'POST', redirect: 'error',
          signal: options?.signal ?? AbortSignal.timeout(25_000), headers: { authorization: `Bearer ${getCredential()}`, 'content-type': 'application/json' }, body: JSON.stringify(request) });
        check(response.ok, 'fake_provider_http_failure');
        return await response.json() as { output: { text: string }; usage: UsageReceipt };
      } } },
    } satisfies ProviderAdapter) });
    const workspaces = Object.fromEntries(['success', 'recovery', 'stale', 'configuration', 'budget', 'foreign'].map(name => [name, randomUUID()]));
    const workspaceIds = Object.values(workspaces);
    const beforeVerify = async (ref: RunRef) => {
      const row = (await database.query<{ runtime_snapshot: Snapshot }>('SELECT runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3',
        [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
      check(row?.runtime_snapshot.specification.role === 'companion', 'unexpected_verifier_role');
      check(row.runtime_snapshot.operations.length === 1 && row.runtime_snapshot.operations[0]!.outcome?.status === 'succeeded', 'verification_before_settlement');
      check(Number((await database.query('SELECT count(*) FROM provider_dispatches WHERE job_id=$1 AND state=\'completed\'', [ref.jobId])).rows[0].count) === 1, 'verification_before_gateway_receipt');
      await verifyCompanionBoundary(database, ref); verifiedJobs.add(ref.jobId);
    };
    phase = 'real_http_api';
    const supervisor = { serviceToken, workspaceIds, beforeVerify,
      jobPolicy: { allowance, durationMs: 180_000, timeoutMs: 30_000, maxAttempts: 3 } };
    const configured = await createServer(database, { loginCodes: true, origin, secureCookies: false, supervisor, providers }); apps.push(configured);
    const unconfigured = await createServer(database, { loginCodes: true, origin, secureCookies: false, supervisor }); apps.push(unconfigured);
    const enabledBase = await configured.listen({ host: '127.0.0.1', port: 0 });
    const disabledBase = await unconfigured.listen({ host: '127.0.0.1', port: 0 });
    async function http(base: string, method: string, route: string, body?: unknown, session?: Session, expected = 200) {
      const response = await fetch(new URL(route, base), { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data = await response.json() as Record<string, any>;
      check(response.status === expected, `http_${method.toLowerCase()}_${route.includes('companion') ? 'companion' : 'api'}_${response.status}`);
      return { response, data };
    }
    async function login(base: string, userId: string): Promise<Session> {
      const token = await issueLoginCode(database, userId); forbidden.add(token);
      const result = await http(base, 'POST', '/auth/redeem', { token });
      const cookies = result.response.headers.getSetCookie().map(value => value.split(';')[0]!);
      check(cookies.length >= 2 && typeof result.data.csrfToken === 'string', 'login_cookie_contract');
      cookies.forEach(cookie => forbidden.add(cookie.slice(cookie.indexOf('=') + 1))); forbidden.add(result.data.csrfToken);
      return { cookie: cookies.join('; '), csrf: result.data.csrfToken, userId };
    }
    async function user(workspaceId: string, role: string, base: string) {
      const id = randomUUID();
      await database.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [id, `qualification:${id}`, 'Qualification learner']);
      await database.query('INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspaceId, id, role]);
      return login(base, id);
    }
    async function makeCase(name: string, configuredProvider = true, question = true): Promise<LearnerCase> {
      const workspaceId = workspaces[name]!; check(workspaceId, 'unknown_case');
      const base = configuredProvider ? enabledBase : disabledBase;
      await database.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `qualification-${name}-${randomUUID()}`, 'Public synthetic qualification']);
      const owner = await user(workspaceId, 'owner', base);
      const course = fixture(), oracle = `PRIVATE_ORACLE_CANARY_${randomUUID()}`;
      forbidden.add(oracle); oracleCanaries.add(oracle);
      for (const assessment of course.assessments) if ('explanation' in assessment.grading) assessment.grading.explanation = oracle;
      const imported = await http(base, 'POST', `/api/workspaces/${workspaceId}/releases`, course, owner);
      await http(base, 'POST', `/api/releases/${imported.data.id}/publish`, {}, owner);
      const session = await user(workspaceId, 'learner', base);
      const enrollment = await http(base, 'POST', '/api/enrollments', { releaseId: imported.data.id }, session);
      const enrollmentId = String(enrollment.data.id), profile = `PROFILE_CANARY_${randomUUID()}`, message = `QUESTION_CANARY_${randomUUID()}`;
      forbidden.add(profile); forbidden.add(message);
      const c: LearnerCase = { name, workspaceId, userId: session.userId, base, session, enrollmentId,
        question: `How can I compare these numbers? ${message}`, profile, eventId: '', messageId: '' };
      const current = (await http(base, 'GET', `/api/enrollments/${enrollmentId}`, undefined, session)).data;
      await http(base, 'POST', `/api/enrollments/${enrollmentId}/profile`, { expectedRevision: current.revision, idempotencyKey: randomUUID(),
        profile: { displayName: 'Qualification learner', goal: profile, pace: 'steady' } }, session);
      if (question) {
        const fresh = (await http(base, 'GET', `/api/enrollments/${enrollmentId}`, undefined, session)).data;
        const asked = await http(base, 'POST', `/api/enrollments/${enrollmentId}/companion`, { expectedRevision: fresh.revision,
          idempotencyKey: randomUUID(), episodeId: 'min', ...(name === 'success' ? {} : { blockId: 'min-text' }), content: c.question }, session);
        c.eventId = String(asked.data.eventId); c.messageId = String(asked.data.messageId);
        check(asked.data.state === 'queued', 'question_not_queued');
      }
      return c;
    }
    async function fund(c: LearnerCase) {
      await configureSupervisorBudget(database, { workspaceId: c.workspaceId }, { microUsd: 1_000_000, tokens: 200_000 });
      await configureSupervisorBudget(database, { workspaceId: c.workspaceId, enrollmentId: c.enrollmentId }, { microUsd: 1_000_000, tokens: 200_000 });
    }
    async function snapshot(c: LearnerCase): Promise<Snapshot> {
      const row = (await database.query<{ runtime_snapshot: Snapshot }>('SELECT runtime_snapshot FROM supervisor_jobs WHERE input_event_id=$1 AND enrollment_id=$2 AND workspace_id=$3 AND role=\'companion\'',
        [c.eventId, c.enrollmentId, c.workspaceId])).rows[0];
      check(row, 'companion_job_not_prepared'); return row.runtime_snapshot;
    }
    async function messages(c: LearnerCase) {
      return (await http(c.base, 'GET', `/api/enrollments/${c.enrollmentId}/companion`, undefined, c.session)).data.messages as Array<{ role: string; content: string; id: string; job_id: string | null; job_state: string | null; job_reason: string | null }>;
    }
    async function noCredit(c: LearnerCase) {
      const result = await database.query(`SELECT
        (SELECT count(*) FROM evidence WHERE enrollment_id=$1) AS evidence,
        (SELECT count(*) FROM attempts WHERE enrollment_id=$1) AS attempts,
        (SELECT count(*) FROM extension_grants WHERE enrollment_id=$1) AS extensions,
        (SELECT count(*) FROM episode_progress WHERE enrollment_id=$1 AND state IN ('completed','placed')) AS completed`, [c.enrollmentId]);
      check(Object.values(result.rows[0]).every(value => Number(value) === 0), 'advisory_output_granted_credit');
    }
    async function cost(c: LearnerCase, invoked: boolean) {
      for (const [table, column, id] of [['supervisor_workspace_budgets', 'workspace_id', c.workspaceId], ['supervisor_enrollment_budgets', 'enrollment_id', c.enrollmentId]] as const) {
        const row = (await database.query(`SELECT used_micro_usd,used_tokens FROM ${table} WHERE ${column}=$1`, [id])).rows[0];
        check(row, 'budget_row_missing');
        equal([Number(row.used_micro_usd), Number(row.used_tokens)], invoked ? [allowance.microUsd, 30] : [0, 0], 'budget_not_consumed_once');
      }
      const rows = (await database.query('SELECT state,provider_usage,outcome FROM provider_dispatches WHERE enrollment_id=$1 AND workspace_id=$2', [c.enrollmentId, c.workspaceId])).rows;
      check(rows.length === (invoked ? 1 : 0), 'dispatch_count_wrong');
      if (invoked) {
        check(rows[0].state === 'completed' && rows[0].provider_usage.cost === null, 'unknown_cost_lost');
        equal(rows[0].outcome.usageBasis, { microUsd: 'reserved_ceiling', tokens: 'reported' }, 'unknown_cost_mislabeled');
      }
    }
    async function startWorker(c: LearnerCase, queue: string, request: typeof fetch = fetch) {
      const worker = await Worker.create({ connection: env!.nativeConnection, taskQueue: queue, workflowBundle: bundle,
        activities: temporalActivities(new HttpHostBridge(c.base, serviceToken, 10_000, request), new HttpProviderGateway(c.base, serviceToken)),
        maxConcurrentActivityTaskExecutions: 4, maxConcurrentWorkflowTaskExecutions: 4, shutdownGraceTime: '3 seconds',
        maxHeartbeatThrottleInterval: '500ms', defaultHeartbeatThrottleInterval: '500ms' });
      const run: WorkerRun = { worker, result: worker.run().then(() => undefined, error => error), stopped: false }; workers.push(run); return run;
    }
    async function stop(run: WorkerRun) {
      if (run.stopped) return;
      if (run.worker.getState() === 'RUNNING') run.worker.shutdown();
      const error = await bounded(run.result, 15_000, 'worker_stop_timeout'); run.stopped = true;
      check(error === undefined, 'worker_failed');
    }
    function starter(queue: string, loseStartFor?: string) {
      const native = temporalStarter(env!.client, queue); let injected = false;
      return { async start(ref: RunRef, id: string) {
        refs.set(id, ref); await native.start(ref, id);
        if (loseStartFor && !injected) {
          const row = (await database.query('SELECT input_event_id FROM supervisor_jobs WHERE id=$1', [ref.jobId])).rows[0];
          if (row?.input_event_id === loseStartFor) { injected = true; lostStartAcks++; throw new GateFailure('injected_start_ack_loss'); }
        }
      } } satisfies WorkflowStarter;
    }
    async function dispatch(c: LearnerCase, start: WorkflowStarter) {
      const result = await dispatchOnce(new HttpHostBridge(c.base, serviceToken), start, { limit: 100 });
      check(result.claimed > 0 && result.failed === 0 && result.quarantined === 0 && result.leaseLost === 0, 'outbox_dispatch_failed');
      return result;
    }
    async function finish(c: LearnerCase, expectedState: string, expectedReason: string | null) {
      const s = await snapshot(c), ref = { ...s.specification.key, generation: s.generation }, id = workflowId(ref);
      const summary = await bounded(env!.client.workflow.getHandle(id).result(), 45_000, 'workflow_completion_timeout') as Summary;
      equal([summary.state, summary.reason], [expectedState, expectedReason], 'unexpected_workflow_result');
      const persisted = await snapshot(c); snapshots.set(id, persisted);
      equal([persisted.state, persisted.reason], [expectedState, expectedReason], 'workflow_host_state_diverged');
      const read = await messages(c), source = read.find(row => row.id === c.messageId);
      check(source?.job_id === ref.jobId && source.job_state === expectedState && source.job_reason === expectedReason, 'learner_job_status_not_visible');
      const replies = read.filter(row => row.role === 'assistant');
      check(replies.length === (expectedState === 'applied' ? 1 : 0), 'fake_or_duplicate_answer');
      if (expectedState === 'applied') {
        check(replies[0]!.content === answer && verifiedJobs.has(ref.jobId), 'reply_not_separately_verified');
        const receipt = (await database.query(`SELECT a.can_verify_companion,a.can_review_adaptation FROM supervisor_verifications v
          JOIN supervisor_verifier_authorities a ON a.id=v.verifier_id WHERE v.job_id=$1`, [ref.jobId])).rows[0];
        check(receipt?.can_verify_companion && !receipt.can_review_adaptation, 'wrong_verification_authority');
      }
      await noCredit(c); return { id, ref, snapshot: persisted };
    }
    async function finishStarted() {
      for (const id of refs.keys()) await bounded(env!.client.workflow.getHandle(id).result(), 45_000, 'background_workflow_incomplete');
    }

    phase = 'scope_fixture';
    const foreign = await makeCase('foreign', true, false);
    await database.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
      [randomUUID(), foreign.enrollmentId, foreign.question, JSON.stringify({ episodeId: 'min' })]);
    phase = 'success';
    const success = await makeCase('success'); await fund(success);
    const peerSession = await user(success.workspaceId, 'learner', enabledBase);
    const releaseId = (await database.query('SELECT course_release_id FROM enrollments WHERE id=$1', [success.enrollmentId])).rows[0].course_release_id;
    const peer = (await http(enabledBase, 'POST', '/api/enrollments', { releaseId }, peerSession)).data.id as string;
    const peerCanary = `PEER_HISTORY_CANARY_${randomUUID()}`; forbidden.add(peerCanary);
    await database.query("INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
      [randomUUID(), peer, peerCanary, JSON.stringify({ episodeId: 'min' })]);
    const queue1 = `qualification-success-${randomUUID()}`, run1 = await startWorker(success, queue1), start1 = starter(queue1);
    const delivered = await dispatch(success, start1); check(delivered.deferred === 0, 'success_outbox_deferred');
    const applied = await finish(success, 'applied', null); await finishStarted();
    check(Number(fakeCalls.length) === 1 && fakeCalls[0]!.context.question === success.question && fakeCalls[0]!.context.learner.profile.goal === success.profile, 'provider_context_not_current');
    await cost(success, true);
    await start1.start(applied.ref, applied.id); // Reject duplicate CLOSED workflow IDs too.
    const again = await new HttpHostBridge(success.base, serviceToken).transition({ type: 'apply', ref: applied.ref });
    check(again.snapshot.applicationReceiptId === applied.snapshot.applicationReceiptId && Number(fakeCalls.length) === 1, 'duplicate_reapplied_or_resubmitted');
    await stop(run1); pass('real_question_outbox_temporal_http_gateway_verification_reply');

    phase = 'restart_recovery';
    const recovery = await makeCase('recovery'); await fund(recovery);
    const lost = deferred<void>(); let dropped = false;
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      if (!dropped && response.ok && body?.method === 'transition' && body.command?.type === 'settle'
        && body.command.ref.enrollmentId === recovery.enrollmentId && body.command.outcome.status === 'succeeded') {
        await response.arrayBuffer(); dropped = true; lostSettleAcks++; lost.resolve();
        throw new GateFailure('injected_settlement_ack_loss'); // Server committed; activity never receives its acknowledgement.
      }
      return response;
    };
    const queue2 = `qualification-recovery-${randomUUID()}`, first = await startWorker(recovery, queue2, lossy), start2 = starter(queue2, recovery.eventId);
    const partial = await dispatch(recovery, start2); check(partial.deferred === 1, 'start_ack_fault_not_exercised');
    await bounded(lost.promise, 30_000, 'settlement_ack_fault_not_exercised');
    await stop(first); workerRestarts++;
    const replacement = await startWorker(recovery, queue2);
    await finish(recovery, 'applied', null); await finishStarted();
    await eventually(async () => Boolean((await database.query('SELECT 1 FROM outbox WHERE event_id=$1 AND delivered_at IS NULL AND available_at<=clock_timestamp()', [recovery.eventId])).rowCount), 'outbox_retry_not_available');
    const redelivery = await dispatch(recovery, start2); check(redelivery.delivered === 1 && redelivery.deferred === 0, 'outbox_recovery_failed');
    check(Number((await database.query('SELECT count(*) FROM supervisor_jobs WHERE input_event_id=$1', [recovery.eventId])).rows[0].count) === 1, 'outbox_recovery_duplicate_job');
    const delivery = (await database.query('SELECT attempts,delivered_at FROM outbox WHERE event_id=$1', [recovery.eventId])).rows[0];
    check(delivery.attempts === 2 && delivery.delivered_at, 'outbox_delivery_not_replayed');
    check(Number(fakeCalls.length) === 2, 'recovery_reinvoked_provider'); await cost(recovery, true);
    await stop(replacement); pass('lost_start_and_settlement_ack_worker_restart_single_cost');

    phase = 'stale_profile';
    const stale = await makeCase('stale'); await fund(stale);
    activeBlock = { marker: stale.question, entered: deferred<void>(), release: deferred<void>() };
    const queue3 = `qualification-stale-${randomUUID()}`, run3 = await startWorker(stale, queue3), start3 = starter(queue3);
    await dispatch(stale, start3); await bounded(activeBlock.entered.promise, 30_000, 'stale_provider_not_started');
    const current = (await http(stale.base, 'GET', `/api/enrollments/${stale.enrollmentId}`, undefined, stale.session)).data;
    const freshProfile = `FRESH_PROFILE_CANARY_${randomUUID()}`; forbidden.add(freshProfile);
    await http(stale.base, 'POST', `/api/enrollments/${stale.enrollmentId}/profile`, { expectedRevision: current.revision, idempotencyKey: randomUUID(),
      profile: { displayName: 'Qualification learner', goal: freshProfile, pace: 'focused' } }, stale.session);
    activeBlock.release.resolve(); activeBlock = undefined;
    const rejected = await finish(stale, 'cancelled', 'stale_revision');
    check(!verifiedJobs.has(rejected.ref.jobId) && Number(fakeCalls.length) === 3, 'stale_output_reached_verification');
    await cost(stale, true); await dispatch(stale, start3); await finishStarted(); await stop(run3);
    pass('fresh_profile_fences_stale_output_without_refunding_unknown_charge');

    phase = 'configuration_missing';
    const missing = await makeCase('configuration', false); await fund(missing);
    const queue4 = `qualification-configuration-${randomUUID()}`, run4 = await startWorker(missing, queue4);
    await dispatch(missing, starter(queue4)); await finish(missing, 'waiting', 'configuration_missing');
    await finishStarted(); check(Number(fakeCalls.length) === 3, 'missing_configuration_generated_answer'); await cost(missing, false); await stop(run4);
    pass('configuration_missing_visible_without_fake_answer');

    phase = 'budget_wait';
    const budget = await makeCase('budget'); // Deliberately no ledger grants.
    const queue5 = `qualification-budget-${randomUUID()}`, run5 = await startWorker(budget, queue5);
    await dispatch(budget, starter(queue5)); await finish(budget, 'budget_wait', 'budget_exhausted');
    await finishStarted(); check(Number(fakeCalls.length) === 3, 'zero_budget_generated_answer'); await cost(budget, false); await stop(run5);
    pass('zero_default_budget_visible_without_provider_submission');

    phase = 'scope_isolation';
    // The foreign profile is real scoped DB state, and an unauthorized learner must not read it.
    const forbiddenRead = await fetch(new URL(`/api/enrollments/${foreign.enrollmentId}/companion`, success.base), {
      headers: { cookie: success.session.cookie }, signal: AbortSignal.timeout(10_000) });
    check([403, 404].includes(forbiddenRead.status), 'cross_tenant_learner_read_allowed');
    const peerRead = await fetch(new URL(`/api/enrollments/${peer}/companion`, success.base), {
      headers: { cookie: success.session.cookie }, signal: AbortSignal.timeout(10_000) });
    check(peerRead.status === 404, 'same_workspace_other_learner_read_allowed');
    const validSpec = applied.snapshot.specification, op = applied.snapshot.operations[0]!;
    const wrongScope = await fetch(new URL('/v1/operations', success.base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json', 'idempotency-key': op.id },
      body: JSON.stringify({ schemaVersion: 1, operationId: op.id, job: { ...validSpec.key, enrollmentId: foreign.enrollmentId, workspaceId: foreign.workspaceId },
        role: validSpec.role, checkpoint: validSpec.checkpoints[0], fence: validSpec.fence }) });
    check([403, 404].includes(wrongScope.status) && Number(fakeCalls.length) === 3, 'cross_tenant_gateway_submission_allowed');
    for (const call of fakeCalls) {
      const text = JSON.stringify(call.request);
      for (const secret of [serviceToken, providerSecret, foreign.profile, foreign.question, peerCanary, 'correctOptionId', '4 is below 9.']) check(!text.includes(secret), 'provider_prompt_scope_or_secret_leak');
      for (const oracle of oracleCanaries) check(!text.includes(oracle), 'private_answer_bank_reached_provider');
      const owner = [success, recovery, stale].find(c => c.question === call.context.question); check(owner, 'unknown_provider_question');
      for (const other of [success, recovery, stale]) if (other !== owner) check(!text.includes(other.profile) && !text.includes(other.question), 'provider_history_crossed_enrollment');
    }
    pass('scoped_db_context_and_no_answer_bank_or_provider_secret_in_prompt');

    phase = 'supervisor_tools_delivery_and_recovery';
    const tools=await qualifySupervisorTools(database,env,bundle);refs.set(tools.wid,tools.ref);tools.canaries.forEach(c=>forbidden.add(c));
    supervisorToolModelCalls=tools.modelCalls;supervisorToolWorkerRestarts=tools.workerRestarts;supervisorApplyAckLoss=tools.applyAckLoss;
    pass('scoped_tools_reviewed_lesson_delivery_lost_apply_ack_and_worker_restart');
    phase = 'generated_teaching_delivery_and_recovery';
    const generatedTools=await qualifySupervisorTools(database,env,bundle,false,false,false,true);refs.set(generatedTools.wid,generatedTools.ref);generatedTools.canaries.forEach(c=>forbidden.add(c));
    supervisorToolModelCalls+=generatedTools.modelCalls;supervisorToolWorkerRestarts+=generatedTools.workerRestarts;supervisorApplyAckLoss+=generatedTools.applyAckLoss;
    pass('novel_teaching_independent_reference_delivery_lost_apply_ack_and_worker_restart');
    phase = 'bounded_teaching_repair_and_recovery';
    const repairedTools=await qualifySupervisorTools(database,env,bundle,false,false,false,true,true);refs.set(repairedTools.wid,repairedTools.ref);repairedTools.canaries.forEach(c=>forbidden.add(c));
    supervisorToolModelCalls+=repairedTools.modelCalls;supervisorToolWorkerRestarts+=repairedTools.workerRestarts;supervisorApplyAckLoss+=repairedTools.applyAckLoss;
    pass('reference_feedback_bounded_draft_repair_lost_apply_ack_and_worker_restart');
    phase = 'public_research_child_dispatch_and_recovery';
    const researchTools=await qualifySupervisorTools(database,env,bundle,false,false,false,false,false,true);refs.set(researchTools.wid,researchTools.ref);researchTools.relatedRefs?.forEach(r=>refs.set(r.wid,r.ref));researchTools.canaries.forEach(c=>forbidden.add(c));
    supervisorToolModelCalls+=researchTools.modelCalls;supervisorToolWorkerRestarts+=researchTools.workerRestarts;supervisorApplyAckLoss+=researchTools.applyAckLoss;
    pass('verified_public_topic_child_collection_private_query_boundary_lost_ack_and_worker_restart');



    phase='supervisor_learner_model_suggestion_recovery';
    const modelTools=await qualifySupervisorTools(database,env,bundle,false,false,true);refs.set(modelTools.wid,modelTools.ref);modelTools.canaries.forEach(c=>forbidden.add(c));
    supervisorToolModelCalls+=modelTools.modelCalls;supervisorToolWorkerRestarts+=modelTools.workerRestarts;supervisorApplyAckLoss+=modelTools.applyAckLoss;
    pass('supervisor_source_linked_model_suggestion_learner_correction_lost_apply_ack_and_worker_restart');

    phase = 'configured_workspace_tool_delivery_and_recovery';
    const configuredTools=await qualifySupervisorTools(database,env,bundle,true);refs.set(configuredTools.wid,configuredTools.ref);configuredTools.canaries.forEach(c=>forbidden.add(c));
    supervisorToolModelCalls+=configuredTools.modelCalls;supervisorToolWorkerRestarts+=configuredTools.workerRestarts;supervisorApplyAckLoss+=configuredTools.applyAckLoss;
    pass('configured_workspace_encrypted_key_binding_admission_delivery_and_recovery');

    phase='workspace_rotation_during_provider_call';
    const rotatedTools=await qualifySupervisorTools(database,env,bundle,true,true);refs.set(rotatedTools.wid,rotatedTools.ref);rotatedTools.canaries.forEach(c=>forbidden.add(c));supervisorToolModelCalls+=rotatedTools.modelCalls;
    pass('workspace_rotation_fences_model_rounds_and_retains_usage');

    phase = 'native_history_replay_and_redaction';
    const scan = (value: unknown, key = '', depth = 0): void => {
      check(depth < 100, 'history_depth_limit');
      if (value instanceof Uint8Array) {
        decodedPayloads++; const decoded = Buffer.from(value).toString('utf8');
        for (const canary of forbidden) check(!decoded.includes(canary), 'native_history_contains_canary');
      } else if (typeof value === 'string') {
        for (const canary of forbidden) check(!value.includes(canary), 'native_history_contains_canary');
        if (key === 'data' && value) scan(Buffer.from(value, 'base64'), '', depth + 1);
      } else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) scan(child, name, depth + 1);
    };
    for (const id of refs.keys()) {
      const history = await env.client.workflow.getHandle(id).fetchHistory();
      check((history.events?.length ?? 0) > 5, 'native_history_missing'); scan(history);
      await Worker.runReplayHistory({ workflowBundle: bundle }, history); replayedHistories++;
    }
    check(decodedPayloads > 0 && replayedHistories >= 5 && Number(fakeCalls.length) === 3, 'history_scan_or_replay_incomplete');
    check(lostStartAcks === 1 && lostSettleAcks === 1 && workerRestarts === 1, 'recovery_coverage_incomplete');
    pass('native_histories_replay_without_learner_or_secret_canaries');
  } catch (error) {
    failure = error instanceof GateFailure || error instanceof ToolsFlowFailure ? error.code : 'qualification_dependency_or_runtime_failure';
  } finally {
    for (const release of pendingExternal) release.resolve();
    activeBlock?.release.resolve();
    for (const run of workers) {
      if (!run.stopped) {
        try { if (run.worker.getState() === 'RUNNING') run.worker.shutdown(); await bounded(run.result, 15_000, 'worker_cleanup_timeout'); }
        catch { cleanupFailures.push('worker_cleanup_failed'); }
      }
    }
    for (const app of apps) { try { await app.close(); } catch { cleanupFailures.push('http_cleanup_failed'); } }
    if (fake) { fake.closeAllConnections(); await new Promise<void>(resolve => fake!.close(() => resolve())); }
    if (env) { try { await env.teardown(); } catch { cleanupFailures.push('temporal_cleanup_failed'); } }
    try { await db?.end(); } catch { cleanupFailures.push('pool_cleanup_failed'); }
    if (schemaCreated) { try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } catch { cleanupFailures.push('schema_cleanup_failed'); } }
    try { await admin.end(); } catch { cleanupFailures.push('admin_pool_cleanup_failed'); }
    if (scratch) { try { await rm(scratch, { recursive: true, force: true }); } catch { cleanupFailures.push('scratch_cleanup_failed'); } }
  }
  if (cleanupFailures.length) failure ??= 'qualification_cleanup_failed';
  if (failure) {
    process.stderr.write(`${JSON.stringify({ gate: 'supervised-flow', status: 'failed', phase, code: failure, completedChecks: passed,
      cleanup: cleanupFailures.length ? 'failed' : 'completed', cleanupFailures })}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${JSON.stringify({ gate: 'supervised-flow', status: 'passed', checks: passed.length,
    storage: 'real-postgresql', orchestration: 'real-temporal', api: 'real-http', externalProvider: 'synthetic-loopback-http',
    providerCalls: fakeCalls.length, supervisorToolModelCalls, workerRestarts:workerRestarts+supervisorToolWorkerRestarts, lostStartAcks, lostSettleAcks, supervisorApplyAckLoss, replayedHistories, decodedPayloads,
    liveProviderVerified: false, earnedCredit: false, cleanup: 'completed' })}\n`);
}
await main().catch(() => {
  process.stderr.write('{"gate":"supervised-flow","status":"failed","code":"qualification_preflight_failed"}\n');
  process.exitCode = 1;
});
