import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { hashPassword, passwordPolicy, storePassword, throttleKey } from '../src/passwords.js';
import { ACCOUNT_ERASURE_CONFIRMATION } from '../src/account-erasure.js';
import { SoftwareAuthenticator } from './software-authenticator.js';

// A loopback pilot (primary origin) also reached through an HTTPS reverse proxy on a
// private network name, e.g. `tailscale serve` (additional origin). Names are synthetic.
const primary = 'http://localhost:4310', tailnet = 'https://pilot.tailnet.example', tailnetIp = 'http://100.99.0.1:4310', untrusted = 'https://evil.example';
const schema = `additional_origins_${randomUUID().replaceAll('-', '')}`, slow = 120_000;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
const extra: Awaited<ReturnType<typeof createServer>>[] = [];
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin: primary, secureCookies: false, additionalOrigins: [tailnet, tailnetIp] });
}, 30_000);
afterAll(async () => { await app?.close(); await Promise.all(extra.map(server => server.close())); await db?.end(); await testDatabase?.drop(); });

async function account(role?: string, workspaceId?: string) {
  const userId = randomUUID(), login = `user-${userId.slice(0, 8)}`, password = `correct horse ${randomUUID().slice(0, 6)}`;
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `synthetic:${userId}`, 'Synthetic user']);
  await storePassword(db, userId, await hashPassword(passwordPolicy(password)), { mustChange: false, loginName: login });
  if (role) await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, userId, role]);
  return { userId, login, password };
}
const cookieHeader = (response: { cookies: { name: string; value: string }[] }) => response.cookies.map(row => `${row.name}=${row.value}`).join('; ');
const login = (user: { login: string; password: string }, headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/auth/login', headers, payload: { login: user.login, password: user.password } });
async function session(user: { login: string; password: string }, origin: string) {
  const response = await login(user, { origin });
  expect(response.statusCode, response.body).toBe(200);
  return { origin, cookie: cookieHeader(response), 'x-csrf-token': response.json().csrfToken as string };
}

describe('additional trusted origins', () => {
  it('signs in from the primary and the additional origin, with Secure cookies only for https', async () => {
    const user = await account();
    const local = await login(user, { origin: primary });
    expect(local.statusCode).toBe(200);
    for (const cookie of local.cookies) { expect(cookie.secure).not.toBe(true); expect(cookie.sameSite).toBe('Strict'); expect(cookie.path).toBe('/'); }
    const remote = await login(user, { origin: tailnet });
    expect(remote.statusCode).toBe(200);
    expect(remote.cookies.map(cookie => cookie.name).sort()).toEqual(['course_csrf', 'course_session']);
    for (const cookie of remote.cookies) { expect(cookie.secure).toBe(true); expect(cookie.sameSite).toBe('Strict'); expect(cookie.path).toBe('/'); }
    expect(remote.cookies.find(cookie => cookie.name === 'course_session')!.httpOnly).toBe(true);
  }, slow);

  it('rejects sign-in from an untrusted, near-miss or missing Origin before any password check', async () => {
    const user = await account();
    for (const origin of [untrusted, 'http://pilot.tailnet.example', `${tailnet}/`, 'https://pilot.tailnet.example:8443', 'null']) {
      const response = await login(user, { origin });
      expect(response.statusCode, origin).toBe(403); expect(response.json().error).toBe('ORIGIN_REJECTED'); expect(response.cookies).toEqual([]);
    }
    const missing = await login(user, {});
    expect(missing.statusCode).toBe(403); expect(missing.json().error).toBe('ORIGIN_REJECTED');
    const redeem = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin: untrusted }, payload: { token: 'A'.repeat(43) } });
    expect(redeem.statusCode).toBe(403);
    // Refused attempts never reached the throttle.
    expect((await db.query('SELECT count(*) FROM password_login_failures WHERE account_key=$1', [throttleKey('login', user.login)])).rows[0].count).toBe('0');
  }, slow);

  it('accepts authenticated writes from either trusted origin and refuses them from an untrusted or missing one', async () => {
    const user = await account(), headers = await session(user, tailnet);
    const change = (extra: Record<string, string>, next: string) => app.inject({ method: 'POST', url: '/auth/password', headers: { ...headers, ...extra },
      payload: { currentPassword: user.password, newPassword: next } });
    const refused = await change({ origin: untrusted }, `${user.password} changed`);
    expect(refused.statusCode).toBe(403); expect(refused.json().error).toBe('ORIGIN_REJECTED');
    const { origin: _origin, ...withoutOrigin } = headers;
    const missing = await app.inject({ method: 'POST', url: '/auth/password', headers: withoutOrigin, payload: { currentPassword: user.password, newPassword: 'x'.repeat(20) } });
    expect(missing.statusCode).toBe(403); expect(missing.json().error).toBe('ORIGIN_REJECTED');
    const next = `${user.password} changed`;
    expect((await change({}, next)).statusCode).toBe(200);
    // The server does not bind a session to one trusted origin; browsers keep cookies per host.
    const again = await app.inject({ method: 'POST', url: '/auth/password', headers: { ...headers, origin: primary }, payload: { currentPassword: next, newPassword: `${next} again` } });
    expect(again.statusCode).toBe(200);
  }, slow);

  it('clears cookies with the attributes they were set with on logout and erasure', async () => {
    const user = await account(), remote = await session(user, tailnet), local = await session(user, primary);
    const remoteOut = await app.inject({ method: 'POST', url: '/auth/logout', headers: remote });
    expect(remoteOut.statusCode).toBe(200);
    expect(remoteOut.cookies.map(cookie => cookie.name).sort()).toEqual(['course_csrf', 'course_session']);
    for (const cookie of remoteOut.cookies) { expect(cookie.value).toBe(''); expect(cookie.secure).toBe(true); expect(cookie.sameSite).toBe('Strict'); expect(cookie.path).toBe('/'); }
    const localOut = await app.inject({ method: 'POST', url: '/auth/logout', headers: local });
    for (const cookie of localOut.cookies) { expect(cookie.value).toBe(''); expect(cookie.secure).not.toBe(true); }
    const leaving = await account(), headers = await session(leaving, tailnet);
    const erased = await app.inject({ method: 'POST', url: '/api/account/erase', headers, payload: { confirmation: ACCOUNT_ERASURE_CONFIRMATION, reason: 'Synthetic account erasure.' } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.cookies.length).toBe(2);
    for (const cookie of erased.cookies) { expect(cookie.value).toBe(''); expect(cookie.secure).toBe(true); expect(cookie.sameSite).toBe('Strict'); }
  }, slow);

  it('uses a relying party per trusted origin; a passkey works only where it was registered', async () => {
    const user = await account(), headers = await session(user, tailnet), key = new SoftwareAuthenticator(tailnet);
    const options = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/options', headers, payload: {} });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().options.rp).toEqual({ id: 'pilot.tailnet.example', name: 'Course Core' });
    const created = key.create(options.json().options);
    const verify = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/verify', headers, payload: { challengeId: options.json().challengeId, response: created.response } });
    expect(verify.statusCode, verify.body).toBe(200);

    const signInOptions = (origin?: string) => app.inject({ method: 'POST', url: '/auth/passkeys/authentication/options', headers: origin ? { origin } : {}, payload: {} });
    for (const origin of [untrusted, undefined]) {
      const refused = await signInOptions(origin);
      expect(refused.statusCode).toBe(403); expect(refused.json().error).toBe('ORIGIN_REJECTED');
    }
    expect((await signInOptions(primary)).json().options.rpId).toBe('localhost');
    const remote = (await signInOptions(tailnet)).json();
    expect(remote.options.rpId).toBe('pilot.tailnet.example');
    const signedIn = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin: tailnet },
      payload: { challengeId: remote.challengeId, response: key.get(remote.options, created.credential) } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    for (const cookie of signedIn.cookies) expect(cookie.secure).toBe(true);

    // The same assertion presented at the primary origin fails: its RP ID and origin differ.
    const local = (await signInOptions(primary)).json();
    const elsewhere = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin: primary },
      payload: { challengeId: local.challengeId, response: key.get(local.options, created.credential) } });
    expect(elsewhere.statusCode).toBe(401); expect(elsewhere.json().error).toBe('PASSKEY_FAILED');
    // A tailnet-origin assertion replayed through the primary origin also fails.
    const replay = (await signInOptions(tailnet)).json();
    const crossed = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/verify', headers: { origin: primary },
      payload: { challengeId: replay.challengeId, response: key.get(replay.options, created.credential) } });
    expect(crossed.statusCode).toBe(401);
  }, slow);

  it('reports passkey availability for the origin a same-origin GET was addressed to', async () => {
    const loopback = await createServer(db, { origin: 'http://127.0.0.1:4310', secureCookies: false, additionalOrigins: [tailnet] }); extra.push(loopback);
    // An IP-address origin cannot host WebAuthn; the tailnet name can.
    expect((await loopback.inject({ url: '/auth/options', headers: { host: '127.0.0.1:4310' } })).json().passkeys).toBe(false);
    expect((await loopback.inject({ url: '/auth/options', headers: { host: 'pilot.tailnet.example' } })).json().passkeys).toBe(true);
    expect((await loopback.inject({ url: '/auth/options', headers: { host: 'evil.example' } })).json().passkeys).toBe(false);
    // No CORS grant is ever added for any origin.
    const response = await loopback.inject({ url: '/auth/options', headers: { host: 'pilot.tailnet.example', origin: untrusted } });
    expect(Object.keys(response.headers).filter(name => name.startsWith('access-control-'))).toEqual([]);
  });

  it('builds invitation and sign-in links on the origin the administrator used', async () => {
    const workspace = randomUUID();
    await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, `origins-${workspace}`, 'Origins']);
    const owner = await account('owner', workspace);
    for (const origin of [tailnet, tailnetIp, primary]) {
      const headers = await session(owner, origin);
      const invited = await app.inject({ method: 'POST', url: `/api/admin/workspaces/${workspace}/people`, headers,
        payload: { displayName: 'Invited person', role: 'learner', loginName: `invited-${randomUUID().slice(0, 8)}`, idempotencyKey: `k-${randomUUID()}` } });
      expect(invited.statusCode, invited.body).toBe(200);
      const body = invited.json();
      expect(body.password.learnerUrl).toBe(`${origin}/`);
      expect(body.signIn.learnerUrl).toBe(`${origin}/#signin=${body.signIn.code}`);
    }
  }, slow);

  it('signs in over http to a Tailscale address without Secure cookies and refuses passkeys cleanly there', async () => {
    const user = await account();
    const response = await login(user, { origin: tailnetIp });
    expect(response.statusCode, response.body).toBe(200);
    for (const cookie of response.cookies) { expect(cookie.secure).not.toBe(true); expect(cookie.sameSite).toBe('Strict'); expect(cookie.path).toBe('/'); }
    expect(response.cookies.find(cookie => cookie.name === 'course_session')!.httpOnly).toBe(true);
    const headers = { origin: tailnetIp, cookie: cookieHeader(response), 'x-csrf-token': response.json().csrfToken as string };
    expect((await app.inject({ url: '/auth/session', headers: { cookie: headers.cookie, host: '100.99.0.1:4310' } })).statusCode).toBe(200);
    // Not a browser secure context: no relying party, so passkeys are reported off and their routes answer 404.
    expect((await app.inject({ url: '/auth/options', headers: { host: '100.99.0.1:4310' } })).json().passkeys).toBe(false);
    expect((await app.inject({ url: '/auth/options', headers: { host: 'pilot.tailnet.example' } })).json().passkeys).toBe(true);
    const signIn = await app.inject({ method: 'POST', url: '/auth/passkeys/authentication/options', headers: { origin: tailnetIp }, payload: {} });
    expect(signIn.statusCode).toBe(404); expect(signIn.json().error).toBe('PASSKEYS_UNAVAILABLE');
    const register = await app.inject({ method: 'POST', url: '/auth/passkeys/registration/options', headers, payload: {} });
    expect(register.statusCode).toBe(404); expect(register.json().error).toBe('PASSKEYS_UNAVAILABLE');
    const listed = await app.inject({ url: '/auth/passkeys', headers: { cookie: headers.cookie, host: '100.99.0.1:4310' } });
    expect(listed.json().available).toBe(false);
    // Writes and sign-out work; a neighbouring address or port is not trusted.
    const out = await app.inject({ method: 'POST', url: '/auth/logout', headers });
    expect(out.statusCode).toBe(200); for (const cookie of out.cookies) expect(cookie.secure).not.toBe(true);
    for (const origin of ['http://100.99.0.2:4310', 'http://100.99.0.1:4311', 'https://100.99.0.1:4310'])
      expect((await login(user, { origin })).statusCode, origin).toBe(403);
  }, slow);

  it('keeps Secure cookies on an https primary origin but not on an http Tailscale address', async () => {
    const remote = await createServer(db, { origin: 'https://learn.example.org', secureCookies: true, additionalOrigins: [tailnetIp] }); extra.push(remote);
    const user = await account();
    const viaPrimary = await remote.inject({ method: 'POST', url: '/auth/login', headers: { origin: 'https://learn.example.org' }, payload: { login: user.login, password: user.password } });
    for (const cookie of viaPrimary.cookies) expect(cookie.secure).toBe(true);
    const viaIp = await remote.inject({ method: 'POST', url: '/auth/login', headers: { origin: tailnetIp }, payload: { login: user.login, password: user.password } });
    expect(viaIp.statusCode).toBe(200); for (const cookie of viaIp.cookies) expect(cookie.secure).not.toBe(true);
  }, slow);

  it('refuses an invalid additional origin when the server is created', async () => {
    for (const bad of ['http://pilot.tailnet.example', `${tailnet}/path`, 'https://*.tailnet.example', primary, 'http://192.168.1.5:4310', 'http://100.128.0.1:4310', 'http://100.99.0.1'])
      await expect(createServer(db, { origin: primary, secureCookies: false, additionalOrigins: [bad] })).rejects.toThrow();
  });
});
