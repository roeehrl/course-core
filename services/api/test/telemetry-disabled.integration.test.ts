import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { startTelemetry, telemetry } from '../src/telemetry.js';
import { fixture } from './fixture.js';
import { otlpReceiver } from './otlp-receiver.js';

// Telemetry is off unless configured: even with an endpoint present, OTEL_SDK_DISABLED wins,
// no Fastify hook is installed and the receiver never sees a request.
const schema = `telemetry_off_${randomUUID().replaceAll('-', '')}`, workspace = randomUUID(), origin = 'http://localhost:4310';
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let receiver: Awaited<ReturnType<typeof otlpReceiver>>;
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use a disposable TEST_DATABASE_URL and unset DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Use a disposable loopback test database.');
  receiver = await otlpReceiver();
  expect((await startTelemetry({ serviceName: 'course-core-api', env: {} })).enabled).toBe(false);
  expect((await startTelemetry({ serviceName: 'course-core-api', env: { OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url } })).enabled).toBe(false);
  expect((await startTelemetry({ serviceName: 'course-core-api', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none' } })).enabled).toBe(false);
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
afterAll(async () => {
  await receiver?.close(); await app?.close(); await db?.end();
  await testDatabase?.drop();
});

it('serves learner requests and transactions without hooks, headers or any export when telemetry is off', async () => {
  expect(telemetry().enabled).toBe(false);
  const course = compileCourse(fixture()), releaseId = randomUUID(), learner = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'off', 'Telemetry off']);
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [learner, `test:${learner}`, 'Off learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspace, learner]);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspace, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), learner]);
  const signIn = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, learner) } });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const session = { cookie: signIn.cookies.map(c => `${c.name}=${c.value}`).join('; '), origin, 'x-csrf-token': signIn.json().csrfToken };
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: { ...session, traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  expect(enrolled.headers.traceparent).toBeUndefined();
  expect(await transaction(db, async client => (await client.query('SELECT 1 AS one')).rows[0].one)).toBe(1);
  await telemetry().flush(); await telemetry().shutdown();
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(receiver.received).toHaveLength(0);
});
