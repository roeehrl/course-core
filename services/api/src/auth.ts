import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { ApiError, requireCondition } from './errors.js';

export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export interface Actor { id: string; displayName: string }
export interface AuthOptions {
  origin: string; secureCookies: boolean;
  /** Defaults to 12 hours; positive whole-millisecond duration, capped at 30 days. */
  sessionHours?: number;
}

export async function issueLoginCode(db: Database, userId: string) {
  const token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO login_codes (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval \'10 minutes\')', [hashSecret(token), userId]);
  return token;
}

export function authService(db: Database, options: AuthOptions) {
  const sessionMs = (options.sessionHours ?? 12) * 3600_000;
  if (!Number.isSafeInteger(sessionMs) || sessionMs <= 0 || sessionMs > 30 * 24 * 3600_000) throw new Error('INVALID_SESSION_LIFETIME');
  const noStore = async (_request: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache'); };
  const cookieOptions = { httpOnly: true, secure: options.secureCookies, sameSite: 'strict' as const, path: '/' };
  async function authenticate(request: FastifyRequest): Promise<Actor> {
    const token = request.cookies.course_session;
    requireCondition(token && /^[A-Za-z0-9_-]{43}$/.test(token), 'UNAUTHENTICATED', 401);
    const result = await db.query<{ id: string; display_name: string; csrf_hash: string }>(
      `SELECT u.id,u.display_name,s.csrf_hash FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`, [hashSecret(token)]);
    const row = result.rows[0];
    requireCondition(row, 'UNAUTHENTICATED', 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      requireCondition(request.headers.origin === options.origin, 'ORIGIN_REJECTED', 403);
      const csrf = request.headers['x-csrf-token'];
      requireCondition(typeof csrf === 'string' && /^[A-Za-z0-9_-]{43}$/.test(csrf)
        && timingSafeEqual(Buffer.from(hashSecret(csrf), 'hex'), Buffer.from(row.csrf_hash, 'hex')), 'CSRF_REJECTED', 403);
    }
    return { id: row.id, displayName: row.display_name };
  }
  function routes(app: FastifyInstance) {
    app.post('/auth/redeem', { onRequest: noStore, logLevel: 'silent', schema: { body: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } } }, async (request, reply) => {
      requireCondition(request.headers.origin === options.origin, 'ORIGIN_REJECTED', 403);
      const { token } = request.body as { token: string };
      const session = await transaction(db, async client => {
        // Take the row lock BEFORE checking wall-clock expiry. now() is frozen at transaction
        // start, and an UPDATE predicate alone can have been evaluated before its lock wait.
        await client.query('SELECT token_hash FROM login_codes WHERE token_hash=$1 FOR UPDATE', [hashSecret(token)]);
        const login = await client.query<{ user_id: string }>(
          'UPDATE login_codes SET consumed_at=clock_timestamp() WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING user_id', [hashSecret(token)]);
        requireCondition(login.rows[0], 'LOGIN_CODE_INVALID', 401);
        const sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
        const saved = await client.query<{ expires_at: Date }>(`INSERT INTO auth_sessions (id,user_id,token_hash,csrf_hash,expires_at)
          VALUES ($1,$2,$3,$4,clock_timestamp()+($5 * interval '1 millisecond')) RETURNING expires_at`,
          [randomUUID(), login.rows[0].user_id, hashSecret(sessionToken), hashSecret(csrf), sessionMs]);
        return { sessionToken, csrf, expires: saved.rows[0]!.expires_at };
      });
      reply.setCookie('course_session', session.sessionToken, { ...cookieOptions, expires: session.expires });
      reply.setCookie('course_csrf', session.csrf, { ...cookieOptions, httpOnly: false, expires: session.expires });
      return { authenticated: true, csrfToken: session.csrf };
    });
    app.get('/auth/session', { onRequest: noStore, logLevel: 'silent' }, async request => ({ user: await authenticate(request) }));
    app.post('/auth/logout', { onRequest: noStore, logLevel: 'silent' }, async (request, reply) => {
      await authenticate(request);
      await db.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1', [hashSecret(request.cookies.course_session!)]);
      reply.clearCookie('course_session', cookieOptions).clearCookie('course_csrf', cookieOptions);
      return { authenticated: false };
    });
  }
  return { authenticate, routes };
}

export async function membership(client: Database | PoolClient, actor: Actor, workspaceId: string, allowed?: string[]) {
  const result = await client.query<{ role: string }>('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, actor.id]);
  const role = result.rows[0]?.role;
  if (!role || (allowed && !allowed.includes(role))) throw new ApiError(403, 'FORBIDDEN');
  return role;
}
