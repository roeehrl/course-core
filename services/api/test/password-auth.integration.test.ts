import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { authService, issueLoginCode, hashSecret, parseLoginCodes, parseSessionHours, type AuthOptions } from '../src/auth.js';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { ApiError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { hashPassword, normalizeLoginName, passwordPolicy, storePassword, temporaryPassword, verifyPassword, SCRYPT_PARAMETERS } from '../src/passwords.js';
import { parseSetPasswordArguments } from '../src/set-password.js';

const schema = `password_auth_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4310';
const slow = 120_000;
let db: Database, schemaUrl: string;
const apps: FastifyInstance[] = [];
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  schemaUrl = testDatabase.url; db = createDatabase(schemaUrl);
}, 30_000);
afterAll(async () => {
  await Promise.all(apps.map(app => app.close())); await db?.end();
  await testDatabase?.drop();
});
async function server(options: Partial<AuthOptions> = {}) {
  const app = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
    if ((error as { validation?: unknown }).validation) return reply.code(400).send({ error: 'INVALID_REQUEST' });
    return reply.code(500).send({ error: 'INTERNAL_ERROR' });
  });
  authService(db, { origin, secureCookies: false, ...options }).routes(app);
  apps.push(app); return app;
}
async function account(options: { password?: string; mustChange?: boolean; role?: string; workspaceId?: string; subject?: string } = {}) {
  const userId = randomUUID(), workspaceId = options.workspaceId ?? randomUUID(), login = `user-${userId.slice(0, 8)}`;
  const password = options.password ?? `correct horse ${randomUUID().slice(0, 6)}`;
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, options.subject ?? `synthetic:${userId}`, 'Synthetic user']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [workspaceId, `test-${workspaceId}`, 'Password test']);
  await db.query('INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspaceId, userId, options.role ?? 'learner']);
  await storePassword(db, userId, await hashPassword(passwordPolicy(password)), { mustChange: options.mustChange ?? false, loginName: login });
  return { userId, workspaceId, login, password };
}
const login = (app: FastifyInstance, payload: Record<string, unknown>, extra: { remoteAddress?: string; origin?: string } = {}) =>
  app.inject({ method: 'POST', url: '/auth/login', headers: { origin: extra.origin ?? origin }, payload, ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}) });
const cookies = (response: { cookies: { name: string; value: string }[] }) => response.cookies.map(row => `${row.name}=${row.value}`).join('; ');
const sessionCount = async (userId: string) => Number((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows[0].count);

describe('password policy, normalisation and hashing', () => {
  it('enforces 12-1024 code points after NFKC, with no composition rules', () => {
    expect(() => passwordPolicy('a'.repeat(11))).toThrow('PASSWORD_POLICY');
    expect(passwordPolicy('a'.repeat(12))).toBe('a'.repeat(12));
    expect(passwordPolicy('😀'.repeat(12))).toHaveLength(24); // 12 code points, 24 UTF-16 units
    expect(() => passwordPolicy('a'.repeat(1025))).toThrow('PASSWORD_POLICY');
    expect(passwordPolicy('a'.repeat(1024))).toHaveLength(1024);
    expect(passwordPolicy('ﬁﬁﬁﬁﬁﬁ'.repeat(2))).toBe('fi'.repeat(12)); // NFKC expands the ligature
    expect(() => passwordPolicy(42)).toThrow('PASSWORD_POLICY');
    expect(() => passwordPolicy('a'.repeat(5000))).toThrow('PASSWORD_POLICY');
  });
  it('normalises login names case-insensitively and rejects malformed ones', () => {
    expect(normalizeLoginName('  Operator:Owner ')).toBe('operator:owner');
    expect(normalizeLoginName('ＡＢＣ')).toBe('abc');
    for (const bad of ['ab', '-abc', 'abc-', 'a b c', 'a/b/c', 'x'.repeat(129), '', 7]) expect(normalizeLoginName(bad)).toBeUndefined();
  });
  it('stores scrypt with per-user salt and parameters, compares in constant time and flags old parameters', async () => {
    const one = await hashPassword('the same passphrase'), two = await hashPassword('the same passphrase');
    expect(one).toMatch(new RegExp(`^\\$scrypt\\$ln=${SCRYPT_PARAMETERS.ln},r=${SCRYPT_PARAMETERS.r},p=${SCRYPT_PARAMETERS.p}\\$[A-Za-z0-9+/]{22}\\$[A-Za-z0-9+/]{43}$`));
    expect(SCRYPT_PARAMETERS.ln).toBeGreaterThanOrEqual(17);
    expect(one).not.toBe(two);
    expect(await verifyPassword('the same passphrase', one)).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword('the same passphrasf', one)).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword('the same passphrase', undefined)).toEqual({ ok: false, needsRehash: false });
    expect(await verifyPassword('the same passphrase', '$scrypt$garbage')).toEqual({ ok: false, needsRehash: false });
    const old = await hashPassword('an older passphrase', { ln: 14, r: 8, p: 1 });
    expect(await verifyPassword('an older passphrase', old)).toEqual({ ok: true, needsRehash: true });
    expect(temporaryPassword()).toMatch(/^[a-km-np-z2-9]{4}(?:-[a-km-np-z2-9]{4}){4}$/);
  }, slow);
  it('parses session lifetime and code settings strictly', () => {
    expect(parseSessionHours(undefined)).toBeUndefined();
    expect(parseSessionHours('168')).toBe(168);
    expect(parseSessionHours('0.5')).toBe(0.5);
    expect(parseSessionHours(720)).toBe(720);
    for (const bad of ['0', '721', '-1', 'abc', '1e3', ' 12']) expect(() => parseSessionHours(bad)).toThrow('INVALID_SESSION_LIFETIME');
    expect(parseLoginCodes(undefined)).toBe(false);
    expect(parseLoginCodes('disabled')).toBe(false);
    expect(parseLoginCodes('enabled')).toBe(true);
    for (const bad of ['true', '1', 'ENABLED', 'yes']) expect(() => parseLoginCodes(bad)).toThrow();
  });
});

describe('password sign-in', () => {
  it('signs in case-insensitively and issues the same cookie session and CSRF as before', async () => {
    const app = await server({ secureCookies: true }), user = await account();
    const response = await login(app, { login: `  ${user.login.toUpperCase()} `, password: user.password });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const session = response.cookies.find(row => row.name === 'course_session')!, csrf = response.cookies.find(row => row.name === 'course_csrf')!;
    expect(session.httpOnly).toBe(true); expect(session.secure).toBe(true); expect(session.sameSite).toBe('Strict');
    expect(csrf.httpOnly).not.toBe(true); expect(response.json().csrfToken).toBe(csrf.value);
    const row = (await db.query('SELECT token_hash,csrf_hash FROM auth_sessions WHERE user_id=$1', [user.userId])).rows[0];
    expect(row.token_hash).toBe(hashSecret(session.value)); expect(row.csrf_hash).toBe(hashSecret(csrf.value));
    const me = await app.inject({ url: '/auth/session', headers: { cookie: cookies(response) } });
    expect(me.json().user).toEqual({ id: user.userId, displayName: 'Synthetic user', loginName: user.login, hasPassword: true });
  }, slow);
  it('accepts an NFKC-equivalent password', async () => {
    const app = await server(), user = await account({ password: 'ﬁne ﬁne ﬁne ﬁne' });
    expect((await login(app, { login: user.login, password: 'fine fine fine fine' })).statusCode).toBe(200);
  }, slow);
  it('answers wrong passwords, unknown and malformed users identically, with comparable work', async () => {
    const app = await server(), user = await account();
    const time = async (payload: Record<string, unknown>) => {
      const started = performance.now(), response = await login(app, payload);
      return { ms: performance.now() - started, status: response.statusCode, body: response.body, cookies: response.cookies.length };
    };
    const wrong: number[] = [], unknown: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await time({ login: user.login, password: 'definitely wrong password' });
      const b = await time({ login: `nobody-${randomUUID().slice(0, 8)}`, password: 'definitely wrong password' });
      const c = await time({ login: 'not a valid login!', password: 'definitely wrong password' });
      for (const result of [a, b, c]) { expect(result.status).toBe(401); expect(result.body).toBe('{"error":"LOGIN_FAILED"}'); expect(result.cookies).toBe(0); }
      wrong.push(a.ms); unknown.push(b.ms, c.ms);
    }
    const median = (values: number[]) => values.sort((x, y) => x - y)[Math.floor(values.length / 2)]!;
    // Unknown accounts run the same scrypt derivation against a dummy hash.
    expect(median(unknown)).toBeGreaterThan(median(wrong) * 0.5);
    expect(median(unknown)).toBeLessThan(median(wrong) * 2);
    expect(await sessionCount(user.userId)).toBe(0);
  }, slow);
  it('requires the exact origin and rejects extra fields and oversized input before any session exists', async () => {
    const app = await server(), user = await account();
    for (const badOrigin of ['', 'null', 'https://evil.invalid', `${origin}/`]) expect((await login(app, { login: user.login, password: user.password }, { origin: badOrigin })).statusCode).toBe(403);
    expect((await login(app, { login: user.login, password: user.password, userId: randomUUID() })).statusCode).toBe(400);
    expect((await login(app, { login: user.login, password: 'x'.repeat(4097) })).statusCode).toBe(400);
    expect(await sessionCount(user.userId)).toBe(0);
  }, slow);
});

describe('throttling', () => {
  const throttle = { accountFailures: 3, addressFailures: 100, windowMinutes: 15 };
  it('locks an account (known or unknown) after repeated failures, even for the right password, without affecting others', async () => {
    const app = await server({ passwordThrottle: throttle }), user = await account(), other = await account();
    for (let i = 0; i < 3; i++) expect((await login(app, { login: user.login, password: 'wrong password here' })).statusCode).toBe(401);
    const locked = await login(app, { login: user.login, password: user.password });
    expect(locked.statusCode).toBe(429); expect(locked.json()).toEqual({ error: 'LOGIN_THROTTLED' }); expect(locked.headers['retry-after']).toBe('900');
    expect(locked.cookies).toHaveLength(0);
    const ghost = `ghost-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) expect((await login(app, { login: ghost, password: 'wrong password here' })).statusCode).toBe(401);
    expect((await login(app, { login: ghost.toUpperCase(), password: 'wrong password here' })).statusCode).toBe(429);
    expect((await login(app, { login: other.login, password: other.password })).statusCode).toBe(200);
    // The window is durable in PostgreSQL; once it passes, the account works again.
    await db.query("UPDATE password_login_failures SET created_at=created_at-interval '16 minutes'");
    expect((await login(app, { login: user.login, password: user.password })).statusCode).toBe(200);
  }, slow);
  it('a successful sign-in clears earlier failures for that account', async () => {
    const app = await server({ passwordThrottle: throttle }), user = await account();
    for (let i = 0; i < 2; i++) expect((await login(app, { login: user.login, password: 'wrong password here' })).statusCode).toBe(401);
    expect((await login(app, { login: user.login, password: user.password })).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) expect((await login(app, { login: user.login, password: 'wrong password here' })).statusCode).toBe(401);
    expect((await login(app, { login: user.login, password: user.password })).statusCode).toBe(200);
  }, slow);
  it('concurrent guesses cannot overrun the account budget', async () => {
    const app = await server({ passwordThrottle: throttle }), user = await account();
    const results = await Promise.all(Array.from({ length: 10 }, () => login(app, { login: user.login, password: 'wrong password here' })));
    expect(results.filter(row => row.statusCode === 401)).toHaveLength(3);
    expect(results.filter(row => row.statusCode === 429)).toHaveLength(7);
  }, slow);
  it('limits failures per client address across accounts', async () => {
    const app = await server({ passwordThrottle: { accountFailures: 100, addressFailures: 3, windowMinutes: 15 } }), user = await account();
    const address = '203.0.113.' + Math.floor(Math.random() * 200 + 10);
    for (let i = 0; i < 3; i++) expect((await login(app, { login: `spray-${i}-${randomUUID().slice(0, 6)}`, password: 'wrong password here' }, { remoteAddress: address })).statusCode).toBe(401);
    expect((await login(app, { login: user.login, password: user.password }, { remoteAddress: address })).statusCode).toBe(429);
    expect((await login(app, { login: user.login, password: user.password }, { remoteAddress: '198.51.100.7' })).statusCode).toBe(200);
  }, slow);
});

