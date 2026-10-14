import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { authService, hashSecret, type AuthOptions } from '../src/auth.js';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { ApiError } from '../src/errors.js';
import { hashPassword, passwordPolicy, storePassword } from '../src/passwords.js';
import { MAX_OPEN_SIGN_IN_CHALLENGES, passkeyName, passkeyRelyingParty } from '../src/passkeys.js';
import { SoftwareAuthenticator, type SoftCredential } from './software-authenticator.js';

const schema = `passkey_auth_${randomUUID().replaceAll('-', '')}`;
const origin = 'http://localhost:4310';
const slow = 120_000;
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
  authService(db, { origin, secureCookies: false, ...options }).routes(app);
  apps.push(app); return app;
}
async function account() {
  const userId = randomUUID(), login = `user-${userId.slice(0, 8)}`, password = `correct horse ${randomUUID().slice(0, 6)}`;
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `synthetic:${userId}`, 'Synthetic user']);
  await storePassword(db, userId, await hashPassword(passwordPolicy(password)), { mustChange: false, loginName: login });
  return { userId, login, password };
}
type Session = { cookie: string; csrf: string };
const cookieHeader = (response: { cookies: { name: string; value: string }[] }) => response.cookies.map(row => `${row.name}=${row.value}`).join('; ');
async function signIn(app: FastifyInstance, user: { login: string; password: string }): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { login: user.login, password: user.password } });
  expect(response.statusCode).toBe(200);
  return { cookie: cookieHeader(response), csrf: response.json().csrfToken };
}
const authed = (session: Session, extra: Record<string, string> = {}) => ({ origin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra });
async function registrationOptions(app: FastifyInstance, session: Session, payload: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/auth/passkeys/registration/options', headers: authed(session), payload });
}
async function register(app: FastifyInstance, session: Session, key: SoftwareAuthenticator, name = 'Work laptop') {
  const options = await registrationOptions(app, session);
  expect(options.statusCode).toBe(200);
  const { challengeId, options: creation } = options.json();
  const created = key.create(creation);
  const verify = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(session), payload: { challengeId, name, response: created.response } });
  expect(verify.statusCode).toBe(200);
  return { credential: created.credential, passkey: verify.json().passkey as { id: string; name: string }, challengeId, creation };
}
async function signInOptions(app: FastifyInstance, headers: Record<string, string> = { origin }, remoteAddress?: string) {
  return app.inject({ method: 'POST', url: '/auth/passkeys/authentication/options', headers, payload: {}, ...(remoteAddress ? { remoteAddress } : {}) });
}
async function passkeySignIn(app: FastifyInstance, key: SoftwareAuthenticator, credential: SoftCredential,
  forge: Parameters<SoftwareAuthenticator['get']>[2] = {}, edit?: (response: ReturnType<SoftwareAuthenticator['get']>) => void) {
  const options = await signInOptions(app);
  expect(options.statusCode).toBe(200);
  const { challengeId, options: request } = options.json();
  const response = key.get(request, credential, forge);
  edit?.(response);
  return { challengeId, response, result: await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin }, payload: { challengeId, response } }) };
}
const passkeyRows = async (userId: string) => (await db.query('SELECT * FROM passkey_credentials WHERE user_id=$1', [userId])).rows;
const sessions = async (userId: string) => Number((await db.query('SELECT count(*) FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [userId])).rows[0].count);

// An origin carrying a username (built, so the public audit sees no URL credential).
const withUser = (value: string) => { const url = new URL(value); url.username = 'someone'; return url.href.replace(/\/$/, ''); };

describe('relying party derivation', () => {
  it('derives the RP ID and expected origin strictly from PUBLIC_ORIGIN', () => {
    expect(passkeyRelyingParty('https://learn.example.org')).toEqual({ id: 'learn.example.org', origin: 'https://learn.example.org', name: 'Course Core' });
    expect(passkeyRelyingParty('https://learn.example.org:8443')).toMatchObject({ id: 'learn.example.org', origin: 'https://learn.example.org:8443' });
    expect(passkeyRelyingParty('http://localhost:4310')).toMatchObject({ id: 'localhost', origin: 'http://localhost:4310' });
    // IP addresses are never valid RP IDs; plain http is only a secure context on localhost.
    for (const bad of ['http://127.0.0.1:4317', 'https://127.0.0.1', 'https://[::1]:4310', 'http://learn.example.org',
      'https://learn.example.org/', 'https://learn.example.org/path', withUser('https://learn.example.org'), 'not a url'])
      expect(passkeyRelyingParty(bad)).toBeUndefined();
  });
  it('bounds and normalises passkey names', () => {
    expect(passkeyName(undefined)).toBe('Passkey');
    expect(passkeyName('  Work\n laptop  ')).toBe('Work laptop');
    for (const bad of ['', '   ', 'x'.repeat(101), 7]) expect(() => passkeyName(bad)).toThrow('PASSKEY_NAME_INVALID');
  });
  it('turns passkeys off when the origin cannot host WebAuthn', async () => {
    const app = await server({ origin: 'http://127.0.0.1:4317' });
    expect((await app.inject({ url: '/auth/options' })).json().passkeys).toBe(false);
    const options = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/options', headers: { origin: 'http://127.0.0.1:4317' }, payload: {} });
    expect(options.statusCode).toBe(404); expect(options.json().error).toBe('PASSKEYS_UNAVAILABLE');
    expect((await (await server()).inject({ url: '/auth/options' })).json().passkeys).toBe(true);
  });
});

describe('passkey registration and sign-in', () => {
  it('registers for a signed-in account and signs in with the same session and CSRF cookies as a password', async () => {
    const app = await server({ secureCookies: true }), user = await account(), key = new SoftwareAuthenticator(origin);
    const session = await signIn(app, user);
    const options = (await registrationOptions(app, session)).json();
    expect(options.options).toMatchObject({ rp: { id: 'localhost', name: 'Course Core' }, user: { name: user.login, displayName: 'Synthetic user' },
      attestation: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
    // The WebAuthn user handle is opaque: not the account id, subject or login name.
    const handle = (await db.query('SELECT passkey_user_handle FROM app_users WHERE id=$1', [user.userId])).rows[0].passkey_user_handle;
    expect(options.options.user.id).toBe(handle);
    expect(Buffer.from(handle, 'base64url').toString('hex')).not.toContain(user.userId.replaceAll('-', ''));
    const created = key.create(options.options);
    const verify = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(session),
      payload: { challengeId: options.challengeId, name: 'Work laptop', response: created.response } });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().passkey).toMatchObject({ name: 'Work laptop', lastUsedAt: null, transports: ['internal', 'hybrid'] });
    const [row] = await passkeyRows(user.userId);
    expect(row).toMatchObject({ credential_id: created.credential.id, sign_count: '0', friendly_name: 'Work laptop', device_type: 'singleDevice' });

    const signInRequest = (await signInOptions(app)).json();
    expect(signInRequest.options).toMatchObject({ rpId: 'localhost', userVerification: 'required', allowCredentials: [] });
    const assertion = key.get(signInRequest.options, created.credential);
    const result = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin }, payload: { challengeId: signInRequest.challengeId, response: assertion } });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    const sessionCookie = result.cookies.find(c => c.name === 'course_session')!, csrf = result.cookies.find(c => c.name === 'course_csrf')!;
    expect(sessionCookie.httpOnly).toBe(true); expect(sessionCookie.secure).toBe(true); expect(sessionCookie.sameSite).toBe('Strict');
    expect(csrf.httpOnly).not.toBe(true); expect(result.json()).toEqual({ authenticated: true, csrfToken: csrf.value });
    const stored = (await db.query('SELECT token_hash,csrf_hash FROM auth_sessions WHERE token_hash=$1', [hashSecret(sessionCookie.value)])).rows[0];
    expect(stored.csrf_hash).toBe(hashSecret(csrf.value));
    const me = await app.inject({ url: '/auth/session', headers: { cookie: cookieHeader(result) } });
    expect(me.json().user).toMatchObject({ id: user.userId, loginName: user.login, hasPassword: true });
    const [used] = await passkeyRows(user.userId);
    expect(used.sign_count).toBe('1'); expect(used.last_used_at).not.toBeNull();
    // The password remains available alongside the passkey.
    await signIn(app, user);
  }, slow);

  it('refuses registration without an authenticated session, CSRF or the exact origin', async () => {
    const app = await server(), user = await account(), session = await signIn(app, user);
    const anonymous = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/options', headers: { origin }, payload: {} });
    expect(anonymous.statusCode).toBe(401); expect(anonymous.json().error).toBe('UNAUTHENTICATED');
    const anonymousVerify = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: { origin },
      payload: { challengeId: randomUUID(), response: { id: 'AAAAAAAAAAAAAAAAAAAAAA', rawId: 'AAAAAAAAAAAAAAAAAAAAAA', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'oA' } } } });
    expect(anonymousVerify.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/passkeys/registration/options', headers: { origin, cookie: session.cookie }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/auth/passkeys/registration/options', headers: authed(session, { origin: 'https://evil.invalid' }), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: '/auth/passkeys' })).statusCode).toBe(401);
    expect((await db.query('SELECT count(*) FROM passkey_challenges WHERE user_id=$1', [user.userId])).rows[0].count).toBe('0');
  }, slow);

  it('requires a fresh session or the current password to register', async () => {
    const app = await server(), user = await account(), session = await signIn(app, user), key = new SoftwareAuthenticator(origin);
    await db.query(`UPDATE auth_sessions SET created_at=clock_timestamp()-interval '11 minutes' WHERE user_id=$1`, [user.userId]);
    const stale = await registrationOptions(app, session);
    expect(stale.statusCode).toBe(403); expect(stale.json().error).toBe('REAUTHENTICATION_REQUIRED');
    const wrong = await registrationOptions(app, session, { currentPassword: 'not the password at all' });
    expect(wrong.statusCode).toBe(403); expect(wrong.json().error).toBe('CURRENT_PASSWORD_INCORRECT');
    const confirmed = await registrationOptions(app, session, { currentPassword: user.password });
    expect(confirmed.statusCode).toBe(200);
    const { challengeId, options } = confirmed.json();
    const verify = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(session), payload: { challengeId, response: key.create(options).response } });
    expect(verify.statusCode).toBe(200); expect(verify.json().passkey.name).toBe('Passkey');
    // An account without a password must sign in again instead.
    const codeOnly = randomUUID();
    await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [codeOnly, `synthetic:${codeOnly}`, 'Code user']);
    await db.query(`INSERT INTO auth_sessions (id,user_id,token_hash,csrf_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,clock_timestamp()+interval '1 hour',clock_timestamp()-interval '1 hour')`,
      [randomUUID(), codeOnly, hashSecret('s'.repeat(43)), hashSecret('c'.repeat(43))]);
    const noPassword = await registrationOptions(app, { cookie: `course_session=${'s'.repeat(43)}`, csrf: 'c'.repeat(43) }, { currentPassword: 'any password here' });
    expect(noPassword.statusCode).toBe(403); expect(noPassword.json().error).toBe('REAUTHENTICATION_REQUIRED');
  }, slow);

  it('refuses registration responses for the wrong origin, RP, ceremony type or without user verification', async () => {
    const app = await server(), user = await account(), session = await signIn(app, user), key = new SoftwareAuthenticator(origin);
    for (const forge of [{ origin: 'https://evil.invalid' }, { origin: 'http://localhost:9999' }, { rpId: 'evil.invalid' }, { type: 'webauthn.get' }, { userVerified: false }, { challenge: 'A'.repeat(43) }]) {
      const { challengeId, options } = (await registrationOptions(app, session)).json();
      const response = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(session), payload: { challengeId, response: key.create(options, forge).response } });
      expect(response.statusCode, JSON.stringify(forge)).toBe(400);
      expect(response.json().error).toBe('PASSKEY_REGISTRATION_FAILED');
    }
    expect(await passkeyRows(user.userId)).toHaveLength(0);
  }, slow);
});

