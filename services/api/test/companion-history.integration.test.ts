import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { fixture } from './fixture.js';

// Reading a long conversation in pages (Q7, "Show earlier messages"): the default read is the newest
// 100 messages and says whether older ones remain; `before` reads the page before a cursor, in a
// stable order even when messages share a time. A cursor that is not one is refused.
const origin = 'http://localhost:4313', schema = `course_companion_history_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, workspaceId: string, releaseId: string;
let testDatabase: TestDatabase | undefined;

type Learner = { id: string; headers: Record<string, string> };
type Page = { messages: { id: string; role: string; content: string; excluded?: boolean; feedback?: unknown }[]; earlier: boolean; before: string | null };
async function fresh(): Promise<Learner> {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `history:${user}`, 'Test learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspaceId, user]);
  const signed = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  const headers = { origin, cookie: signed.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': signed.json().csrfToken };
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  return { id: enrolled.json().id, headers };
}
/** `count` stored messages, alternating question and reply, a pair a second from `start`; every
 * fifth pair shares one time, so the order on equal times is exercised. */
async function conversation(f: Learner, count: number, start = Date.UTC(2026, 0, 1)) {
  const rows = Array.from({ length: count }, (_, index) => {
    const pair = Math.floor(index / 2);
    return { id: randomUUID(), role: index % 2 ? 'assistant' : 'learner', content: `Message ${index}`, at: new Date(start + pair * 1000 + (pair % 5 === 0 ? 0 : (index % 2) * 500)) };
  });
  await db.query(`INSERT INTO companion_messages(id,enrollment_id,role,content,context,created_at)
    SELECT id,$2,role,content,'{"episodeId":"min"}'::jsonb,at FROM unnest($1::uuid[],$3::text[],$4::text[],$5::timestamptz[]) AS r(id,role,content,at)`,
    [rows.map(row => row.id), f.id, rows.map(row => row.role), rows.map(row => row.content), rows.map(row => row.at)]);
  // The order the API reads them in: time, then id.
  const ordered = (await db.query<{ id: string; content: string }>('SELECT id,content FROM companion_messages WHERE enrollment_id=$1 ORDER BY created_at,id', [f.id])).rows;
  return ordered.map(row => row.content);
}
async function page(f: Learner, query = '') {
  const read = await app.inject({ url: `/api/enrollments/${f.id}/companion${query}`, headers: f.headers });
  return { status: read.statusCode, body: read.json() as Page & { error?: string } };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  const compiled = compileCourse(fixture()), owner = randomUUID();
  workspaceId = randomUUID(); releaseId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `history:${owner}`, 'Test author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `history-${workspaceId}`, 'Companion history tests']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, 'ordering', '1.0.0', compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

describe('reading the conversation in pages', () => {
  it('reads the newest 100, then each earlier page before its cursor, in one stable order, until none remain', async () => {
    const f = await fresh();
    const all = await conversation(f, 230);
    const latest = await page(f);
    expect(latest.status).toBe(200);
    expect(latest.body.messages.map(row => row.content)).toEqual(all.slice(130));
    expect(latest.body.earlier).toBe(true);
    expect(latest.body.before).toEqual(expect.any(String));
    const second = await page(f, `?before=${latest.body.before}`);
    expect(second.body.messages.map(row => row.content)).toEqual(all.slice(30, 130));
    expect(second.body.earlier).toBe(true);
    // A smaller page, then the last one, which says nothing remains.
    const third = await page(f, `?before=${second.body.before}&limit=20`);
    expect(third.body.messages.map(row => row.content)).toEqual(all.slice(10, 30));
    const last = await page(f, `?before=${third.body.before}&limit=20`);
    expect(last.body.messages.map(row => row.content)).toEqual(all.slice(0, 10));
    expect(last.body).toMatchObject({ earlier: false, before: null });
    // Every message once, in the order they were written.
    expect([...last.body.messages, ...third.body.messages, ...second.body.messages, ...latest.body.messages].map(row => row.content)).toEqual(all);
    // Each page carries the same row shape as the latest one.
    for (const row of second.body.messages) expect(row).toHaveProperty('excluded', false);
    for (const row of second.body.messages.filter(row => row.role === 'assistant')) expect(row).toHaveProperty('feedback', null);
  });

  it('says no earlier messages remain for a short conversation, and the default read keeps its shape', async () => {
    const f = await fresh();
    const all = await conversation(f, 100);
    const latest = await page(f);
    expect(latest.body.messages.map(row => row.content)).toEqual(all);
    expect(latest.body).toMatchObject({ earlier: false, before: null });
    expect((await page(await fresh())).body).toEqual({ messages: [], earlier: false, before: null });
  });

  it('refuses a cursor that is not one, and a limit out of range', async () => {
    const f = await fresh();
    await conversation(f, 4);
    const encode = (text: string) => Buffer.from(text).toString('base64url');
    for (const query of [`?before=${encode('yesterday|' + randomUUID())}`, `?before=${encode('2026-01-01 00:00:00+00|not-an-id')}`, '?before=%25%25%25',
      `?before=${encode(`2026-01-01 00:00:00+00|${randomUUID()}|extra`)}`, '?limit=0', '?limit=101', '?limit=ten', '?page=2']) {
      const refused = await page(f, query);
      expect(refused.status, query).toBe(400);
      expect(refused.body.error, query).toBe('INVALID_REQUEST');
    }
    // A well-formed cursor before every message reads an empty page.
    expect((await page(f, `?before=${encode(`2000-01-01 00:00:00+00|${randomUUID()}`)}`)).body).toEqual({ messages: [], earlier: false, before: null });
  });

  it('reads only the learner\'s own conversation', async () => {
    const f = await fresh(), other = await fresh();
    await conversation(f, 3);
    const read = await app.inject({ url: `/api/enrollments/${f.id}/companion`, headers: other.headers });
    expect(read.statusCode).toBe(404);
  });
});
