import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { declarativeActivityRuntime } from '../src/activity-runtime.js';
import { DENIED_CALLS_PER_MINUTE, STATE_SAVES_PER_MINUTE } from '../src/activity-routes.js';
import { activityCourse, activityDefinition, sandboxedActivityRuntime, sandboxedCourse, syntheticActivityEvaluator, EVALUATOR_ID } from './activity-fixture.js';

// Real HTTP, PostgreSQL and migrations: the activity runtime's broker, its denials and the only
// path from an observation to evidence (a registered evaluator).
const origin = 'http://localhost:4391', schema = 'activity_' + randomUUID().replaceAll('-', '');
type App = Awaited<ReturnType<typeof createServer>>;
let db: Database, app: App, testDatabase: TestDatabase | undefined, workspace: string, owner: Session, learner: Session;
const evaluator = syntheticActivityEvaluator();
interface Session { userId: string; cookie: string; csrf: string }

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, 'activity:' + id, role + ' person']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map(c => c.name + '=' + c.value).join('; '), csrf: r.json().csrfToken };
}
const call = (who: Session, method: 'GET' | 'POST', url: string, payload?: unknown, on: App = app) =>
  on.inject({ method, url, headers: { origin, cookie: who.cookie, 'x-csrf-token': who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function publish(course: object) {
  const imported = await call(owner, 'POST', `/api/workspaces/${workspace}/releases`, course);
  expect(imported.statusCode, imported.body).toBe(200);
  const published = await call(owner, 'POST', `/api/releases/${imported.json().id}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  return imported.json().id as string;
}
async function enroll(release: string, who = learner) {
  const r = await call(who, 'POST', '/api/enrollments', { releaseId: release });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
async function command(enrollment: string, action: string, body: Record<string, unknown>, who = learner) {
  const snapshot = (await call(who, 'GET', '/api/enrollments/' + enrollment)).json();
  return call(who, 'POST', `/api/enrollments/${enrollment}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), ...body });
}
async function answer(enrollment: string, assessmentId: string, value: unknown) {
  const issued = await command(enrollment, 'challenges', { episodeId: 'min', assessmentId, mode: 'independent' });
  expect(issued.statusCode, issued.body).toBe(200);
  const r = await command(enrollment, 'answers', { challengeId: issued.json().challengeId, answer: value });
  expect(r.statusCode, r.body).toBe(200);
}
const launch = (enrollment: string, target = 'web_desktop', who = learner, on: App = app) =>
  call(who, 'POST', `/api/enrollments/${enrollment}/activities`, { episodeId: 'min', blockId: 'min-activity', target }, on);
const broker = (enrollment: string, instance: string, body: Record<string, unknown>, who = learner, on: App = app) =>
  call(who, 'POST', `/api/enrollments/${enrollment}/activity-instances/${instance}/calls`, { idempotencyKey: randomUUID(), ...body }, on);
const count = async (sql: string, args: unknown[]) => Number((await db.query(sql, args)).rows[0].n);

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [declarativeActivityRuntime(), evaluator, sandboxedActivityRuntime()] });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'act-' + workspace, 'Activities']);
  owner = await session('owner');
  learner = await session('learner');
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe('activity publication over HTTP', () => {
  it('refuses to publish on a host without the activity runtime or the declared evaluator', async () => {
    for (const [installed, code, version] of [[[], 'PUBLISH_ACTIVITY_TARGET_UNSUPPORTED', '1.0.1'], [[declarativeActivityRuntime()], 'PUBLISH_EVALUATOR_RUNTIME_UNAVAILABLE', '1.0.2']] as const) {
      const bare = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [...installed] });
      try {
        const imported = await call(owner, 'POST', `/api/workspaces/${workspace}/releases`, { ...activityCourse(), version }, bare);
        expect(imported.statusCode, imported.body).toBe(200);
        const published = await call(owner, 'POST', `/api/releases/${imported.json().id}/publish`, undefined, bare);
        expect(published.statusCode).toBe(409);
        expect(published.json().error).toBe(code);
      } finally { await bare.close(); }
    }
  });
});