describe('challenges are single-use, short-lived and bound', () => {
  it('a registration challenge cannot be reused, used after expiry, or used from another session or account', async () => {
    const app = await server(), user = await account(), other = await account(), key = new SoftwareAuthenticator(origin);
    const session = await signIn(app, user), second = await signIn(app, user), stranger = await signIn(app, other);
    const first = await register(app, session, key);
    const replay = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(session),
      payload: { challengeId: first.challengeId, response: key.create(first.creation).response } });
    expect(replay.statusCode).toBe(400); expect(replay.json().error).toBe('PASSKEY_CHALLENGE_INVALID');

    for (const thief of [second, stranger]) {
      const { challengeId, options } = (await registrationOptions(app, session)).json();
      const stolen = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(thief), payload: { challengeId, response: key.create(options).response } });
      expect(stolen.statusCode).toBe(400); expect(stolen.json().error).toBe('PASSKEY_CHALLENGE_INVALID');
    }

    const { challengeId, options } = (await registrationOptions(app, session)).json();
    await db.query(`UPDATE passkey_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [challengeId]);
    const expired = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(session), payload: { challengeId, response: key.create(options).response } });
    expect(expired.statusCode).toBe(400); expect(expired.json().error).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(await passkeyRows(user.userId)).toHaveLength(1);
    expect(await passkeyRows(other.userId)).toHaveLength(0);
  }, slow);

  it('a sign-in challenge works once and not after expiry; challenges live five minutes', async () => {
    const app = await server(), user = await account(), key = new SoftwareAuthenticator(origin);
    const { credential } = await register(app, await signIn(app, user), key);
    const used = await passkeySignIn(app, key, credential);
    expect(used.result.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin },
      payload: { challengeId: used.challengeId, response: key.get({ challenge: JSON.parse(Buffer.from(used.response.response.clientDataJSON, 'base64url').toString()).challenge }, credential) } });
    expect(replay.statusCode).toBe(400); expect(replay.json().error).toBe('PASSKEY_CHALLENGE_INVALID');

    const options = (await signInOptions(app)).json();
    const lifetime = (await db.query(`SELECT extract(epoch FROM expires_at-created_at)::int AS seconds FROM passkey_challenges WHERE id=$1`, [options.challengeId])).rows[0].seconds;
    expect(lifetime).toBe(300); expect(options.options.timeout).toBe(300_000);
    await db.query(`UPDATE passkey_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [options.challengeId]);
    const expired = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin }, payload: { challengeId: options.challengeId, response: key.get(options.options, credential) } });
    expect(expired.statusCode).toBe(400); expect(expired.json().error).toBe('PASSKEY_CHALLENGE_INVALID');
    expect((await db.query('SELECT count(*) FROM passkey_challenges WHERE id=$1', [options.challengeId])).rows[0].count).toBe('0');
    // A registration challenge is not a sign-in challenge.
    const registration = (await registrationOptions(app, await signIn(app, user))).json();
    const crossed = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin },
      payload: { challengeId: registration.challengeId, response: key.get({ challenge: registration.options.challenge }, credential) } });
    expect(crossed.statusCode).toBe(400);
  }, slow);

  it('bounds the open sign-in challenges per client address and requires the exact origin', async () => {
    const app = await server(), address = '203.0.113.77';
    for (const bad of ['', 'https://evil.invalid', `${origin}/`]) expect((await signInOptions(app, bad ? { origin: bad } : {}, address)).statusCode).toBe(403);
    for (let i = 0; i < MAX_OPEN_SIGN_IN_CHALLENGES; i++) expect((await signInOptions(app, { origin }, address)).statusCode).toBe(200);
    const limited = await signInOptions(app, { origin }, address);
    expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBe('300');
    expect((await signInOptions(app, { origin }, '203.0.113.78')).statusCode).toBe(200);
  }, slow);
});

