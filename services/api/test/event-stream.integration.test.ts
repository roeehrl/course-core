import { randomUUID } from 'node:crypto';
import { get, type IncomingMessage, type ServerResponse } from 'node:http';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { appendEvent } from '../src/events.js';
import { migrate } from '../src/migrations.js';
import { parseClientEnvelope } from '../src/event-envelope.js';
import { fixture } from './fixture.js';

const schema = `course_event_stream_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://127.0.0.1';
let db: Database, app: Awaited<ReturnType<typeof createServer>>, base: string, workspaceId: string, releaseId: string, digest: string;
let testDatabase: TestDatabase | undefined;
const serverStreams = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>();

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  // Short bounds so lifetime, heartbeat and access checks happen within a test.
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false,
    eventStream: { pollMs: 40, heartbeatMs: 150, recheckMs: 200, lifetimeMs: 3000, perAccount: 2 } });
  base = await app.listen({ port: 0, host: '127.0.0.1' });
  // Each test stream is tagged so the test can wait until the server has released it.
  app.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const tag = request.headers['x-test-stream'];
    if (typeof tag === 'string') serverStreams.get(tag)?.(request, response);
  });
  const compiled = compileCourse(fixture()), owner = randomUUID();
  workspaceId = randomUUID(); releaseId = randomUUID(); digest = compiled.digest;
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `stream:${owner}`, 'Author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `stream-${workspaceId}`, 'Stream tests']);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

type Learner = { id: string; user: string; headers: Record<string, string> };
async function fresh(role = 'learner'): Promise<Learner> {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `stream:${user}`, 'Learner']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, user, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  expect(login.statusCode, login.body).toBe(200);
  const headers = { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
  const enrolled = role === 'learner' ? await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } }) : undefined;
  return { id: enrolled?.json().id, user, headers };
}
const revision = async (id: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
async function command(f: Learner, action: string, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/${action}`, headers: { ...f.headers, ...extra }, payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), ...body } });
}
type Opened = { status: number; type: string | undefined };
type Streamed = Opened & { text: string; events: { id: string; data: Record<string, any> }[] };
/**
 * Opens a real SSE request on its own connection, as each EventSource holds one. Not fetch():
 * Node 26's fetch re-validates an idle keep-alive connection on an unref'd immediate before
 * reusing it, so a request on a pooled connection can wait until something else wakes the event
 * loop, often longer than a stream deadline (it surfaced here as an AbortError).
 * `opened` resolves with the response status once the server has answered (a 200 stream is
 * then counted against its account); `done` resolves when the stream ends, `until` matches or
 * `close()` is called; `released` resolves once the server has seen the stream close.
 */
function openStream(f: { headers: Record<string, string> }, id: string, options: { lastEventId?: string; after?: string; until?: (text: string) => boolean;
  /** Called on the server as the request arrives, before the route handler has done any work. */
  arrived?: (request: IncomingMessage, response: ServerResponse) => void } = {}) {
  const tag = randomUUID();
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  // The server's own 'close' listeners run in the same emit; the stream slot is free after it.
  serverStreams.set(tag, (request, response) => {
    request.once('close', () => { serverStreams.delete(tag); setImmediate(release); });
    options.arrived?.(request, response);
  });
  const request = get(`${base}/api/enrollments/${id}/events/stream${options.after ? `?after=${options.after}` : ''}`, { agent: false,
    headers: { cookie: f.headers.cookie!, 'x-test-stream': tag, ...(options.lastEventId ? { 'last-event-id': options.lastEventId } : {}) } });
  const response = new Promise<IncomingMessage>((resolve, reject) => { request.once('response', resolve); request.once('error', reject); });
  const opened = response.then(r => ({ status: r.statusCode!, type: r.headers['content-type'] }));
  const done = response.then(r => new Promise<Streamed>(resolve => {
    let text = '';
    r.setEncoding('utf8');
    r.on('data', (chunk: string) => { text += chunk; if (options.until?.(text)) request.destroy(); });
    r.once('close', () => resolve({ status: r.statusCode!, type: r.headers['content-type'], text,
      events: [...text.matchAll(/id: (\d+)\nevent: learning-event\ndata: (.*)\n\n/g)].map(match => ({ id: match[1]!, data: JSON.parse(match[2]!) })) }));
  }));
  // A request closed by the test (or the server) reports an error; callers that care await `opened`/`done`.
  request.on('error', () => undefined);
  opened.catch(() => undefined); done.catch(() => undefined);
  return { opened, done, released, close: () => request.destroy() };
}
/** Reads a stream until `until` matches or the server ends it; without `until`, only its status. */
async function stream(f: { headers: Record<string, string> }, id: string, options: { lastEventId?: string; after?: string; until?: (text: string) => boolean } = {}) {
  const open = openStream(f, id, options);
  if (!options.until) { await open.opened; open.close(); }
  return open.done;
}