describe('changing and replacing passwords', () => {
  it('requires the current password and CSRF, then revokes every other session', async () => {
    const app = await server(), user = await account();
    const a = await login(app, { login: user.login, password: user.password }), b = await login(app, { login: user.login, password: user.password });
    const headers = { origin, cookie: cookies(a), 'x-csrf-token': a.json().csrfToken as string };
    const change = (payload: Record<string, unknown>, h: Record<string, string> = headers) => app.inject({ method: 'POST', url: '/auth/password', headers: h, payload });
    expect((await change({ currentPassword: user.password, newPassword: 'a brand new passphrase' }, { origin, cookie: cookies(a) })).statusCode).toBe(403);
    expect((await change({ currentPassword: user.password, newPassword: 'a brand new passphrase' }, { origin, cookie: cookies(a), 'x-csrf-token': b.json().csrfToken })).statusCode).toBe(403);
    expect((await change({ currentPassword: user.password, newPassword: 'a brand new passphrase' }, { cookie: cookies(a), 'x-csrf-token': headers['x-csrf-token'] })).statusCode).toBe(403);
    const wrong = await change({ currentPassword: 'not my password!', newPassword: 'a brand new passphrase' });
    expect(wrong.statusCode).toBe(403); expect(wrong.json().error).toBe('CURRENT_PASSWORD_INCORRECT');
    expect((await change({ currentPassword: user.password, newPassword: 'too short' })).json().error).toBe('PASSWORD_POLICY');
    expect((await change({ currentPassword: user.password, newPassword: user.password })).json().error).toBe('PASSWORD_UNCHANGED');
    expect(await sessionCount(user.userId)).toBe(2);
    const changed = await change({ currentPassword: user.password, newPassword: 'a brand new passphrase' });
    expect(changed.statusCode).toBe(200); expect(changed.json()).toEqual({ changed: true, otherSessionsRevoked: 1 });
    expect((await app.inject({ url: '/auth/session', headers: { cookie: cookies(a) } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/auth/session', headers: { cookie: cookies(b) } })).statusCode).toBe(401);
    expect((await login(app, { login: user.login, password: user.password })).statusCode).toBe(401);
    expect((await login(app, { login: user.login, password: 'a brand new passphrase' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/password', payload: { currentPassword: 'x'.repeat(12), newPassword: 'y'.repeat(12) }, headers: { origin } })).statusCode).toBe(401);
  }, slow);
  it('throttles wrong current passwords per user', async () => {
    const app = await server({ passwordThrottle: { accountFailures: 2, addressFailures: 100, windowMinutes: 15 } }), user = await account();
    const a = await login(app, { login: user.login, password: user.password });
    const headers = { origin, cookie: cookies(a), 'x-csrf-token': a.json().csrfToken as string };
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'POST', url: '/auth/password', headers, payload: { currentPassword: 'not my password!', newPassword: 'a brand new passphrase' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/auth/password', headers, payload: { currentPassword: user.password, newPassword: 'a brand new passphrase' } })).statusCode).toBe(429);
  }, slow);
  it('a temporary password issues no session until it is replaced, then stops working', async () => {
    const app = await server(), user = await account({ mustChange: true });
    const first = await login(app, { login: user.login, password: user.password });
    expect(first.statusCode).toBe(409); expect(first.json()).toEqual({ error: 'PASSWORD_CHANGE_REQUIRED' }); expect(first.cookies).toHaveLength(0);
    expect((await login(app, { login: user.login, password: 'wrong password here', newPassword: 'my chosen passphrase' })).statusCode).toBe(401);
    expect((await login(app, { login: user.login, password: user.password, newPassword: user.password })).json().error).toBe('PASSWORD_UNCHANGED');
    expect((await login(app, { login: user.login, password: user.password, newPassword: 'short' })).json().error).toBe('PASSWORD_POLICY');
    expect(await sessionCount(user.userId)).toBe(0);
    const done = await login(app, { login: user.login, password: user.password, newPassword: 'my chosen passphrase' });
    expect(done.statusCode).toBe(200); expect(done.cookies.map(row => row.name).sort()).toEqual(['course_csrf', 'course_session']);
    expect((await db.query('SELECT must_change FROM password_credentials WHERE user_id=$1', [user.userId])).rows[0].must_change).toBe(false);
    expect((await login(app, { login: user.login, password: user.password })).statusCode).toBe(401);
    expect((await login(app, { login: user.login, password: 'my chosen passphrase' })).statusCode).toBe(200);
  }, slow);
  it('upgrades a hash made with older parameters at the next sign-in', async () => {
    const app = await server(), user = await account();
    await db.query('UPDATE password_credentials SET password_hash=$2 WHERE user_id=$1', [user.userId, await hashPassword(user.password, { ln: 14, r: 8, p: 1 })]);
    expect((await login(app, { login: user.login, password: user.password })).statusCode).toBe(200);
    expect((await db.query('SELECT password_hash FROM password_credentials WHERE user_id=$1', [user.userId])).rows[0].password_hash).toMatch(/^\$scrypt\$ln=17,/);
    expect((await login(app, { login: user.login, password: user.password })).statusCode).toBe(200);
  }, slow);
});

describe('one-time codes are optional and off by default', () => {
  it('refuses redemption without consuming the code, and advertises codes as disabled', async () => {
    const app = await server(), user = await account(), code = await issueLoginCode(db, user.userId);
    const options = await app.inject({ url: '/auth/options' });
    expect(options.json()).toEqual({ password: { minLength: 12, maxLength: 1024 }, loginCodes: false, passkeys: true });
    const refused = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } });
    expect(refused.statusCode).toBe(403); expect(refused.json()).toEqual({ error: 'LOGIN_CODES_DISABLED' }); expect(refused.cookies).toHaveLength(0);
    expect((await db.query('SELECT consumed_at FROM login_codes WHERE token_hash=$1', [hashSecret(code)])).rows[0].consumed_at).toBeNull();
    // The same code works once when codes are explicitly enabled.
    const enabled = await server({ loginCodes: true });
    expect((await enabled.inject({ url: '/auth/options' })).json().loginCodes).toBe(true);
    expect((await enabled.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } })).statusCode).toBe(200);
    expect((await enabled.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: code } })).statusCode).toBe(401);
  }, slow);
});