describe('passkey sign-in verification', () => {
  it('rejects the wrong origin, RP, ceremony type, missing user verification and a forged user handle', async () => {
    const app = await server(), user = await account(), key = new SoftwareAuthenticator(origin);
    const { credential } = await register(app, await signIn(app, user), key);
    for (const forge of [{ origin: 'https://evil.invalid' }, { origin: 'http://localhost:4311' }, { rpId: 'evil.invalid' }, { type: 'webauthn.create' }, { userVerified: false }]) {
      const { result } = await passkeySignIn(app, key, credential, forge);
      expect(result.statusCode, JSON.stringify(forge)).toBe(401);
      expect(result.json().error).toBe('PASSKEY_FAILED'); expect(result.cookies).toHaveLength(0);
    }
    const forged = await passkeySignIn(app, key, credential, {}, response => { response.response.userHandle = 'A'.repeat(43); });
    expect(forged.result.statusCode).toBe(401);
    const tampered = await passkeySignIn(app, key, credential, {}, response => { response.response.signature = Buffer.alloc(70, 1).toString('base64url'); });
    expect(tampered.result.statusCode).toBe(401);
    expect(await sessions(user.userId)).toBe(1); // only the password session used to register
  }, slow);

  it('rejects a signature counter that does not increase', async () => {
    const app = await server(), user = await account(), key = new SoftwareAuthenticator(origin);
    const { credential } = await register(app, await signIn(app, user), key);
    expect((await passkeySignIn(app, key, credential, { counter: 5 })).result.statusCode).toBe(200);
    for (const counter of [5, 4, 0]) {
      const { result } = await passkeySignIn(app, key, credential, { counter });
      expect(result.statusCode, String(counter)).toBe(401); expect(result.json().error).toBe('PASSKEY_FAILED');
    }
    expect((await passkeyRows(user.userId))[0].sign_count).toBe('5');
    expect((await passkeySignIn(app, key, credential, { counter: 6 })).result.statusCode).toBe(200);
  }, slow);

  it('an unknown credential and another account\'s credential id are refused; a credential is registered once', async () => {
    const app = await server(), alice = await account(), bob = await account(), key = new SoftwareAuthenticator(origin);
    const { credential } = await register(app, await signIn(app, alice), key);
    const stranger = new SoftwareAuthenticator(origin);
    const fake = stranger.create({ challenge: 'A'.repeat(43), rp: { id: 'localhost' }, user: { id: 'B'.repeat(43) } }).credential;
    expect((await passkeySignIn(app, stranger, fake)).result.statusCode).toBe(401);
    // Bob presents Alice's credential id with his own key: the signature does not verify.
    const impostor = { ...fake, id: credential.id, userHandle: credential.userHandle };
    expect((await passkeySignIn(app, stranger, impostor)).result.statusCode).toBe(401);
    // Bob cannot register a credential id that already belongs to Alice.
    const bobSession = await signIn(app, bob);
    const { challengeId, options } = (await registrationOptions(app, bobSession)).json();
    const created = key.create(options);
    const reused = { ...created.response, id: credential.id, rawId: credential.id };
    const duplicate = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(bobSession), payload: { challengeId, response: reused } });
    expect(duplicate.statusCode).toBe(400); // the attested credential id must match the response id
    const again = (await registrationOptions(app, bobSession)).json();
    const sameId = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers: authed(bobSession),
      payload: { challengeId: again.challengeId, response: key.create(again.options, { credentialId: credential.id }).response } });
    expect(sameId.statusCode).toBe(409); expect(sameId.json().error).toBe('PASSKEY_ALREADY_REGISTERED');
    expect(await passkeyRows(bob.userId)).toHaveLength(0);
    expect(await sessions(alice.userId)).toBe(1);
  }, slow);

  it('passkey failures share the password throttle for the account and the address', async () => {
    const app = await server({ passwordThrottle: { accountFailures: 3, addressFailures: 100, windowMinutes: 15 } });
    const user = await account(), key = new SoftwareAuthenticator(origin);
    const { credential } = await register(app, await signIn(app, user), key);
    for (let i = 0; i < 3; i++) expect((await passkeySignIn(app, key, credential, { origin: 'https://evil.invalid' })).result.statusCode).toBe(401);
    const throttled = await passkeySignIn(app, key, credential);
    expect(throttled.result.statusCode).toBe(429); expect(throttled.result.json().error).toBe('LOGIN_THROTTLED');
    const password = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin }, payload: { login: user.login, password: user.password } });
    expect(password.statusCode).toBe(429);
    await db.query('DELETE FROM password_login_failures');
    // A success clears the account's failures.
    expect((await passkeySignIn(app, key, credential, { origin: 'https://evil.invalid' })).result.statusCode).toBe(401);
    expect((await passkeySignIn(app, key, credential)).result.statusCode).toBe(200);
    expect((await db.query('SELECT count(*) FROM password_login_failures')).rows[0].count).toBe('0');
  }, slow);

  it('refuses the must-change-password state; an administrator\'s temporary password removes passkeys', async () => {
    const app = await server(), user = await account(), key = new SoftwareAuthenticator(origin);
    const { credential } = await register(app, await signIn(app, user), key);
    await db.query('UPDATE password_credentials SET must_change=true WHERE user_id=$1', [user.userId]);
    const before = await sessions(user.userId);
    const refused = await passkeySignIn(app, key, credential);
    expect(refused.result.statusCode).toBe(409); expect(refused.result.json().error).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(refused.result.cookies).toHaveLength(0); expect(await sessions(user.userId)).toBe(before);
    await db.query('UPDATE password_credentials SET must_change=false WHERE user_id=$1', [user.userId]);
    const reset = await storePassword(db, user.userId, await hashPassword(passwordPolicy('a temporary password')), { mustChange: true });
    expect(reset.passkeysRemoved).toBe(1);
    expect(await passkeyRows(user.userId)).toHaveLength(0);
    expect((await passkeySignIn(app, key, credential)).result.statusCode).toBe(401);
  }, slow);
});