describe('declarative activity with a registered evaluator', () => {
  it('grants only declared capabilities and makes evidence only from the evaluator result', async () => {
    const release = await publish(activityCourse()), enrollment = await enroll(release);
    const started = await launch(enrollment);
    expect(started.statusCode, started.body).toBe(200);
    const view = started.json();
    expect(view).toMatchObject({ mode: 'run', execution: 'declarative', target: 'web_desktop', grantedCapabilities: ['state.read', 'state.patch', 'observation.emit'],
      state: { values: { value: null, sure: null } }, stateRevision: 1, evaluated: true, satisfied: false });
    expect(view.frameUrl).toBeUndefined();
    // Server-only wiring is not sent to the learner.
    expect(started.body).not.toContain(EVALUATOR_ID);
    // Launching again (another device class) keeps the same instance and state.
    const again = (await launch(enrollment, 'web_mobile')).json();
    expect(again).toMatchObject({ instanceId: view.instanceId, target: 'web_mobile' });
    // A target the course does not declare is refused.
    expect((await launch(enrollment, 'ios_phone')).json().error).toBe('ACTIVITY_TARGET_NOT_DECLARED');

    const id = view.instanceId as string;
    expect((await broker(enrollment, id, { capability: 'state.patch', payload: { state: { values: { value: 3 } } } })).json().error).toBe('ACTIVITY_STATE_REVISION_REQUIRED');
    expect((await broker(enrollment, id, { capability: 'state.patch', expectedStateRevision: 7, payload: { state: { values: { value: 3 } } } })).json().error).toBe('ACTIVITY_STATE_STALE');
    expect((await broker(enrollment, id, { capability: 'state.patch', expectedStateRevision: 1, payload: { state: { values: { value: 42 } } } })).json().error).toBe('ACTIVITY_STATE_INVALID');
    const big = await broker(enrollment, id, { capability: 'state.patch', expectedStateRevision: 1, payload: { state: { values: {}, pad: 'x'.repeat(3000) } } });
    expect([big.statusCode, big.json().error]).toEqual([413, 'ACTIVITY_STATE_TOO_LARGE']);
    const patched = await broker(enrollment, id, { capability: 'state.patch', expectedStateRevision: 1, payload: { state: { values: { value: 3 } } } });
    expect(patched.json()).toEqual({ stateRevision: 2 });
    expect((await broker(enrollment, id, { capability: 'state.read' })).json()).toEqual({ state: { values: { value: 3 } }, stateRevision: 2 });
    // Saving state marks the activity in progress for the safe-boundary rule (E03 presence).
    const presence = () => db.query("SELECT kind,closed_at IS NULL AS open FROM activity_presence WHERE enrollment_id=$1 AND episode_id='min' AND block_id='min-activity'", [enrollment]);
    expect((await presence()).rows).toEqual([{ kind: 'activity', open: true }]);

    // Undeclared and forbidden capabilities are denied and recorded; they do nothing.
    for (const capability of ['network.fetch', 'evidence.write', 'made.up']) {
      const denied = await broker(enrollment, id, { capability, payload: {} });
      expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'ACTIVITY_CAPABILITY_DENIED', details: { capability: capability === 'made.up' ? 'unknown' : capability } }]);
    }
    expect(await count("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='activity.capability_denied'", [enrollment])).toBe(3);

    // A wrong value: an evaluator result (not passed) is the only evidence; nothing reaches assessment evidence.
    const wrong = await broker(enrollment, id, { capability: 'observation.emit', payload: { observation: { kind: 'submitted', values: { value: 9, sure: true } } } });
    expect(wrong.statusCode, wrong.body).toBe(200);
    expect(wrong.json()).toMatchObject({ evaluation: { status: 'not_passed', evaluator: `${EVALUATOR_ID}@1.0.0` }, satisfied: false });
    expect((await broker(enrollment, id, { capability: 'observation.emit', payload: { observation: { kind: 'passed', values: { value: 4, sure: true } } } })).json().error).toBe('ACTIVITY_OBSERVATION_INVALID');
    expect(await count('SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1', [enrollment])).toBe(0);
    expect((await db.query('SELECT objective_id,result FROM activity_evidence WHERE enrollment_id=$1', [enrollment])).rows).toEqual([{ objective_id: 'minimum', result: { passed: false } }]);

    // The gate passes from assessments; the activity still blocks completion.
    await answer(enrollment, 'min-a', 'two');
    await answer(enrollment, 'min-b', 4);
    expect((await command(enrollment, 'read', { episodeId: 'min', blockId: 'min-text' })).statusCode).toBe(200);
    const blocked = await command(enrollment, 'complete', { episodeId: 'min' });
    expect([blocked.statusCode, blocked.json()]).toEqual([409, { error: 'ACTIVITY_EVIDENCE_REQUIRED', details: { activityBlockIds: ['min-activity'] } }]);
    // Activity blocks cannot be "read" past.
    expect((await command(enrollment, 'read', { episodeId: 'min', blockId: 'min-activity' })).json().error).toBe('BLOCK_NOT_READING');

    const key = randomUUID(), right = { capability: 'observation.emit', idempotencyKey: key, payload: { observation: { kind: 'submitted', values: { value: 4, sure: true } } } };
    const passed = await broker(enrollment, id, right);
    expect(passed.json()).toMatchObject({ evaluation: { status: 'passed', explanation: '4 is the smaller value.' }, satisfied: true });
    // Finishing it ends that signal at once.
    expect((await presence()).rows).toEqual([{ kind: 'activity', open: false }]);
    // A retry returns the stored result without evaluating again; a different body under the same key is refused.
    const calls = evaluator.calls;
    expect((await broker(enrollment, id, right)).json()).toMatchObject({ observationId: passed.json().observationId, evaluation: { status: 'passed' }, satisfied: true, replayed: true });
    expect(evaluator.calls).toBe(calls);
    expect((await broker(enrollment, id, { ...right, payload: { observation: { kind: 'submitted', values: { value: 5, sure: true } } } })).json().error).toBe('IDEMPOTENCY_CONFLICT');
    const snapshot = (await call(learner, 'GET', '/api/enrollments/' + enrollment)).json();
    expect(snapshot.lessons[0].completedBlockIds).toContain('min-activity');
    const done = await command(enrollment, 'complete', { episodeId: 'min' });
    expect(done.statusCode, done.body).toBe(200);
    expect(await count('SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1', [enrollment])).toBe(2);
    expect(await count("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='activity.completed' AND payload->>'grantsMastery'='false'", [enrollment])).toBe(1);
  });

  it('records no evidence when the evaluator fails or answers outside the declared objectives', async () => {
    const release = await publish(activityCourse()), enrollment = await enroll(release);
    for (const behavior of ['throws', 'out_of_scope'] as const) {
      const host = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [declarativeActivityRuntime(), syntheticActivityEvaluator(behavior)] });
      try {
        const id = (await launch(enrollment, 'web_desktop', learner, host)).json().instanceId;
        const r = await broker(enrollment, id, { capability: 'observation.emit', payload: { observation: { kind: 'submitted', values: { value: 4, sure: true } } } }, learner, host);
        expect(r.json()).toMatchObject({ evaluation: { status: 'unavailable' }, satisfied: false });
      } finally { await host.close(); }
    }
    expect(await count('SELECT count(*)::int AS n FROM activity_evidence WHERE enrollment_id=$1', [enrollment])).toBe(0);
    // A host that no longer has the runtime stops serving the activity.
    const bare = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [] });
    try {
      expect((await launch(enrollment, 'web_desktop', learner, bare)).json().error).toBe('ACTIVITY_RUNTIME_UNAVAILABLE');
      const id = (await launch(enrollment)).json().instanceId;
      expect((await broker(enrollment, id, { capability: 'state.read' }, learner, bare)).json().error).toBe('ACTIVITY_RUNTIME_UNAVAILABLE');
    } finally { await bare.close(); }
  });

  it('keeps instances to their learner and limits the observation rate', async () => {
    const release = await publish(activityCourse(activityDefinition({ evaluatorRef: undefined }))), enrollment = await enroll(release);
    const id = (await launch(enrollment)).json().instanceId;
    const other = await session('learner'), staff = await session('instructor'), otherEnrollment = await enroll(release, other);
    expect((await broker(otherEnrollment, id, { capability: 'state.read' }, other)).json().error).toBe('ACTIVITY_INSTANCE_NOT_FOUND');
    expect((await broker(enrollment, id, { capability: 'state.read' }, other)).json().error).toBe('ENROLLMENT_NOT_FOUND');
    expect((await broker(enrollment, id, { capability: 'state.read' }, staff)).json().error).toBe('ENROLLMENT_NOT_FOUND');
    expect((await launch(enrollment, 'web_desktop', staff)).json().error).toBe('ENROLLMENT_NOT_FOUND');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await broker(enrollment, id, { capability: 'observation.emit', payload: { observation: { kind: 'submitted', values: { value: i, sure: false } } } })).statusCode);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('admin release checks', () => {
  it('warn staff when a sandboxed web activity runtime is installed, without blocking review', async () => {
    await publish(sandboxedCourse());
    const course = (await call(owner, 'GET', '/api/admin/session')).json().courses.find((c: { workspaceId?: string }) => c.workspaceId === workspace);
    const view = (await call(owner, 'GET', `/api/admin/courses/${course.id}`)).json();
    const warning = view.releases[0].checks.find((c: { code: string }) => c.code === 'SANDBOXED_WEB_ACTIVITIES');
    // A code the admin app words (releaseChecks namespace); no English prose from the server.
    expect(warning).toEqual({ code: 'SANDBOXED_WEB_ACTIVITIES', passed: true, warning: true });
    const bare = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [declarativeActivityRuntime()] });
    try {
      const checks = (await call(owner, 'GET', `/api/admin/courses/${course.id}`, undefined, bare)).json().releases[0].checks;
      expect(checks.map((c: { code: string }) => c.code)).not.toContain('SANDBOXED_WEB_ACTIVITIES');
    } finally { await bare.close(); }
  });
});

