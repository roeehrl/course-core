import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderAdapter, UsageReceipt } from '@course-core/providers';
import type { ProviderRequest, RunRef } from '@course-core/supervisor';
import { defineAgentStrategy } from '@course-core/sdk';
import { canonicalJson } from '@course-core/sdk/compiler';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { appendEvent } from '../src/events.js';
import { ensureCatalog } from '../src/admin-routes.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { composeProviders } from '../src/provider-composition.js';
import { WorkspaceProviders } from '../src/provider-setup.js';
import { credentialVault } from '../src/key-vault.js';
import { roleRevisions } from '../src/agent-evals/revision.js';
import { supervisorTool } from '../src/supervisor-tool-catalog.js';
import { hypothesisCourse } from './hypothesis-fixture.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';

/**
 * Which strategy answered each provider call (requirement B08), with a SCRIPTED model only: the
 * dispatch records Core's own or the course's strategy and the role revision it ran as; the run
 * inspector shows it; a course's own strategy is gated separately (refused until its exact
 * revision is approved); and the host provider file's roles are reported by the eval gate.
 */
const schema = 'strategy_runs_' + randomUUID().replaceAll('-', ''), workspace = randomUUID();
const origin = 'http://localhost:4310', token = randomUUID();
type Session = { id: string; cookie: string; csrf: string };
let db: Database, testDatabase: TestDatabase | undefined, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, owner: Session;
const releases: Record<'core' | 'course', { id: string; catalog: string }> = { core: { id: randomUUID(), catalog: '' }, course: { id: randomUUID(), catalog: '' } };
const usage: UsageReceipt = { accounting: { accountingKey: 'synthetic' }, providerId: 'test', modelId: 'planner', operation: 'assess',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
const adapter: ProviderAdapter = { providerId: 'test', validateModel() {}, ports: { structured_assessment: { async assess() {
  return { usage, output: { decision: 'finish', tool: 'none', argumentsJson: '{}', summary: 'Nothing to change.' } as never };
} } } };
const configuration = {
  registry: { revision: 'strategy-runs', models: [{ id: 'planner', providerId: 'test', remoteModel: 'planner', providerConfig: {}, enabled: true,
    capabilities: ['structured_assessment'], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
  adapters: [{ id: 'test', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
  roles: { supervisor: { modelId: 'planner', maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 } },
};
/** A course declaration that only narrows Core's tool loop (course-strategies.ts). */
const declared = defineAgentStrategy({
  id: 'example.supervisor.read-first', version: '1.0.0', roles: ['supervisor'], description: 'Reads the learner record and hypotheses only, then proposes.',
  inputSchema: { type: 'object' }, outputContract: { schema: { type: 'object' }, proposalKinds: ['supervised_plan'] },
  toolRefs: ['get_profile', 'list_hypotheses', 'propose_practice_check'], modelRequirements: { capabilities: ['structured_output'] },
  autonomy: { level: 'propose_only', mayApply: [], requiresLearnerOptIn: true, maxAppliedChangesPerDay: 0 },
  budget: { maxToolCalls: 3, maxWallSeconds: 120, maxOutputTokens: 800 }, retry: { maxAttempts: 2, reconcileUnknownOutcome: true }, cancellation: 'cooperative',
});
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
async function login(role = 'learner'): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, 'test:' + id, 'Synthetic person']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
}
async function enroll(release: 'core' | 'course') {
  const learner = await login();
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId: releases[release].id } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id as string;
  const revision = (await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision;
  const consent = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/supervision`, headers: headers(learner), payload: { adaptiveTeaching: true, expectedRevision: revision, idempotencyKey: randomUUID() } });
  expect(consent.statusCode, consent.body).toBe(200);
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: id }, { microUsd: 10_000_000, tokens: 50_000_000 });
  return { learner, id };
}
/** A review job, claimed and sent through the provider gateway as the workflow activity does. */
async function dispatch(learner: Session, id: string) {
  const event = await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId: id, actorId: learner.id, actorKind: 'learner',
    type: 'learning.review_requested', payload: { episodeId: 'min' }, idempotencyKey: randomUUID(), supervise: true }));
  const outbox = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox) as RunRef[];
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
  expect(claim.effect).toBe('invoke');
  const op = claim.snapshot.operations.find(o => o.checkpointId === 'generate')!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: op.id, job: claim.snapshot.specification.key, role: 'supervisor',
    checkpoint: claim.snapshot.specification.checkpoints.find(c => c.id === 'generate')!, fence: claim.snapshot.specification.fence };
  const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: 'Bearer ' + token, 'idempotency-key': op.id }, payload: request });
  expect(r.statusCode, r.body).toBe(200);
  const row = (await db.query('SELECT strategy_id,strategy_version,strategy_source,role_revision_digest,eval_standing,failure_code FROM provider_dispatches WHERE operation_id=$1', [op.id])).rows[0];
  return { outcome: r.json(), row, jobId: ref!.jobId };
}
async function insertRelease(key: 'core' | 'course', server: Record<string, unknown>, learner: unknown) {
  const digest = createHash('sha256').update(canonicalJson(server)).digest('hex');
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [releases[key].id, workspace, server.id, server.version, digest, JSON.stringify(server), JSON.stringify(learner), owner.id]);
  await ensureCatalog(db, releases[key].id);
  releases[key].catalog = (await db.query('SELECT c.id FROM admin_course_catalog c JOIN course_releases r ON r.course_key=c.course_key AND r.workspace_id=c.workspace_id WHERE r.id=$1', [releases[key].id])).rows[0].id;
}
const evalStatus = async () => {
  const r = await app.inject({ url: `/api/admin/workspaces/${workspace}/provider-evals`, headers: headers(owner) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error('Disposable TEST_DATABASE_URL required');
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders(configuration, () => 'synthetic', { test: () => adapter });
  // The host file's runtime is the fallback for jobs without a workspace configuration (main.ts).
  const workspaceProviders = new WorkspaceProviders(db, credentialVault(randomBytes(32)), {}, providers);
  const jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, providers, providerConfiguration: configuration, workspaceProviders,
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'strategy-runs', 'Strategy runs qualification']);
  await allowUnpricedPaidWork(db, workspace);
  owner = await login('owner');
  const course = hypothesisCourse();
  await insertRelease('core', course.server as unknown as Record<string, unknown>, course.learner);
  const tools = ['get_profile', 'list_hypotheses', 'propose_practice_check'].map(id => supervisorTool(id)!.contract);
  const declaring = { ...structuredClone(course.server), id: 'strategy-course', agentStrategies: [declared], tools } as unknown as Record<string, unknown>;
  await insertRelease('course', declaring, { ...structuredClone(course.learner), id: 'strategy-course' });
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 100_000_000, tokens: 1_000_000_000 });
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('which strategy ran, and course strategies gated separately (B08)', () => {
  it('records Core\'s own strategy, its role revision and standing on the dispatch, and the run inspector shows it', async () => {
    const { learner, id } = await enroll('core');
    const { outcome, row, jobId } = await dispatch(learner, id);
    expect(outcome.status).toBe('succeeded');
    const digest = (await roleRevisions(configuration)).supervisor!.digest;
    expect(row).toEqual({ strategy_id: 'core.supervisor.tool-loop', strategy_version: expect.any(String), strategy_source: 'core', role_revision_digest: digest,
      eval_standing: 'not_checked', failure_code: null });
    const inspected = await app.inject({ url: `/api/admin/courses/${releases.core.catalog}/runs/${jobId}`, headers: headers(owner) });
    expect(inspected.statusCode, inspected.body).toBe(200);
    expect(inspected.json().policies).toMatchObject({ providerSource: 'host_file',
      strategies: [{ strategyId: 'core.supervisor.tool-loop', source: 'core', revisionDigest: digest, evalStanding: 'not_checked' }] });
  });

  it('refuses a course\'s own strategy until its exact revision is approved, never running Core\'s wider one in its place', async () => {
    const { learner, id } = await enroll('course');
    const refused = await dispatch(learner, id);
    expect(refused.outcome).toEqual({ status: 'not_started', retryable: false });
    expect(refused.row).toMatchObject({ strategy_id: 'example.supervisor.read-first', strategy_version: '1.0.0', strategy_source: 'course',
      eval_standing: 'not_checked', failure_code: 'COURSE_STRATEGY_NOT_CHECKED' });
    // The course strategy is its own revision, listed for an owner's decision.
    const listed = (await evalStatus()).courseStrategies;
    expect(listed).toEqual([expect.objectContaining({ releaseId: releases.course.id, role: 'supervisor', strategy: 'example.supervisor.read-first',
      strategyVersion: '1.0.0', revisionDigest: refused.row.role_revision_digest, status: 'not_covered' })]);
    expect(refused.row.role_revision_digest).not.toBe((await roleRevisions(configuration)).supervisor!.digest);
    // Approving Core's own revision does not approve the course's.
    const approve = (revisionDigest: string) => app.inject({ method: 'POST', url: `/api/admin/workspaces/${workspace}/provider-evals/overrides`, headers: headers(owner),
      payload: { idempotencyKey: randomUUID(), role: 'supervisor', revisionDigest, reason: 'Owner reviewed this exact setup and accepts it for the pilot.' } });
    expect((await approve((await roleRevisions(configuration)).supervisor!.digest)).statusCode).toBe(200);
    expect((await dispatch(learner, id)).row.failure_code).toBe('COURSE_STRATEGY_NOT_CHECKED');
    expect((await approve(refused.row.role_revision_digest)).statusCode).toBe(200);
    const ran = await dispatch(learner, id);
    expect(ran.outcome.status).toBe('succeeded');
    expect(ran.row).toMatchObject({ strategy_id: 'example.supervisor.read-first', strategy_source: 'course', eval_standing: 'approved', failure_code: null });
    expect((await evalStatus()).courseStrategies[0].status).toBe('override');
  });

  it('reports the host provider file\'s roles in the eval gate while the workspace has no configuration of its own', async () => {
    const status = await evalStatus();
    const digest = (await roleRevisions(configuration)).supervisor!.digest;
    expect(status.hostFile).toEqual({ inUse: true, roles: [{ role: 'supervisor', strategy: 'core.supervisor.tool-loop', revisionDigest: digest, covered: true, status: 'override' }] });
    // A learner never sees any of it.
    const learner = await login();
    expect((await app.inject({ url: `/api/admin/workspaces/${workspace}/provider-evals`, headers: headers(learner) })).statusCode).toBe(403);
  });
});
