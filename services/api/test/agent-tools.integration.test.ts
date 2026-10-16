import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueLoginCode, type Actor } from '../src/auth.js';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { appendEvent } from '../src/events.js';
import { createServer } from '../src/server.js';
import { AGENT_GRANT_LIMITS } from '../src/agent-tools-routes.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { fixture } from './fixture.js';

const origin = 'http://localhost:4310';
const schema = `course_agent_tools_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID();
const oracleCanary = `ORACLE_${randomUUID()}`, thoughtsCanary = `THOUGHTS_${randomUUID()}`;
let db: Database, app: FastifyInstance, releaseId: string, foreignReleaseId: string, owner: Session;
type Session = { actor: Actor; cookie: string; csrf: string };
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function session(workspace: string, role = 'learner'): Promise<Session> {
  const actor = { id: randomUUID(), displayName: 'Synthetic person' };
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES ($1,$2,$3)', [actor.id, `agent-tools-test:${actor.id}`, actor.displayName]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspace, actor.id, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  expect(login.statusCode, login.body).toBe(200);
  return { actor, csrf: login.json().csrfToken, cookie: login.cookies.map(row => `${row.name}=${row.value}`).join('; ') };
}
async function enroll(learner: Session, release = releaseId) {
  const response = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId: release } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().id as string;
}
async function fresh(workspace = workspaceId, release = releaseId) {
  const learner = await session(workspace);
  return { learner, id: await enroll(learner, release) };
}
const revision = async (id: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
async function command(learner: Session, id: string, action: string, fields: object) {
  const response = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/${action}`, headers: headers(learner),
    payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), ...fields } });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}
