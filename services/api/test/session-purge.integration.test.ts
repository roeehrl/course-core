import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createServer } from '../src/server.js';
import { migrate } from '../src/migrations.js';
import { hashSecret, issueLoginCode } from '../src/auth.js';
import { ENDED_SESSION_RETENTION_DAYS, purgeEndedSessions } from '../src/session-purge.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const origin = 'http://localhost:4391', schema = `session_purge_${randomUUID().replaceAll('-', '')}`;
let testDatabase: TestDatabase | undefined, db: Database, app: Awaited<ReturnType<typeof createServer>>;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

async function user(workspaceId: string, role = 'learner') {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `purge:${id}`, `${role} person`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, id, role]);
  return id;
}
async function workspace() {
  const id = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [id, `purge-${id}`, 'Purge']);
  return id;
}
/** A session row with times relative to now, in days (negative is in the past). */
async function session(userId: string, times: { created: number; expires: number; revoked?: number }) {
  const id = randomUUID();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,csrf_hash,created_at,expires_at,revoked_at)
    VALUES($1,$2,$3,$4,clock_timestamp()+make_interval(days=>$5),clock_timestamp()+make_interval(days=>$6),
      CASE WHEN $7::int IS NULL THEN NULL ELSE clock_timestamp()+make_interval(days=>$7::int) END)`,
  [id, userId, hashSecret(randomBytes(32).toString('base64url')), hashSecret(randomBytes(32).toString('base64url')), times.created, times.expires, times.revoked ?? null]);
  return id;
}
async function signIn(userId: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(r.statusCode, r.body).toBe(200);
  return { cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken as string };
}
const remaining = async (ids: string[]) => (await db.query<{ id: string }>('SELECT id FROM auth_sessions WHERE id=ANY($1::uuid[])', [ids])).rows.map(r => r.id).sort();

describe('ended sign-in sessions are purged', () => {
  it('deletes sessions ended over the retention period ago and keeps live and recently ended ones', async () => {
    const ws = await workspace(), a = await user(ws), b = await user(ws);
    const old = ENDED_SESSION_RETENTION_DAYS + 1, recent = ENDED_SESSION_RETENTION_DAYS - 1;
    const keep = {
      live: await session(a, { created: -1, expires: 1 }),
      // Long-lived (SESSION_HOURS up to 30 days) and still valid, though created long ago.
      liveOldCreated: await session(a, { created: -29, expires: 1 }),
      expiredRecently: await session(a, { created: -recent - 1, expires: -recent }),
      revokedRecently: await session(b, { created: -recent - 1, expires: 20, revoked: -recent }),
    };
    const purge = {
      expiredLongAgo: await session(a, { created: -old - 1, expires: -old }),
      revokedLongAgoUnexpired: await session(b, { created: -old - 1, expires: 20, revoked: -old }),
      revokedAfterExpiry: await session(b, { created: -old - 2, expires: -old, revoked: -1 }),
    };
    // Retention counts from when the session stopped working: revocation, or expiry if earlier.
    expect(await purgeEndedSessions(db)).toEqual({ purged: 3 });
    expect(await remaining([...Object.values(keep), ...Object.values(purge)])).toEqual(Object.values(keep).sort());
    // Idempotent.
    expect(await purgeEndedSessions(db)).toEqual({ purged: 0 });
  });

  it('works in bounded batches and stops at the batch limit', async () => {
    const ws = await workspace(), a = await user(ws);
    const ended = await Promise.all(Array.from({ length: 7 }, () => session(a, { created: -40, expires: -30 })));
    expect(await purgeEndedSessions(db, { batchSize: 2, maxBatches: 2 })).toEqual({ purged: 4 });
    expect(await remaining(ended)).toHaveLength(3);
    expect(await purgeEndedSessions(db, { batchSize: 2, maxBatches: 10 })).toEqual({ purged: 3 });
    expect(await remaining(ended)).toEqual([]);
  });

  it('skips rows a concurrent revocation holds instead of waiting for it', async () => {
    const ws = await workspace(), a = await user(ws);
    const held = await session(a, { created: -40, expires: -30 }), free = await session(a, { created: -40, expires: -30 });
    const holder = await db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [held]);
      expect(await purgeEndedSessions(db)).toEqual({ purged: 1 });
      await holder.query('COMMIT');
    } finally { holder.release(); }
    expect(await remaining([held, free])).toEqual([held]);
  });

  it('keeps the People screen last sign-in and live sign-ins working through a purge', async () => {
    const ws = await workspace(), owner = await user(ws, 'owner'), learner = await user(ws);
    const live = await signIn(owner);
    await signIn(learner);
    const signedIn = (await db.query('SELECT last_sign_in_at FROM app_users WHERE id=$1', [learner])).rows[0].last_sign_in_at as Date;
    expect(signedIn).toBeInstanceOf(Date);
    // The learner's session ended long ago.
    await db.query(`UPDATE auth_sessions SET created_at=clock_timestamp()-interval '40 days',expires_at=clock_timestamp()-interval '30 days' WHERE user_id=$1`, [learner]);
    expect((await purgeEndedSessions(db)).purged).toBeGreaterThanOrEqual(1);
    expect(Number((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1', [learner])).rows[0].count)).toBe(0);
    const r = await app.inject({ method: 'GET', url: `/api/admin/workspaces/${ws}/people`, headers: { origin, cookie: live.cookie, 'x-csrf-token': live.csrf } });
    expect(r.statusCode, r.body).toBe(200);
    const people = r.json().people as Array<{ userId: string; lastSignInAt: string | null }>;
    expect(people.find(p => p.userId === learner)?.lastSignInAt).toBe(signedIn.toISOString());
    expect(people.find(p => p.userId === owner)?.lastSignInAt).not.toBeNull();
  });

  it('an erased account keeps no last sign-in and its revoked sessions are purged after retention', async () => {
    const ws = await workspace(), learner = await user(ws);
    const live = await signIn(learner);
    const r = await app.inject({ method: 'POST', url: '/api/account/erase', headers: { origin, cookie: live.cookie, 'x-csrf-token': live.csrf },
      payload: { confirmation: 'ERASE MY ACCOUNT', reason: 'Synthetic erasure for the session purge test.' } });
    expect(r.statusCode, r.body).toBe(200);
    expect((await db.query('SELECT last_sign_in_at FROM app_users WHERE id=$1', [learner])).rows[0].last_sign_in_at).toBeNull();
    // Revoked now: kept for the retention period, then purged.
    expect(Number((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NOT NULL', [learner])).rows[0].count)).toBe(1);
    await purgeEndedSessions(db);
    expect(Number((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1', [learner])).rows[0].count)).toBe(1);
    await db.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp()-make_interval(days=>$2) WHERE user_id=$1`, [learner, ENDED_SESSION_RETENTION_DAYS + 1]);
    await purgeEndedSessions(db);
    expect(Number((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1', [learner])).rows[0].count)).toBe(0);
  });

  it('migration 080 backfills last sign-in from existing sessions, except for erased accounts', async () => {
    const directory = fileURLToPath(new URL('../migrations', import.meta.url));
    const older = await mkdtemp(join(tmpdir(), 'course-core-migrations-'));
    const legacySchema = `legacy_sessions_${randomUUID().replaceAll('-', '')}`;
    try {
      await cp(directory, older, { recursive: true, filter: source => !source.endsWith('080_session_purge.sql') });
      await db.query(`CREATE SCHEMA ${legacySchema}`);
      const url = new URL(testDatabase!.url);
      url.searchParams.set('options', `-csearch_path=${legacySchema}`);
      const legacy = createDatabase(url.toString());
      try {
        await migrate(legacy, older);
        const [signedIn, never, erased] = [randomUUID(), randomUUID(), randomUUID()];
        await legacy.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,'A'),($3,$4,'B'),($5,$6,'Erased account')",
          [signedIn, `legacy:${signedIn}`, never, `legacy:${never}`, erased, `erased:${erased}`]);
        const insert = (userId: string, created: string) => legacy.query(`INSERT INTO auth_sessions(id,user_id,token_hash,csrf_hash,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz+interval '12 hours')`, [randomUUID(), userId, hashSecret(randomUUID()), hashSecret(randomUUID()), created]);
        await insert(signedIn, '2026-01-02T03:04:05Z'); await insert(signedIn, '2026-02-03T04:05:06Z'); await insert(erased, '2026-02-01T00:00:00Z');
        expect(await migrate(legacy, directory)).toEqual(['080_session_purge.sql']);
        const rows = (await legacy.query('SELECT id,last_sign_in_at FROM app_users')).rows;
        const at = (id: string) => rows.find(r => r.id === id)?.last_sign_in_at?.toISOString() ?? null;
        expect(at(signedIn)).toBe('2026-02-03T04:05:06.000Z'); expect(at(never)).toBeNull(); expect(at(erased)).toBeNull();
      } finally { await legacy.end(); }
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
      await rm(older, { recursive: true, force: true });
    }
  }, 60_000);
});
