import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DockerSandbox, QUALIFIED_IMAGES } from '@course-core/sandbox';
import { createDatabase } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { codeEvaluator } from '../src/code-evaluator.js';
import { fixture } from '../test/fixture.js';

// Required explicit real-Docker/real-Postgres qualification, separate from fast API tests.
if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use only a disposable TEST_DATABASE_URL.');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Disposable loopback test database required.');
const schema = `course_code_${randomUUID().replaceAll('-', '')}`, admin = createDatabase(url.toString());
const root = fileURLToPath(new URL('../.local/', import.meta.url)); await mkdir(root, { recursive: true, mode: 0o700 });
const storage = await mkdtemp(path.join(root, 'practical-test-'));
await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
const db = createDatabase(url.toString());
let app: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const image = process.env.COURSE_SANDBOX_IMAGE ?? QUALIFIED_IMAGES[process.arch as keyof typeof QUALIFIED_IMAGES];
  assert(image, 'Pin a qualified image for this platform.');
  const sandbox = new DockerSandbox({ image, storageDirectory: storage });
  assert.equal((await sandbox.readiness()).ready, true, 'Real Docker isolation and the pinned image are required.');
  const registry = await codeEvaluator(Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'public-comparison-code', version: '0.1.0', fixtures: [{ id: 'minimum-json', language: 'python', cases: [
    { id: 'negative', input: [-3, -8], expected: -8 }, { id: 'positive', input: [4, 1], expected: 1 }, { id: 'zero', input: [0, 3], expected: 0 }, { id: 'reversed', input: [9, 2], expected: 2 },
  ] }] })), sandbox);
  const course = fixture();
  course.extensions.push({ id: registry.id, version: registry.version, integrity: registry.integrity, execution: 'server', entrypoint: 'fixtures/comparison.json', platforms: ['web'], capabilities: ['assessment.evaluate'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Submit a Python comparison function.' } });
  course.assessments.push({ id: 'min-code', type: 'code', familyId: 'implementation', objectiveIds: ['minimum'], language: 'python', starterCode: 'def solve(values):\n    pass\n', prompt: 'Implement solve(values), returning the minimum of a nonempty number list.', grading: { evaluatorId: registry.id, fixtureRef: 'minimum-json' } });
  course.gates[0]!.assessmentIds.push('min-code'); course.gates[0]!.minimumIndependentFamilies = 3;
  const workspaceId = randomUUID(), userId = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `test:${userId}`, 'Practical learner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, 'practical', 'Practical qualification']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, userId]);
  app = await createServer(db, { origin: 'http://localhost:4310', secureCookies: false, installedExtensions: [registry] });
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin: 'http://localhost:4310' }, payload: { token: await issueLoginCode(db, userId) } });
  assert.equal(login.statusCode, 200);
  const headers = { origin: 'http://localhost:4310', cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
  const send = (method: 'GET' | 'POST', url: string, payload?: object) => app!.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const imported = await send('POST', `/api/workspaces/${workspaceId}/releases`, course); assert.equal(imported.statusCode, 200, imported.body);
  const releaseId = imported.json().id;
  const published = await send('POST', `/api/releases/${releaseId}/publish`); assert.equal(published.statusCode, 200, published.body);
  const enrolled = await send('POST', '/api/enrollments', { releaseId }); assert.equal(enrolled.statusCode, 200, enrolled.body);
  const enrollmentId = enrolled.json().id;
  async function command(action: string, body: Record<string, unknown>) {
    const snapshot = (await send('GET', `/api/enrollments/${enrollmentId}`)).json();
    const result = await send('POST', `/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), ...body });
    assert.equal(result.statusCode, 200, result.body); return result.json();
  }
  const issued = await command('challenges', { episodeId: 'min', assessmentId: 'min-code', mode: 'independent' });
  assert.equal(issued.question.type, 'code'); assert(!('grading' in issued.question));
  const answer = { expectedRevision: issued.revision, idempotencyKey: randomUUID(), challengeId: issued.challengeId, answer: 'def solve(values):\n    return min(values)\n' };
  const [first, duplicate] = await Promise.all([send('POST', `/api/enrollments/${enrollmentId}/answers`, answer), send('POST', `/api/enrollments/${enrollmentId}/answers`, answer)]);
  assert.equal(first.statusCode, 200, first.body); assert.deepEqual(first.json(), duplicate.json());
  assert.equal(first.json().result.passed, true); assert.equal(first.json().result.execution.passedCases, 4);
  assert.equal((await db.query('SELECT count(*) FROM attempts WHERE enrollment_id=$1', [enrollmentId])).rows[0].count, '1');
  assert.equal((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1', [enrollmentId])).rows[0].count, '1');
  const repeated = await command('challenges', { episodeId: 'min', assessmentId: 'min-code', mode: 'practice' });
  const wrong = await command('answers', { challengeId: repeated.challengeId, answer: 'def solve(values):\n    return max(values)\n' });
  assert.equal(wrong.result.passed, false); assert.equal(wrong.result.independent, false);
  assert((await db.query("SELECT result FROM attempts WHERE enrollment_id=$1 AND result->>'passed'='false'", [enrollmentId])).rowCount);
  console.log(JSON.stringify({ verified: true, storage: 'real-postgresql', execution: 'real-container', matchingReferenceCases: 4, duplicateAnswerReplayed: true, wrongProgramRejected: true, privateOracleNotReturned: true }));
} finally {
  await app?.close(); await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); await rm(storage, { recursive: true, force: true });
}
