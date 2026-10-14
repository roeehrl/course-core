import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { ApiError } from './errors.js';

/** Password policy (NIST SP 800-63B style): length only, no composition rules. Lengths
 * count Unicode code points after NFKC normalisation. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
/** Raw input bound (UTF-16 code units) before normalisation, so a request cannot make
 * the server normalise or hash arbitrarily large strings. */
export const PASSWORD_INPUT_LIMIT = 4096;

/** scrypt N=2^17, r=8, p=1: 128 MiB and a few hundred milliseconds per derivation
 * (the OWASP-recommended scrypt setting). Stored with each hash; a hash made with
 * other parameters is still verified and is upgraded on the next successful sign-in. */
export const SCRYPT_PARAMETERS = Object.freeze({ ln: 17, r: 8, p: 1 });
const KEY_BYTES = 32, SALT_BYTES = 16;
const PHC = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{32,128})$/;
type Parameters = { ln: number; r: number; p: number };

/** Bounds concurrent derivations (each uses 128 MiB). Excess requests wait in a short
 * queue; beyond it the server answers 503 instead of exhausting memory. */
const MAX_CONCURRENT = 2, MAX_QUEUED = 32;
let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(body: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) throw new ApiError(503, 'AUTH_BUSY');
    await new Promise<void>(resolve => waiting.push(resolve));
  } else active++;
  try { return await body(); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}
function derive(password: string, salt: Buffer, { ln, r, p }: Parameters): Promise<Buffer> {
  const N = 2 ** ln;
  return limited(() => new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { N, r, p, maxmem: 2 * 128 * N * r * p + 1024 * 1024 },
      (error, key) => error ? reject(error) : resolve(key));
  }));
}
const b64 = (value: Buffer) => value.toString('base64').replace(/=+$/, '');

/** Returns the normalised password or throws PASSWORD_POLICY (400). */
export function passwordPolicy(value: unknown): string {
  if (typeof value !== 'string' || value.length > PASSWORD_INPUT_LIMIT) throw new ApiError(400, 'PASSWORD_POLICY');
  const normalized = value.normalize('NFKC');
  const length = Array.from(normalized).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) throw new ApiError(400, 'PASSWORD_POLICY');
  return normalized;
}
/** Login names: NFKC, trimmed, lower-cased; 3-128 of a-z 0-9 . _ @ + : - (letters or
 * digits at both ends). Returns undefined for anything else. */
export function normalizeLoginName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._@+:-]{1,126}[a-z0-9]$/.test(normalized) ? normalized : undefined;
}
export async function hashPassword(password: string, parameters: Parameters = SCRYPT_PARAMETERS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, parameters);
  return `$scrypt$ln=${parameters.ln},r=${parameters.r},p=${parameters.p}$${b64(salt)}$${b64(key)}`;
}
function parse(stored: string) {
  const match = PHC.exec(stored);
  if (!match) return undefined;
  const parameters = { ln: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  // Refuse absurd stored parameters rather than allocate unbounded memory.
  if (parameters.ln < 10 || parameters.ln > 20 || parameters.r < 1 || parameters.r > 32 || parameters.p < 1 || parameters.p > 16) return undefined;
  return { parameters, salt: Buffer.from(match[4]!, 'base64'), key: Buffer.from(match[5]!, 'base64') };
}
let dummy: Promise<string> | undefined;
/** A hash of a random secret with current parameters: unknown accounts cost the same
 * derivation as known ones. */
function dummyHash() { return dummy ??= hashPassword(randomBytes(32).toString('base64')); }
/** Computes the dummy hash ahead of the first unknown-account attempt. */
export function prepareDummyHash() { void dummyHash().catch(() => { dummy = undefined; }); }

export async function verifyPassword(password: string, stored: string | undefined): Promise<{ ok: boolean; needsRehash: boolean }> {
  const real = stored === undefined ? undefined : parse(stored);
  const parsed = real ?? parse(await dummyHash())!;
  const candidate = await derive(password, parsed.salt, parsed.parameters);
  const ok = real !== undefined && candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
  const current = SCRYPT_PARAMETERS;
  return { ok, needsRehash: ok && (parsed.parameters.ln !== current.ln || parsed.parameters.r !== current.r || parsed.parameters.p !== current.p) };
}

/** 20 characters from a 32-symbol alphabet without l/o/0/1 (100 bits), in groups of 4. */
export function temporaryPassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const characters = Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return characters.match(/.{4}/g)!.join('-');
}
export const throttleKey = (kind: string, value: string) => createHash('sha256').update(`${kind}\u0000${value}`).digest('hex');

/** Sets a user's password hash (already derived), optionally their login name. Revokes
 * every session of the user except `keepSessionHash`. A temporary (must-change)
 * password is account recovery, so it also removes the user's passkeys. */
export async function storePassword(client: PoolClient | Database, userId: string, passwordHash: string,
  options: { mustChange: boolean; loginName?: string; keepSessionHash?: string }) {
  if (options.loginName !== undefined) {
    const taken = await client.query('SELECT 1 FROM app_users WHERE login_name=$1 AND id<>$2', [options.loginName, userId]);
    if (taken.rowCount) throw new ApiError(409, 'LOGIN_NAME_TAKEN');
    await client.query('UPDATE app_users SET login_name=$2 WHERE id=$1', [userId, options.loginName]);
  }
  await client.query(`INSERT INTO password_credentials (user_id,password_hash,must_change) VALUES ($1,$2,$3)
    ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,must_change=EXCLUDED.must_change,changed_at=clock_timestamp()`,
  [userId, passwordHash, options.mustChange]);
  const revoked = await client.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp()
    WHERE user_id=$1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash<>$2)`, [userId, options.keepSessionHash ?? null]);
  const passkeys = options.mustChange ? await client.query('DELETE FROM passkey_credentials WHERE user_id=$1', [userId]) : undefined;
  return { sessionsRevoked: revoked.rowCount ?? 0, passkeysRemoved: passkeys?.rowCount ?? 0 };
}