describe('learning-event envelope', () => {
  it('records the client, course version, attempt and check instance; ignores malformed client facts', async () => {
    const f = await fresh();
    const occurred = new Date(Date.now() - 60_000).toISOString();
    const read = await command(f, 'read', { episodeId: 'min', blockId: 'min-text' },
      { 'x-course-platform': 'web', 'x-course-app-version': '0.1.0', 'x-course-client-sequence': '42', 'x-course-occurred-at': occurred });
    expect(read.statusCode, read.body).toBe(200);
    const row = (await db.query("SELECT * FROM learning_events WHERE enrollment_id=$1 AND event_type='block.read'", [f.id])).rows[0];
    expect(row).toMatchObject({ schema_version: 1, platform: 'web', app_version: '0.1.0', client_sequence: '42', course_digest: digest, attempt_id: null, causation_id: null });
    expect(row.occurred_at.toISOString()).toBe(occurred);
    expect(row.received_at).toBeInstanceOf(Date);
    // An answer records its attempt and the check instance it answered.
    const issued = await command(f, 'challenges', { episodeId: 'min', assessmentId: 'min-a', mode: 'practice' }, { 'x-course-platform': 'toaster', 'x-course-occurred-at': '2001-01-01T00:00:00Z', 'x-course-app-version': 'bad version!' });
    expect(issued.statusCode, issued.body).toBe(200);
    const answered = await command(f, 'answers', { challengeId: issued.json().challengeId, answer: 'two' });
    expect(answered.statusCode, answered.body).toBe(200);
    const submitted = (await db.query("SELECT * FROM learning_events WHERE enrollment_id=$1 AND event_type='assessment.submitted'", [f.id])).rows[0];
    const attempt = (await db.query('SELECT id FROM attempts WHERE enrollment_id=$1', [f.id])).rows[0].id;
    expect(submitted).toMatchObject({ attempt_id: attempt, activity_instance_id: issued.json().challengeId, course_digest: digest });
    // The malformed facts sent with the check request were ignored, not stored.
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND (platform='toaster' OR app_version='bad version!' OR occurred_at<'2002-01-01')", [f.id])).rows[0].n).toBe(0);
    // Background work has no request and records no client facts.
    const background = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId: f.id, actorKind: 'system', type: 'synthetic.background', payload: {}, idempotencyKey: randomUUID(), causationId: row.id }));
    expect((await db.query('SELECT platform,causation_id,course_digest FROM learning_events WHERE id=$1', [background.id])).rows[0]).toEqual({ platform: null, causation_id: row.id, course_digest: digest });
    // GET /events carries the envelope.
    const events = (await app.inject({ url: `/api/enrollments/${f.id}/events`, headers: f.headers })).json().events;
    expect(events.find((event: { event_type: string }) => event.event_type === 'block.read')).toMatchObject({ platform: 'web', client_sequence: '42', course_digest: digest });
  });

  it('parses only well-formed, recent client facts', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(parseClientEnvelope({ 'x-course-platform': 'ios', 'x-course-app-version': '2.0.1+5', 'x-course-client-sequence': '7', 'x-course-occurred-at': '2026-10-15T11:59:00Z' }, now))
      .toEqual({ platform: 'ios', appVersion: '2.0.1+5', clientSequence: 7, occurredAt: '2026-10-15T11:59:00.000Z' });
    expect(parseClientEnvelope({ 'x-course-platform': 'server', 'x-course-app-version': 'x'.repeat(65), 'x-course-client-sequence': '-1', 'x-course-occurred-at': '2026-11-15T12:00:00Z' }, now)).toEqual({});
    expect(parseClientEnvelope({ 'x-course-client-sequence': '1'.repeat(16), 'x-course-occurred-at': 'yesterday' }, now)).toEqual({});
  });
});