describe('administrator-issued temporary passwords', () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  beforeAll(async () => { app = await createServer(db, { origin, secureCookies: false }); }, 30_000);
  afterAll(async () => { await app?.close(); });
  async function staff(role: string, workspaceId: string) {
    const user = await account({ role, workspaceId });
    const response = await login(app as unknown as FastifyInstance, { login: user.login, password: user.password });
    expect(response.statusCode).toBe(200);
    return { ...user, headers: { origin, cookie: cookies(response), 'x-csrf-token': response.json().csrfToken as string } };
  }
  const people = (workspaceId: string) => `/api/admin/workspaces/${workspaceId}/people`;
  it('invites with a username, shows the temporary password once, and never stores it', async () => {
    const workspaceId = randomUUID(), owner = await staff('owner', workspaceId);
    const idempotencyKey = `k-${randomUUID()}`;
    const invite = () => app.inject({ method: 'POST', url: people(workspaceId), headers: owner.headers, payload: { displayName: 'New learner', role: 'learner', loginName: 'New.Learner@Example.org', idempotencyKey } });
    const created = await invite();
    expect(created.statusCode, created.body).toBe(200);
    const body = created.json();
    expect(body.signIn).toBeUndefined();
    expect(body.password).toMatchObject({ loginName: 'new.learner@example.org', mustChangeOnNextSignIn: true });
    const temporary = body.password.temporaryPassword as string;
    const replay = await invite();
    expect(replay.json().replayed).toBe(true); expect(replay.body).not.toContain(temporary);
    const stored = JSON.stringify((await db.query('SELECT response FROM people_command_receipts WHERE workspace_id=$1', [workspaceId])).rows)
      + JSON.stringify((await db.query('SELECT payload FROM learning_events WHERE workspace_id=$1', [workspaceId])).rows);
    expect(stored).not.toContain(temporary);
    expect((await login(app as unknown as FastifyInstance, { login: 'new.learner@example.org', password: temporary })).json().error).toBe('PASSWORD_CHANGE_REQUIRED');
    const list = (await app.inject({ url: people(workspaceId), headers: owner.headers })).json();
    expect(list.loginCodes).toBe(false);
    const row = list.people.find((person: { userId: string }) => person.userId === body.userId);
    expect(row).toMatchObject({ loginName: 'new.learner@example.org', hasPassword: true, mustChangePassword: true, canSetPassword: true, canIssueSignIn: false });
    // Without codes an invitation needs a username; sign-in codes cannot be issued.
    const bare = await app.inject({ method: 'POST', url: people(workspaceId), headers: owner.headers, payload: { displayName: 'No login', role: 'learner', idempotencyKey: `k-${randomUUID()}` } });
    expect(bare.json().error).toBe('LOGIN_NAME_REQUIRED');
    const code = await app.inject({ method: 'POST', url: `${people(workspaceId)}/${body.userId}/sign-in`, headers: owner.headers, payload: { idempotencyKey: `k-${randomUUID()}` } });
    expect(code.statusCode).toBe(409); expect(code.json().error).toBe('LOGIN_CODES_DISABLED');
    const taken = await app.inject({ method: 'POST', url: people(workspaceId), headers: owner.headers, payload: { displayName: 'Dup', role: 'learner', loginName: 'NEW.LEARNER@example.org', idempotencyKey: `k-${randomUUID()}` } });
    expect(taken.statusCode).toBe(409); expect(taken.json().error).toBe('LOGIN_NAME_TAKEN');
  }, slow);
  it('a reset revokes the member sessions and forces a new password; privileged and shared accounts are protected', async () => {
    const workspaceId = randomUUID(), owner = await staff('owner', workspaceId), adminUser = await staff('admin', workspaceId);
    const invited = (await app.inject({ method: 'POST', url: people(workspaceId), headers: owner.headers, payload: { displayName: 'Member', role: 'learner', loginName: `member-${randomUUID().slice(0, 6)}`, idempotencyKey: `k-${randomUUID()}` } })).json();
    const first = await login(app as unknown as FastifyInstance, { login: invited.password.loginName, password: invited.password.temporaryPassword, newPassword: 'member chosen passphrase' });
    expect(first.statusCode).toBe(200);
    expect(await sessionCount(invited.userId)).toBe(1);
    const reset = await app.inject({ method: 'POST', url: `${people(workspaceId)}/${invited.userId}/password`, headers: adminUser.headers, payload: { idempotencyKey: `k-${randomUUID()}` } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(reset.json().password.loginName).toBe(invited.password.loginName);
    expect(await sessionCount(invited.userId)).toBe(0);
    expect((await login(app as unknown as FastifyInstance, { login: invited.password.loginName, password: 'member chosen passphrase' })).statusCode).toBe(401);
    expect((await login(app as unknown as FastifyInstance, { login: invited.password.loginName, password: reset.json().password.temporaryPassword })).json().error).toBe('PASSWORD_CHANGE_REQUIRED');
    // Admins cannot reset owners; nobody resets themselves; bootstrap/operator accounts and
    // accounts with access to another workspace are outside this workspace's authority.
    const call = (headers: Record<string, string>, userId: string) => app.inject({ method: 'POST', url: `${people(workspaceId)}/${userId}/password`, headers, payload: { loginName: `x-${randomUUID().slice(0, 6)}`, idempotencyKey: `k-${randomUUID()}` } });
    expect((await call(adminUser.headers, owner.userId)).json().error).toBe('ROLE_NOT_ASSIGNABLE');
    expect((await call(owner.headers, owner.userId)).json().error).toBe('SELF_CHANGE_FORBIDDEN');
    expect((await call(owner.headers, adminUser.userId)).json().error).toBe('PASSWORD_NOT_SETTABLE');
    const other = randomUUID();
    await db.query("INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,'Other')", [other, `other-${other}`]);
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [other, invited.userId]);
    expect((await call(owner.headers, invited.userId)).json().error).toBe('PASSWORD_NOT_SETTABLE');
    const learner = await staff('learner', workspaceId);
    expect((await call(learner.headers, invited.userId)).statusCode).toBe(403);
  }, slow);
});

