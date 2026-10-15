import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ProviderAdapter, UsageReceipt } from '@course-core/providers';
import type { HostBridge, ProviderRequest } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { appendEvent } from '../src/events.js';
import { ensureCatalog } from '../src/admin-routes.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, resolveSupervisorOperation } from '../src/supervisor-bridge.js';
import { teachingContext } from '../src/provider-context.js';
import { supervisorTools } from '../src/supervisor-tools.js';
import { composeProviders } from '../src/provider-composition.js';
import { hypothesisCourse } from './hypothesis-fixture.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';

/** Scripted (synthetic) planner model only: this proves the tool path, scope,
 * authorization and learner precedence, not the quality of a real model. */
const schema = 'hypothesis_tools_' + randomUUID().replaceAll('-', ''), workspace = randomUUID(), releaseId = randomUUID();
const origin = 'http://localhost:4310', token = randomUUID();
let db: Database, admin: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: HostBridge, owner: Session;
type Session = { id: string; cookie: string; csrf: string };
const scripts = new Map<string, (round: number, prompt: any) => unknown>();
const usage: UsageReceipt = { accounting: { accountingKey: 'synthetic' }, providerId: 'test', modelId: 'planner', operation: 'assess',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
const finish = { decision: 'finish', tool: 'none', argumentsJson: '{}', summary: 'Recorded a teaching hypothesis for learner review.' };
const adapter: ProviderAdapter = { providerId: 'test', validateModel() {}, ports: { structured_assessment: { async assess(req) {
  const [key, round] = req.accounting.accountingKey.split(':round-');
  const script = scripts.get(key!);
  return { usage, output: (script ? script(Number(round), JSON.parse(req.messages[0]!.text)) : finish) as never };
} } } };
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
async function login(role = 'learner'): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, 'test:' + id, 'Synthetic learner']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
}
async function command(learner: Session, id: string, path: string, body: Record<string, unknown>) {
  const revision = (await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision;
  const r = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/${path}`, headers: headers(learner), payload: { expectedRevision: revision, idempotencyKey: randomUUID(), ...body } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
/** A learner with one wrong practice answer and an admitted supervisor operation. */
async function prepare(consent = true) {
  const learner = await login();
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id as string;
  await command(learner, id, 'supervision', { adaptiveTeaching: consent });
  const issued = await command(learner, id, 'challenges', { episodeId: 'min', assessmentId: 'min-ambiguous', mode: 'practice' });
  await command(learner, id, 'answers', { challengeId: issued.challengeId, answer: 'six' });
  const submitted = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='assessment.submitted'", [id])).rows[0].id as string;
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: id }, { microUsd: 10000000, tokens: 20000000 });
  return { learner, id, submitted, ...(await admit(learner, id)) };
}
/** Admits a new supervisor operation for the enrollment's current revision. */
async function admit(learner: Session, id: string) {
  const event = await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId: id, actorId: learner.id, actorKind: 'learner',
    type: 'learning.review_requested', payload: { episodeId: 'min' }, idempotencyKey: randomUUID(), supervise: true }));
  const outbox = (await bridge.claimOutbox(randomUUID(), 100, 30000)).find(e => e.eventId === event.id)!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
  expect([claim.effect, claim.snapshot.state, claim.snapshot.reason]).toEqual(['invoke', 'running', null]);
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role: 'supervisor',
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  return { ref: ref!, request };
}
/** Ends a fenced run (its enrollment changed) so a new one can be admitted. */
async function retire(ref: Awaited<ReturnType<typeof admit>>['ref']) {
  expect((await bridge.transition({ type: 'halt', ref, reason: 'cancel_requested' })).snapshot.state).toBe('cancelled');
}
async function tools(job: { request: ProviderRequest }) {
  const resolved = await resolveSupervisorOperation(db, job.request);
  return supervisorTools(db, job.request, await teachingContext(db, resolved.ref, resolved.input.context));
}
async function hypothesesOf(job: { learner: Session; id: string }) {
  const r = await app.inject({ url: `/api/enrollments/${job.id}/learner-model/hypotheses`, headers: headers(job.learner) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error('Disposable TEST_DATABASE_URL required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw Error('Disposable loopback database required');
  admin = createDatabase(url.href);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', '-csearch_path=' + schema);
  db = createDatabase(url.href);
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const providers = composeProviders({
    registry: { revision: 'hypothesis-tools', models: [{ id: 'planner', providerId: 'test', remoteModel: 'planner', providerConfig: {}, enabled: true,
      capabilities: ['structured_assessment'], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: 'test', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    roles: { supervisor: { modelId: 'planner', maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 } },
  }, () => 'synthetic', { test: () => adapter });
  const jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, providers, supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'hypothesis-tools', 'Hypothesis tool qualification']);
  // Scripted, unpriced model: opt the workspace out of the operator price requirement.
  await allowUnpricedPaidWork(db, workspace);
  owner = await login('owner');
  const course = hypothesisCourse();
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [releaseId, workspace, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), owner.id]);
  await ensureCatalog(db, releaseId);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

it('a scripted supervisor lists, proposes, probes and reads results through the tool registry; the run inspector shows it', async () => {
  const job = await prepare();
  const seen: any[] = [];
  scripts.set(createHash('sha256').update(job.request.operationId).digest('hex'), (round, prompt) => {
    seen.push(prompt);
    if (round === 0) return { decision: 'tool', tool: 'list_hypotheses', argumentsJson: '{}', summary: '' };
    if (round === 1) return { decision: 'tool', tool: 'propose_hypothesis', argumentsJson: JSON.stringify({ templateId: 'min-first', evidenceEventIds: [job.submitted], uncertainty: 'high' }), summary: '' };
    if (round === 2) return { decision: 'tool', tool: 'propose_hypothesis', argumentsJson: JSON.stringify({ templateId: 'min-largest', evidenceEventIds: [job.submitted], uncertainty: 'high' }), summary: '' };
    if (round === 3) return { decision: 'tool', tool: 'schedule_probe', argumentsJson: JSON.stringify({ probeId: 'min-probe',
      hypothesisIds: prompt.toolResults.filter((t: any) => t.tool === 'propose_hypothesis').map((t: any) => t.result.hypothesisId) }), summary: '' };
    if (round === 4) return { decision: 'tool', tool: 'read_probe_results', argumentsJson: '{}', summary: '' };
    return finish;
  });
  const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: 'Bearer ' + token, 'idempotency-key': job.request.operationId }, payload: job.request });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().status).toBe('succeeded');
  const listed = seen[1].toolResults[0].result;
  expect(listed.templates.map((t: any) => t.templateId)).toEqual(['min-largest', 'min-first']);
  expect(listed.probes).toEqual([{ probeId: 'min-probe', objectiveId: 'minimum', distinguishes: ['min-largest', 'min-first'] }]);
  expect(JSON.stringify(listed)).not.toMatch(/correctOptionId|optionIds/);
  expect(seen[5].toolResults.at(-1).result.runs).toEqual([expect.objectContaining({ probeId: 'min-probe', state: 'scheduled', requestedBy: 'supervisor' })]);

  const current = await hypothesesOf(job);
  expect(current.items.map((h: any) => [h.templateId, h.source, h.status])).toEqual(expect.arrayContaining([['min-first', 'supervisor', 'probing'], ['min-largest', 'supervisor', 'probing']]));
  expect(current.probes[0]).toMatchObject({ requestedBy: 'supervisor', state: 'scheduled' });
  const changes = (await db.query('SELECT actor_kind,action,job_id FROM teaching_hypothesis_changes WHERE enrollment_id=$1 ORDER BY sequence', [job.id])).rows;
  expect(changes.every(c => c.actor_kind === 'agent' && c.job_id === job.ref.jobId)).toBe(true);
  expect(changes.map(c => c.action)).toEqual(['proposed', 'proposed', 'probe_scheduled', 'probe_scheduled']);
  // Nothing became evidence.
  expect((await db.query('SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1 AND result->>\'passed\'=\'true\'', [job.id])).rows[0].n).toBe(0);

  const catalog = (await db.query('SELECT id FROM admin_course_catalog WHERE workspace_id=$1', [workspace])).rows[0];
  const inspector = await app.inject({ url: `/api/admin/courses/${catalog.id}/runs/${job.ref.jobId}`, headers: headers(owner) });
  expect(inspector.statusCode, inspector.body).toBe(200);
  expect(inspector.json().hypothesisChanges.map((c: any) => c.action)).toEqual(['proposed', 'proposed', 'probe_scheduled', 'probe_scheduled']);
  expect(inspector.json().decisions.filter((d: any) => d.tool === 'propose_hypothesis').map((d: any) => d.explanation))
    .toEqual(Array(2).fill('Teaching hypothesis change recorded for learner review. Hypotheses and probes never count as evidence.'));
  expect(inspector.body).not.toContain('choosing the first value');
}, 30000);

it('writes need learner opt-in; reads do not', async () => {
  const job = await prepare(false), port = await tools(job);
  expect((await port.invoke('list_hypotheses', {}, 0)).result).toMatchObject({ authority: 'teaching_hypotheses_not_evidence' });
  const refused = await port.invoke('propose_hypothesis', { templateId: 'min-first', evidenceEventIds: [job.submitted], uncertainty: 'high' }, 1);
  expect(refused.result).toEqual({ recorded: false, reason: 'SUPERVISION_CONSENT_REQUIRED', grantsMastery: false });
  expect((await hypothesesOf(job)).items).toEqual([]);
});

it('a learner pin survives a competing agent; rejections, stale revisions and foreign evidence are refused', async () => {
  const job = await prepare(), port = await tools(job);
  const proposed = (await port.invoke('propose_hypothesis', { templateId: 'min-largest', evidenceEventIds: [job.submitted], uncertainty: 'high' }, 0)).result as any;
  expect(proposed).toMatchObject({ recorded: true, status: 'proposed', delivery: 'visible_to_learner_for_review' });
  // The learner pins while that agent run is still in flight: the run is fenced.
  const [h] = (await hypothesesOf(job)).items;
  await command(job.learner, job.id, `learner-model/hypotheses/${h.hypothesisId}/decision`, { expectedHypothesisRevision: h.revision, action: 'pin' });
  await expect(port.invoke('update_hypothesis', { hypothesisId: proposed.hypothesisId, expectedRevision: proposed.revision, status: 'rejected' }, 1)).rejects.toMatchObject({ code: 'SUPERVISOR_INPUT_STALE' });
  // A later run sees the pin and cannot change status or uncertainty, nor use a stale revision.
  await retire(job.ref);
  const later = await tools(await admit(job.learner, job.id));
  const stale = await later.invoke('update_hypothesis', { hypothesisId: proposed.hypothesisId, expectedRevision: proposed.revision, evidenceEventIds: [job.submitted] }, 0);
  expect(stale.result).toMatchObject({ recorded: false, reason: 'HYPOTHESIS_STALE' });
  const current = (await hypothesesOf(job)).items[0];
  const competing = await later.invoke('update_hypothesis', { hypothesisId: h.hypothesisId, expectedRevision: current.revision, status: 'rejected', uncertainty: 'medium' }, 1);
  expect(competing.result).toMatchObject({ recorded: false, reason: 'HYPOTHESIS_PINNED_BY_LEARNER' });
  // Evidence may still be attached to a pinned hypothesis; the pin stays.
  const evidence = await later.invoke('update_hypothesis', { hypothesisId: h.hypothesisId, expectedRevision: current.revision, evidenceEventIds: [job.submitted] }, 2);
  expect(evidence.result).toMatchObject({ recorded: true, status: 'proposed' });
  expect((await hypothesesOf(job)).items[0]).toMatchObject({ pinned: true, status: 'proposed', observations: 2 });

  const other = await prepare();
  const foreign = await later.invoke('propose_hypothesis', { templateId: 'min-first', evidenceEventIds: [other.submitted], uncertainty: 'high' }, 3);
  expect(foreign.result).toMatchObject({ recorded: false, reason: 'SOURCE_EVENT_OUT_OF_SCOPE' });
  const outside = await later.invoke('propose_hypothesis', { templateId: 'max-needs-min', evidenceEventIds: [job.submitted], uncertainty: 'high' }, 4);
  expect(outside.result).toMatchObject({ recorded: false, reason: 'HYPOTHESIS_TEMPLATE_OUT_OF_SCOPE' });

  // A learner-rejected template cannot be proposed again by an agent.
  const first = await tools(other);
  const theirs = (await first.invoke('propose_hypothesis', { templateId: 'min-first', evidenceEventIds: [other.submitted], uncertainty: 'high' }, 0)).result as any;
  // A replayed step returns its receipt instead of writing twice.
  const replay = await first.invoke('propose_hypothesis', { templateId: 'min-first', evidenceEventIds: [other.submitted], uncertainty: 'high' }, 0);
  expect(replay.result).toMatchObject({ hypothesisId: theirs.hypothesisId });
  expect((await db.query('SELECT count(*)::int AS n FROM teaching_hypotheses WHERE enrollment_id=$1', [other.id])).rows[0].n).toBe(1);
  // Invalid arguments never reach the store; a confident claim is not allowed.
  await expect(first.invoke('propose_hypothesis', { templateId: 'min-largest', evidenceEventIds: [other.submitted], uncertainty: 'low' }, 1)).rejects.toMatchObject({ code: 'SUPERVISOR_TOOL_ARGUMENTS' });
  const [mine] = (await hypothesesOf(other)).items;
  await command(other.learner, other.id, `learner-model/hypotheses/${theirs.hypothesisId}/decision`, { expectedHypothesisRevision: mine.revision, action: 'reject' });
  await retire(other.ref);
  const next = await tools(await admit(other.learner, other.id));
  const again = await next.invoke('propose_hypothesis', { templateId: 'min-first', evidenceEventIds: [other.submitted], uncertainty: 'medium' }, 0);
  expect(again.result).toMatchObject({ recorded: false, reason: 'HYPOTHESIS_REJECTED_BY_LEARNER' });
  expect((await next.invoke('list_hypotheses', {}, 1)).result).toMatchObject({ hypotheses: [], learnerRejectedTemplateIds: ['min-first'] });
}, 30000);
