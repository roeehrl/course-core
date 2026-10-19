import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { hashPassword, normalizeLoginName, passwordPolicy, prepareDummyHash, storePassword, throttleKey, verifyPassword,
  PASSWORD_INPUT_LIMIT, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwords.js';
import { passkeyRelyingParty, passkeyRoutes } from './passkeys.js';
import { trustedOrigins } from './origins.js';

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export interface Actor { id: string; displayName: string }
export interface PasswordThrottle {
  /** Failed attempts allowed per login name (known or unknown) within the window. */
  accountFailures: number;
  /** Failed attempts allowed per client address within the window. */
  addressFailures: number;
  windowMinutes: number;
}
export const DEFAULT_PASSWORD_THROTTLE: PasswordThrottle = Object.freeze({ accountFailures: 10, addressFailures: 100, windowMinutes: 15 });
export interface AuthOptions {
  /** The primary public origin (PUBLIC_ORIGIN). */
  origin: string;
  /** Secure cookies for requests made from the primary origin. Requests from an additional
   * origin receive Secure cookies exactly when that origin is https. */
  secureCookies: boolean;
  /** Further exact https origins the same server is reachable under (ADDITIONAL_ORIGINS),
   * for example a tailnet HTTPS proxy in front of a loopback pilot. */
  additionalOrigins?: readonly string[];
  /** ALLOW_INSECURE_ORIGINS: additional origins may be any exact http origin, not only a
   * literal Tailscale address. Off by default; never relaxes the Origin check itself. */
  allowInsecureOrigins?: boolean;
  /** Defaults to 12 hours; positive whole-millisecond duration, capped at 30 days. */
  sessionHours?: number;
  /** One-time sign-in code redemption and issue. Off unless explicitly enabled. */
  loginCodes?: boolean;
  passwordThrottle?: PasswordThrottle;
}
export const MAX_SESSION_HOURS = 30 * 24;
/** Parses an optional session lifetime setting (hours, may be fractional). */
export function parseSessionHours(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const hours = typeof value === 'number' ? value : /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const ms = hours * 3600_000;
  if (!Number.isFinite(hours) || !Number.isSafeInteger(ms) || ms <= 0 || hours > MAX_SESSION_HOURS) throw new Error('INVALID_SESSION_LIFETIME');
  return hours;
}
/** AUTH_LOGIN_CODES accepts exactly "enabled" or "disabled"; anything else is a configuration error. */
export function parseLoginCodes(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'disabled') return false;
  if (value === 'enabled') return true;
  throw new Error('AUTH_LOGIN_CODES must be "enabled" or "disabled".');
}

export async function issueLoginCode(db: Database, userId: string) {
  const token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO login_codes (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval \'10 minutes\')', [hashSecret(token), userId]);
  return token;
}

const passwordInput = { type: 'string', minLength: 1, maxLength: PASSWORD_INPUT_LIMIT };