describe('resumable event stream', () => {
  it('streams, resumes after Last-Event-ID, heartbeats and asks the client to reconnect', async () => {
    const f = await fresh();
    await command(f, 'read', { episodeId: 'min', blockId: 'min-text' });
    const first = await stream(f, f.id, { until: text => text.includes('event: reconnect') });
    expect(first.status).toBe(200);
    expect(first.type).toContain('text/event-stream');
    expect(first.events.map(event => event.data.event_type)).toEqual(['enrollment.started', 'block.read']);
    expect(first.events[1]!.data).toMatchObject({ course_digest: digest, schema_version: 1 });
    expect(first.text).toContain(': heartbeat');
    expect(first.text).toContain('event: reconnect');
    // Resuming after the last id returns only later events, including one appended while connected.
    const resumed = openStream(f, f.id, { lastEventId: first.events.at(-1)!.id, until: text => text.includes('companion.requested') });
    expect((await resumed.opened).status).toBe(200);
    expect((await command(f, 'companion', { episodeId: 'min', content: 'Live question?' })).statusCode).toBe(200);
    const second = await resumed.done;
    expect(second.events.map(event => event.data.event_type)).toEqual(['companion.requested']);
    expect(BigInt(second.events[0]!.id)).toBeGreaterThan(BigInt(first.events.at(-1)!.id));
    // ?after= starts after a known cursor; Last-Event-ID wins when both are given.
    const after = await stream(f, f.id, { after: first.events[0]!.id, until: text => text.includes('companion.requested') });
    expect(after.events.map(event => event.data.event_type)).toEqual(['block.read', 'companion.requested']);
  });

  it('gives staff the same payload rule as GET /events: allowlisted payloads only', async () => {
    const f = await fresh(), owner = await fresh('owner');
    await command(f, 'read', { episodeId: 'min', blockId: 'min-text' });
    expect((await command(f, 'companion', { episodeId: 'min', content: 'STREAM_PRIVATE_QUESTION' })).statusCode).toBe(200);
    const paged = await app.inject({ url: `/api/enrollments/${f.id}/events`, headers: owner.headers });
    expect(paged.statusCode, paged.body).toBe(200);
    const streamed = await stream(owner, f.id, { until: text => text.includes('companion.requested') });
    expect(streamed.status).toBe(200);
    const pick = (row: Record<string, unknown>) => ({ event_type: row.event_type, payload: row.payload, payloadWithheld: row.payloadWithheld });
    expect(streamed.events.map(event => pick(event.data))).toEqual(paged.json().events.map(pick));
    expect(streamed.events.some(event => event.data.payloadWithheld === true)).toBe(true);
    // The learner's own stream carries every payload.
    const own = await stream(f, f.id, { until: text => text.includes('companion.requested') });
    expect(own.events.every(event => event.data.payloadWithheld === false)).toBe(true);
  });

  it('refuses other learners, anonymous callers and too many streams, and ends when access ends', async () => {
    const f = await fresh(), peer = await fresh();
    expect((await stream(peer, f.id)).status).toBe(404);
    expect((await stream({ headers: { cookie: '' } }, f.id)).status).toBe(401);
    expect((await stream(f, f.id, { after: 'abc' })).status).toBe(400);
    // Two streams per account; a third is refused until one closes.
    const open = [openStream(f, f.id), openStream(f, f.id)];
    expect((await Promise.all(open.map(each => each.opened))).map(each => each.status)).toEqual([200, 200]);
    expect((await stream(f, f.id)).status).toBe(429);
    open[0]!.close();
    await open[0]!.released;
    const reopened = openStream(f, f.id);
    expect((await reopened.opened).status).toBe(200);
    expect((await stream(f, f.id)).status).toBe(429);
    for (const each of [open[1]!, reopened]) { each.close(); await each.released; }
    // A client that leaves while its access is still being checked frees its slot at once,
    // instead of holding it (and polling) until the stream's lifetime runs out.
    const left = await Promise.all([0, 1, 2].map(() => new Promise<string>(resolve => {
      openStream(f, f.id, { arrived: (request, response) => {
        let written = '';
        const write = response.write.bind(response) as (chunk: unknown) => boolean, end = response.end.bind(response) as () => ServerResponse;
        response.write = ((chunk: unknown) => { written += String(chunk); return write(chunk); }) as typeof response.write;
        response.end = (() => { resolve(written); return end(); }) as typeof response.end;
        request.socket.destroy();
      } });
    })));
    expect(left.filter(text => text.includes('event: reconnect') || text.includes(': heartbeat'))).toEqual([]);
    expect((await stream(f, f.id)).status).toBe(200);
    // Erasure while connected: the stream says so and ends; a new stream is refused (410).
    // The stream's lifetime (3 s) must outlast the erasure, which writes to every learner table;
    // a stream that reached its lifetime first would only ask the client to reconnect.
    const live = openStream(f, f.id, { until: text => text.includes('event: closed') });
    expect((await live.opened).status).toBe(200);
    const erased = await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/erase`, headers: f.headers, payload: { confirmation: `ERASE ${f.id.slice(0, 8)}`, reason: 'Synthetic erasure request.' } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await live.done).text).toContain('"reason":"access_changed"');
    expect((await stream(f, f.id)).status).toBe(410);
    // Erasure clears the device facts and keeps the identifiers.
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND (platform IS NOT NULL OR app_version IS NOT NULL OR occurred_at IS NOT NULL OR client_sequence IS NOT NULL)", [f.id])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND course_digest=$2", [f.id, digest])).rows[0].n).toBeGreaterThan(0);
  });
});

describe('erasure and migration coherence (S11)', () => {
  // Runs every migration from an empty schema, the same budget as the other such tests (database-template, catalogue, session-purge).
  it('an enrollment erased before the envelope migration stays erased and unreadable after it', async () => {
    const directory = fileURLToPath(new URL('../migrations', import.meta.url));
    const older = await mkdtemp(join(tmpdir(), 'course-core-migrations-'));
    const legacySchema = `legacy_envelope_${randomUUID().replaceAll('-', '')}`;
    try {
      await cp(directory, older, { recursive: true, filter: source => !source.endsWith('054_event_envelope.sql') });
      await db.query(`CREATE SCHEMA ${legacySchema}`);
      const url = new URL(testDatabase!.url);
      url.searchParams.set("options", `-csearch_path=${legacySchema}`);
      const legacy = createDatabase(url.toString());
      try {
        expect(await migrate(legacy, older)).not.toContain('054_event_envelope.sql');
        // A learner erased under the previous schema (the redaction the erasure route performed then).
        const [owner, learner, workspace, release, enrollment] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        const compiled = compileCourse(fixture());
        await legacy.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3),($4,$5,$6)', [owner, `legacy:${owner}`, 'Author', learner, `legacy:${learner}`, 'Learner']);
        await legacy.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, `legacy-${workspace}`, 'Legacy']);
        await legacy.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
          [release, workspace, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
        await legacy.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspace, learner]);
        await legacy.query("INSERT INTO enrollments(id,workspace_id,course_release_id,user_id,policy,profile,status) VALUES($1,$2,$3,$4,$5,'{}','erased')", [enrollment, workspace, release, learner, JSON.stringify(compiled.server.policy)]);
        await legacy.query(`INSERT INTO learning_events(id,workspace_id,enrollment_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key)
          VALUES ($1,$2,$3,$4,'learner','companion.requested','{"erased":true}',$5,$6)`, [randomUUID(), workspace, enrollment, learner, randomUUID(), randomUUID()]);
        const applied = await migrate(legacy, directory);
        expect(applied).toEqual(['054_event_envelope.sql']);
        // Nothing is backfilled into the erased rows: no device facts and no course version are invented.
        expect((await legacy.query('SELECT payload,schema_version,platform,app_version,client_sequence,occurred_at,received_at,course_digest,attempt_id FROM learning_events WHERE enrollment_id=$1', [enrollment])).rows)
          .toEqual([{ payload: { erased: true }, schema_version: 1, platform: null, app_version: null, client_sequence: null, occurred_at: null, received_at: null, course_digest: null, attempt_id: null }]);
        expect((await legacy.query('SELECT status,profile FROM enrollments WHERE id=$1', [enrollment])).rows[0]).toEqual({ status: 'erased', profile: {} });
        // The new code reads the migrated schema: the erased enrollment is gone for its learner.
        const server = await createServer(legacy, { loginCodes: true, origin: 'http://127.0.0.1', secureCookies: false });
        try {
          const login = await server.inject({ method: 'POST', url: '/auth/redeem', headers: { origin: 'http://127.0.0.1' }, payload: { token: await issueLoginCode(legacy, learner) } });
          const cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
          for (const path of ['/events', '/events/stream', '/companion', ''])
            expect((await server.inject({ url: `/api/enrollments/${enrollment}${path}`, headers: { cookie } })).statusCode, path).toBe(410);
        } finally { await server.close(); }
      } finally { await legacy.end(); }
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
      await rm(older, { recursive: true, force: true });
    }
  }, 30_000);
});
