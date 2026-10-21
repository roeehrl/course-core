import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { requestLocale } from '../src/locale.js';

const origin = 'http://localhost:4391';
const schema = `locale_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string;
interface Session { userId: string; cookie: string; csrf: string }

async function newWorkspace(defaultLocale: string | null = null) {
  const id = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title,default_locale) VALUES($1,$2,$3,$4)', [id, `locale-${id}`, 'Locale', defaultLocale]);
  return id;
}
async function session(role: string, workspaceId = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `locale:${id}`, `${role} user`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { userId: id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
}
function call(who: Session, method: 'GET' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { origin, cookie: who.cookie, 'x-csrf-token': who.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => { workspace = await newWorkspace(); });
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe('user locale preference', () => {
  it('resolves from Accept-Language, then the saved preference wins, and null clears it', async () => {
    const learner = await session('learner');
    let r = await call(learner, 'GET', '/api/me/locale', undefined, { 'accept-language': 'he-IL,he;q=0.9,en;q=0.8' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ preference: null, locale: 'he', source: 'request', workspaceDefault: null, supported: ['en', 'he'] });

    r = await call(learner, 'PUT', '/api/me/locale', { locale: 'en' }, { 'accept-language': 'he-IL' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ preference: 'en', locale: 'en', source: 'user' });
    r = await call(learner, 'GET', '/api/me/locale', undefined, { 'accept-language': 'he' });
    expect(r.json()).toMatchObject({ preference: 'en', locale: 'en', source: 'user' });

    r = await call(learner, 'PUT', '/api/me/locale', { locale: 'he' });
    expect(r.json()).toMatchObject({ preference: 'he', locale: 'he', source: 'user' });
    const me = await call(learner, 'GET', '/auth/session');
    expect(me.json().user.locale).toBe('he');

    r = await call(learner, 'PUT', '/api/me/locale', { locale: null }, { 'accept-language': 'fr' });
    expect(r.json()).toEqual({ preference: null, locale: 'en', source: 'default', workspaceDefault: null, supported: ['en', 'he'] });
    expect((await call(learner, 'GET', '/auth/session')).json().user.locale).toBeNull();
  });

  it('uses the workspace default when the browser asks for nothing supported, and English last', async () => {
    const hebrewWorkspace = await newWorkspace('he');
    const member = await session('learner', hebrewWorkspace);
    let r = await call(member, 'GET', '/api/me/locale', undefined, { 'accept-language': 'fr-FR, de;q=0.5' });
    expect(r.json()).toMatchObject({ preference: null, locale: 'he', source: 'workspace', workspaceDefault: 'he' });
    r = await call(member, 'GET', '/api/me/locale', undefined, { 'accept-language': 'en-US' });
    expect(r.json()).toMatchObject({ locale: 'en', source: 'request', workspaceDefault: 'he' });
    r = await call(member, 'GET', `/api/me/locale?workspaceId=${hebrewWorkspace}`);
    expect(r.json()).toMatchObject({ locale: 'he', source: 'workspace' });
    const plain = await session('learner');
    r = await call(plain, 'GET', '/api/me/locale');
    expect(r.json()).toMatchObject({ locale: 'en', source: 'default', workspaceDefault: null });
    // A workspace the user does not belong to is refused.
    expect((await call(plain, 'GET', `/api/me/locale?workspaceId=${hebrewWorkspace}`)).statusCode).toBe(403);
  });

  it('rejects unsupported, pseudo, mistyped and extra values without changing the preference', async () => {
    const learner = await session('learner');
    await call(learner, 'PUT', '/api/me/locale', { locale: 'he' });
    for (const [body, error] of [
      [{ locale: 'fr' }, 'UNSUPPORTED_LOCALE'],
      [{ locale: 'en-XA' }, 'UNSUPPORTED_LOCALE'],
      [{ locale: 'HE' }, 'UNSUPPORTED_LOCALE'],
      [{ locale: 3 }, 'INVALID_REQUEST'],
      [{ locale: '' }, 'INVALID_REQUEST'],
      [{}, 'INVALID_REQUEST'],
      [{ locale: 'en', theme: 'dark' }, 'INVALID_REQUEST'],
    ] as const) {
      const r = await call(learner, 'PUT', '/api/me/locale', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json()).toEqual({ error });
    }
    expect((await db.query('SELECT locale FROM app_users WHERE id=$1', [learner.userId])).rows[0].locale).toBe('he');
    expect((await call(learner, 'GET', '/api/me/locale?workspaceId=nope')).statusCode).toBe(400);
  });

  it('requires a session, a CSRF token and a trusted origin', async () => {
    const learner = await session('learner');
    expect((await app.inject({ method: 'GET', url: '/api/me/locale' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/api/me/locale', headers: { origin }, payload: { locale: 'he' } })).statusCode).toBe(401);
    let r = await app.inject({ method: 'PUT', url: '/api/me/locale', headers: { origin, cookie: learner.cookie }, payload: { locale: 'he' } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'CSRF_REJECTED' });
    r = await call(learner, 'PUT', '/api/me/locale', { locale: 'he' }, { origin: 'https://attacker.example' });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: 'ORIGIN_REJECTED' });
    expect((await db.query('SELECT locale FROM app_users WHERE id=$1', [learner.userId])).rows[0].locale).toBeNull();
  });
});

describe('workspace default locale', () => {
  it('lets only the owner set it, records it in the audit log, and any member read it', async () => {
    const owner = await session('owner'), admin = await session('admin'), learner = await session('learner');
    const outsider = await session('owner', await newWorkspace());
    const url = `/api/workspaces/${workspace}/locale`;
    for (const who of [admin, learner, outsider]) {
      const r = await call(who, 'PUT', url, { defaultLocale: 'he' });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: 'FORBIDDEN' });
    }
    expect((await call(outsider, 'GET', url)).statusCode).toBe(403);
    expect((await call(learner, 'GET', url)).json()).toEqual({ defaultLocale: null, supported: ['en', 'he'] });

    expect((await call(owner, 'PUT', url, { defaultLocale: 'fr' })).json()).toEqual({ error: 'UNSUPPORTED_LOCALE' });
    expect((await call(owner, 'PUT', url, { defaultLocale: 'he', extra: 1 })).statusCode).toBe(400);
    let r = await call(owner, 'PUT', url, { defaultLocale: 'he' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ defaultLocale: 'he', supported: ['en', 'he'] });
    await call(owner, 'PUT', url, { defaultLocale: 'he' });
    expect((await call(admin, 'GET', url)).json()).toMatchObject({ defaultLocale: 'he' });
    expect((await call(learner, 'GET', '/api/me/locale', undefined, { 'accept-language': 'ja' })).json()).toMatchObject({ locale: 'he', source: 'workspace' });

    r = await call(owner, 'PUT', url, { defaultLocale: null });
    expect(r.json()).toEqual({ defaultLocale: null, supported: ['en', 'he'] });
    const events = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='workspace.locale_changed' ORDER BY sequence", [workspace])).rows;
    // Setting the same value twice records one change.
    expect(events.map(row => row.payload)).toEqual([{ defaultLocale: 'he', previous: null }, { defaultLocale: null, previous: 'he' }]);
  });
});

describe('storage and server-side resolution', () => {
  it('the columns refuse values that are not language tags', async () => {
    const id = randomUUID();
    await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `locale:${id}`, 'Check']);
    await expect(db.query("UPDATE app_users SET locale='english please' WHERE id=$1", [id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.query("UPDATE workspaces SET default_locale='<he>' WHERE id=$1", [workspace])).rejects.toMatchObject({ code: '23514' });
    await db.query("UPDATE app_users SET locale='he' WHERE id=$1", [id]);
  });

  it('requestLocale follows the same order for server-rendered text', async () => {
    const request = (header?: string) => ({ headers: header ? { 'accept-language': header } : {} }) as FastifyRequest;
    expect(await requestLocale(db, request('he-IL'))).toEqual({ locale: 'he', source: 'request' });
    expect(await requestLocale(db, request())).toEqual({ locale: 'en', source: 'default' });
    const hebrew = await newWorkspace('he');
    const member = await session('learner', hebrew);
    expect(await requestLocale(db, request('fr'), member.userId)).toEqual({ locale: 'he', source: 'workspace' });
    await db.query("UPDATE app_users SET locale='en' WHERE id=$1", [member.userId]);
    expect(await requestLocale(db, request('he'), member.userId, hebrew)).toEqual({ locale: 'en', source: 'user' });
  });
});
