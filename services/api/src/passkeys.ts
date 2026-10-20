import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { throttleKey, verifyPassword } from './passwords.js';

/** Where WebAuthn may run, derived from one configured trusted origin. Browsers
 * accept a relying party ID that is a domain (never an IP address) on a secure
 * context: https, or http on localhost for development. */
export interface RelyingParty { id: string; origin: string; name: string }
export function passkeyRelyingParty(origin: string): RelyingParty | undefined {
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  if (url.origin !== origin || url.username || url.password) return undefined;
  const host = url.hostname;
  if (!host || host.startsWith('[') || isIP(host) !== 0) return undefined;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && host === 'localhost')) return undefined;
  return { id: host, origin: url.origin, name: 'Course Core' };
}

/** Ceremony challenges are single-use and live for five minutes. */
export const PASSKEY_CHALLENGE_MINUTES = 5;
/** Registering a passkey needs a session at most this old, or the current password. */
export const PASSKEY_FRESH_SESSION_MINUTES = 10;
export const MAX_PASSKEYS_PER_USER = 20;
/** Unconsumed sign-in challenges kept at once, across all clients. Issuing one never fails:
 * at the cap, the oldest challenge of the client address holding the most is dropped. A
 * client flooding requests only displaces its own challenges, unless others share its
 * address (every client of a local forwarder arrives from loopback); then it must issue this
 * many more challenges during someone's ceremony to displace theirs. */
export const MAX_OPEN_SIGN_IN_CHALLENGES = 10_000;
let openSignInCap = MAX_OPEN_SIGN_IN_CHALLENGES;
/** Test hook: a smaller cap (no argument restores the default). */
export function setOpenSignInChallengeCap(cap = MAX_OPEN_SIGN_IN_CHALLENGES) {
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_OPEN_SIGN_IN_CHALLENGES) throw new Error('INVALID_PASSKEY_CHALLENGE_CAP');
  openSignInCap = cap;
}
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const encoded = (max: number) => ({ type: 'string', minLength: 1, maxLength: max, pattern: '^[A-Za-z0-9_-]+={0,2}$' });
const credentialResponse = (required: string[], fields: Record<string, unknown>) => ({
  type: 'object', additionalProperties: true, required: ['id', 'rawId', 'type', 'response'],
  properties: {
    id: encoded(1366), rawId: encoded(1366), type: { const: 'public-key' },
    authenticatorAttachment: { type: 'string', maxLength: 32 },
    clientExtensionResults: { type: 'object' },
    response: { type: 'object', additionalProperties: true, required: ['clientDataJSON', ...required], properties: { clientDataJSON: encoded(8192), ...fields } },
  },
});
const registrationBody = {
  type: 'object', additionalProperties: false, required: ['challengeId', 'response'],
  properties: {
    challengeId: { type: 'string', format: 'uuid' },
    name: { type: 'string', maxLength: 400 },
    response: credentialResponse(['attestationObject'], {
      attestationObject: encoded(65536), transports: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 32 } },
    }),
  },
};
const authenticationBody = {
  type: 'object', additionalProperties: false, required: ['challengeId', 'response'],
  properties: {
    challengeId: { type: 'string', format: 'uuid' },
    response: credentialResponse(['authenticatorData', 'signature'], {
      authenticatorData: encoded(65536), signature: encoded(8192), userHandle: { type: 'string', maxLength: 512 },
    }),
  },
};

/** A trimmed, single-line label of 1-100 code points; defaults to "Passkey". */
export function passkeyName(value: unknown): string {
  if (value === undefined) return 'Passkey';
  requireCondition(typeof value === 'string', 'PASSKEY_NAME_INVALID');
  const name = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  requireCondition(name.length > 0 && Array.from(name).length <= 100 && !/[\u0000-\u001f\u007f]/.test(name), 'PASSKEY_NAME_INVALID');
  return name;
}

export interface PasskeyDependencies {
  db: Database;
  /** The relying party for the trusted origin a request was made from, if WebAuthn-capable there. */
  relyingParty: (request: FastifyRequest) => RelyingParty | undefined;
  requireTrustedOrigin: (request: FastifyRequest) => void;
  noStore: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  authenticate: (request: FastifyRequest) => Promise<{ id: string; displayName: string }>;
  createSession: (client: PoolClient, userId: string) => Promise<{ sessionToken: string; csrf: string; expires: Date }>;
  sendSession: (reply: FastifyReply, session: { sessionToken: string; csrf: string; expires: Date }) => unknown;
  reserveAttempt: (reply: FastifyReply, accountKey: string, request: FastifyRequest) => Promise<void>;
  clearAccount: (accountKey: string) => Promise<void>;
  addressKey: (request: FastifyRequest) => string;
  clientSource: (request: FastifyRequest) => { address: string; shared: boolean };
  hashSecret: (value: string) => string;
}