async function answer(learner: Session, id: string, assessmentId: string, value: unknown) {
  const issued = await command(learner, id, 'challenges', { episodeId: 'min', assessmentId, mode: 'independent' });
  return command(learner, id, 'answers', { challengeId: issued.challengeId, answer: value });
}
async function message(learner: Session, enrollmentId: string, content: string, workspace = workspaceId) {
  const messageId = randomUUID();
  const digest = (await db.query('SELECT c.digest FROM enrollments e JOIN course_releases c ON c.id=e.course_release_id WHERE e.id=$1', [enrollmentId])).rows[0].digest;
  await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)",
    [messageId, enrollmentId, content, JSON.stringify({ episodeId: 'min', courseDigest: digest })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId, actorId: learner.actor.id,
    actorKind: 'learner', type: 'companion.requested', payload: { messageId, episodeId: 'min' }, idempotencyKey: randomUUID() }));
  return { messageId, eventId: event.id };
}
const grants = (who: Session, id: string) => app.inject({ url: `/api/enrollments/${id}/agent-grants`, headers: headers(who) });
const create = (who: Session, id: string, payload: object) => app.inject({ method: 'POST', url: `/api/enrollments/${id}/agent-grants`, headers: headers(who), payload });
async function grant(who: Session, id: string, scopes = ['context', 'profile', 'evidence', 'history', 'propose_intervention'], expiresInDays = 7) {
  const response = await create(who, id, { label: 'My desktop assistant', scopes, expiresInDays });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json();
  expect(body.token).toMatch(/^ccat_[A-Za-z0-9_-]{43}$/);
  return { token: body.token as string, grantId: body.grant.id as string };
}
const revoke = (who: Session, id: string, grantId: string) => app.inject({ method: 'POST', url: `/api/enrollments/${id}/agent-grants/${grantId}/revoke`, headers: headers(who) });
const tool = (token: string, name: string, args: object = {}, extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/api/agent-tools/v1/tools/${name}`, headers: { ...bearer(token), ...extra }, payload: args });
const mcp = (token: string, body: unknown) => app.inject({ method: 'POST', url: '/api/agent-tools/mcp', headers: bearer(token), payload: body as object });
async function propose(token: string, id: string, sourceEventIds: string[], idempotencyKey = randomUUID()) {
  return tool(token, 'propose_intervention', { expectedRevision: await revision(id), idempotencyKey, suggestion: { kind: 'explanation_style', value: 'step_by_step' }, sourceEventIds });
}
/** Every application table's rows that contain `marker` as text. */
async function tablesContaining(marker: string) {
  const tables = (await db.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).rows;
  const hits: string[] = [];
  for (const { name } of tables) if ((await db.query(`SELECT 1 FROM "${name}" t WHERE t::text LIKE $1 LIMIT 1`, [`%${marker}%`])).rowCount) hits.push(name);
  return hits;
}
/** What grading and progress rest on, to show the tools leave it untouched. */
async function gradingState(id: string) {
  const q = async (sql: string) => (await db.query(sql, [id])).rows;
  return { attempts: await q('SELECT id,result FROM attempts WHERE enrollment_id=$1 ORDER BY id'), evidence: await q('SELECT id,result,invalidated_at FROM evidence WHERE enrollment_id=$1 ORDER BY id'),
    progress: await q('SELECT episode_id,state,completed_block_ids FROM episode_progress WHERE enrollment_id=$1 ORDER BY episode_id'),
    retention: await q('SELECT objective_id,due_at FROM retention_schedules WHERE enrollment_id=$1 ORDER BY objective_id') };
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceId, 'agent-tools', 'Agent tools', foreignWorkspaceId, 'agent-tools-foreign', 'Other']);
  owner = await session(workspaceId, 'owner');
  const foreignOwner = await session(foreignWorkspaceId, 'owner');
  const course = fixture();
  if (course.assessments[0]!.type === 'choice') course.assessments[0]!.grading.explanation = oracleCanary;
  for (const [workspace, author] of [[workspaceId, owner], [foreignWorkspaceId, foreignOwner]] as const) {
    const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace}/releases`, headers: headers(author), payload: course });
    expect(imported.statusCode, imported.body).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/releases/${imported.json().id}/publish`, headers: headers(author) })).statusCode).toBe(200);
    if (workspace === workspaceId) releaseId = imported.json().id; else foreignReleaseId = imported.json().id;
  }
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

describe('learner grants', () => {
  it('shows the token once, keeps only its digest and lists grants without secrets', async () => {
    const { learner, id } = await fresh();
    const { token, grantId } = await grant(learner, id);
    const listed = await grants(learner, id);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().grants).toEqual([expect.objectContaining({ id: grantId, label: 'My desktop assistant', state: 'active',
      scopes: ['context', 'profile', 'evidence', 'history', 'propose_intervention'] })]);
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain('token');
    // Only the digest is stored: the token appears in no table, event or receipt.
    expect((await tool(token, 'get_context')).statusCode).toBe(200);
    expect(await tablesContaining(token.slice(5))).toEqual([]);
    const events = (await db.query("SELECT event_type,payload FROM learning_events WHERE enrollment_id=$1 AND event_type LIKE 'agent_grant.%'", [id])).rows;
    expect(events).toEqual([{ event_type: 'agent_grant.created', payload: expect.objectContaining({ grantId }) }]);
    // The learner's own export lists the grant and its calls, never a token.
    const exported = await app.inject({ url: `/api/enrollments/${id}/export`, headers: headers(learner) });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).toContain(grantId); expect(exported.body).not.toContain(token);
  });

  it('refuses staff, peers and other workspaces, and bounds grants', async () => {
    const { learner, id } = await fresh();
    const peer = await session(workspaceId), foreign = await session(foreignWorkspaceId);
    for (const who of [owner, await session(workspaceId, 'admin'), await session(workspaceId, 'instructor'), peer, foreign]) {
      expect((await create(who, id, { label: 'x', scopes: ['context'], expiresInDays: 1 })).statusCode).toBe(404);
      expect((await grants(who, id)).statusCode).toBe(404);
    }
    const { grantId } = await grant(learner, id, ['context']);
    expect((await revoke(owner, id, grantId)).statusCode).toBe(404);
    expect((await revoke(peer, id, grantId)).statusCode).toBe(404);
    for (const payload of [{ label: 'x', scopes: ['context'], expiresInDays: AGENT_GRANT_LIMITS.maxDays + 1 }, { label: 'x', scopes: ['grading'], expiresInDays: 1 },
      { label: 'x', scopes: [], expiresInDays: 1 }, { label: '', scopes: ['context'], expiresInDays: 1 }, { label: 'x', scopes: ['context', 'context'], expiresInDays: 1 },
      { label: 'x', scopes: ['context'], expiresInDays: 1, enrollmentId: randomUUID() }])
      expect((await create(learner, id, payload)).statusCode).toBe(400);
    // A missing CSRF token is refused like every other learner command.
    expect((await app.inject({ method: 'POST', url: `/api/enrollments/${id}/agent-grants`, headers: { cookie: learner.cookie, origin },
      payload: { label: 'x', scopes: ['context'], expiresInDays: 1 } })).statusCode).toBe(403);
    for (let i = 1; i < AGENT_GRANT_LIMITS.activeGrants; i++) await grant(learner, id, ['context']);
    expect((await create(learner, id, { label: 'one too many', scopes: ['context'], expiresInDays: 1 })).json().error).toBe('AGENT_GRANT_LIMIT');
    expect((await revoke(learner, id, grantId)).statusCode).toBe(200);
    await grant(learner, id, ['context']);
  });
});

describe('agent tools', () => {
  it('reads the minimal projection: context, profile, evidence and history, never keys or private notes', async () => {
    const { learner, id } = await fresh();
    await app.inject({ method: 'POST', url: `/api/enrollments/${id}/learner-model/profile`, headers: headers(learner), payload: { expectedRevision: await revision(id),
      idempotencyKey: randomUUID(), profile: { preferences: { pace: 'steady' }, priorKnowledge: [{ objectiveId: 'minimum', statement: 'I know some of this.' }], thoughts: thoughtsCanary } } });
    await answer(learner, id, 'min-a', 'two');
    const asked = await message(learner, id, 'How do I compare negative numbers?');
    const { token } = await grant(learner, id);
    const context = await tool(token, 'get_context');
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json().result).toMatchObject({ course: { courseKey: 'ordering', title: 'Ordering values' }, enrollment: { id, status: 'active' },
      currentEpisode: { id: 'min', objectives: [{ id: 'minimum', description: 'Find a minimum.' }] } });
    const profile = (await tool(token, 'get_profile', { episodeId: 'min' })).json().result;
    expect(profile.selfReport.priorKnowledge).toEqual([{ objectiveId: 'minimum', statement: 'I know some of this.' }]);
    expect(profile).not.toHaveProperty('understanding');
    const evidence = (await tool(token, 'get_evidence')).json().result;
    expect(evidence.understanding[0]).toMatchObject({ objectiveId: 'minimum', status: 'practicing' });
    expect(evidence.understanding[0].evidenceRefs).toHaveLength(1);
    const history = (await tool(token, 'get_history', { q: 'negative', limit: 5 })).json().result;
    expect(history.items).toEqual([expect.objectContaining({ messageId: asked.messageId, text: 'How do I compare negative numbers?' })]);
    const all = JSON.stringify([context.json(), profile, evidence, (await tool(token, 'get_history')).json()]);
    for (const secret of [thoughtsCanary, oracleCanary, 'correctOptionId', 'Minimum of 4 and 9?', '"grading"', 'explanation":"2 is']) expect(all).not.toContain(secret);
    // What the learner excluded from AI context stays out.
    const evidenceId = (await db.query('SELECT id FROM evidence WHERE enrollment_id=$1', [id])).rows[0].id;
    await command(learner, id, `learner-model/evidence/${evidenceId}/control`, { action: 'exclude' });
    await command(learner, id, 'companion/context-exclusions', { messageId: asked.messageId, excluded: true });
    expect((await tool(token, 'get_evidence')).json().result.understanding[0].evidenceRefs).toEqual([]);
    expect((await tool(token, 'get_history', { q: 'negative' })).json().result.items).toEqual([]);
    expect(JSON.stringify((await tool(token, 'get_history', { kind: 'evidence' })).json())).not.toContain(evidenceId);
    // Arguments cannot pick another enrollment, workspace or user.
    for (const args of [{ enrollmentId: randomUUID() }, { workspaceId }, { userId: learner.actor.id }]) expect((await tool(token, 'get_evidence', args)).statusCode).toBe(400);
    expect((await tool(token, 'get_profile', { episodeId: 'missing' })).statusCode).toBe(404);
    expect((await tool(token, 'grade_answer')).statusCode).toBe(404);
  });

  it('never crosses enrollments: the same learner\'s other enrollment, other learners and other workspaces', async () => {
    const { learner, id } = await fresh();
    const other = await enroll(learner, (await (async () => {
      const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/releases`, headers: headers(owner), payload: { ...fixture(), id: 'ordering-two' } });
      expect(imported.statusCode, imported.body).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/releases/${imported.json().id}/publish`, headers: headers(owner) })).statusCode).toBe(200);
      return imported.json().id as string;
    })()));
    const hidden = `OTHER_ENROLLMENT_${randomUUID()}`;
    const otherMessage = await message(learner, other, hidden);
    const peer = await fresh();
    await message(peer.learner, peer.id, `PEER_${hidden}`);
    const foreign = await fresh(foreignWorkspaceId, foreignReleaseId);
    await message(foreign.learner, foreign.id, `FOREIGN_${hidden}`, foreignWorkspaceId);
    const { token } = await grant(learner, id);
    const read = JSON.stringify(await Promise.all(['get_context', 'get_profile', 'get_evidence', 'get_history'].map(async name => (await tool(token, name)).json())));
    expect(read).not.toContain(hidden);
    expect(read).not.toContain(other);
    // An event of another enrollment cannot be cited, even the same learner's own.
    expect((await propose(token, id, [otherMessage.eventId])).json().error).toBe('SOURCE_EVENT_OUT_OF_SCOPE');
    const own = await message(learner, id, 'An own question.');
    const peerToken = (await grant(peer.learner, peer.id)).token;
    expect((await tool(peerToken, 'propose_intervention', { expectedRevision: await revision(peer.id), idempotencyKey: randomUUID(),
      suggestion: { kind: 'pace', value: 'gentle' }, sourceEventIds: [own.eventId] })).json().error).toBe('SOURCE_EVENT_OUT_OF_SCOPE');
  });

  it('enforces scopes on HTTP and MCP', async () => {
    const { learner, id } = await fresh();
    const { token } = await grant(learner, id, ['context']);
    expect((await tool(token, 'get_context')).statusCode).toBe(200);
    for (const name of ['get_profile', 'get_evidence', 'get_history']) expect((await tool(token, name)).json()).toEqual({ error: 'AGENT_SCOPE_MISSING' });
    const event = await message(learner, id, 'q');
    expect((await propose(token, id, [event.eventId])).statusCode).toBe(403);
    const listed = (await mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual(['get_context']);
    const denied = (await mcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_profile', arguments: {} } })).json();
    expect(denied.result).toMatchObject({ isError: true, structuredContent: { error: 'AGENT_SCOPE_MISSING' } });
    expect((await db.query('SELECT tool,outcome FROM agent_tool_calls WHERE enrollment_id=$1 AND outcome<>$2 ORDER BY created_at', [id, 'OK'])).rows)
      .toEqual(expect.arrayContaining([{ tool: 'get_profile', outcome: 'AGENT_SCOPE_MISSING' }, { tool: 'propose_intervention', outcome: 'AGENT_SCOPE_MISSING' }]));
  });

  it('speaks minimal MCP: initialize, notifications, tools/list and tools/call', async () => {
    const { learner, id } = await fresh();
    const { token } = await grant(learner, id);
    const init = (await mcp(token, { jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'course-core-agent-tools' } });
    expect((await mcp(token, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
    const tools = (await mcp(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['get_context', 'get_profile', 'get_evidence', 'get_history', 'propose_intervention']);
    expect(tools.find((t: { name: string }) => t.name === 'propose_intervention').annotations.readOnlyHint).toBe(false);
    const called = (await mcp(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_context', arguments: {} } })).json();
    expect(called.result.isError).toBe(false);
    expect(JSON.parse(called.result.content[0].text)).toEqual(called.result.structuredContent);
    expect(called.result.structuredContent.enrollment.id).toBe(id);
    expect((await mcp(token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })).json().error.code).toBe(-32602);
    expect((await mcp(token, { jsonrpc: '2.0', id: 5, method: 'resources/list' })).json().error.code).toBe(-32601);
    expect((await mcp(token, [{ jsonrpc: '2.0', id: 6, method: 'ping' }])).json().error.code).toBe(-32600);
    expect((await mcp(token, { jsonrpc: '2.0', id: 7, method: 'ping' })).json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect((await app.inject({ url: '/api/agent-tools/mcp', headers: bearer(token) })).statusCode).toBe(405);
    const unauthorized = await app.inject({ method: 'POST', url: '/api/agent-tools/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain('Bearer');
  });

  it('authenticates only by bearer token, and the token authenticates nothing else', async () => {
    const { learner, id } = await fresh();
    const { token } = await grant(learner, id);
    // A browser session is not an agent grant.
    expect((await app.inject({ method: 'POST', url: '/api/agent-tools/v1/tools/get_context', headers: headers(learner), payload: {} })).statusCode).toBe(401);
    for (const url of [`/api/agent-tools/v1/tools/get_context?access_token=${token}`, `/api/agent-tools/v1/tools/get_context?token=${token}`])
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    for (const value of [token, `Basic ${token}`, `Bearer ${token}x`, `Bearer ccat_${'A'.repeat(43)}`, `bearer ${token}`])
      expect((await app.inject({ method: 'POST', url: '/api/agent-tools/v1/tools/get_context', headers: { authorization: value }, payload: {} })).json()).toEqual({ error: 'AGENT_TOKEN_INVALID' });
    // The rest of the API never accepts the token.
    for (const url of [`/api/enrollments/${id}`, `/api/enrollments/${id}/learner-model`, `/api/enrollments/${id}/agent-grants`, '/api/workspaces'])
      expect((await app.inject({ url, headers: bearer(token) })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/enrollments/${id}/agent-grants`, headers: { ...bearer(token), origin },
      payload: { label: 'self-made', scopes: ['context'], expiresInDays: 1 } })).statusCode).toBe(401);
  });

  it('stops at once on revocation, expiry, removed membership and erasure', async () => {
    const { learner, id } = await fresh();
    const first = await grant(learner, id), second = await grant(learner, id), third = await grant(learner, id);
    expect((await tool(first.token, 'get_context')).statusCode).toBe(200);
    expect((await revoke(learner, id, first.grantId)).json().grant).toMatchObject({ state: 'revoked', revokedReason: 'learner' });
    expect((await revoke(learner, id, first.grantId)).statusCode).toBe(200);
    for (const name of ['get_context', 'get_profile', 'get_evidence', 'get_history']) expect((await tool(first.token, name)).statusCode).toBe(401);
    expect((await mcp(first.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(401);
    expect((await tool(second.token, 'get_context')).statusCode).toBe(200);
    // Expiry.
    await db.query("UPDATE agent_tool_grants SET created_at=clock_timestamp()-interval '3 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [second.grantId]);
    expect((await tool(second.token, 'get_context')).json()).toEqual({ error: 'AGENT_TOKEN_INVALID' });
    expect((await grants(learner, id)).json().grants.find((g: { id: string }) => g.id === second.grantId).state).toBe('expired');
    // Erasure revokes every grant of the enrollment.
    const erased = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/erase`, headers: headers(learner),
      payload: { confirmation: `ERASE ${id.slice(0, 8)}`, reason: 'Synthetic learner asked for erasure.' } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts.agentToolGrants).toBe(3);
    expect((await tool(third.token, 'get_context')).statusCode).toBe(401);
    expect((await db.query('SELECT DISTINCT label,revoked_reason IS NOT NULL AS revoked FROM agent_tool_grants WHERE enrollment_id=$1', [id])).rows).toEqual([{ label: '[erased]', revoked: true }]);
    // Removing the learner from the workspace ends their grants too.
    const other = await fresh();
    const kept = await grant(other.learner, other.id);
    await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, other.learner.actor.id]);
    expect((await tool(kept.token, 'get_context')).statusCode).toBe(401);
  });

  it('rate-limits each grant', async () => {
    const { learner, id } = await fresh();
    const { token, grantId } = await grant(learner, id);
    await db.query(`INSERT INTO agent_tool_calls(id,grant_id,enrollment_id,tool,outcome) SELECT gen_random_uuid(),$1,$2,'get_context','OK' FROM generate_series(1,$3::int)`,
      [grantId, id, AGENT_GRANT_LIMITS.callsPerMinute]);
    expect((await tool(token, 'get_context')).json()).toEqual({ error: 'AGENT_RATE_LIMITED' });
  });
});

describe('propose_intervention through the proposal port', () => {
  it('creates only a pending suggestion for the learner to review; grading and progress are untouched', async () => {
    const { learner, id } = await fresh();
    await answer(learner, id, 'min-a', 'two');
    const asked = await message(learner, id, 'I keep mixing up min and max.');
    const { token, grantId } = await grant(learner, id);
    for (const name of ['get_context', 'get_profile', 'get_evidence', 'get_history']) expect((await tool(token, name)).statusCode).toBe(200);
    const before = await gradingState(id);
    const understandingBefore = (await tool(token, 'get_evidence')).json().result.understanding;
    const key = randomUUID();
    const proposed = await propose(token, id, [asked.eventId], key);
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect(proposed.json().result).toMatchObject({ status: 'pending_learner_review', grantsMastery: false });
    // A replay returns the same receipt; a stale revision is refused.
    expect((await tool(token, 'propose_intervention', { expectedRevision: 1, idempotencyKey: key, suggestion: { kind: 'explanation_style', value: 'step_by_step' },
      sourceEventIds: [asked.eventId] })).json().result.proposalId).toBe(proposed.json().result.proposalId);
    expect((await tool(token, 'propose_intervention', { expectedRevision: 1, idempotencyKey: randomUUID(), suggestion: { kind: 'pace', value: 'gentle' },
      sourceEventIds: [asked.eventId] })).json().error).toBe('STALE_REVISION');
    expect((await tool(token, 'propose_intervention', { expectedRevision: await revision(id), idempotencyKey: randomUUID(), suggestion: { kind: 'review_objective', objectiveId: 'unknown' },
      sourceEventIds: [asked.eventId] })).json().error).toBe('OBJECTIVE_OUT_OF_SCOPE');
    const stored = (await db.query('SELECT service_id,actor_id FROM learner_model_proposals WHERE enrollment_id=$1', [id])).rows;
    expect(stored).toEqual([{ service_id: `agent-grant:${grantId}`, actor_id: learner.actor.id }]);
    expect((await db.query("SELECT actor_kind FROM learning_events WHERE enrollment_id=$1 AND event_type='learner_model.proposal.created'", [id])).rows).toEqual([{ actor_kind: 'agent' }]);
    // It waits in the learner's own review queue and is not in the provider projection until accepted.
    const model = (await app.inject({ url: `/api/enrollments/${id}/learner-model?episodeId=min`, headers: headers(learner) })).json();
    expect(model.suggestions.items).toEqual([expect.objectContaining({ proposalId: proposed.json().result.proposalId, status: 'pending', grantsMastery: false })]);
    expect((await tool(token, 'get_profile')).json().result.suggestions.items).toEqual([]);
    expect(await gradingState(id)).toEqual(before);
    expect((await tool(token, 'get_evidence')).json().result.understanding).toEqual(understandingBefore);
  });

  it('cannot propose once a revocation has committed, even racing it', async () => {
    const { learner, id } = await fresh();
    for (let round = 0; round < 4; round++) {
      const asked = await message(learner, id, `Race question ${round}`);
      const { token, grantId } = await grant(learner, id);
      const [proposed, revoked] = await Promise.all([propose(token, id, [asked.eventId]), revoke(learner, id, grantId)]);
      expect(revoked.statusCode).toBe(200);
      const created = (await db.query(`SELECT p.id,e.sequence FROM learner_model_proposals p JOIN learning_events e ON e.id=p.event_id WHERE p.service_id=$1`, [`agent-grant:${grantId}`])).rows;
      const revocation = (await db.query("SELECT sequence FROM learning_events WHERE enrollment_id=$1 AND event_type='agent_grant.revoked' AND payload->>'grantId'=$2", [id, grantId])).rows[0];
      if (proposed.statusCode === 200) expect(Number(created[0].sequence)).toBeLessThan(Number(revocation.sequence));
      else { expect([401, 403, 409], proposed.body).toContain(proposed.statusCode); expect(created).toEqual([]); }
      expect((await propose(token, id, [asked.eventId])).statusCode).toBe(401);
    }
  });
});