export function authService(db: Database, options: AuthOptions) {
  const sessionMs = (options.sessionHours ?? 12) * 3600_000;
  if (!Number.isSafeInteger(sessionMs) || sessionMs <= 0 || sessionMs > MAX_SESSION_HOURS * 3600_000) throw new Error('INVALID_SESSION_LIFETIME');
  const loginCodes = options.loginCodes === true;
  const throttle = options.passwordThrottle ?? DEFAULT_PASSWORD_THROTTLE;
  if (![throttle.accountFailures, throttle.addressFailures, throttle.windowMinutes].every(n => Number.isInteger(n) && n > 0 && n <= 100_000)) throw new Error('INVALID_PASSWORD_THROTTLE');
  prepareDummyHash();
  // State-changing requests must come from one of these exact origins.
  const origins = trustedOrigins(options.origin, options.additionalOrigins ?? [], { allowInsecure: options.allowInsecureOrigins === true });
  const requireTrustedOrigin = (request: FastifyRequest) => requireCondition(origins.matched(request) !== undefined, 'ORIGIN_REJECTED', 403);
  // Passkeys are available on each trusted origin that is WebAuthn-capable, with that
  // origin's host as relying party: a passkey registered under one origin works only there.
  const relyingParties = new Map(origins.all.map(origin => [origin, passkeyRelyingParty(origin)]));
  const relyingParty = (request: FastifyRequest) => relyingParties.get(origins.forRequest(request));
  const noStore = async (_request: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache'); };
  /** Session cookie attributes for this request's origin; also used to clear them. */
  // Browsers drop Secure cookies on http, so an http Tailscale-address origin gets none.
  const cookieOptions = (request: FastifyRequest) => {
    const origin = origins.forRequest(request);
    return { httpOnly: true, secure: origin === options.origin ? options.secureCookies : origin.startsWith('https:'), sameSite: 'strict' as const, path: '/' };
  };
  async function authenticate(request: FastifyRequest): Promise<Actor> {
    const token = request.cookies.course_session;
    requireCondition(token && /^[A-Za-z0-9_-]{43}$/.test(token), 'UNAUTHENTICATED', 401);
    const result = await db.query<{ id: string; display_name: string; csrf_hash: string }>(
      `SELECT u.id,u.display_name,s.csrf_hash FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`, [hashSecret(token)]);
    const row = result.rows[0];
    requireCondition(row, 'UNAUTHENTICATED', 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      requireTrustedOrigin(request);
      const csrf = request.headers['x-csrf-token'];
      requireCondition(typeof csrf === 'string' && /^[A-Za-z0-9_-]{43}$/.test(csrf)
        && timingSafeEqual(Buffer.from(hashSecret(csrf), 'hex'), Buffer.from(row.csrf_hash, 'hex')), 'CSRF_REJECTED', 403);
    }
    return { id: row.id, displayName: row.display_name };
  }
  async function createSession(client: PoolClient, userId: string) {
    const sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    const saved = await client.query<{ expires_at: Date }>(`INSERT INTO auth_sessions (id,user_id,token_hash,csrf_hash,expires_at)
      VALUES ($1,$2,$3,$4,clock_timestamp()+($5 * interval '1 millisecond')) RETURNING expires_at`,
    [randomUUID(), userId, hashSecret(sessionToken), hashSecret(csrf), sessionMs]);
    return { sessionToken, csrf, expires: saved.rows[0]!.expires_at };
  }
  function sendSession(reply: FastifyReply, session: { sessionToken: string; csrf: string; expires: Date }) {
    const cookies = cookieOptions(reply.request);
    reply.setCookie('course_session', session.sessionToken, { ...cookies, expires: session.expires });
    reply.setCookie('course_csrf', session.csrf, { ...cookies, httpOnly: false, expires: session.expires });
    return { authenticated: true, csrfToken: session.csrf };
  }
  /** Counts an attempt as failed BEFORE the password is checked, so concurrent guesses
   * cannot overrun the budget; a successful attempt then clears its account's failures.
   * Rejects (429) when either key has used its failure budget within the window. */
  async function reserveAttempt(reply: FastifyReply, accountKey: string, addressKey: string) {
    const throttled = await transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['password-login:' + accountKey]);
      await client.query('DELETE FROM password_login_failures WHERE created_at<clock_timestamp()-($1 * interval \'1 minute\')', [throttle.windowMinutes]);
      const counts = (await client.query<{ account: number; address: number }>(
        `SELECT count(*) FILTER (WHERE account_key=$1)::int AS account,count(*) FILTER (WHERE address_key=$2)::int AS address
         FROM password_login_failures WHERE (account_key=$1 OR address_key=$2) AND created_at>clock_timestamp()-($3 * interval '1 minute')`,
        [accountKey, addressKey, throttle.windowMinutes])).rows[0]!;
      if (counts.account >= throttle.accountFailures || counts.address >= throttle.addressFailures) return true;
      await client.query('INSERT INTO password_login_failures (account_key,address_key) VALUES ($1,$2)', [accountKey, addressKey]);
      return false;
    });
    if (throttled) {
      reply.header('Retry-After', String(throttle.windowMinutes * 60));
      throw new ApiError(429, 'LOGIN_THROTTLED');
    }
  }
  const addressKey = (request: FastifyRequest) => throttleKey('address', request.ip ?? 'unknown');
  function routes(app: FastifyInstance) {
    app.get('/auth/options', { onRequest: noStore, logLevel: 'silent' }, async request => ({
      password: { minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH }, loginCodes, passkeys: relyingParty(request) !== undefined,
    }));
    app.post('/auth/redeem', { onRequest: noStore, logLevel: 'silent', schema: { body: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } } }, async (request, reply) => {
      requireTrustedOrigin(request);
      // Disabled codes are refused before any lookup, so an old code cannot be consumed.
      requireCondition(loginCodes, 'LOGIN_CODES_DISABLED', 403);
      const { token } = request.body as { token: string };
      const session = await transaction(db, async client => {
        // Take the row lock BEFORE checking wall-clock expiry. now() is frozen at transaction
        // start, and an UPDATE predicate alone can have been evaluated before its lock wait.
        await client.query('SELECT token_hash FROM login_codes WHERE token_hash=$1 FOR UPDATE', [hashSecret(token)]);
        const login = await client.query<{ user_id: string }>(
          'UPDATE login_codes SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING user_id', [hashSecret(token)]);
        requireCondition(login.rows[0], 'LOGIN_CODE_INVALID', 401);
        return createSession(client, login.rows[0].user_id);
      });
      return sendSession(reply, session);
    });
    app.post('/auth/login', { onRequest: noStore, logLevel: 'silent', schema: { body: { type: 'object', additionalProperties: false, required: ['login', 'password'],
      properties: { login: { type: 'string', minLength: 1, maxLength: 512 }, password: passwordInput, newPassword: passwordInput } } } }, async (request, reply) => {
      requireTrustedOrigin(request);
      const body = request.body as { login: string; password: string; newPassword?: string };
      const loginName = normalizeLoginName(body.login);
      // Unknown and malformed names share the throttle and the full derivation cost.
      const accountKey = throttleKey('login', loginName ?? body.login.normalize('NFKC').trim().toLowerCase()), address = addressKey(request);
      await reserveAttempt(reply, accountKey, address);
      const account = loginName === undefined ? undefined : (await db.query<{ id: string; password_hash: string; must_change: boolean }>(
        `SELECT u.id,c.password_hash,c.must_change FROM app_users u JOIN password_credentials c ON c.user_id=u.id WHERE u.login_name=$1`, [loginName])).rows[0];
      const verified = await verifyPassword(body.password.normalize('NFKC'), account?.password_hash);
      if (!account || !verified.ok) throw new ApiError(401, 'LOGIN_FAILED');
      await db.query('DELETE FROM password_login_failures WHERE account_key=$1', [accountKey]);
      let replacement: string | undefined;
      if (account.must_change) {
        requireCondition(body.newPassword !== undefined, 'PASSWORD_CHANGE_REQUIRED', 409);
        const next = passwordPolicy(body.newPassword);
        requireCondition(next !== body.password.normalize('NFKC'), 'PASSWORD_UNCHANGED', 400);
        replacement = await hashPassword(next);
      } else if (verified.needsRehash) replacement = await hashPassword(body.password.normalize('NFKC'));
      const session = await transaction(db, async client => {
        // The password must not have changed while it was being verified.
        const current = await client.query('SELECT 1 FROM password_credentials WHERE user_id=$1 AND password_hash=$2 FOR UPDATE', [account.id, account.password_hash]);
        requireCondition(current.rowCount, 'LOGIN_FAILED', 401);
        if (replacement && account.must_change) await storePassword(client, account.id, replacement, { mustChange: false });
        else if (replacement) await client.query('UPDATE password_credentials SET password_hash=$2 WHERE user_id=$1', [account.id, replacement]);
        return createSession(client, account.id);
      });
      return sendSession(reply, session);
    });
    app.post('/auth/password', { onRequest: noStore, logLevel: 'silent', schema: { body: { type: 'object', additionalProperties: false, required: ['currentPassword', 'newPassword'],
      properties: { currentPassword: passwordInput, newPassword: passwordInput } } } }, async (request, reply) => {
      const actor = await authenticate(request);
      const body = request.body as { currentPassword: string; newPassword: string };
      const accountKey = throttleKey('user', actor.id), address = addressKey(request);
      await reserveAttempt(reply, accountKey, address);
      const stored = (await db.query<{ password_hash: string }>('SELECT password_hash FROM password_credentials WHERE user_id=$1', [actor.id])).rows[0];
      const verified = await verifyPassword(body.currentPassword.normalize('NFKC'), stored?.password_hash);
      if (!stored) throw new ApiError(409, 'PASSWORD_NOT_SET');
      if (!verified.ok) throw new ApiError(403, 'CURRENT_PASSWORD_INCORRECT');
      await db.query('DELETE FROM password_login_failures WHERE account_key=$1', [accountKey]);
      const next = passwordPolicy(body.newPassword);
      requireCondition(next !== body.currentPassword.normalize('NFKC'), 'PASSWORD_UNCHANGED', 400);
      const hash = await hashPassword(next);
      const result = await transaction(db, async client => {
        const current = await client.query('SELECT 1 FROM password_credentials WHERE user_id=$1 AND password_hash=$2 FOR UPDATE', [actor.id, stored.password_hash]);
        requireCondition(current.rowCount, 'PASSWORD_CHANGED_CONCURRENTLY', 409);
        return storePassword(client, actor.id, hash, { mustChange: false, keepSessionHash: hashSecret(request.cookies.course_session!) });
      });
      return { changed: true, otherSessionsRevoked: result.sessionsRevoked };
    });
    app.get('/auth/session', { onRequest: noStore, logLevel: 'silent' }, async request => {
      const user = await authenticate(request);
      const login = (await db.query<{ login_name: string | null; has_password: boolean }>(
        'SELECT u.login_name,EXISTS(SELECT 1 FROM password_credentials c WHERE c.user_id=u.id) AS has_password FROM app_users u WHERE u.id=$1', [user.id])).rows[0];
      return { user: { ...user, loginName: login?.login_name ?? null, hasPassword: login?.has_password ?? false } };
    });
    app.post('/auth/logout', { onRequest: noStore, logLevel: 'silent' }, async (request, reply) => {
      await authenticate(request);
      await db.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [hashSecret(request.cookies.course_session!)]);
      const cookies = cookieOptions(request);
      reply.clearCookie('course_session', cookies).clearCookie('course_csrf', { ...cookies, httpOnly: false });
      return { authenticated: false };
    });
    passkeyRoutes(app, { db, relyingParty, requireTrustedOrigin, noStore, authenticate, createSession, sendSession, reserveAttempt, addressKey, hashSecret,
      clearAccount: async accountKey => { await db.query('DELETE FROM password_login_failures WHERE account_key=$1', [accountKey]); } });
  }
  return { authenticate, routes, loginCodes, origins, cookieOptions };
}

export async function membership(client: Database | PoolClient, actor: Actor, workspaceId: string, allowed?: string[]) {
  const result = await client.query<{ role: string }>('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actor.id]);
  const role = result.rows[0]?.role;
  if (!role || (allowed && !allowed.includes(role))) throw new ApiError(403, 'FORBIDDEN');
  return role;
}