/** Passkey registration, sign-in and management. Passwords stay primary: nothing here
 * removes or replaces a password, and an account may delete every passkey it has. */
export function passkeyRoutes(app: FastifyInstance, deps: PasskeyDependencies) {
  const { db, noStore } = deps;
  const available = (request: FastifyRequest) => { const rp = deps.relyingParty(request); requireCondition(rp, 'PASSKEYS_UNAVAILABLE', 404); return rp; };
  async function issueChallenge(client: Database | PoolClient, purpose: 'registration' | 'authentication', addressKey: string,
    owner?: { userId: string; sessionHash: string }) {
    await client.query('DELETE FROM passkey_challenges WHERE expires_at<=clock_timestamp()');
    const id = randomUUID(), challenge = randomBytes(32);
    await client.query(`INSERT INTO passkey_challenges (id,purpose,challenge,user_id,session_hash,address_key,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp()+($7 * interval '1 minute'))`,
    [id, purpose, b64url(challenge), owner?.userId ?? null, owner?.sessionHash ?? null, addressKey, PASSKEY_CHALLENGE_MINUTES]);
    return { id, challenge };
  }
  /** Deletes and returns an unexpired challenge, so it can be used at most once. */
  async function consumeChallenge(client: Database | PoolClient, id: string, purpose: string, owner?: { userId: string; sessionHash: string }) {
    const row = (await client.query<{ challenge: string }>(`DELETE FROM passkey_challenges WHERE id=$1 AND purpose=$2
      AND ($3::uuid IS NULL OR user_id=$3) AND ($4::text IS NULL OR session_hash=$4) RETURNING challenge,expires_at>clock_timestamp() AS live`,
    [id, purpose, owner?.userId ?? null, owner?.sessionHash ?? null])).rows[0] as { challenge: string; live: boolean } | undefined;
    requireCondition(row?.live, 'PASSKEY_CHALLENGE_INVALID', 400);
    return row.challenge;
  }

  app.post('/auth/passkeys/registration/options', { onRequest: noStore, logLevel: 'silent', schema: { body: { type: 'object', additionalProperties: false,
    properties: { currentPassword: { type: 'string', minLength: 1, maxLength: 4096 } } } } }, async (request, reply) => {
    const actor = await deps.authenticate(request), party = available(request);
    const sessionHash = deps.hashSecret(request.cookies.course_session!);
    const body = (request.body ?? {}) as { currentPassword?: string };
    const fresh = (await db.query<{ fresh: boolean }>(`SELECT created_at>clock_timestamp()-($2 * interval '1 minute') AS fresh
      FROM auth_sessions WHERE token_hash=$1`, [sessionHash, PASSKEY_FRESH_SESSION_MINUTES])).rows[0]?.fresh === true;
    if (!fresh) {
      // An older session must prove the password again, under the change-password throttle.
      requireCondition(body.currentPassword !== undefined, 'REAUTHENTICATION_REQUIRED', 403);
      const accountKey = throttleKey('user', actor.id);
      await deps.reserveAttempt(reply, accountKey, request);
      const stored = (await db.query<{ password_hash: string }>('SELECT password_hash FROM password_credentials WHERE user_id=$1', [actor.id])).rows[0];
      const verified = await verifyPassword(body.currentPassword.normalize('NFKC'), stored?.password_hash);
      if (!stored) throw new ApiError(403, 'REAUTHENTICATION_REQUIRED');
      if (!verified.ok) throw new ApiError(403, 'CURRENT_PASSWORD_INCORRECT');
      await deps.clearAccount(accountKey);
    }
    const { options, challengeId } = await transaction(db, async client => {
      const user = (await client.query<{ display_name: string; login_name: string | null; passkey_user_handle: string | null }>(
        'SELECT display_name,login_name,passkey_user_handle FROM app_users WHERE id=$1 FOR UPDATE', [actor.id])).rows[0]!;
      let handle = user.passkey_user_handle;
      if (!handle) {
        handle = b64url(randomBytes(32));
        await client.query('UPDATE app_users SET passkey_user_handle=$2 WHERE id=$1', [actor.id, handle]);
      }
      const existing = (await client.query<{ credential_id: string; transports: string[] }>(
        'SELECT credential_id,transports FROM passkey_credentials WHERE user_id=$1 ORDER BY created_at', [actor.id])).rows;
      requireCondition(existing.length < MAX_PASSKEYS_PER_USER, 'PASSKEY_LIMIT', 409);
      const issued = await issueChallenge(client, 'registration', deps.addressKey(request), { userId: actor.id, sessionHash });
      const options = await generateRegistrationOptions({
        rpName: party.name, rpID: party.id, userID: Buffer.from(handle, 'base64url'),
        userName: user.login_name ?? user.display_name, userDisplayName: user.display_name,
        challenge: issued.challenge, timeout: PASSKEY_CHALLENGE_MINUTES * 60_000, attestationType: 'none',
        excludeCredentials: existing.map(row => ({ id: row.credential_id, transports: row.transports })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      });
      return { options, challengeId: issued.id };
    });
    return { challengeId, options };
  });

  app.post('/auth/passkeys/registration/verify', { onRequest: noStore, logLevel: 'silent', schema: { body: registrationBody } }, async request => {
    const actor = await deps.authenticate(request), party = available(request);
    const body = request.body as { challengeId: string; name?: string; response: RegistrationResponseJSON };
    const name = passkeyName(body.name);
    const sessionHash = deps.hashSecret(request.cookies.course_session!);
    const challenge = await consumeChallenge(db, body.challengeId, 'registration', { userId: actor.id, sessionHash });
    let verified;
    try {
      verified = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge, expectedOrigin: party.origin,
        expectedRPID: party.id, expectedType: 'webauthn.create', requireUserPresence: true, requireUserVerification: true });
    } catch { throw new ApiError(400, 'PASSKEY_REGISTRATION_FAILED'); }
    requireCondition(verified.verified, 'PASSKEY_REGISTRATION_FAILED', 400);
    const info = verified.registrationInfo, credential = info.credential;
    requireCondition(credential.id === body.response.id && info.userVerified, 'PASSKEY_REGISTRATION_FAILED', 400);
    const transports = [...new Set((body.response.response.transports ?? []).filter(value => TRANSPORTS.has(value)))];
    const id = randomUUID();
    const saved = await transaction(db, async client => {
      await client.query('SELECT 1 FROM app_users WHERE id=$1 FOR UPDATE', [actor.id]);
      const count = Number((await client.query('SELECT count(*) FROM passkey_credentials WHERE user_id=$1', [actor.id])).rows[0].count);
      requireCondition(count < MAX_PASSKEYS_PER_USER, 'PASSKEY_LIMIT', 409);
      const inserted = await client.query<{ created_at: Date }>(`INSERT INTO passkey_credentials
        (id,user_id,credential_id,public_key,sign_count,transports,device_type,backed_up,friendly_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (credential_id) DO NOTHING RETURNING created_at`,
      [id, actor.id, credential.id, Buffer.from(credential.publicKey), credential.counter, transports, info.credentialDeviceType, info.credentialBackedUp, name]);
      requireCondition(inserted.rowCount, 'PASSKEY_ALREADY_REGISTERED', 409);
      return inserted.rows[0]!;
    });
    return { passkey: { id, name, createdAt: saved.created_at, lastUsedAt: null, backedUp: info.credentialBackedUp, transports } };
  });

  app.post('/auth/passkeys/authentication/options', { onRequest: noStore, logLevel: 'silent', schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async request => {
    deps.requireTrustedOrigin(request);
    const party = available(request), address = deps.addressKey(request);
    // One lock for every sign-in issue keeps the total exactly bounded. Nothing is refused:
    // a per-address refusal let one client behind a shared address (loopback) block
    // passkey sign-in for everyone there. See MAX_OPEN_SIGN_IN_CHALLENGES.
    const issued = await transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['passkey-challenge:authentication']);
      await client.query('DELETE FROM passkey_challenges WHERE expires_at<=clock_timestamp()');
      const open = Number((await client.query(`SELECT count(*) FROM passkey_challenges WHERE purpose='authentication'`)).rows[0].count);
      if (open >= openSignInCap) {
        await client.query(`DELETE FROM passkey_challenges WHERE id IN (SELECT id FROM passkey_challenges WHERE purpose='authentication' AND address_key=(
            SELECT address_key FROM passkey_challenges WHERE purpose='authentication' GROUP BY address_key ORDER BY count(*) DESC,min(created_at) LIMIT 1)
          ORDER BY created_at,id LIMIT $1)`, [open - openSignInCap + 1]);
      }
      return issueChallenge(client, 'authentication', address);
    });
    // Discoverable credentials: the authenticator offers the account, so no account
    // name is asked for and none is revealed.
    const options = await generateAuthenticationOptions({ rpID: party.id, challenge: issued.challenge, userVerification: 'required',
      timeout: PASSKEY_CHALLENGE_MINUTES * 60_000, allowCredentials: [] });
    return { challengeId: issued.id, options };
  });

  app.post('/auth/passkeys/authentication/verify', { onRequest: noStore, logLevel: 'silent', schema: { body: authenticationBody } }, async (request, reply) => {
    deps.requireTrustedOrigin(request);
    const party = available(request);
    const body = request.body as { challengeId: string; response: AuthenticationResponseJSON };
    requireCondition(body.response.id === body.response.rawId, 'INVALID_REQUEST', 400);
    const stored = (await db.query<{ id: string; user_id: string; public_key: Buffer; sign_count: string; transports: string[];
      login_name: string | null; passkey_user_handle: string | null }>(
      `SELECT p.id,p.user_id,p.public_key,p.sign_count,p.transports,u.login_name,u.passkey_user_handle
       FROM passkey_credentials p JOIN app_users u ON u.id=p.user_id WHERE p.credential_id=$1`, [body.response.id])).rows[0];
    // The same durable throttle as password sign-in: a known account shares its
    // username budget. Unknown credential ids (random, so nothing to guess) share one
    // budget per client address, so made-up ids cannot each open a fresh budget.
    const accountKey = stored ? (stored.login_name ? throttleKey('login', stored.login_name) : throttleKey('user', stored.user_id))
      : throttleKey('passkey-unknown', deps.clientSource(request).address);
    await deps.reserveAttempt(reply, accountKey, request);
    const challenge = await consumeChallenge(db, body.challengeId, 'authentication');
    if (!stored) throw new ApiError(401, 'PASSKEY_FAILED');
    const userHandle = body.response.response.userHandle;
    if (userHandle !== undefined && userHandle !== stored.passkey_user_handle) throw new ApiError(401, 'PASSKEY_FAILED');
    let verified;
    try {
      verified = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: challenge, expectedOrigin: party.origin,
        expectedRPID: party.id, expectedType: 'webauthn.get', requireUserVerification: true,
        credential: { id: body.response.id, publicKey: new Uint8Array(stored.public_key), counter: Number(stored.sign_count), transports: stored.transports } });
    } catch { throw new ApiError(401, 'PASSKEY_FAILED'); }
    if (!verified.verified || !verified.authenticationInfo.userVerified) throw new ApiError(401, 'PASSKEY_FAILED');
    await deps.clearAccount(accountKey);
    const session = await transaction(db, async client => {
      // The counter must not have moved while this assertion was verified.
      const updated = await client.query(`UPDATE passkey_credentials SET sign_count=$3,backed_up=$4,last_used_at=clock_timestamp()
        WHERE id=$1 AND sign_count=$2`, [stored.id, stored.sign_count, verified.authenticationInfo.newCounter, verified.authenticationInfo.credentialBackedUp]);
      requireCondition(updated.rowCount, 'PASSKEY_FAILED', 401);
      // A temporary password must be replaced first; a passkey does not skip that step.
      const password = (await client.query<{ must_change: boolean }>('SELECT must_change FROM password_credentials WHERE user_id=$1', [stored.user_id])).rows[0];
      requireCondition(!password?.must_change, 'PASSWORD_CHANGE_REQUIRED', 409);
      return deps.createSession(client, stored.user_id);
    });
    return deps.sendSession(reply, session);
  });

  app.get('/auth/passkeys', { onRequest: noStore, logLevel: 'silent' }, async request => {
    const actor = await deps.authenticate(request);
    const rows = (await db.query<{ id: string; friendly_name: string; created_at: Date; last_used_at: Date | null; backed_up: boolean; transports: string[] }>(
      'SELECT id,friendly_name,created_at,last_used_at,backed_up,transports FROM passkey_credentials WHERE user_id=$1 ORDER BY created_at,id', [actor.id])).rows;
    return { available: deps.relyingParty(request) !== undefined, passkeys: rows.map(row => ({ id: row.id, name: row.friendly_name, createdAt: row.created_at,
      lastUsedAt: row.last_used_at, backedUp: row.backed_up, transports: row.transports })) };
  });

  app.delete('/auth/passkeys/:passkeyId', { onRequest: noStore, logLevel: 'silent', schema: { params: { type: 'object', required: ['passkeyId'],
    properties: { passkeyId: { type: 'string', format: 'uuid' } } } } }, async request => {
    const actor = await deps.authenticate(request), { passkeyId } = request.params as { passkeyId: string };
    // Only the caller's own passkey; another account's id is indistinguishable from a missing one.
    const deleted = await db.query('DELETE FROM passkey_credentials WHERE id=$1 AND user_id=$2', [passkeyId, actor.id]);
    requireCondition(deleted.rowCount, 'PASSKEY_NOT_FOUND', 404);
    return { deleted: true };
  });
}
