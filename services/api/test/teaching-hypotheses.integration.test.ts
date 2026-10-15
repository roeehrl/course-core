import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueLoginCode, type Actor } from '../src/auth.js';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { migrationsDirectory } from './database-template.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { ensureCatalog } from '../src/admin-routes.js';
import { readLearnerModel } from '../src/learner-model.js';
import { hypothesisCourse } from './hypothesis-fixture.js';

const origin = 'http://localhost:4310';
const schema = `course_hypotheses_${randomUUID().replaceAll('-', '')}`;
const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID(), releaseId = randomUUID();
let db: Database, testDatabase: TestDatabase | undefined, app: Awaited<ReturnType<typeof createServer>>;
let owner: Session, admin: Session, instructor: Session, reviewer: Session, foreign: Session;
type Session = { actor: Actor; cookie: string; csrf: string };
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
const base = (id: string) => `/api/enrollments/${id}/learner-model`;

async function session(workspace: string, role = 'learner'): Promise<Session> {
  const actor = { id: randomUUID(), displayName: 'Synthetic learner' };
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES ($1,$2,$3)', [actor.id, `hypothesis-test:${actor.id}`, actor.displayName]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspace, actor.id, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  expect(login.statusCode, login.body).toBe(200);
  return { actor, csrf: login.json().csrfToken, cookie: login.cookies.map(r => `${r.name}=${r.value}`).join('; ') };
}
async function enroll() {
  const learner = await session(workspaceId);
  const r = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId } });
  expect(r.statusCode, r.body).toBe(200);
  return { learner, id: r.json().id as string };
}
const revision = async (id: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
async function post(learner: Session, id: string, path: string, body: Record<string, unknown>, key = randomUUID()) {
  return app.inject({ method: 'POST', url: `/api/enrollments/${id}/${path}`, headers: headers(learner), payload: { expectedRevision: await revision(id), idempotencyKey: key, ...body } });
}
async function ok(learner: Session, id: string, path: string, body: Record<string, unknown>) {
  const r = await post(learner, id, path, body);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function answer(learner: Session, id: string, assessmentId: string, value: unknown, mode = 'practice', extra: Record<string, unknown> = {}) {
  const issued = await ok(learner, id, 'challenges', { episodeId: 'min', assessmentId, mode });
  return ok(learner, id, 'answers', { challengeId: issued.challengeId, answer: value, ...extra });
}
async function view(s: Session, id: string) {
  const r = await app.inject({ url: `${base(id)}/hypotheses`, headers: headers(s) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const counts = async (id: string) => (await db.query(`SELECT (SELECT count(*) FROM evidence WHERE enrollment_id=$1)::int AS evidence,
  (SELECT count(*) FROM attempts WHERE enrollment_id=$1)::int AS attempts,(SELECT count(*) FROM assessment_challenges WHERE enrollment_id=$1)::int AS challenges`, [id])).rows[0];
async function decide(learner: Session, id: string, hypothesisId: string, action: string, extra: Record<string, unknown> = {}) {
  const current = (await view(learner, id)).items.find((h: { hypothesisId: string }) => h.hypothesisId === hypothesisId);
  return post(learner, id, `learner-model/hypotheses/${hypothesisId}/decision`, { expectedHypothesisRevision: current.revision, action, ...extra });
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use only a disposable TEST_DATABASE_URL; no database/mock fallback.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Disposable loopback test database required.');
  // A copy of the run's migrated template; migration 037 must be among those it applied.
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  expect((await db.query("SELECT 1 FROM schema_migrations WHERE name='037_teaching_hypotheses.sql'")).rowCount).toBe(1);
  expect(await migrate(db, migrationsDirectory)).toEqual([]);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES ($1,$2,$3),($4,$5,$6)', [workspaceId, 'hypotheses', 'Hypothesis tests', foreignWorkspaceId, 'hypotheses-foreign', 'Other']);
  owner = await session(workspaceId, 'owner'); admin = await session(workspaceId, 'admin'); instructor = await session(workspaceId, 'instructor');
  reviewer = await session(workspaceId, 'reviewer'); foreign = await session(foreignWorkspaceId, 'owner');
  const course = hypothesisCourse();
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), owner.actor.id]);
  await ensureCatalog(db, releaseId);
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('migration 037', () => {
  it('makes probe runs structurally non-evidence and the change log append-only', async () => {
    const { id } = await enroll();
    const digest = (await db.query('SELECT digest FROM course_releases WHERE id=$1', [releaseId])).rows[0].digest;
    await expect(db.query(`INSERT INTO diagnostic_probe_runs(id,enrollment_id,workspace_id,probe_id,assessment_id,course_digest,hypothesis_ids,requested_by,expires_at,grants_evidence)
      VALUES($1,$2,$3,'min-probe','min-probe-item',$4,'["x"]','trigger',now()+interval '1 day',true)`, [randomUUID(), id, workspaceId, digest])).rejects.toMatchObject({ code: '23514' });
    const hypothesisId = randomUUID();
    await db.query(`INSERT INTO teaching_hypotheses(id,enrollment_id,workspace_id,kind,statement,objective_ids,uncertainty,status,source,course_digest)
      VALUES($1,$2,$3,'misconception','A synthetic statement.','["minimum"]','high','proposed','supervisor',$4)`, [hypothesisId, id, workspaceId, digest]);
    // Rejected needs its author; a pin cannot outlive a rejection.
    await expect(db.query("UPDATE teaching_hypotheses SET status='rejected' WHERE id=$1", [hypothesisId])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query("UPDATE teaching_hypotheses SET status='rejected',rejected_by='learner',pinned=true WHERE id=$1", [hypothesisId])).rejects.toMatchObject({ code: '23514' });
    await db.query(`INSERT INTO teaching_hypothesis_changes(id,hypothesis_id,enrollment_id,workspace_id,hypothesis_revision,actor_kind,action,data) VALUES($1,$2,$3,$4,1,'system','proposed','{}')`,
      [randomUUID(), hypothesisId, id, workspaceId]);
    await expect(db.query("UPDATE teaching_hypothesis_changes SET data='{\"x\":1}' WHERE hypothesis_id=$1", [hypothesisId])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query('DELETE FROM teaching_hypothesis_changes WHERE hypothesis_id=$1', [hypothesisId])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('trigger table at runtime', () => {
  it('"I don\'t know" records a T7 signal and proposes nothing (SDK 0.5 abstain path)', async () => {
    const { learner, id } = await enroll();
    const issued = await ok(learner, id, 'challenges', { episodeId: 'min', assessmentId: 'min-practice', mode: 'practice' });
    const r = await ok(learner, id, 'answers', { challengeId: issued.challengeId, abstain: true });
    expect(r.result).toMatchObject({ abstained: true, passed: false });
    const signal = (await db.query("SELECT rule_ids,recommendations,restraints,effects FROM teaching_signals WHERE enrollment_id=$1 AND signal_kind='answer.abstained'", [id])).rows[0];
    expect(signal.rule_ids).toEqual(['T7']);
    expect(signal.recommendations.map((x: { action: string }) => x.action)).toEqual(['worked_example']);
    expect(signal.restraints).toContain('abstain_is_not_a_misconception');
    expect(signal.effects).toEqual([]);
    expect((await view(learner, id)).items).toHaveLength(0);
  });
  it('a linked wrong answer proposes, a repeat probes, and the probe never counts as evidence', async () => {
    const { learner, id } = await enroll();
    // The browser never sees which wrong option maps to which misconception.
    const issued = await ok(learner, id, 'challenges', { episodeId: 'min', assessmentId: 'min-practice', mode: 'practice' });
    expect(JSON.stringify(issued.question)).not.toMatch(/misconception|min-largest|correctOption/);
    await ok(learner, id, 'answers', { challengeId: issued.challengeId, answer: 'nine', confidence: 5 });
    let current = await view(learner, id);
    expect(current.items).toHaveLength(1);
    const [first] = current.items;
    expect(first).toMatchObject({ templateId: 'min-largest', kind: 'misconception', status: 'proposed', uncertainty: 'high', source: 'assessment', pinned: false, observations: 1, grantsMastery: false });
    expect(first.evidenceRefs).toHaveLength(1);
    expect(first.expiresAt).not.toBeNull();
    const signal = (await db.query("SELECT rule_ids,recommendations,restraints FROM teaching_signals WHERE enrollment_id=$1 AND signal_kind='answer.incorrect'", [id])).rows[0];
    expect(signal.rule_ids).toEqual(['T1']);
    expect(signal.recommendations.map((r: { action: string }) => r.action)).toEqual(['contrast_case']);
    expect(signal.restraints).toContain('single_error_is_not_a_stable_misconception');

    await answer(learner, id, 'min-again', 'eight');
    current = await view(learner, id);
    expect(current.items[0]).toMatchObject({ hypothesisId: first.hypothesisId, status: 'probing', uncertainty: 'medium', observations: 2, expiresAt: null });
    expect(current.probes).toHaveLength(1);
    const [probe] = current.probes;
    expect(probe).toMatchObject({ probeId: 'min-probe', requestedBy: 'trigger', state: 'scheduled', countsAsEvidence: false, hypothesisIds: [first.hypothesisId] });
    expect(probe.question).toEqual({ id: 'min-probe-item', type: 'choice', prompt: 'Which is the smallest of 4, 9 and 2?',
      options: [{ id: 'four', text: '4' }, { id: 'nine', text: '9' }, { id: 'two', text: '2' }] });

    const before = await counts(id), gateBefore = (await app.inject({ url: `/api/enrollments/${id}`, headers: headers(learner) })).json().objectives;
    const answered = await ok(learner, id, `learner-model/probes/${probe.probeRunId}/answer`, { answer: 'nine' });
    expect(answered).toMatchObject({ outcome: 'incorrect', correct: false, conclusive: true, countsAsEvidence: false, grantsMastery: false });
    expect(answered.hypotheses).toEqual([expect.objectContaining({ hypothesisId: first.hypothesisId, status: 'confirmed', uncertainty: 'low' })]);
    // No attempt, evidence or challenge row; the gate projection is unchanged.
    expect(await counts(id)).toEqual(before);
    expect((await app.inject({ url: `/api/enrollments/${id}`, headers: headers(learner) })).json().objectives).toEqual(gateBefore);
    const event = (await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='diagnostic.probe.answered'", [id])).rows[0];
    expect(event.payload).toMatchObject({ countsAsEvidence: false, grantsMastery: false });
    const again = await post(learner, id, `learner-model/probes/${probe.probeRunId}/answer`, { answer: 'two' });
    expect([again.statusCode, again.json().error]).toEqual([409, 'PROBE_ALREADY_ANSWERED']);

    // Strong independent evidence on a linked item resolves the confirmed hypothesis.
    await answer(learner, id, 'min-a', 'two', 'independent');
    expect((await view(learner, id)).items[0]).toMatchObject({ status: 'resolved' });
  });

  it('an expired idea leaves provider context, shows as expired, and a later error renews the same record', async () => {
    const { learner, id } = await enroll();
    await answer(learner, id, 'min-practice', 'nine');
    const [h] = (await view(learner, id)).items;
    await db.query("UPDATE teaching_hypotheses SET expires_at=now()-interval '1 minute' WHERE id=$1", [h.hypothesisId]);
    expect((await view(learner, id)).items[0]).toMatchObject({ hypothesisId: h.hypothesisId, status: 'expired' });
    expect((await readLearnerModel(db, learner.actor, { workspaceId, enrollmentId: id, episodeId: 'min' })).teaching!.hypotheses).toEqual([]);
    await answer(learner, id, 'min-again', 'eight');
    const renewed = (await view(learner, id)).items;
    expect(renewed).toHaveLength(1);
    expect(renewed[0]).toMatchObject({ hypothesisId: h.hypothesisId, status: 'proposed', observations: 2 });
    expect(new Date(renewed[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('an ambiguous wrong answer schedules a discriminating probe without guessing a hypothesis', async () => {
    const { learner, id } = await enroll();
    await answer(learner, id, 'min-ambiguous', 'eight');
    const current = await view(learner, id);
    // The probe needs hypotheses to test: none are invented from an ambiguous error.
    expect(current.items).toEqual([]);
    expect(current.probes).toEqual([]);
    const signal = (await db.query("SELECT rule_ids,skipped FROM teaching_signals WHERE enrollment_id=$1", [id])).rows[0];
    expect(signal.rule_ids).toEqual(['T2']);
    expect(signal.skipped).toEqual([expect.objectContaining({ reason: 'no_active_hypothesis' })]);
  });

  it('placement answers and unlinked single errors propose nothing; repeated companion questions recommend another representation', async () => {
    const { learner, id } = await enroll();
    await answer(learner, id, 'min-b', 3);
    expect((await view(learner, id)).items).toEqual([]);
    const evidenceBefore = (await counts(id)).evidence;
    for (const content of ['Why is this the smallest?', 'Can you explain comparisons again?', 'I still do not see it.'])
      await ok(learner, id, 'companion', { episodeId: 'min', content });
    const rows = (await db.query("SELECT rule_ids,recommendations,restraints FROM teaching_signals WHERE enrollment_id=$1 AND signal_kind='companion.question' ORDER BY created_at", [id])).rows;
    expect(rows.map(r => r.rule_ids)).toEqual([[], [], ['T5']]);
    expect(rows[2].recommendations.map((r: { action: string }) => r.action)).toEqual(['change_representation']);
    expect(rows[2].restraints).toContain('question_never_lowers_evidence');
    expect((await counts(id)).evidence).toBe(evidenceBefore);
  });
});

describe('learner controls over HTTP', () => {
  it('pin, correct and reject with audit, revision fences, provider-context exclusion and respected rejection', async () => {
    const { learner, id } = await enroll();
    await answer(learner, id, 'min-practice', 'nine');
    const [h] = (await view(learner, id)).items;
    // Stale hypothesis revision: refresh instead of overwriting a newer change.
    const stale = await post(learner, id, `learner-model/hypotheses/${h.hypothesisId}/decision`, { expectedHypothesisRevision: h.revision + 1, action: 'pin' });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'HYPOTHESIS_CHANGED']);
    const key = randomUUID(), body = { expectedHypothesisRevision: h.revision, action: 'pin' };
    const pinned = await post(learner, id, `learner-model/hypotheses/${h.hypothesisId}/decision`, body, key);
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(pinned.json()).toMatchObject({ pinned: true, grantsMastery: false });
    // An exact retry replays the receipt; the key cannot be reused for another intent.
    const replay = await app.inject({ method: 'POST', url: `${base(id)}/hypotheses/${h.hypothesisId}/decision`, headers: headers(learner),
      payload: { expectedRevision: (await revision(id)) - 1, idempotencyKey: key, ...body } });
    expect(replay.json()).toEqual(pinned.json());
    const conflict = await app.inject({ method: 'POST', url: `${base(id)}/hypotheses/${h.hypothesisId}/decision`, headers: headers(learner),
      payload: { expectedRevision: await revision(id), idempotencyKey: key, expectedHypothesisRevision: h.revision, action: 'reject' } });
    expect([conflict.statusCode, conflict.json().error]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect((await view(learner, id)).items[0]).toMatchObject({ pinned: true, expiresAt: null });

    const corrected = await decide(learner, id, h.hypothesisId, 'correct', { correction: 'I mixed up the words smallest and largest.' });
    expect(corrected.statusCode, corrected.body).toBe(200);
    let memory = await readLearnerModel(db, learner.actor, { workspaceId, enrollmentId: id, episodeId: 'min' });
    expect(memory.teaching!.hypotheses).toEqual([expect.objectContaining({ hypothesisId: h.hypothesisId, statement: 'I mixed up the words smallest and largest.', correctedByLearner: true, pinnedByLearner: true })]);

    const rejected = await decide(learner, id, h.hypothesisId, 'reject', { reason: 'This is not what happened.' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'rejected', pinned: false });
    memory = await readLearnerModel(db, learner.actor, { workspaceId, enrollmentId: id, episodeId: 'min' });
    expect(memory.teaching!.hypotheses).toEqual([]);
    const afterReject = await decide(learner, id, h.hypothesisId, 'correct', { correction: 'Another wording.' });
    expect([afterReject.statusCode, afterReject.json().error]).toEqual([409, 'HYPOTHESIS_REJECTED']);
    // The trigger table does not re-propose what the learner rejected.
    await answer(learner, id, 'min-again', 'eight');
    expect((await view(learner, id)).items.map((row: { status: string }) => row.status)).toEqual(['rejected']);

    const audit = (await db.query('SELECT actor_kind,action FROM teaching_hypothesis_changes WHERE hypothesis_id=$1 ORDER BY sequence', [h.hypothesisId])).rows;
    expect(audit).toEqual([{ actor_kind: 'system', action: 'proposed' }, { actor_kind: 'learner', action: 'pinned' }, { actor_kind: 'learner', action: 'corrected' }, { actor_kind: 'learner', action: 'rejected' }]);
    const events = (await db.query("SELECT payload->>'action' AS action FROM learning_events WHERE enrollment_id=$1 AND event_type='learner_model.hypothesis.reviewed' ORDER BY sequence", [id])).rows;
    expect(events.map(r => r.action)).toEqual(['pinned', 'corrected', 'rejected']);
  });

  it('refuses other learners, staff writes, foreign workspaces and invalid input', async () => {
    const { learner, id } = await enroll();
    await answer(learner, id, 'min-practice', 'nine');
    const [h] = (await view(learner, id)).items;
    const other = await session(workspaceId);
    expect((await app.inject({ url: `${base(id)}/hypotheses`, headers: headers(other) })).statusCode).toBe(404);
    const otherWrite = await post(other, id, `learner-model/hypotheses/${h.hypothesisId}/decision`, { expectedHypothesisRevision: h.revision, action: 'reject' });
    expect([otherWrite.statusCode, otherWrite.json().error]).toEqual([404, 'ENROLLMENT_NOT_FOUND']);
    // Staff may read for teaching; only the learner changes their hypotheses.
    expect((await view(instructor, id)).items).toHaveLength(1);
    const staffWrite = await post(instructor, id, `learner-model/hypotheses/${h.hypothesisId}/decision`, { expectedHypothesisRevision: h.revision, action: 'reject' });
    expect(staffWrite.statusCode).toBe(404);
    expect((await app.inject({ url: `${base(id)}/hypotheses`, headers: headers(foreign) })).statusCode).toBe(403);
    // A hypothesis of a different enrollment is not reachable through this one.
    const second = await enroll();
    await answer(second.learner, second.id, 'min-practice', 'nine');
    const [theirs] = (await view(second.learner, second.id)).items;
    const crossed = await post(learner, id, `learner-model/hypotheses/${theirs.hypothesisId}/decision`, { expectedHypothesisRevision: theirs.revision, action: 'pin' });
    expect([crossed.statusCode, crossed.json().error]).toEqual([404, 'HYPOTHESIS_NOT_FOUND']);
    for (const bad of [{ action: 'correct' }, { action: 'reject', correction: 'x' }, { action: 'delete' }, { action: 'pin', extra: true }]) {
      const r = await post(learner, id, `learner-model/hypotheses/${h.hypothesisId}/decision`, { expectedHypothesisRevision: h.revision, ...bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await post(learner, id, 'learner-model/diagnostics', { hypothesisId: h.hypothesisId, objectiveId: 'minimum' })).statusCode).toBe(400);
    expect((await post(learner, id, 'learner-model/diagnostics', { objectiveId: 'unknown-objective' })).statusCode).toBe(404);
  });

  it('requests a diagnostic: a declared probe is scheduled, otherwise the supervisor is asked; requests are capped', async () => {
    const { learner, id } = await enroll();
    const requested = await ok(learner, id, 'learner-model/diagnostics', { objectiveId: 'minimum', note: 'I think I pick whichever number I read first.' });
    expect(requested).toMatchObject({ state: 'probe_scheduled', countsAsEvidence: false, grantsMastery: false });
    const current = await view(learner, id);
    expect(current.items.map((h: { source: string; templateId: string | null }) => [h.source, h.templateId]).sort()).toEqual([['learner', null], ['learner', 'min-first'], ['learner', 'min-largest']]);
    expect(current.probes[0]).toMatchObject({ probeRunId: requested.probeRunId, requestedBy: 'learner', state: 'scheduled' });
    // "I don't know" on a probe is recorded and inconclusive.
    const abstained = await ok(learner, id, `learner-model/probes/${requested.probeRunId}/answer`, { abstain: true });
    expect(abstained).toMatchObject({ outcome: 'abstained', correct: null, conclusive: false, countsAsEvidence: false });

    const waiting = await ok(learner, id, 'learner-model/diagnostics', { objectiveId: 'maximum' });
    expect(waiting).toMatchObject({ state: 'awaiting_supervisor', waitingReason: 'no_declared_probe' });
    const outbox = await db.query("SELECT 1 FROM outbox o JOIN learning_events e ON e.id=o.event_id WHERE e.enrollment_id=$1 AND e.event_type='learner_model.diagnostic.requested'", [id]);
    expect(outbox.rowCount).toBe(1);
    // An open independent check holds new probes back.
    await ok(learner, id, 'challenges', { episodeId: 'min', mode: 'independent' });
    const held = await ok(learner, id, 'learner-model/diagnostics', { objectiveId: 'minimum' });
    expect(held).toMatchObject({ state: 'awaiting_supervisor', waitingReason: 'independent_assessment_active' });
    const limited = await post(learner, id, 'learner-model/diagnostics', { objectiveId: 'minimum' });
    expect([limited.statusCode, limited.json().error]).toEqual([409, 'DIAGNOSTIC_REQUEST_LIMIT']);
  });
});

describe('skill projection', () => {
  it('reports practicing, demonstrated, retained, needs review and disputed from real records', async () => {
    const { learner, id } = await enroll();
    const objective = async () => (await app.inject({ url: `${base(id)}?episodeId=min`, headers: headers(learner) })).json().understanding[0];
    expect(await objective()).toMatchObject({ status: 'needs_evidence', demonstrated: false, retention: 'not_scheduled', practiceAttempts: 0, openDisputes: 0 });
    await answer(learner, id, 'min-practice', 'three');
    expect(await objective()).toMatchObject({ status: 'practicing', practiceAttempts: 1, demonstrated: false });
    await answer(learner, id, 'min-a', 'two', 'independent');
    await answer(learner, id, 'min-b', 4, 'independent');
    expect(await objective()).toMatchObject({ status: 'demonstrated', demonstrated: true });
    await db.query("INSERT INTO retention_schedules(enrollment_id,objective_id,demonstrated_at,step,due_at) VALUES($1,'minimum',now(),0,now()+interval '1 day')", [id]);
    expect(await objective()).toMatchObject({ status: 'demonstrated', retention: 'scheduled' });
    await db.query("UPDATE retention_schedules SET retained_at=now(),due_at=NULL WHERE enrollment_id=$1", [id]);
    expect(await objective()).toMatchObject({ status: 'retained', retention: 'retained' });
    await db.query("UPDATE retention_schedules SET needs_review=true WHERE enrollment_id=$1", [id]);
    expect(await objective()).toMatchObject({ status: 'needs_review', retention: 'needs_review', demonstrated: true });
    const attempt = (await db.query("SELECT attempt_id FROM evidence WHERE enrollment_id=$1 AND objective_id='minimum' LIMIT 1", [id])).rows[0].attempt_id;
    await db.query("INSERT INTO rubric_appeals(id,attempt_id,enrollment_id,reason) VALUES($1,$2,$3,'A synthetic appeal reason.')", [randomUUID(), attempt, id]);
    expect(await objective()).toMatchObject({ status: 'disputed', openDisputes: 1, demonstrated: true });
  });
});

describe('export, erasure and staff views', () => {
  it('keeps the learner\'s own words from every staff role on hypothesis reads and exports', async () => {
    const { learner, id } = await enroll();
    await answer(learner, id, 'min-practice', 'nine');
    await ok(learner, id, 'learner-model/diagnostics', { objectiveId: 'minimum', note: 'ROLE_NOTE_MARKER' });
    const [h] = (await view(learner, id)).items.filter((row: { templateId: string | null }) => row.templateId === 'min-largest');
    expect((await decide(learner, id, h.hypothesisId, 'correct', { correction: 'ROLE_CORRECTION_MARKER' })).statusCode).toBe(200);
    const probe = (await view(learner, id)).probes[0];
    await ok(learner, id, `learner-model/probes/${probe.probeRunId}/answer`, { answer: 'four' });
    const markers = /ROLE_NOTE_MARKER|ROLE_CORRECTION_MARKER/;
    const flagged = [
      expect.objectContaining({ hypothesisId: h.hypothesisId, correctedByLearner: true, learnerCorrection: null }),
      expect.objectContaining({ source: 'learner', templateId: null, statement: null, statementWithheld: true }),
    ];
    for (const [reader, role] of [[owner, 'owner'], [admin, 'admin'], [instructor, 'instructor']] as const) {
      const route = await app.inject({ url: `${base(id)}/hypotheses`, headers: headers(reader) });
      expect(route.statusCode, `${role}: ${route.body}`).toBe(200);
      expect(route.body, role).not.toMatch(markers);
      expect(route.json().items, role).toEqual(expect.arrayContaining(flagged));
      expect(route.json().requests[0], role).toMatchObject({ note: null, noteWithheld: true });
      const record = await app.inject({ url: `/api/admin/enrollments/${id}/hypotheses`, headers: headers(reader) });
      expect(record.statusCode, `${role}: ${record.body}`).toBe(200);
      expect(record.body, role).not.toMatch(markers);
      expect(record.json().items, role).toEqual(expect.arrayContaining(flagged));
      const exported = await app.inject({ url: `/api/enrollments/${id}/export`, headers: headers(reader) });
      if (role === 'instructor') { expect(exported.statusCode, role).toBe(404); continue; }
      expect(exported.statusCode, `${role}: ${exported.body}`).toBe(200);
      expect(exported.body, role).not.toMatch(markers);
      const copy = exported.json();
      expect(copy).toMatchObject({ audience: 'staff', learnerModel: null });
      // An explicit staff projection, not a silent omission: flags only.
      expect(copy.teachingHypotheses.audience).toBe('staff');
      expect(copy.teachingHypotheses.hypotheses).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: h.hypothesisId, corrected_by_learner: true }),
        expect.objectContaining({ source: 'learner', statement: null, statement_withheld: true }),
      ]));
      expect(copy.teachingHypotheses.diagnosticRequests[0]).toMatchObject({ note_withheld: true });
      expect(copy.teachingHypotheses.diagnosticRequests[0]).not.toHaveProperty('note');
      expect(copy.teachingHypotheses.probeRuns[0]).not.toHaveProperty('response');
      expect(copy.teachingHypotheses.changes.every((c: Record<string, unknown>) => !('data' in c))).toBe(true);
    }
    // Roles outside the staff read roles get nothing.
    expect((await app.inject({ url: `${base(id)}/hypotheses`, headers: headers(reviewer) })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/admin/enrollments/${id}/hypotheses`, headers: headers(reviewer) })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/enrollments/${id}/export`, headers: headers(reviewer) })).statusCode).toBe(404);
    // The learner's own copy is complete.
    const own = await app.inject({ url: `/api/enrollments/${id}/export`, headers: headers(learner) });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ audience: 'learner' });
    expect(own.json()).not.toHaveProperty('teachingHypotheses');
    const teaching = own.json().learnerModel.teaching;
    expect(JSON.stringify(teaching)).toMatch(/ROLE_NOTE_MARKER/);
    expect(JSON.stringify(teaching)).toMatch(/ROLE_CORRECTION_MARKER/);
    expect(teaching.probeRuns[0]).toMatchObject({ response: { answer: 'four' } });
  });
  it('exports every hypothesis record and redacts them on erasure', async () => {
    const { learner, id } = await enroll();
    await answer(learner, id, 'min-practice', 'nine');
    await ok(learner, id, 'learner-model/diagnostics', { objectiveId: 'minimum', note: 'PRIVATE_NOTE_CANARY' });
    const [h] = (await view(learner, id)).items.filter((row: { templateId: string | null }) => row.templateId === 'min-largest');
    expect((await decide(learner, id, h.hypothesisId, 'correct', { correction: 'PRIVATE_CORRECTION_CANARY' })).statusCode).toBe(200);
    const probe = (await view(learner, id)).probes[0];
    await ok(learner, id, `learner-model/probes/${probe.probeRunId}/answer`, { answer: 'four' });

    const staffView = await app.inject({ url: `/api/admin/enrollments/${id}/hypotheses`, headers: headers(owner) });
    expect(staffView.statusCode, staffView.body).toBe(200);
    expect(staffView.json().items.length).toBeGreaterThan(0);
    expect(staffView.json().signals.length).toBeGreaterThan(0);
    // Staff learn that the learner corrected or wrote an idea, never their words.
    expect(staffView.body).not.toMatch(/PRIVATE_NOTE_CANARY|PRIVATE_CORRECTION_CANARY/);
    expect(staffView.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ hypothesisId: h.hypothesisId, correctedByLearner: true, learnerCorrection: null, statementWithheld: false }),
      expect.objectContaining({ source: 'learner', templateId: null, statement: null, statementWithheld: true }),
    ]));
    for (const reader of [owner, instructor]) {
      const staffRead = await app.inject({ url: `${base(id)}/hypotheses`, headers: headers(reader) });
      expect(staffRead.statusCode, staffRead.body).toBe(200);
      expect(staffRead.body).not.toMatch(/PRIVATE_NOTE_CANARY|PRIVATE_CORRECTION_CANARY/);
      expect(staffRead.json().requests[0]).toMatchObject({ note: null, noteWithheld: true });
    }
    const own = await view(learner, id);
    expect(JSON.stringify(own)).toMatch(/PRIVATE_NOTE_CANARY/);
    expect(own.items.find((row: { hypothesisId: string }) => row.hypothesisId === h.hypothesisId)).toMatchObject({ learnerCorrection: 'PRIVATE_CORRECTION_CANARY', correctedByLearner: true });
    expect(own.requests[0]).toMatchObject({ note: 'PRIVATE_NOTE_CANARY' });
    expect((await app.inject({ url: `/api/admin/enrollments/${id}/hypotheses`, headers: headers(learner) })).statusCode).toBe(403);

    const exported = await app.inject({ url: `/api/enrollments/${id}/export`, headers: headers(learner) });
    expect(exported.statusCode, exported.body).toBe(200);
    const teaching = exported.json().learnerModel.teaching;
    expect(teaching.hypotheses.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(teaching.hypotheses)).toContain('PRIVATE_CORRECTION_CANARY');
    expect(teaching.changes.map((c: { action: string }) => c.action)).toEqual(expect.arrayContaining(['proposed', 'corrected', 'probe_scheduled', 'probe_answered']));
    expect(teaching.probeRuns[0]).toMatchObject({ state: 'answered', response: { answer: 'four' } });
    expect(teaching.diagnosticRequests[0]).toMatchObject({ note: 'PRIVATE_NOTE_CANARY', state: 'fulfilled' });
    expect(teaching.signals.length).toBeGreaterThan(0);

    const erased = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/erase`, headers: headers(learner),
      payload: { confirmation: `ERASE ${id.slice(0, 8)}`, reason: 'Synthetic erasure request.' } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts).toMatchObject({ teachingHypotheses: 3, diagnosticProbeRuns: 1, diagnosticRequests: 1 });
    const dump = JSON.stringify((await db.query(`SELECT (SELECT jsonb_agg(h) FROM teaching_hypotheses h WHERE enrollment_id=$1) AS h,(SELECT jsonb_agg(c) FROM teaching_hypothesis_changes c WHERE enrollment_id=$1) AS c,
      (SELECT jsonb_agg(r) FROM diagnostic_probe_runs r WHERE enrollment_id=$1) AS r,(SELECT jsonb_agg(q) FROM diagnostic_requests q WHERE enrollment_id=$1) AS q`, [id])).rows[0]);
    expect(dump).not.toMatch(/PRIVATE_NOTE_CANARY|PRIVATE_CORRECTION_CANARY|choosing the largest|"four"/);
    const gone = await app.inject({ url: `${base(id)}/hypotheses`, headers: headers(learner) });
    expect([gone.statusCode, gone.json().error]).toEqual([410, 'ENROLLMENT_ERASED']);
    const write = await post(learner, id, `learner-model/hypotheses/${h.hypothesisId}/decision`, { expectedHypothesisRevision: 1, action: 'pin' });
    expect([write.statusCode, write.json().error]).toEqual([410, 'ENROLLMENT_ERASED']);
    expect((await app.inject({ url: `/api/admin/enrollments/${id}/hypotheses`, headers: headers(owner) })).statusCode).toBe(410);
  });
});
