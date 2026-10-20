import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { startTelemetry, telemetry } from '../src/telemetry.js';
import { fixture } from './fixture.js';

// U14: telemetry is on, but its collector is down (the OTLP endpoint is a port nobody listens on).
// Learner requests still succeed and their receipts and events commit; the span buffer stays within
// its configured bound; lost spans are counted and reported, never silent; shutdown is bounded.
const schema = `telemetry_down_${randomUUID().replaceAll('-', '')}`, workspace = randomUUID(), origin = 'http://localhost:4310';
const QUEUE = 16, notices: string[] = [];
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;

beforeAll(async () => {
  const closed = createHttpServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const runtime = await startTelemetry({ serviceName: 'course-core-api', notice: line => notices.push(line), env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_METRIC_EXPORT_INTERVAL: '1000', OTEL_BSP_MAX_QUEUE_SIZE: String(QUEUE), OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '8',
    OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_BSP_EXPORT_TIMEOUT: '1000' } });
  expect(runtime.tracing).toBe(true);
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
afterAll(async () => {
  await telemetry().shutdown();
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

it('keeps serving and recording while the collector is down, with a bounded span buffer and counted losses', async () => {
  const course = compileCourse(fixture()), releaseId = randomUUID(), learner = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'collector-down', 'Collector down']);
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [learner, `test:${learner}`, 'Collector learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspace, learner]);
  await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspace, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), learner]);
  const signIn = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, learner) } });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const headers = { cookie: signIn.cookies.map(c => `${c.name}=${c.value}`).join('; '), origin, 'x-csrf-token': signIn.json().csrfToken };
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const enrollment = enrolled.json().id as string;

  // A burst of reads and idempotent commands, far more spans than the queue holds.
  let peak = 0, slowest = 0;
  const keys: string[] = [];
  for (let round = 0; round < 8; round++) {
    const revision = (await app.inject({ method: 'GET', url: `/api/enrollments/${enrollment}`, headers })).json().revision as number;
    const key = randomUUID(); keys.push(key);
    const started = performance.now();
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: `/api/enrollments/${enrollment}/read`, headers, payload: { expectedRevision: revision, idempotencyKey: key, episodeId: 'min', blockId: 'min-text' } }),
      ...Array.from({ length: 12 }, () => app.inject({ method: 'GET', url: `/api/enrollments/${enrollment}`, headers })),
    ]);
    slowest = Math.max(slowest, performance.now() - started);
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    peak = Math.max(peak, telemetry().spanBuffer()!.queued);
  }
  // Requests never waited on the collector (each export attempt may take up to its 1 s timeout).
  expect(slowest).toBeLessThan(5000);
  const status = telemetry().spanBuffer()!;
  expect(peak).toBeLessThanOrEqual(QUEUE);
  expect(status.queued).toBeLessThanOrEqual(QUEUE);
  expect(status.exported).toBe(0);
  expect(status.dropped.queueFull).toBeGreaterThan(0);

  // Domain records are durable, and still name the trace that wrote them.
  const receipts = (await db.query('SELECT idempotency_key FROM command_receipts WHERE enrollment_id=$1', [enrollment])).rows.map(row => row.idempotency_key);
  expect(receipts.sort()).toEqual([...keys].sort());
  const events = (await db.query('SELECT event_type,trace_id FROM learning_events WHERE enrollment_id=$1', [enrollment])).rows;
  expect(events.length).toBeGreaterThanOrEqual(9);
  for (const event of events) expect(event.trace_id, event.event_type).toMatch(/^[0-9a-f]{32}$/);

  // Failed exports are counted too, and both kinds of loss are reported in fixed-code lines.
  const deadline = Date.now() + 15_000;
  while (telemetry().spanBuffer()!.dropped.exportFailed === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  expect(telemetry().spanBuffer()!.dropped.exportFailed).toBeGreaterThan(0);
  const reasons = notices.map(line => JSON.parse(line) as { code: string; reason: string; total: number });
  expect(new Set(reasons.map(notice => notice.reason))).toEqual(new Set(['queue_full', 'export_failed']));
  for (const notice of reasons) expect(Object.keys(notice)).toEqual(['code', 'reason', 'total']);
  expect(notices.join('')).not.toContain(enrollment);

  // Shutdown gives up on the dead collector within the export timeouts.
  const stopping = performance.now();
  await telemetry().shutdown();
  expect(performance.now() - stopping).toBeLessThan(10_000);
  expect(telemetry().enabled).toBe(false);
}, 60000);