describe('managing your own passkeys', () => {
  it('lists only your passkeys, deletes them (including the last one) and never another account\'s', async () => {
    const app = await server(), alice = await account(), bob = await account(), key = new SoftwareAuthenticator(origin);
    const aliceSession = await signIn(app, alice), bobSession = await signIn(app, bob);
    const one = await register(app, aliceSession, key, 'Phone'), two = await register(app, aliceSession, key, 'Laptop');
    const bobs = await register(app, bobSession, new SoftwareAuthenticator(origin), 'Bob key');
    const list = await app.inject({ url: '/auth/passkeys', headers: { cookie: aliceSession.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().available).toBe(true);
    expect(list.json().passkeys.map((p: { name: string }) => p.name)).toEqual(['Phone', 'Laptop']);
    expect(JSON.stringify(list.json())).not.toMatch(/credential|public/i);
    // A second registration excludes the existing credentials.
    const options = (await registrationOptions(app, aliceSession)).json().options;
    expect(options.excludeCredentials.map((c: { id: string }) => c.id).sort()).toEqual([one.credential.id, two.credential.id].sort());

    const foreign = await app.inject({ method: 'DELETE', url: `/auth/passkeys/${bobs.passkey.id}`, headers: authed(aliceSession) });
    expect(foreign.statusCode).toBe(404); expect(foreign.json().error).toBe('PASSKEY_NOT_FOUND');
    expect(await passkeyRows(bob.userId)).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/auth/passkeys/${one.passkey.id}`, headers: { origin, cookie: aliceSession.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/auth/passkeys/${one.passkey.id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/auth/passkeys/not-a-uuid', headers: authed(aliceSession) })).statusCode).toBe(400);

    for (const passkey of [one.passkey, two.passkey]) {
      const deleted = await app.inject({ method: 'DELETE', url: `/auth/passkeys/${passkey.id}`, headers: authed(aliceSession) });
      expect(deleted.statusCode).toBe(200); expect(deleted.json()).toEqual({ deleted: true });
    }
    expect(await passkeyRows(alice.userId)).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: `/auth/passkeys/${one.passkey.id}`, headers: authed(aliceSession) })).statusCode).toBe(404);
    // A deleted passkey no longer signs in; the password always does.
    expect((await passkeySignIn(app, key, one.credential)).result.statusCode).toBe(401);
    await signIn(app, alice);
  }, slow);
});
