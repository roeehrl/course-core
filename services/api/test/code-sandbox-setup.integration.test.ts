import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GradeReport } from '@course-core/sandbox';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { issueLoginCode } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { codeEvaluator, type CodeSandbox } from '../src/code-evaluator.js';
import { codeRecoveryFixture, comparisonFixtures } from './code-recovery-fixture.js';

// Real HTTP and PostgreSQL with a scripted sandbox that reports each outcome: no code runs here.
// The sandbox's two clocks are qualified on real Docker in packages/sandbox, and this same path
// with a real slow container start in qualification/practical-flow.ts.
const origin = 'http://127.0.0.1:4396', schema = `code_setup_${randomUUID().replaceAll('-', '')}`;
type App = Awaited<ReturnType<typeof createServer>>;
let testDatabase: TestDatabase | undefined, db: Database, app: App | undefined, workspaceId: string, enrollmentId: string;
let headers: Record<string, string>;

let outcome: GradeReport['status'] = 'graded';
const slow: { setupTimeouts: number; lastSetupTimeoutAt: number | null } = { setupTimeouts: 0, lastSetupTimeoutAt: null };
const sandbox: CodeSandbox & { setupDiagnostics(): typeof slow } = {
  readiness: async () => ({ ready: true, reason: 'configured' }),
  grade: async ({ source, cases }) => {
    const status = outcome, ran = status === 'graded', passed = ran && source.includes('min(values)');
    if (status === 'setup_timeout') { slow.setupTimeouts += 1; slow.lastSetupTimeoutAt = Date.now(); }
    const executionMs = status === 'timeout' ? 5000 : ran ? 40 : 0;
    return { status, passed, cases: ran ? cases.map(c => ({ id: c.id, passed, reason: passed ? 'matched_reference' : 'output_mismatch' })) : [],
      sourceDigest: 'a'.repeat(64), durationMs: 60000 + executionMs, executionMs, setupMs: 60000, outputBytes: 0, batchesCompleted: ran ? 1 : 0,
      runtime: { protocol: 'python-json-v1', image: 'synthetic' } } satisfies GradeReport;
  },
  setupDiagnostics: () => ({ ...slow }),
};

const send = (method: 'GET' | 'POST', url: string, payload?: object) => app!.inject({ method, url, headers, ...(payload ? { payload } : {}) });
async function command(action: string, body: Record<string, unknown>) {
  const snapshot = (await send('GET', `/api/enrollments/${enrollmentId}`)).json();
  const result = await send('POST', `/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), ...body });
  expect(result.statusCode, result.body).toBe(200);
  return result.json();
}
const count = async (table: 'attempts' | 'evidence') => (await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE enrollment_id=$1`, [enrollmentId])).rows[0].n as number;
const sandboxCheck = async () => {
  const response = await send('GET', `/api/admin/workspaces/${workspaceId}/platform-readiness`);
  expect(response.statusCode, response.body).toBe(200);
  return (response.json().checks as { id: string; status: string; facts: Record<string, unknown> }[]).find(c => c.id === 'sandbox')!;
};

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const registry = await codeEvaluator(Buffer.from(JSON.stringify(comparisonFixtures)), sandbox);
  const recovery = codeRecoveryFixture(registry);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [registry], adaptation: recovery.runtime, sandbox });
  workspaceId = randomUUID();
  const userId = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `test:${userId}`, 'Setup learner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, 'code-setup', 'Code setup']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, userId]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(login.statusCode, login.body).toBe(200);
  headers = { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
  const imported = await send('POST', `/api/workspaces/${workspaceId}/releases`, recovery.course);
  expect(imported.statusCode, imported.body).toBe(200);
  const releaseId = imported.json().id;
  const approved = await send('POST', `/api/admin/releases/${releaseId}/adaptation-registry`, { expectedRegistryRevision: 0, configuration: recovery.config });
  expect(approved.statusCode, approved.body).toBe(200);
  expect((await send('POST', `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  const enrolled = await send('POST', '/api/enrollments', { releaseId });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  enrollmentId = enrolled.json().id;
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

describe('a code answer the sandbox was too slow to start', () => {
  it('is not graded or counted, and the same request is graded as the first attempt when sent again', async () => {
    expect((await sandboxCheck())).toEqual({ id: 'sandbox', status: 'ok', facts: { ready: true, reason: null, slowStarts: 0, lastSlowStartSeconds: null } });
    const issued = await command('challenges', { episodeId: 'min', assessmentId: 'min-code', mode: 'independent' });
    const answer = { expectedRevision: issued.revision, idempotencyKey: randomUUID(), challengeId: issued.challengeId, answer: 'def solve(values):\n    return min(values)\n' };
    outcome = 'setup_timeout';
    const refused = await send('POST', `/api/enrollments/${enrollmentId}/answers`, answer);
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toEqual({ error: 'CODE_SANDBOX_SETUP_SLOW' });
    // Nothing was recorded: no attempt, no evidence, the challenge is still open and the revision unchanged.
    expect(await count('attempts')).toBe(0); expect(await count('evidence')).toBe(0);
    expect((await db.query('SELECT attempt_id FROM assessment_challenges WHERE id=$1', [issued.challengeId])).rows[0].attempt_id).toBeNull();
    expect((await send('GET', `/api/enrollments/${enrollmentId}`)).json().revision).toBe(issued.revision);
    // Staff diagnostics: the readiness page marks the sandbox and counts the slow start.
    const marked = await sandboxCheck();
    expect(marked).toMatchObject({ status: 'warning', facts: { ready: true, reason: null, slowStarts: 1 } });
    expect(marked.facts.lastSlowStartSeconds).toBeLessThan(60);

    // The learner sends the same saved request again: it is graded once, as the first independent attempt.
    outcome = 'graded';
    const graded = await send('POST', `/api/enrollments/${enrollmentId}/answers`, answer);
    expect(graded.statusCode, graded.body).toBe(200);
    expect(graded.json().result).toMatchObject({ passed: true, independent: true, message: { code: 'code_all_matched' }, execution: { status: 'graded', executionMs: 40, setupMs: 60000 } });
    expect(await count('attempts')).toBe(1); expect(await count('evidence')).toBe(1);
    const replay = await send('POST', `/api/enrollments/${enrollmentId}/answers`, answer);
    expect(replay.json()).toEqual(graded.json());
    expect(await count('attempts')).toBe(1);
  });

  it('still records code that ran past the time limit as a counted, failed attempt', async () => {
    const issued = await command('challenges', { episodeId: 'min', assessmentId: 'min-code', mode: 'practice' });
    outcome = 'timeout';
    const result = await command('answers', { challengeId: issued.challengeId, answer: 'def solve(values):\n    while True: pass\n' });
    expect(result.result).toMatchObject({ passed: false, message: { code: 'code_limit', params: { limit: 'time' } }, execution: { status: 'timeout', executionMs: 5000 } });
    expect(await count('attempts')).toBe(2);
    outcome = 'graded';
  });

  it('clears the warning an hour after the last slow start, keeping the count', async () => {
    slow.lastSetupTimeoutAt = Date.now() - 2 * 3600_000;
    const check = await sandboxCheck();
    expect(check).toMatchObject({ status: 'ok', facts: { ready: true, slowStarts: 1 } });
    expect(check.facts.lastSlowStartSeconds).toBeGreaterThanOrEqual(7199);
  });
});