describe('host CLIs never read a password from argv', () => {
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  function run(script: string, args: string[], stdin: string, env: Record<string, string> = {}) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, script, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: schemaUrl, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }
  it('parses only a workspace slug and subject', () => {
    expect(parseSetPasswordArguments(['example-workspace', 'operator:owner'])).toEqual({ workspace: 'example-workspace', subject: 'operator:owner', loginName: undefined, temporary: false });
    expect(parseSetPasswordArguments(['w', 's', '--login', 'Op.Owner', '--temporary'])).toEqual({ workspace: 'w', subject: 's', loginName: 'op.owner', temporary: true });
    for (const args of [['w'], ['w', 's', 'a password on argv'], ['w', 's', '--password', 'secret value here'], ['w', 's', '--password=secret value here'], ['W', 's'], ['w', 's', '--login']]) {
      expect(() => parseSetPasswordArguments(args)).toThrow(/Usage|Login names/);
    }
  });
  it('set-password reads stdin, refuses argv passwords and never prints the secret', async () => {
    const slug = `cli-${randomUUID().slice(0, 8)}`, workspaceId = randomUUID(), userId = randomUUID(), subject = `operator:${randomUUID().slice(0, 8)}`;
    await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$2)', [workspaceId, slug]);
    await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, subject, 'Operator']);
    await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, userId]);
    const secret = 'cli supplied passphrase';
    const argv = await run('src/set-password-cli.ts', [slug, subject, secret], `${secret}\n`);
    expect(argv.code).toBe(1); expect(argv.stderr).toContain('Usage: set-password'); expect(argv.stderr + argv.stdout).not.toContain(secret);
    expect((await db.query('SELECT 1 FROM password_credentials WHERE user_id=$1', [userId])).rowCount).toBe(0);
    const env = await run('src/set-password-cli.ts', [slug, subject], '', { PASSWORD: secret, COURSE_PASSWORD: secret });
    expect(env.code).toBe(1); expect((await db.query('SELECT 1 FROM password_credentials WHERE user_id=$1', [userId])).rowCount).toBe(0);
    const short = await run('src/set-password-cli.ts', [slug, subject], 'short\n');
    expect(short.code).toBe(1); expect(short.stderr).toContain('12-1024');
    const ok = await run('src/set-password-cli.ts', [slug, subject], `${secret}\n`);
    expect(ok.code, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ userId, loginName: subject, mustChangeOnNextSignIn: false, sessionsRevoked: 0 });
    expect(ok.stdout + ok.stderr).not.toContain(secret);
    const app = await server();
    expect((await login(app, { login: subject.toUpperCase(), password: secret })).statusCode).toBe(200);
    const missing = await run('src/set-password-cli.ts', [slug, 'operator:nobody'], `${secret}\n`);
    expect(missing.code).toBe(1); expect(missing.stderr).toContain('No member');
  }, slow);
  it('bootstrap can set the owner password from stdin and issues no code unless codes are enabled', async () => {
    const slug = `boot-${randomUUID().slice(0, 8)}`, subject = `operator:${randomUUID().slice(0, 8)}`, secret = 'bootstrap owner passphrase';
    const created = await run('src/bootstrap-cli.ts', [slug, subject, 'Operator', '--password'], `${secret}\n`);
    expect(created.code, created.stderr).toBe(0);
    const output = JSON.parse(created.stdout);
    expect(output.loginName).toBe(subject); expect(output.oneTimeSignInUrl).toBeUndefined();
    expect(created.stdout + created.stderr).not.toContain(secret);
    const app = await server();
    expect((await login(app, { login: subject, password: secret })).statusCode).toBe(200);
    const withCodes = await run('src/bootstrap-cli.ts', [slug, `${subject}-2`, 'Operator 2', '--no-password'], '', { AUTH_LOGIN_CODES: 'enabled' });
    expect(withCodes.code, withCodes.stderr).toBe(0);
    expect(JSON.parse(withCodes.stdout).oneTimeSignInUrl).toMatch(/#signin=[A-Za-z0-9_-]{43}$/);
    const rejected = await run('src/bootstrap-cli.ts', [slug, subject, 'Operator', secret], '');
    expect(rejected.code).not.toBe(0);
  }, slow);
});