describe('broker budgets', () => {
  it('records a bounded number of small denial events, then answers 429; state saves are limited too', async () => {
    const release = await publish(activityCourse(activityDefinition({ evaluatorRef: undefined }))), enrollment = await enroll(release);
    const id = (await launch(enrollment)).json().instanceId as string;
    const big = { blob: 'x'.repeat(90_000) };
    const denied: number[] = [];
    for (let i = 0; i < DENIED_CALLS_PER_MINUTE + 3; i++) denied.push((await broker(enrollment, id, { capability: 'network.fetch', payload: big })).statusCode);
    expect(denied).toEqual([...Array(DENIED_CALLS_PER_MINUTE).fill(403), 429, 429, 429]);
    const events = (await db.query("SELECT octet_length(payload::text) AS bytes FROM learning_events WHERE enrollment_id=$1 AND event_type='activity.capability_denied'", [enrollment])).rows;
    expect(events).toHaveLength(DENIED_CALLS_PER_MINUTE);
    // The request payload is never stored on a denial event.
    expect(Math.max(...events.map(e => Number(e.bytes)))).toBeLessThan(200);
    // A budget window that has passed opens again.
    await db.query("UPDATE activity_instances SET denial_window_start=denial_window_start - interval '2 minutes' WHERE id=$1", [id]);
    expect((await broker(enrollment, id, { capability: 'network.fetch' })).statusCode).toBe(403);

    let revision = 1;
    const saves: number[] = [];
    for (let i = 0; i < STATE_SAVES_PER_MINUTE + 1; i++) {
      const r = await broker(enrollment, id, { capability: 'state.patch', expectedStateRevision: revision, payload: { state: { values: { value: i % 10 } } } });
      saves.push(r.statusCode);
      if (r.statusCode === 200) revision = r.json().stateRevision;
    }
    expect(saves.slice(0, STATE_SAVES_PER_MINUTE).every(code => code === 200)).toBe(true);
    expect([saves.at(-1), revision]).toEqual([429, STATE_SAVES_PER_MINUTE + 1]);
    // Oversized bodies are refused before any work.
    expect((await broker(enrollment, id, { capability: 'network.fetch', payload: { blob: 'x'.repeat(100_000) } })).statusCode).toBe(413);
  });
});

