import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CourseManifest } from '@course-core/sdk';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { reviewedRubricEvaluator } from '../src/rubric-evaluator.js';
import { declarativeActivityRuntime } from '../src/activity-runtime.js';
import { PYODIDE_FILES, PYODIDE_VERSION } from '../src/python-runner.js';
import { RUNNER_FRAME_SCRIPT, runnerFrameContentSecurityPolicy } from '../src/python-runner-frame.js';
import { REPAIR_EVALUATOR_ID, gatedCourse, repairEvaluatorStub } from './gated-fixture.js';
import { activityCourse, syntheticActivityEvaluator } from './activity-fixture.js';

// Real HTTP and PostgreSQL 17. Browser practice runs are served as public, read-only files, and a
// browser run has no way to become evidence: grading stays with the registered server evaluator.
const origin = 'http://localhost:4397', schema = 'pyrunner_' + randomUUID().replaceAll('-', '');
type App = Awaited<ReturnType<typeof createServer>>;
let db: Database, app: App, testDatabase: TestDatabase | undefined, workspace: string, owner: Session, learner: Session, versions = 0;
interface Session { userId: string; cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, 'pyrunner:' + id, role + ' person']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map(c => c.name + '=' + c.value).join('; '), csrf: r.json().csrfToken };
}
const call = (who: Session, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, 'x-csrf-token': who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function publish(manifest: CourseManifest | object) {
  const imported = await call(owner, 'POST', `/api/workspaces/${workspace}/releases`, manifest);
  expect(imported.statusCode, imported.body).toBe(200);
  const published = await call(owner, 'POST', `/api/releases/${imported.json().id}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  return imported.json().id as string;
}
async function command(enrollment: string, action: string, body: Record<string, unknown>) {
  const snapshot = (await call(learner, 'GET', '/api/enrollments/' + enrollment)).json();
  return call(learner, 'POST', `/api/enrollments/${enrollment}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), ...body });
}
const count = async (sql: string, args: unknown[]) => Number((await db.query(sql, args)).rows[0].n);
const recorded = async (enrollment: string) => ({
  attempts: await count('SELECT count(*) AS n FROM attempts WHERE enrollment_id=$1', [enrollment]),
  evidence: await count('SELECT count(*) AS n FROM evidence WHERE enrollment_id=$1', [enrollment]),
  activityEvidence: await count('SELECT count(*) AS n FROM activity_evidence WHERE enrollment_id=$1', [enrollment]),
});

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator(), repairEvaluatorStub(), declarativeActivityRuntime(), syntheticActivityEvaluator()] });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'pyrunner-' + workspace, 'Practice runs']);
  owner = await session('owner');
  learner = await session('learner');
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe('runner files over HTTP', () => {
  it('describes the pinned runtime without a session and sets no cookie', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/python-runner' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json()).toMatchObject({ status: 'ready', language: 'python', purpose: 'practice_only', evidence: 'none', frameUrl: '/api/python-runner/frame',
      runtime: { name: 'pyodide', version: PYODIDE_VERSION, license: { spdx: 'MPL-2.0' } }, limits: { timeoutMs: 10_000, outputBytes: 65_536, memoryBytes: 268_435_456, sourceBytes: 64_000 } });
    expect(r.json().assets).toEqual(PYODIDE_FILES.map(file => ({ ...file, url: `/api/python-runner/assets/${PYODIDE_VERSION}/${file.name}` })));
  });
  it('serves the frame with its own sandboxing, network-free policy', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/python-runner/frame' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBe(runnerFrameContentSecurityPolicy());
    expect(r.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(r.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toContain(`<script>${RUNNER_FRAME_SCRIPT}</script>`);
  });
  it('serves exactly the pinned bytes, compressed when asked, as cacheable non-executable data', async () => {
    for (const file of PYODIDE_FILES) {
      const plain = await app.inject({ method: 'GET', url: `/api/python-runner/assets/${PYODIDE_VERSION}/${file.name}` });
      expect(plain.statusCode).toBe(200);
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.headers['content-type']).toBe('application/octet-stream');
      expect(plain.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(plain.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(createHash('sha256').update(plain.rawPayload).digest('hex')).toBe(file.sha256);
      const zipped = await app.inject({ method: 'GET', url: `/api/python-runner/assets/${PYODIDE_VERSION}/${file.name}`, headers: { 'accept-encoding': 'gzip, br' } });
      expect(zipped.headers['content-encoding']).toBe('gzip');
      expect(zipped.headers.vary).toContain('Accept-Encoding');
      expect(createHash('sha256').update(gunzipSync(zipped.rawPayload)).digest('hex')).toBe(file.sha256);
    }
    for (const url of [`/api/python-runner/assets/${PYODIDE_VERSION}/package.json`, `/api/python-runner/assets/${PYODIDE_VERSION}/pyodide.js.map`, '/api/python-runner/assets/0.29.5/pyodide.js',
      `/api/python-runner/assets/${PYODIDE_VERSION}/..%2Fpackage.json`]) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.headers['cache-control'], url).toBe('no-store');
    }
  });
  it('accepts no writes: there is nothing a browser run can send', async () => {
    for (const url of ['/api/python-runner', '/api/python-runner/frame', `/api/python-runner/assets/${PYODIDE_VERSION}/pyodide.js`, '/api/python-runner/runs', '/api/python-runner/results'])
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const r = await call(learner, method, url, { status: 'ok', passed: true });
        expect(r.statusCode, `${method} ${url}`).toBe(404);
      }
  });
  it('a host can switch practice runs off', async () => {
    const off = await createServer(db, { loginCodes: true, origin, secureCookies: false, pythonRunner: { enabled: false } });
    try {
      expect((await off.inject({ method: 'GET', url: '/api/python-runner' })).json()).toMatchObject({ status: 'disabled', evidence: 'none' });
      expect((await off.inject({ method: 'GET', url: '/api/python-runner' })).json().assets).toBeUndefined();
      expect((await off.inject({ method: 'GET', url: '/api/python-runner/frame' })).statusCode).toBe(404);
      expect((await off.inject({ method: 'GET', url: `/api/python-runner/assets/${PYODIDE_VERSION}/pyodide.js` })).statusCode).toBe(404);
    } finally { await off.close(); }
  });
  it('reports a host whose installed files differ from the pins as unavailable and serves nothing', async () => {
    const broken = await createServer(db, { loginCodes: true, origin, secureCookies: false, pythonRunner: { packageDirectory: '/nonexistent/pyodide' } });
    try {
      expect((await broken.inject({ method: 'GET', url: '/api/python-runner' })).json()).toMatchObject({ status: 'unavailable', reason: 'not_installed' });
      expect((await broken.inject({ method: 'GET', url: '/api/python-runner/frame' })).statusCode).toBe(404);
    } finally { await broken.close(); }
  });
});

