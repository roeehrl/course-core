import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { authService, hashSecret, issueLoginCode, membership, type AuthOptions } from '../src/auth.js';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { ApiError } from '../src/errors.js';
import { appendEvent } from '../src/events.js';

const schema = `auth_hardening_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4310';
let admin: Database, db: Database;
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use only a dedicated TEST_DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Dedicated loopback test database required.');
  admin = createDatabase(url.toString()); await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-csearch_path=${schema}`); db = createDatabase(url.toString());
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
}, 30_000);
afterAll(async () => {
  await Promise.all(apps.map(app => app.close())); await db?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});
async function server(options: Partial<AuthOptions> = {}) {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
    if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  const auth = authService(db, { origin, secureCookies: false, ...options }); auth.routes(app);
  app.post('/probe/:workspaceId', async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    return transaction(db, async client => {
      await membership(client, actor, workspaceId, ['owner', 'admin']);
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'auth.probe', payload: {}, idempotencyKey: randomUUID() });
      return { actorId: actor.id };
    });
  });
  apps.push(app); return app;
}
async function seed(role = 'owner', workspaceId = randomUUID()) {
  const userId = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `synthetic:${userId}`, 'Synthetic user']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [workspaceId, `test-${workspaceId}`, 'Auth test']);
  await db.query('INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspaceId, userId, role]);
  return { userId, workspaceId };
}
async function redeem(app: FastifyInstance, userId: string, extraHeaders: Record<string, string> = {}) {
  const code = await issueLoginCode(db, userId);
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin, ...extraHeaders }, payload: { token: code } });
  expect(response.statusCode).toBe(200);
  return { code, response, cookie: response.cookies.map(row => `${row.name}=${row.value}`).join('; '), csrf: response.json().csrfToken as string,
    token: response.cookies.find(row => row.name === 'course_session')!.value };
}
async function probeCount(workspaceId: string) {
  return Number((await db.query("SELECT count(*) FROM learning_events WHERE workspace_id=$1 AND event_type='auth.probe'", [workspaceId])).rows[0].count);
}

describe('bootstrap code redemption and authoritative expiry', () => {
  it('consumes one bootstrap code exactly once under concurrent replay', async () => {
    const app = await server(), user = await seed(), code = await issueLoginCode(db, user.userId);
    const results = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } })));
    expect(results.filter(row => row.statusCode === 200)).toHaveLength(1);
    expect(results.filter(row => row.statusCode === 401)).toHaveLength(9);
    expect((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1', [user.userId])).rows[0].count).toBe('1');
    expect((await db.query('SELECT consumed_at FROM login_codes WHERE token_hash=$1', [hashSecret(code)])).rows[0].consumed_at).not.toBeNull();
  });
  it('rejects a code which expires while redemption waits on its row lock', async () => {
    const app = await server(), user = await seed(), code = await issueLoginCode(db, user.userId), hash = hashSecret(code);
    const holder = await db.connect(); await holder.query('BEGIN');
    await holder.query("UPDATE login_codes SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE token_hash=$1", [hash]);
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const response = app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } }).then(value => value);
    let blocked = false;
    try {
      for (let i = 0; i < 100; i++) {
        blocked = (await db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked;
        if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } finally { await holder.query('COMMIT'); holder.release(); }
    const result = await response;
    expect(blocked).toBe(true); expect(result.statusCode).toBe(401); expect(result.cookies).toHaveLength(0);
    expect((await db.query('SELECT consumed_at FROM login_codes WHERE token_hash=$1', [hash])).rows[0].consumed_at).toBeNull();
    expect((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1', [user.userId])).rows[0].count).toBe('0');
  });
  it('invalid origins, expired codes and injected user identity never create sessions', async () => {
    const app = await server(), user = await seed(), foreign = await seed(), code = await issueLoginCode(db, user.userId);
    for (const badOrigin of ['', 'null', 'https://evil.invalid', `${origin}/`, 'http://localhost:4311']) {
      expect((await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin: badOrigin }, payload: { token: code } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code, userId: foreign.userId } })).statusCode).toBe(400);
    expect((await db.query('SELECT consumed_at FROM login_codes WHERE token_hash=$1', [hashSecret(code)])).rows[0].consumed_at).toBeNull();
    await db.query("UPDATE login_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hashSecret(code)]);
    expect((await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } })).statusCode).toBe(401);
    expect((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=ANY($1::uuid[])', [[user.userId, foreign.userId]])).rows[0].count).toBe('0');
  });
  it('rolls back code consumption if session persistence fails; the original code then works once', async () => {
    const app = await server(), user = await seed(), code = await issueLoginCode(db, user.userId);
    await db.query(`CREATE FUNCTION fail_auth_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private storage error'; END $$`);
    await db.query('CREATE TRIGGER fail_auth_session BEFORE INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION fail_auth_session()');
    try {
      const result = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } });
      expect(result.statusCode).toBe(500); expect(result.body).not.toContain('private'); expect(result.cookies).toHaveLength(0);
      expect((await db.query('SELECT consumed_at FROM login_codes WHERE token_hash=$1', [hashSecret(code)])).rows[0].consumed_at).toBeNull();
    } finally { await db.query('DROP TRIGGER fail_auth_session ON auth_sessions'); await db.query('DROP FUNCTION fail_auth_session()'); }
    expect((await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } })).statusCode).toBe(401);
  });
});