describe('sandboxed web activity', () => {
  it('serves the frame under an opaque-origin, network-less policy and never grants what the runtime does not offer', async () => {
    const release = await publish(sandboxedCourse()), enrollment = await enroll(release);
    const view = (await launch(enrollment, 'web_mobile')).json();
    expect(view).toMatchObject({ mode: 'run', execution: 'sandboxed_web', grantedCapabilities: ['state.read', 'observation.emit'], evaluated: false,
      frameUrl: '/api/activity-frames/synthetic-sandboxed-activity/1.0.0' });
    const frame = await app.inject({ method: 'GET', url: view.frameUrl });
    expect(frame.statusCode).toBe(200);
    const csp = String(frame.headers['content-security-policy']);
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(frame.headers['set-cookie']).toBeUndefined();
    expect(frame.body).toContain('courseActivity');
    expect((await app.inject({ method: 'GET', url: '/api/activity-frames/course-core-declarative-activity/1.0.0' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/activity-frames/synthetic-sandboxed-activity/0.9.0' })).statusCode).toBe(404);
    // Every other response keeps refusing to be framed.
    expect(String((await app.inject({ method: 'GET', url: '/health' })).headers['content-security-policy'])).toContain("frame-ancestors 'none'");

    // Declared but not offered by the runtime: denied like any undeclared capability.
    const patch = await broker(enrollment, view.instanceId, { capability: 'state.patch', expectedStateRevision: 1, payload: { state: { x: 1 } } });
    expect([patch.statusCode, patch.json().error]).toEqual([403, 'ACTIVITY_CAPABILITY_DENIED']);
    expect((await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='activity.capability_denied'", [enrollment])).rows[0].payload)
      .toMatchObject({ capability: 'state.patch', declared: true });
    // Practice: the observation covers the block but is never evidence.
    const observed = await broker(enrollment, view.instanceId, { capability: 'observation.emit', payload: { observation: { kind: 'probe', ok: true } } });
    expect(observed.json()).toMatchObject({ evaluation: { status: 'not_evaluated' }, satisfied: true });
    expect(await count('SELECT count(*)::int AS n FROM activity_evidence WHERE enrollment_id=$1', [enrollment])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1', [enrollment])).toBe(0);
  });

  it('exports the learner\'s activity record and erases its content', async () => {
    const release = await publish(sandboxedCourse()), enrollment = await enroll(release);
    const id = (await launch(enrollment)).json().instanceId, canary = 'CANARY-' + randomUUID();
    await broker(enrollment, id, { capability: 'observation.emit', payload: { observation: { kind: 'probe', note: canary } } });
    const exported = (await call(learner, 'GET', `/api/enrollments/${enrollment}/export`)).json();
    expect(exported.activities.instances.items).toHaveLength(1);
    expect(exported.activities.observations.items[0].observation.note).toBe(canary);
    // An owner's copy keeps that the activity was done and its outcome, never the learner's work.
    const staff = await call(owner, 'GET', `/api/enrollments/${enrollment}/export`);
    expect(staff.statusCode, staff.body).toBe(200);
    const copy = staff.json();
    expect(copy.audience).toBe('staff');
    expect(copy.withheld.map((w: { id: string }) => w.id)).toContain('activity-work');
    expect(copy.withheld.find((w: { id: string }) => w.id === 'drafts').reason).toBe("Drafts stay on the learner's device and are never sent to the server.");
    expect(copy.activities.instances.items[0]).toMatchObject({ activity_id: 'sandbox-probe', state: null });
    expect(copy.activities.instances.items[0].satisfied_at).not.toBeNull();
    expect(copy.activities.observations.items[0]).toMatchObject({ observation: null, evaluation: { status: 'not_evaluated', satisfied: true } });
    expect(staff.body).not.toContain(canary);
    const erased = await call(owner, 'POST', `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: 'Learner asked for their course data to be removed.' });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(await count("SELECT count(*)::int AS n FROM activity_observations o WHERE o.enrollment_id=$1 AND o::text LIKE $2", [enrollment, '%' + canary + '%'])).toBe(0);
  });
});