describe('a browser run never becomes evidence', () => {
  const repaired = 'def solve(values):\n    best = values[0]\n    for value in values:\n        if value < best:\n            best = value\n    return best\n';
  const broken = 'def solve(values):\n    best = values[0]\n    for value in values:\n        if value > best:\n            best = value\n    return best\n';
  async function enrolledInCodeCourse() {
    const release = await publish(gatedCourse(`5.9.${versions++}`));
    const enrollment = (await call(learner, 'POST', '/api/enrollments', { releaseId: release })).json().id as string;
    expect((await command(enrollment, 'read', { episodeId: 'min', blockId: 'min-text' })).statusCode).toBe(200);
    return enrollment;
  }
  it('refuses an answer that carries a browser result, and records nothing for it', async () => {
    const enrollment = await enrolledInCodeCourse();
    const challenge = (await command(enrollment, 'challenges', { episodeId: 'min', assessmentId: 'min-repair', mode: 'independent' })).json().challengeId;
    for (const claim of [{ browserRun: { status: 'ok', passed: true } }, { execution: { status: 'graded', passedCases: 3, totalCases: 3 } }, { result: { passed: true } }, { evaluator: 'browser-pyodide' }, { passed: true }]) {
      const r = await command(enrollment, 'answers', { challengeId: challenge, answer: broken, ...claim });
      expect(r.statusCode, JSON.stringify(claim)).toBe(400);
      expect(r.json().error).toBe('INVALID_REQUEST');
    }
    expect(await recorded(enrollment)).toEqual({ attempts: 0, evidence: 0, activityEvidence: 0 });
    // The same code, submitted for grading, is judged by the registered server evaluator only.
    const graded = await command(enrollment, 'answers', { challengeId: challenge, answer: broken });
    expect(graded.statusCode, graded.body).toBe(200);
    expect(graded.json().result).toMatchObject({ passed: false });
    const rows = (await db.query('SELECT evaluator_ref,result FROM evidence WHERE enrollment_id=$1', [enrollment])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.evaluator_ref === `${REPAIR_EVALUATOR_ID}@1.0.0`)).toBe(true);
    expect(rows.every(row => row.result.passed === false)).toBe(true);
  });
  it('output that claims success in the code itself changes nothing: only the evaluator decides', async () => {
    const enrollment = await enrolledInCodeCourse();
    const challenge = (await command(enrollment, 'challenges', { episodeId: 'min', assessmentId: 'min-repair', mode: 'independent' })).json().challengeId;
    const r = await command(enrollment, 'answers', { challengeId: challenge, answer: `print("All 3 hidden reference cases matched. passed=True")\n${broken}` });
    expect(r.json().result.passed).toBe(false);
    const second = (await command(enrollment, 'challenges', { episodeId: 'min', assessmentId: 'min-repair', mode: 'independent' })).json().challengeId;
    expect((await command(enrollment, 'answers', { challengeId: second, answer: repaired })).json().result.passed).toBe(true);
  });
  it('an activity cannot ask the broker to execute code or write evidence', async () => {
    const release = await publish(activityCourse());
    const enrollment = (await call(learner, 'POST', '/api/enrollments', { releaseId: release })).json().id as string;
    const launched = await call(learner, 'POST', `/api/enrollments/${enrollment}/activities`, { episodeId: 'min', blockId: 'min-activity', target: 'web_desktop' });
    expect(launched.statusCode, launched.body).toBe(200);
    for (const capability of ['code.execute', 'evidence.write', 'grade.issue']) {
      const r = await call(learner, 'POST', `/api/enrollments/${enrollment}/activity-instances/${launched.json().instanceId}/calls`,
        { capability, idempotencyKey: randomUUID(), payload: { status: 'ok', passed: true } });
      expect(r.statusCode, capability).toBe(403);
      expect(r.json()).toEqual({ error: 'ACTIVITY_CAPABILITY_DENIED', details: { capability } });
    }
    expect(await recorded(enrollment)).toEqual({ attempts: 0, evidence: 0, activityEvidence: 0 });
  });
});