describe('cookie, session, CSRF and workspace boundaries', () => {
  it('derives session expiry from database time even when the application clock is far ahead', async () => {
    const app = await server({ sessionHours: 1 }), user = await seed();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 24 * 3600_000);
    try { await redeem(app, user.userId); } finally { clock.mockRestore(); }
    const row = (await db.query('SELECT expires_at,clock_timestamp() AS observed FROM auth_sessions WHERE user_id=$1', [user.userId])).rows[0];
    const remaining = row.expires_at.getTime() - row.observed.getTime();
    expect(remaining).toBeGreaterThan(3590_000); expect(remaining).toBeLessThanOrEqual(3600_000);
  });
  it('rejects invalid or unbounded configured session lifetimes before issuing credentials', () => {
    for (const sessionHours of [0, -1, NaN, Infinity, 721]) {
      expect(() => authService(db, { origin, secureCookies: false, sessionHours })).toThrow('INVALID_SESSION_LIFETIME');
    }
  });
  it('sets host-only scoped cookies with fresh tokens; persists hashes and DB-aligned expiry', async () => {
    const app = await server({ secureCookies: true }), user = await seed();
    const prior = 'a'.repeat(43), session = await redeem(app, user.userId, { cookie: `course_session=${prior}; course_csrf=${prior}` });
    expect(session.token).not.toBe(prior); expect(session.csrf).not.toBe(session.token);
    const authCookie = session.response.cookies.find(row => row.name === 'course_session')!;
    const csrfCookie = session.response.cookies.find(row => row.name === 'course_csrf')!;
    expect(authCookie.httpOnly).toBe(true); expect(authCookie.secure).toBe(true); expect(authCookie.path).toBe('/'); expect(authCookie.sameSite).toBe('Strict'); expect(authCookie.domain).toBeUndefined();
    expect(csrfCookie.httpOnly).not.toBe(true); expect(csrfCookie.secure).toBe(true); expect(csrfCookie.sameSite).toBe('Strict');
    const row = (await db.query('SELECT token_hash,csrf_hash,expires_at FROM auth_sessions WHERE user_id=$1', [user.userId])).rows[0];
    expect(row.token_hash).toBe(hashSecret(session.token)); expect(row.csrf_hash).toBe(hashSecret(session.csrf));
    expect(Math.abs(new Date(authCookie.expires!).getTime() - row.expires_at.getTime())).toBeLessThan(1000);
    expect(session.response.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ url: '/auth/session', headers: { cookie: session.cookie } })).headers['cache-control']).toBe('no-store');
  });
  it('requires exact origin and the authenticated session CSRF token before mutating storage', async () => {
    const app = await server(), user = await seed(), a = await redeem(app, user.userId), b = await redeem(app, user.userId);
    for (const headers of [
      { cookie: a.cookie, origin },
      { cookie: a.cookie, origin, 'x-csrf-token': b.csrf },
      { cookie: a.cookie, origin, 'x-csrf-token': 'bad' },
      { cookie: a.cookie, 'x-csrf-token': a.csrf },
      { cookie: a.cookie, origin: 'null', 'x-csrf-token': a.csrf },
      { cookie: a.cookie, origin: 'http://other.localhost:4310', 'x-csrf-token': a.csrf },
    ]) expect((await app.inject({ method: 'POST', url: `/probe/${user.workspaceId}`, headers })).statusCode).toBe(403);
    expect(await probeCount(user.workspaceId)).toBe(0);
    expect((await app.inject({ method: 'POST', url: `/probe/${user.workspaceId}`, headers: { cookie: a.cookie, origin, 'x-csrf-token': a.csrf } })).statusCode).toBe(200);
    expect(await probeCount(user.workspaceId)).toBe(1);
  });
  it('logout requires CSRF, revokes only that session, and blocks cookie/code replay', async () => {
    const app = await server(), user = await seed(), a = await redeem(app, user.userId), b = await redeem(app, user.userId);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { origin, cookie: a.cookie, 'x-csrf-token': b.csrf } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/auth/session', headers: { cookie: a.cookie } })).statusCode).toBe(200);
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { origin, cookie: a.cookie, 'x-csrf-token': a.csrf } });
    expect(logout.statusCode).toBe(200); expect(logout.cookies.map(row => row.name).sort()).toEqual(['course_csrf', 'course_session']);
    expect((await app.inject({ url: '/auth/session', headers: { cookie: a.cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/probe/${user.workspaceId}`, headers: { origin, cookie: a.cookie, 'x-csrf-token': a.csrf } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: a.code } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/auth/session', headers: { cookie: b.cookie } })).statusCode).toBe(200);
    expect(await probeCount(user.workspaceId)).toBe(0);
  });
  it('expired sessions and absent/malformed cookies cannot mutate data', async () => {
    const app = await server(), user = await seed(), session = await redeem(app, user.userId);
    await db.query("UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [hashSecret(session.token)]);
    for (const value of [session.cookie, '', 'course_session=short', `course_session=${'x'.repeat(44)}`, `course_session=${'x'.repeat(43)}`,
      `course_session=${session.code}`, `course_session=${session.csrf}`]) {
      expect((await app.inject({ url: '/auth/session', headers: { cookie: value } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: `/probe/${user.workspaceId}`, headers: { origin, cookie: value, 'x-csrf-token': session.csrf } })).statusCode).toBe(401);
    }
    expect(await probeCount(user.workspaceId)).toBe(0);
  });
  it('valid cookies and CSRF never substitute for current workspace role/membership', async () => {
    const app = await server(), owner = await seed(), learner = await seed('learner', owner.workspaceId), foreign = await seed(), session = await redeem(app, learner.userId);
    for (const workspaceId of [owner.workspaceId, foreign.workspaceId]) expect((await app.inject({ method: 'POST', url: `/probe/${workspaceId}`, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf } })).statusCode).toBe(403);
    const privileged = await redeem(app, owner.userId);
    expect((await app.inject({ method: 'POST', url: `/probe/${foreign.workspaceId}`, headers: { origin, cookie: privileged.cookie, 'x-csrf-token': privileged.csrf } })).statusCode).toBe(403);
    await db.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [owner.workspaceId, owner.userId]);
    expect((await app.inject({ method: 'POST', url: `/probe/${owner.workspaceId}`, headers: { origin, cookie: privileged.cookie, 'x-csrf-token': privileged.csrf } })).statusCode).toBe(403);
    expect(await probeCount(owner.workspaceId)).toBe(0); expect(await probeCount(foreign.workspaceId)).toBe(0);
  });
});
