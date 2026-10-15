import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authService, issueLoginCode, type Actor } from '../src/auth.js';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { appendEvent } from '../src/events.js';
import { ApiError } from '../src/errors.js';
import { createLearnerModelProposalPort, readLearnerModel, registerLearnerModelRoutes } from '../src/learner-model.js';
import { fixture } from './fixture.js';

const origin = 'http://localhost:4310';
const schema = `course_learner_model_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID();
const bankCanary = `UNISSUED_BANK_${randomUUID()}`, oracleCanary = `ORACLE_${randomUUID()}`;
let db: Database, adminDb: Database, app: FastifyInstance, core: FastifyInstance;
let staff: Session, service: Session, foreignStaff: Session, releaseId: string, foreignReleaseId: string;
type Session = { actor: Actor; cookie: string; csrf: string };
const serviceCredential = randomBytes(32).toString('hex');
let port: ReturnType<typeof createLearnerModelProposalPort<string>>;
const urlFor = (id: string) => `/api/enrollments/${id}/learner-model`;
const profile = (thoughts = '') => ({ preferences: { pace: 'steady', explanationStyle: 'worked_example', goal: 'Understand comparisons.' },
  priorKnowledge: [{ objectiveId: 'minimum', statement: 'I think I already know this.' }], thoughts });
const headers = (session: Session) => ({ cookie: session.cookie, origin, 'x-csrf-token': session.csrf });
async function session(workspace: string, role = 'learner'): Promise<Session> {
  const actor = { id: randomUUID(), displayName: 'Synthetic learner' };
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES ($1,$2,$3)', [actor.id, `learner-model-test:${actor.id}`, actor.displayName]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspace, actor.id, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  expect(login.statusCode, login.body).toBe(200);
  return { actor, csrf: login.json().csrfToken, cookie: login.cookies.map(row => `${row.name}=${row.value}`).join('; ') };
}
async function fresh(workspace = workspaceId, release = releaseId) {
  const learner = await session(workspace);
  const response = await core.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId: release } });
  expect(response.statusCode, response.body).toBe(200);
  return { learner, id: response.json().id as string };
}
async function revision(id: string) { return Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision); }
async function model(learner: Session, id: string, query = '?episodeId=min') {
  const response = await app.inject({ url: urlFor(id) + query, headers: headers(learner) });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}
async function edit(learner: Session, id: string, value = profile(), extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: urlFor(id) + '/profile', headers: headers(learner),
    payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), profile: value, ...extra } });
}
async function coreCommand(learner: Session, id: string, action: string, fields: object) {
  const response = await core.inject({ method: 'POST', url: `/api/enrollments/${id}/${action}`, headers: headers(learner),
    payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), ...fields } });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}
async function answer(learner: Session, id: string, assessmentId: string, value: unknown, mode = 'independent') {
  const issued = await coreCommand(learner, id, 'challenges', { episodeId: 'min', assessmentId, mode });
  return coreCommand(learner, id, 'answers', { challengeId: issued.challengeId, answer: value });
}
async function message(learner: Session, enrollmentId: string, workspace: string, content: string, episodeId = 'min', role = 'learner') {
  const messageId = randomUUID();
  const digest = (await db.query('SELECT c.digest FROM enrollments e JOIN course_releases c ON c.id=e.course_release_id WHERE e.id=$1', [enrollmentId])).rows[0].digest;
  await db.query('INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,$3,$4,$5)',
    [messageId, enrollmentId, role, content, JSON.stringify({ episodeId, courseDigest: digest })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId, actorId: learner.actor.id,
    actorKind: role === 'learner' ? 'learner' : 'agent', type: 'companion.requested', payload: { messageId, episodeId, hidden: 'EVENT_PAYLOAD_CANARY' }, idempotencyKey: randomUUID() }));
  return { messageId, eventId: event.id, cursor: event.cursor };
}
async function propose(id: string, sourceEventIds: string[], extra: Record<string, unknown> = {}) {
  return port.propose(serviceCredential, { workspaceId, enrollmentId: id, expectedRevision: await revision(id), idempotencyKey: randomUUID(),
    suggestion: { kind: 'explanation_style', value: 'step_by_step' }, sourceEventIds, ...extra });
}
async function decide(learner: Session, id: string, proposalId: string, action: string, extra: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: urlFor(id) + `/proposals/${proposalId}/decision`, headers: headers(learner),
    payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), action, ...extra } });
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use only a disposable TEST_DATABASE_URL; no database/mock fallback.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Disposable loopback test database required.');
  adminDb = createDatabase(url.toString());
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  db = createDatabase(url.toString());
  expect(await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)))).toContain('007_learner_model.sql');
  expect(await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)))).toEqual([]);
  // No edits to production server composition are required to test this new port.
  app = Fastify({ logger: false });
  app.register(cookie);
  const auth = authService(db, { origin, secureCookies: false, loginCodes: true });
  auth.routes(app);
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError
    ? reply.code(error.statusCode).send({ error: error.code }) : reply.code(500).send({ error: 'INTERNAL_ERROR' }));
  registerLearnerModelRoutes(app, db, auth);
  await app.ready();
  core = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceId, 'learner-model', 'Model tests', foreignWorkspaceId, 'foreign-model', 'Other workspace']);
  staff = await session(workspaceId, 'instructor'); service = await session(workspaceId, 'admin'); foreignStaff = await session(foreignWorkspaceId, 'admin');
  const author = await session(workspaceId, 'owner');
  const course = fixture();
  course.assessments[2]!.prompt = bankCanary;
  if (course.assessments[0]!.type === 'choice') course.assessments[0]!.grading.explanation = oracleCanary;
  course.objectives.push({ id: 'ungated', description: 'Unassessed example.', prerequisites: [] });
  course.chapters[0]!.episodes.push({ id: 'free', title: 'Unassessed', objectiveIds: ['ungated'], blocks: [{ id: 'free-text', type: 'text', markdown: 'An unassessed example.' }] });
  for (const [workspace, owner] of [[workspaceId, author], [foreignWorkspaceId, foreignStaff]] as const) {
    const imported = await core.inject({ method: 'POST', url: `/api/workspaces/${workspace}/releases`, headers: headers(owner), payload: course });
    expect(imported.statusCode, imported.body).toBe(200);
    const released = imported.json().id as string;
    expect((await core.inject({ method: 'POST', url: `/api/releases/${released}/publish`, headers: headers(owner) })).statusCode).toBe(200);
    if (workspace === workspaceId) releaseId = released; else foreignReleaseId = released;
  }
  port = createLearnerModelProposalPort(db, async (credential: string, scope) => {
    if (credential !== serviceCredential || scope.workspaceId !== workspaceId) throw new Error('Denied service credential');
    return { ...scope, actor: service.actor, serviceId: 'test-authorized-context-service' };
  });
}, 30000);
afterAll(async () => {
  await app?.close(); await core?.close(); await db?.end();
  if (adminDb) { await adminDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await adminDb.end(); }
});

describe('derived understanding and learner corrections', () => {
  it('requires independent current-course gate evidence; claims and review never award mastery', async () => {
    const { learner, id } = await fresh();
    expect((await model(learner, id)).understanding[0].status).toBe('needs_evidence');
    expect((await edit(learner, id)).statusCode).toBe(200);
    expect((await model(learner, id)).understanding[0].status).toBe('needs_evidence');
    await answer(learner, id, 'min-a', 'two');
    let view = await model(learner, id);
    // One recorded family is practice towards the gate, not a demonstration; no delayed check is scheduled yet.
    expect(view.understanding[0]).toMatchObject({ status: 'practicing', demonstrated: false, practiceAttempts: 1, independentFamilies: 1, requiredFamilies: 2, retention: 'not_scheduled' });
    await answer(learner, id, 'min-b', 4);
    view = await model(learner, id);
    expect(view.understanding[0]).toMatchObject({ status: 'demonstrated', independentFamilies: 2 });
    expect(view.understanding[0].evidenceRefs).toHaveLength(2);
    const before = (await db.query('SELECT id,result,independent,invalidated_at FROM evidence WHERE enrollment_id=$1 ORDER BY id', [id])).rows;
    expect((await edit(learner, id, profile('Actually I want to review the basics.'))).statusCode).toBe(200);
    expect((await model(learner, id)).understanding[0].status).toBe('demonstrated');
    expect((await db.query('SELECT id,result,independent,invalidated_at FROM evidence WHERE enrollment_id=$1 ORDER BY id', [id])).rows).toEqual(before);
    expect(JSON.stringify(view)).not.toMatch(/probability|diagnosis|retainedMastery/);
    expect(JSON.stringify(view)).not.toContain(bankCanary); expect(JSON.stringify(view)).not.toContain(oracleCanary);
    expect((await model(learner, id, '?episodeId=free')).understanding[0].status).toBe('not_assessed');
    await db.query('UPDATE evidence SET invalidated_at=now(),invalidation_reason=$2 WHERE id=$1', [before[0].id, 'Synthetic staff invalidation']);
    expect((await model(learner, id)).understanding[0]).toMatchObject({ status: 'practicing', demonstrated: false, practiceAttempts: 1 });
  });

  it('does not count practice, helped, failed, duplicate-family, or other-course evidence', async () => {
    const { learner, id } = await fresh();
    await answer(learner, id, 'min-a', 'five');
    await answer(learner, id, 'min-a', 'two');
    await answer(learner, id, 'min-b', 4, 'practice');
    expect((await model(learner, id)).understanding[0].independentFamilies).toBe(0);
    const other = await fresh();
    const challenge = await coreCommand(other.learner, other.id, 'challenges', { episodeId: 'min', assessmentId: 'min-a', mode: 'independent' });
    await coreCommand(other.learner, other.id, 'solution', { challengeId: challenge.challengeId });
    await coreCommand(other.learner, other.id, 'answers', { challengeId: challenge.challengeId, answer: 'two' });
    await answer(other.learner, other.id, 'min-b', 4);
    expect((await model(other.learner, other.id)).understanding[0].independentFamilies).toBe(1);
    await db.query("UPDATE attempts SET course_digest=repeat('0',64) WHERE enrollment_id=$1 AND assessment_id='min-b'", [other.id]);
    expect((await model(other.learner, other.id)).understanding[0].independentFamilies).toBe(0);
  });

  it('replays concurrent edits exactly, rejects changed intent/stale writes, and preserves append-only history', async () => {
    const { learner, id } = await fresh();
    const fields = { expectedRevision: await revision(id), idempotencyKey: randomUUID() };
    const responses = await Promise.all(Array.from({ length: 5 }, () => edit(learner, id, profile('Initial thoughts.'), fields)));
    expect(responses.every(row => row.statusCode === 200)).toBe(true);
    expect(new Set(responses.map(row => row.body)).size).toBe(1);
    expect((await edit(learner, id, profile('Different intent.'), fields)).json().error).toBe('IDEMPOTENCY_CONFLICT');
    expect((await edit(learner, id, profile(), { ...fields, idempotencyKey: randomUUID() })).json().error).toBe('STALE_REVISION');
    expect((await edit(learner, id, profile('Corrected thoughts.'))).statusCode).toBe(200);
    const changes = (await app.inject({ url: urlFor(id) + '/changes?limit=1', headers: headers(learner) })).json();
    expect(changes.items).toHaveLength(1); expect(changes.nextCursor).toBeTruthy();
    const previous = (await app.inject({ url: urlFor(id) + '/changes?before=' + changes.nextCursor, headers: headers(learner) })).json();
    expect(previous.items[0].data.profile.thoughts).toBe('Initial thoughts.');
    await expect(db.query("UPDATE learner_model_changes SET data='{}' WHERE enrollment_id=$1", [id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('DELETE FROM learner_model_changes WHERE enrollment_id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    expect(Number((await db.query('SELECT count(*) FROM learner_model_changes WHERE enrollment_id=$1', [id])).rows[0].count)).toBe(2);
  });
});

describe('authorized proposals, provenance and learner review', () => {
  it('keeps explicit empty preferences authoritative through identity edits and lets explicit profile updates replace them', async () => {
    const { learner, id } = await fresh();
    await coreCommand(learner, id, 'profile', { profile: { displayName: 'Before', goal: 'Earlier goal', pace: 'focused' } });
    expect((await model(learner, id)).selfReport.preferences).toMatchObject({ goal: 'Earlier goal', pace: 'focused' });
    const cleared = await app.inject({ method: 'POST', url: urlFor(id) + '/profile', headers: headers(learner), payload: {
      expectedRevision: await revision(id), idempotencyKey: randomUUID(), profile: { preferences: {}, priorKnowledge: [], thoughts: '' },
    } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    await coreCommand(learner, id, 'profile', { identityOnly: true, profile: { displayName: 'After', goal: 'Stale hidden value', pace: 'steady' } });
    expect((await model(learner, id)).selfReport.preferences).toEqual({});
    await coreCommand(learner, id, 'profile', { profile: { displayName: 'After', goal: 'Explicit new goal', pace: 'gentle' } });
    expect((await model(learner, id)).selfReport.preferences).toEqual({ goal: 'Explicit new goal', pace: 'gentle' });
    expect((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1', [id])).rows[0].count).toBe('0');
  });
  it('has no browser agent-creation route and denies forged authority, diagnoses and probability fields', async () => {
    const { learner, id } = await fresh();
    const source = await message(learner, id, workspaceId, 'Could I see a step-by-step example?');
    const payload = { workspaceId, enrollmentId: id, expectedRevision: await revision(id), idempotencyKey: randomUUID(), suggestion: { kind: 'pace', value: 'gentle' }, sourceEventIds: [source.eventId] };
    expect((await app.inject({ method: 'POST', url: urlFor(id) + '/proposals', headers: { ...headers(learner), 'x-actor-kind': 'agent' }, payload })).statusCode).toBe(404);
    await expect(port.propose('untrusted', payload)).rejects.toMatchObject({ code: 'LEARNER_MODEL_SERVICE_FORBIDDEN' });
    for (const suggestion of [{ kind: 'diagnosis', value: 'trait' }, { kind: 'pace', value: 'gentle', confidence: 0.99 }, { kind: 'review_objective', objectiveId: 'minimum', masteryProbability: 1 }]) {
      await expect(port.propose(serviceCredential, { ...payload, suggestion })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect((await edit(learner, id, profile(), { actorKind: 'agent' })).statusCode).toBe(400);
    const denied = createLearnerModelProposalPort(db, async () => ({ actor: learner.actor, workspaceId, enrollmentId: id, serviceId: 'not-a-staff-service' }));
    await expect(denied.propose(null, payload)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('records accept/correct/dispute without rewriting proposal provenance, manual preferences, or grades', async () => {
    const { learner, id } = await fresh();
    await answer(learner, id, 'min-a', 'two'); await answer(learner, id, 'min-b', 4);
    await edit(learner, id);
    const source = await message(learner, id, workspaceId, 'Please break this into steps.');
    const created = await propose(id, [source.eventId]);
    const providerScope = { workspaceId, enrollmentId: id, episodeId: 'min' };
    expect((await readLearnerModel(db, learner.actor, providerScope)).suggestions.items).toEqual([]);
    const grades = (await db.query('SELECT * FROM evidence WHERE enrollment_id=$1 ORDER BY id', [id])).rows;
    expect((await decide(learner, id, created.proposalId!, 'accept')).statusCode).toBe(200);
    let context = await readLearnerModel(db, learner.actor, providerScope);
    expect(context.suggestions.items[0]).toMatchObject({ status: 'accepted', suggestion: { kind: 'explanation_style', value: 'step_by_step' }, grantsMastery: false });
    const refs = context.suggestions.items[0]!.sourceEventRefs;
    expect(refs[0]).toMatchObject({ eventId: source.eventId, eventType: 'companion.requested' });
    expect(refs[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(context)).not.toContain('EVENT_PAYLOAD_CANARY');
    expect((await decide(learner, id, created.proposalId!, 'correct', { correction: { kind: 'explanation_style', value: 'concise' }, reason: 'I prefer concise examples.' })).statusCode).toBe(200);
    context = await readLearnerModel(db, learner.actor, providerScope);
    expect(context.suggestions.items[0]!.suggestion).toEqual({ kind: 'explanation_style', value: 'concise' });
    expect(context.suggestions.items[0]!.sourceEventRefs).toEqual(refs);
    expect(context.selfReport.preferences.explanationStyle).toBe('worked_example');
    expect((await decide(learner, id, created.proposalId!, 'dispute', { reason: 'This no longer represents what I want.' })).statusCode).toBe(200);
    expect((await readLearnerModel(db, learner.actor, providerScope)).suggestions.items).toEqual([]);
    const history = (await app.inject({ url: urlFor(id) + '/changes', headers: headers(learner) })).json();
    expect(history.items.slice(0, 4).map((row: { action: string }) => row.action)).toEqual(['proposal.disputed', 'proposal.corrected', 'proposal.accepted', 'proposal.created']);
    expect((await db.query('SELECT * FROM evidence WHERE enrollment_id=$1 ORDER BY id', [id])).rows).toEqual(grades);
    expect((await model(learner, id)).understanding[0].status).toBe('demonstrated');
    await expect(db.query("UPDATE learner_model_sources SET event_digest=repeat('0',64) WHERE proposal_id=$1", [created.proposalId])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query("UPDATE learner_model_proposals SET suggestion='{}' WHERE id=$1", [created.proposalId])).rejects.toMatchObject({ code: '23514' });
  });

  it('binds source events/proposals to enrollment and workspace and rejects changed source content', async () => {
    const a = await fresh(), b = await fresh(), foreign = await fresh(foreignWorkspaceId, foreignReleaseId);
    const own = await message(a.learner, a.id, workspaceId, 'Own question');
    const other = await message(b.learner, b.id, workspaceId, 'OTHER_ENROLLMENT_CANARY');
    const remote = await message(foreign.learner, foreign.id, foreignWorkspaceId, 'OTHER_WORKSPACE_CANARY');
    for (const source of [other, remote]) await expect(propose(a.id, [source.eventId])).rejects.toMatchObject({ code: 'SOURCE_EVENT_OUT_OF_SCOPE' });
    const created = await propose(a.id, [own.eventId]);
    expect((await decide(b.learner, b.id, created.proposalId!, 'accept')).json().error).toBe('PROPOSAL_NOT_FOUND');
    await db.query("UPDATE learning_events SET payload=payload || '{\"changed\":true}'::jsonb WHERE id=$1", [own.eventId]);
    expect((await decide(a.learner, a.id, created.proposalId!, 'accept')).json().error).toBe('PROPOSAL_SOURCE_CHANGED');
    expect((await decide(a.learner, a.id, created.proposalId!, 'dispute')).statusCode).toBe(200);
    const all = JSON.stringify(await model(a.learner, a.id));
    expect(all).not.toContain('OTHER_ENROLLMENT_CANARY'); expect(all).not.toContain('OTHER_WORKSPACE_CANARY');
  });

  it('revalidates service authorization on retries and makes review replays actor/intent bound', async () => {
    const { learner, id } = await fresh();
    const source = await message(learner, id, workspaceId, 'Scoped source');
    const input = { workspaceId, enrollmentId: id, expectedRevision: await revision(id), idempotencyKey: randomUUID(), suggestion: { kind: 'pace', value: 'gentle' }, sourceEventIds: [source.eventId] };
    const created = await port.propose(serviceCredential, input);
    expect(await port.propose(serviceCredential, input)).toEqual(created);
    const differentService = createLearnerModelProposalPort(db, async () => ({ actor: service.actor, workspaceId, enrollmentId: id, serviceId: 'different-authorized-service' }));
    await expect(differentService.propose(null, input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(port.propose(serviceCredential, { ...input, suggestion: { kind: 'pace', value: 'focused' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const key = randomUUID(), expectedRevision = await revision(id);
    const results = await Promise.all([1, 2].map(() => decide(learner, id, created.proposalId!, 'accept', { expectedRevision, idempotencyKey: key })));
    expect(results.every(result => result.statusCode === 200)).toBe(true); expect(results[0]!.body).toBe(results[1]!.body);
    expect((await decide(learner, id, created.proposalId!, 'dispute', { expectedRevision, idempotencyKey: randomUUID() })).json().error).toBe('STALE_REVISION');
    await db.query("UPDATE memberships SET role='observer' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, service.actor.id]);
    try { await expect(port.propose(serviceCredential, input)).rejects.toMatchObject({ code: 'FORBIDDEN' }); }
    finally { await db.query("UPDATE memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, service.actor.id]); }
  });

  it('caps pending proposals and rejects excessive or duplicate provenance references', async () => {
    const { learner, id } = await fresh();
    const source = await message(learner, id, workspaceId, 'Bounded proposal source');
    await expect(propose(id, [source.eventId, source.eventId])).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(propose(id, Array.from({ length: 9 }, () => randomUUID()))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const created = [];
    for (let n = 0; n < 20; n++) created.push(await propose(id, [source.eventId]));
    const before = await revision(id);
    await expect(propose(id, [source.eventId])).rejects.toMatchObject({ code: 'LEARNER_MODEL_PROPOSAL_LIMIT' });
    expect(await revision(id)).toBe(before);
    expect((await decide(learner, id, created[0]!.proposalId!, 'dispute')).statusCode).toBe(200);
    await expect(propose(id, [source.eventId])).resolves.toMatchObject({ grantsMastery: false });
  });
});

describe('bounded private context and retrieval', () => {
  it('authorizes learner/staff reads, denies other learners and foreign staff, and requires CSRF for edits', async () => {
    const a = await fresh(), b = await fresh();
    for (const endpoint of ['', '/history', '/changes']) {
      expect((await app.inject({ url: urlFor(a.id) + endpoint })).statusCode).toBe(401);
      expect((await app.inject({ url: urlFor(a.id) + endpoint, headers: headers(b.learner) })).statusCode).toBe(404);
      expect((await app.inject({ url: urlFor(a.id) + endpoint, headers: headers(foreignStaff) })).statusCode).toBe(403);
      expect((await app.inject({ url: urlFor(a.id) + endpoint, headers: headers(staff) })).statusCode).toBe(200);
    }
    expect((await edit(staff, a.id)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: urlFor(a.id) + '/profile', headers: { cookie: a.learner.cookie, origin }, payload: { expectedRevision: 1, idempotencyKey: randomUUID(), profile: profile() } })).json().error).toBe('CSRF_REJECTED');
    await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, b.learner.actor.id]);
    await expect(readLearnerModel(db, b.learner.actor, { workspaceId, enrollmentId: b.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('minimizes provider context and never follows cross-enrollment, workspace, scope or assistant canaries', async () => {
    const a = await fresh(), b = await fresh(), foreign = await fresh(foreignWorkspaceId, foreignReleaseId);
    await edit(a.learner, a.id, { ...profile('PRIVATE_THOUGHTS_CANARY'), priorKnowledge: [{ objectiveId: 'minimum', statement: 'Own current-scope claim' }, { objectiveId: 'maximum', statement: 'OTHER_SCOPE_CLAIM_CANARY' }] });
    const own = await message(a.learner, a.id, workspaceId, 'My own needle question');
    const other = await message(b.learner, b.id, workspaceId, 'OTHER_LEARNER_CANARY');
    await message(a.learner, a.id, workspaceId, 'OTHER_EPISODE_CANARY', 'max');
    await message(a.learner, a.id, workspaceId, 'ASSISTANT_CANARY', 'min', 'assistant');
    await message(foreign.learner, foreign.id, foreignWorkspaceId, 'FOREIGN_WORKSPACE_CANARY');
    await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId: a.id, actorKind: 'learner', actorId: a.learner.actor.id, type: 'companion.requested', payload: { messageId: other.messageId }, idempotencyKey: randomUUID() }));
    const result = await readLearnerModel(db, a.learner.actor, { workspaceId, enrollmentId: a.id, episodeId: 'min' });
    const serialized = JSON.stringify(result);
    for (const canary of ['PRIVATE_THOUGHTS_CANARY', 'OTHER_SCOPE_CLAIM_CANARY', 'OTHER_LEARNER_CANARY', 'FOREIGN_WORKSPACE_CANARY', 'ASSISTANT_CANARY', 'My own needle question', bankCanary, oracleCanary]) expect(serialized).not.toContain(canary);
    expect(result.selfReport.priorKnowledge).toEqual([{ objectiveId: 'minimum', statement: 'Own current-scope claim' }]);
    await expect(readLearnerModel(db, a.learner.actor, { workspaceId: foreignWorkspaceId, enrollmentId: a.id })).rejects.toMatchObject({ code: 'ENROLLMENT_NOT_FOUND' });
    await expect(readLearnerModel(db, a.learner.actor, { workspaceId, enrollmentId: b.id })).rejects.toMatchObject({ code: 'ENROLLMENT_NOT_FOUND' });
    const history = (await app.inject({ url: urlFor(a.id) + '/history?episodeId=min&q=needle', headers: headers(a.learner) })).json();
    expect(history.items).toHaveLength(1); expect(history.items[0]).toMatchObject({ messageId: own.messageId, text: 'My own needle question' });
    for (const canary of ['OTHER_LEARNER_CANARY', 'OTHER_EPISODE_CANARY', 'FOREIGN_WORKSPACE_CANARY', 'ASSISTANT_CANARY', 'EVENT_PAYLOAD_CANARY']) expect(JSON.stringify(history)).not.toContain(canary);
    const retrieved = await readLearnerModel(db, a.learner.actor, { workspaceId, enrollmentId: a.id, episodeId: 'min' }, { retrieval: { q: 'needle', kind: 'questions', limit: 1 } });
    expect(retrieved).toHaveProperty('history.items', history.items);
    for (const canary of ['PRIVATE_THOUGHTS_CANARY', 'OTHER_SCOPE_CLAIM_CANARY', 'OTHER_LEARNER_CANARY', 'FOREIGN_WORKSPACE_CANARY', 'ASSISTANT_CANARY', bankCanary, oracleCanary]) expect(JSON.stringify(retrieved)).not.toContain(canary);
    for (const retrieval of [{ q: '', limit: 1 }, { q: 'needle', limit: 6 }]) await expect(readLearnerModel(db, a.learner.actor,
      { workspaceId, enrollmentId: a.id, episodeId: 'min' }, { retrieval })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('keeps the same learner\'s other enrollment separate and returns bounded matching snippets', async () => {
    const { learner, id } = await fresh();
    const imported = await core.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/releases`, headers: headers(service), payload: { ...fixture(), version: '1.0.1' } });
    expect(imported.statusCode, imported.body).toBe(200);
    const released = imported.json().id;
    expect((await core.inject({ method: 'POST', url: `/api/releases/${released}/publish`, headers: headers(service) })).statusCode).toBe(200);
    const enrolled = await core.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId: released } });
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const otherId = enrolled.json().id;
    await edit(learner, otherId, { ...profile(), priorKnowledge: [{ objectiveId: 'minimum', statement: 'OTHER_OWN_ENROLLMENT_CLAIM_CANARY' }] });
    const other = await message(learner, otherId, workspaceId, 'OTHER_OWN_ENROLLMENT_CANARY needle');
    await answer(learner, otherId, 'min-a', 'two'); await answer(learner, otherId, 'min-b', 4);
    const own = await message(learner, id, workspaceId, 'x'.repeat(1400) + ' bounded needle ' + 'x'.repeat(1400));
    // An incorrect event reference must not follow even another enrollment of the same user.
    await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId: id, actorKind: 'learner', actorId: learner.actor.id,
      type: 'companion.requested', payload: { messageId: other.messageId }, idempotencyKey: randomUUID() }));
    const retrieved = await readLearnerModel(db, learner.actor, { workspaceId, enrollmentId: id, episodeId: 'min' }, { retrieval: { q: 'needle', limit: 5 } });
    if (!('history' in retrieved)) throw new Error('Explicit retrieval missing');
    expect(retrieved.history.items).toHaveLength(1);
    expect(retrieved.history.items[0]).toMatchObject({ messageId: own.messageId });
    expect(retrieved.history.items[0]!.text).toContain('bounded needle');
    expect(retrieved.history.items[0]!.text.length).toBeLessThanOrEqual(1000);
    expect(retrieved.understanding[0]!.status).toBe('needs_evidence');
    expect(JSON.stringify(retrieved)).not.toContain('OTHER_OWN_ENROLLMENT');
    await expect(propose(id, [other.eventId])).rejects.toMatchObject({ code: 'SOURCE_EVENT_OUT_OF_SCOPE' });
    expect((await readLearnerModel(db, learner.actor, { workspaceId, enrollmentId: otherId, episodeId: 'min' })).understanding[0]!.status).toBe('demonstrated');
  });

  it('returns only submitted-question/evidence metadata, never raw responses, graders or an unissued bank', async () => {
    const { learner, id } = await fresh();
    await answer(learner, id, 'min-a', 'two');
    const history = (await app.inject({ url: urlFor(id) + '/history?episodeId=min&kind=evidence', headers: headers(learner) })).json();
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ assessmentId: 'min-a', passed: true, text: 'Which is smaller?' });
    expect(history.items[0].evidenceRefs[0]).toMatchObject({ objectiveId: 'minimum', independent: true, invalidated: false });
    expect(JSON.stringify(history)).not.toContain('correctOptionId'); expect(JSON.stringify(history)).not.toContain(oracleCanary); expect(JSON.stringify(history)).not.toContain(bankCanary);
    expect(history.items[0]).not.toHaveProperty('response');
    await db.query("UPDATE assessment_challenges SET episode_id='max' WHERE enrollment_id=$1", [id]);
    expect((await app.inject({ url: urlFor(id) + '/history?episodeId=min&kind=evidence', headers: headers(learner) })).json().items).toEqual([]);
  });

  it('bounds history windows, paginates empty search windows, and treats search text literally', async () => {
    const { learner, id } = await fresh();
    const digest = (await model(learner, id)).courseDigest;
    await db.query(`WITH messages AS (INSERT INTO companion_messages(id,enrollment_id,role,content,context)
      SELECT gen_random_uuid(),$1,'learner','bounded question '||n,jsonb_build_object('episodeId','min','courseDigest',$2::text) FROM generate_series(1,205) n RETURNING id)
      INSERT INTO learning_events(id,workspace_id,enrollment_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key)
      SELECT gen_random_uuid(),$3,$1,$4,'learner','companion.requested',jsonb_build_object('messageId',id),gen_random_uuid(),gen_random_uuid()::text FROM messages`, [id, digest, workspaceId, learner.actor.id]);
    const first = (await app.inject({ url: urlFor(id) + '/history?episodeId=min&q=does-not-exist', headers: headers(learner) })).json();
    expect(first).toMatchObject({ items: [], scannedEvents: 200, maxScannedEvents: 200 }); expect(first.nextCursor).toBeTruthy();
    const last = (await app.inject({ url: urlFor(id) + '/history?episodeId=min&q=does-not-exist&before=' + first.nextCursor, headers: headers(learner) })).json();
    expect(last).toMatchObject({ items: [], scannedEvents: 5, nextCursor: null });
    const page = (await app.inject({ url: urlFor(id) + '/history?episodeId=min&limit=3', headers: headers(learner) })).json();
    const next = (await app.inject({ url: urlFor(id) + '/history?episodeId=min&limit=3&before=' + page.nextCursor, headers: headers(learner) })).json();
    expect(page.items).toHaveLength(3); expect(next.items).toHaveLength(3);
    expect(next.items.every((item: { eventId: string }) => !page.items.some((old: { eventId: string }) => old.eventId === item.eventId))).toBe(true);
    expect((await app.inject({ url: urlFor(id) + '/history?q=%25', headers: headers(learner) })).json().items).toEqual([]);
    for (const query of ['limit=0', 'limit=21', 'before=-1', 'before=hello', 'before=NaN', 'before=0', 'before=9223372036854775808', 'q=' + 'a'.repeat(101), 'actorKind=agent', 'episodeId=missing', 'episodeId=min&objectiveId=maximum']) {
      expect([400, 404]).toContain((await app.inject({ url: urlFor(id) + '/history?' + query, headers: headers(learner) })).statusCode);
    }
    expect((await app.inject({ url: urlFor(id) + '/changes?before=hello', headers: headers(learner) })).statusCode).toBe(400);
  });

  it('rolls back profile, revisions, receipts and history if appending the event fails', async () => {
    const { learner, id } = await fresh();
    const before = await model(learner, id);
    await db.query(`CREATE FUNCTION reject_learner_model_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='learner_model.profile.edited' THEN RAISE EXCEPTION 'synthetic append failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_learner_model_event BEFORE INSERT ON learning_events FOR EACH ROW EXECUTE FUNCTION reject_learner_model_event()`);
    try { expect((await edit(learner, id, profile('Must roll back.'))).statusCode).toBe(500); }
    finally { await db.query('DROP TRIGGER reject_learner_model_event ON learning_events; DROP FUNCTION reject_learner_model_event()'); }
    expect(await model(learner, id)).toEqual(before);
    expect((await db.query('SELECT 1 FROM learner_model_changes WHERE enrollment_id=$1', [id])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM command_receipts WHERE enrollment_id=$1', [id])).rows).toHaveLength(0);
  });
});
