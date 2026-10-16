import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Database } from './database.js';
import { ApiError } from './errors.js';

/**
 * Optional S3-compatible object storage for large artifacts (generated clips, large supervisor
 * artifacts). Off by default: with no store configured everything stays inline in Postgres, as
 * before. When configured, Postgres still holds the authoritative record of each object
 * (migration 062 `artifact_objects`: digest, size, type, owner scope, lifecycle) and the store
 * holds only opaque bytes under a random key. Every full read is checked against the recorded
 * SHA-256 and size; range reads send the entity tag recorded at upload as `If-Match`, so an
 * object replaced in the bucket is refused instead of served.
 *
 * Objects are private: the API proxies every read after its own authorization and never hands
 * out bucket URLs or presigned links. Credentials come from the server environment only and
 * never appear in errors, logs, events or responses. Object keys carry identifiers only, never
 * learner text.
 *
 * Lifecycle: an upload is first recorded as `staged`, then claimed (`stored`) inside the domain
 * transaction that references it. A staged object nobody claimed, and an object whose owner let
 * go of it (erasure: migration 062 triggers mark it `delete_pending`), is deleted from the store
 * by `sweepArtifactObjects`, which retries failures and records only stable error codes.
 */

export type ObjectPurpose = 'media_asset' | 'supervisor_artifact';
export type ObjectMediaType = 'video/mp4' | 'video/webm' | 'application/json';

export class ObjectStoreError extends Error {
  constructor(public readonly code: 'OBJECT_STORE_UNAVAILABLE' | 'OBJECT_STORE_REFUSED' | 'OBJECT_NOT_FOUND' | 'OBJECT_CHANGED' | 'OBJECT_TOO_LARGE') {
    super(code);
  }
}

/** The minimal object API Core needs. `S3ObjectStore` implements it for any S3-compatible service. */
export interface ObjectStore {
  readonly bucket: string;
  put(key: string, body: Uint8Array, mediaType: string, sha256: string): Promise<{ etag: string | null }>;
  /** `range` is inclusive. `ifMatch` refuses an object whose entity tag changed (OBJECT_CHANGED). */
  get(key: string, options: { maxBytes: number; range?: { start: number; end: number }; ifMatch?: string | null }): Promise<Uint8Array>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** Confirms the bucket is reachable with these credentials. */
  check(): Promise<void>;
}

export interface ArtifactStore {
  objects: ObjectStore;
  /** Key prefix inside the bucket, so one bucket can serve several installations. */
  prefix: string;
  /** Supervisor artifacts whose canonical JSON is larger than this go to the store. */
  inlineLimitBytes: number;
}

export interface S3Settings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const EMPTY_SHA256 = createHash('sha256').digest('hex');
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();
const KEY_PATTERN = /^[A-Za-z0-9/_.-]{1,512}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Path-style S3 requests signed with AWS Signature Version 4 (MinIO, Ceph, AWS S3 and others). */
export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  readonly #endpoint: URL;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secretAccessKey: string;
  readonly #timeoutMs: number;
  constructor(settings: S3Settings) {
    const endpoint = new URL(settings.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')) throw new Error('The object store endpoint must be an origin without credentials or a path.');
    if (!BUCKET_PATTERN.test(settings.bucket)) throw new Error('Invalid object store bucket name.');
    if (!/^[a-z0-9-]{1,40}$/.test(settings.region)) throw new Error('Invalid object store region.');
    if (!settings.accessKeyId || !settings.secretAccessKey) throw new Error('Object store credentials are required.');
    this.#endpoint = endpoint; this.bucket = settings.bucket; this.#region = settings.region;
    this.#accessKeyId = settings.accessKeyId; this.#secretAccessKey = settings.secretAccessKey;
    this.#timeoutMs = settings.timeoutMs ?? 60_000;
  }
  #url(key?: string) {
    if (key !== undefined && !KEY_PATTERN.test(key)) throw new Error('Invalid object key.');
    return new URL(`/${this.bucket}${key === undefined ? '' : '/' + key}`, this.#endpoint);
  }
  /** Signature Version 4 over host, payload hash and date; other headers are sent unsigned. */
  #signed(method: string, url: URL, payloadHash: string, extra: Record<string, string> = {}, now = new Date()) {
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = [method, url.pathname, '', `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`, signedHeaders, payloadHash].join('\n');
    const scope = `${day}/${this.#region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
    const key = hmac(hmac(hmac(hmac('AWS4' + this.#secretAccessKey, day), this.#region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
    return { ...extra, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.#accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  }
  async #request(method: string, url: URL, init: { body?: Uint8Array; payloadHash?: string; headers?: Record<string, string> } = {}) {
    try {
      return await fetch(url, { method, headers: this.#signed(method, url, init.payloadHash ?? EMPTY_SHA256, init.headers),
        ...(init.body ? { body: init.body as Uint8Array<ArrayBuffer> } : {}), redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch { throw new ObjectStoreError('OBJECT_STORE_UNAVAILABLE'); }
  }
  static #failure(status: number): never {
    if (status === 404) throw new ObjectStoreError('OBJECT_NOT_FOUND');
    if (status === 412) throw new ObjectStoreError('OBJECT_CHANGED');
    if (status === 408 || status === 429 || status >= 500) throw new ObjectStoreError('OBJECT_STORE_UNAVAILABLE');
    throw new ObjectStoreError('OBJECT_STORE_REFUSED');
  }
  async put(key: string, body: Uint8Array, mediaType: string, digest: string) {
    const response = await this.#request('PUT', this.#url(key), { body, payloadHash: digest, headers: { 'content-type': mediaType } });
    await response.body?.cancel();
    if (!response.ok) S3ObjectStore.#failure(response.status);
    return { etag: response.headers.get('etag') };
  }
  async get(key: string, options: { maxBytes: number; range?: { start: number; end: number }; ifMatch?: string | null }) {
    const headers: Record<string, string> = {};
    if (options.range) headers.range = `bytes=${options.range.start}-${options.range.end}`;
    if (options.ifMatch) headers['if-match'] = options.ifMatch;
    const response = await this.#request('GET', this.#url(key), { headers });
    if (!response.ok) { await response.body?.cancel(); S3ObjectStore.#failure(response.status); }
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > options.maxBytes) { await response.body?.cancel(); throw new ObjectStoreError('OBJECT_TOO_LARGE'); }
    const chunks: Uint8Array[] = []; let total = 0;
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength;
      if (total > options.maxBytes) throw new ObjectStoreError('OBJECT_TOO_LARGE');
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  async delete(key: string) {
    const response = await this.#request('DELETE', this.#url(key));
    await response.body?.cancel();
    if (!response.ok && response.status !== 404) S3ObjectStore.#failure(response.status);
  }
  async check() {
    const response = await this.#request('HEAD', this.#url());
    await response.body?.cancel();
    if (!response.ok) S3ObjectStore.#failure(response.status);
  }
}

const MAX_INLINE_LIMIT = 1024 * 1024;
/**
 * Reads the optional store from the environment. `COURSE_ARTIFACT_STORE` unset or `postgres`
 * keeps everything inline. `s3` requires COURSE_ARTIFACT_S3_ENDPOINT (https, or http on a
 * loopback host), _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY; _REGION defaults to
 * us-east-1, _PREFIX to `course-core`, COURSE_ARTIFACT_INLINE_LIMIT_BYTES to 16384.
 * Error messages name the setting, never its value.
 */
export function artifactStoreFromEnvironment(env: NodeJS.ProcessEnv = process.env): ArtifactStore | null {
  const kind = env.COURSE_ARTIFACT_STORE ?? 'postgres';
  if (kind === 'postgres') return null;
  if (kind !== 's3') throw new Error('COURSE_ARTIFACT_STORE must be postgres or s3.');
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`${name} is required when COURSE_ARTIFACT_STORE=s3.`); return value; };
  const endpoint = new URL(required('COURSE_ARTIFACT_S3_ENDPOINT'));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/')
    throw new Error('COURSE_ARTIFACT_S3_ENDPOINT must be an origin without credentials or a path.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw new Error('COURSE_ARTIFACT_S3_ENDPOINT must use https (plain http only on a loopback host).');
  const prefix = env.COURSE_ARTIFACT_S3_PREFIX ?? 'course-core';
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(prefix)) throw new Error('Invalid COURSE_ARTIFACT_S3_PREFIX.');
  const limit = Number(env.COURSE_ARTIFACT_INLINE_LIMIT_BYTES ?? 16384);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_INLINE_LIMIT) throw new Error('Invalid COURSE_ARTIFACT_INLINE_LIMIT_BYTES.');
  return { prefix, inlineLimitBytes: limit, objects: new S3ObjectStore({ endpoint: endpoint.origin, bucket: required('COURSE_ARTIFACT_S3_BUCKET'),
    region: env.COURSE_ARTIFACT_S3_REGION ?? 'us-east-1', accessKeyId: required('COURSE_ARTIFACT_S3_ACCESS_KEY_ID'), secretAccessKey: required('COURSE_ARTIFACT_S3_SECRET_ACCESS_KEY') }) };
}

/** Process composition: the one store this API process uses (null: inline Postgres only).
 * Set once by createServer before it serves requests. */
let configured: ArtifactStore | null = null;
export function configureArtifactStore(store: ArtifactStore | null) {
  if (store) {
    if (!Number.isSafeInteger(store.inlineLimitBytes) || store.inlineLimitBytes < 0 || store.inlineLimitBytes > MAX_INLINE_LIMIT) throw new Error('Invalid inline limit.');
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(store.prefix)) throw new Error('Invalid object key prefix.');
  }
  configured = store;
}
export const artifactStore = () => configured;

type Sql = Database | PoolClient;
export interface StagedObject { id: string; sha256: string; byteLength: number }
interface ObjectRow { id: string; workspace_id: string; enrollment_id: string | null; purpose: ObjectPurpose; sha256: string; byte_length: string;
  media_type: ObjectMediaType; bucket: string; object_key: string; etag: string | null; state: string }

/** Maps store failures to API errors with stable codes (no bucket, key or credential). */
function unavailable(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = error instanceof ObjectStoreError ? error.code : 'OBJECT_STORE_UNAVAILABLE';
  if (code === 'OBJECT_NOT_FOUND' || code === 'OBJECT_CHANGED' || code === 'OBJECT_TOO_LARGE') throw new ApiError(502, 'ARTIFACT_OBJECT_INTEGRITY');
  throw new ApiError(503, 'ARTIFACT_STORE_UNAVAILABLE');
}

/**
 * Uploads `bytes` as a new staged object. Runs outside any domain transaction (the record of
 * the upload commits first, so a crash mid-upload still leaves a row the sweep cleans up).
 * The caller claims it with `claimObject` in the transaction that references it, or lets it go
 * with `releaseObject`.
 */
export async function stageObject(db: Database, store: ArtifactStore, input: { workspaceId: string; enrollmentId: string | null; purpose: ObjectPurpose;
  mediaType: ObjectMediaType; bytes: Uint8Array }): Promise<StagedObject> {
  const id = randomUUID(), digest = sha256(input.bytes);
  const key = `${store.prefix}/${input.purpose === 'media_asset' ? 'media' : 'artifacts'}/${input.workspaceId}/${id}`;
  await db.query(`INSERT INTO artifact_objects(id,workspace_id,enrollment_id,purpose,sha256,byte_length,media_type,backend,bucket,object_key,state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'s3',$8,$9,'staged')`,
  [id, input.workspaceId, input.enrollmentId, input.purpose, digest, input.bytes.byteLength, input.mediaType, store.objects.bucket, key]);
  try {
    const { etag } = await store.objects.put(key, input.bytes, input.mediaType, digest);
    await db.query('UPDATE artifact_objects SET etag=$2 WHERE id=$1', [id, etag && etag.length <= 200 ? etag : null]);
  } catch (error) {
    await releaseObject(db, id, error instanceof ObjectStoreError ? error.code : 'OBJECT_STORE_UNAVAILABLE').catch(() => undefined);
    unavailable(error);
  }
  return { id, sha256: digest, byteLength: input.bytes.byteLength };
}

/** Marks a staged object as referenced, inside the transaction that inserts its owner row. */
export async function claimObject(client: PoolClient, staged: StagedObject, scope: { workspaceId: string; enrollmentId: string | null; purpose: ObjectPurpose }) {
  const claimed = await client.query(`UPDATE artifact_objects SET state='stored',stored_at=clock_timestamp()
    WHERE id=$1 AND state='staged' AND workspace_id=$2 AND enrollment_id IS NOT DISTINCT FROM $3 AND purpose=$4 AND sha256=$5 AND byte_length=$6`,
  [staged.id, scope.workspaceId, scope.enrollmentId, scope.purpose, staged.sha256, staged.byteLength]);
  if (claimed.rowCount !== 1) throw new ApiError(409, 'ARTIFACT_OBJECT_NOT_STAGED');
}

/** Gives up a staged object that no row will reference; the sweep deletes it from the store. */
export async function releaseObject(sql: Sql, id: string, reason: string | null = null) {
  await sql.query(`UPDATE artifact_objects SET state='delete_pending',delete_requested_at=clock_timestamp(),last_error=COALESCE($2,last_error)
    WHERE id=$1 AND state='staged'`, [id, reason]);
}

async function objectRow(sql: Sql, id: string) {
  const row = (await sql.query<ObjectRow>('SELECT * FROM artifact_objects WHERE id=$1', [id])).rows[0];
  if (!row || row.state !== 'stored') throw new ApiError(410, 'ARTIFACT_OBJECT_GONE');
  return row;
}
function storeFor(row: ObjectRow) {
  const store = configured;
  // Objects written to another bucket stay unreadable rather than being looked up elsewhere.
  if (!store || store.objects.bucket !== row.bucket) throw new ApiError(503, 'ARTIFACT_STORE_UNAVAILABLE');
  return store;
}

/** The whole object, refused unless its size and SHA-256 match the record. */
export async function readObject(sql: Sql, id: string): Promise<Uint8Array> {
  const row = await objectRow(sql, id), store = storeFor(row), size = Number(row.byte_length);
  let bytes: Uint8Array;
  try { bytes = await store.objects.get(row.object_key, { maxBytes: size, ifMatch: row.etag }); }
  catch (error) { unavailable(error); }
  if (bytes.byteLength !== size || sha256(bytes) !== row.sha256) throw new ApiError(502, 'ARTIFACT_OBJECT_INTEGRITY');
  return bytes;
}

/** An inclusive byte range of a stored object, bound to the object recorded at upload. */
export async function readObjectRange(sql: Sql, id: string, start: number, end: number): Promise<Uint8Array> {
  const row = await objectRow(sql, id), store = storeFor(row), size = Number(row.byte_length);
  if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end < size)) throw new ApiError(416, 'RANGE_NOT_SATISFIABLE');
  if (start === 0 && end === size - 1) return readObject(sql, id);
  // Without a recorded entity tag a partial read could not be tied to the uploaded bytes.
  if (!row.etag) {
    const whole = await readObject(sql, id);
    return whole.subarray(start, end + 1);
  }
  let bytes: Uint8Array;
  try { bytes = await store.objects.get(row.object_key, { maxBytes: end - start + 1, range: { start, end }, ifMatch: row.etag }); }
  catch (error) { unavailable(error); }
  if (bytes.byteLength !== end - start + 1) throw new ApiError(502, 'ARTIFACT_OBJECT_INTEGRITY');
  return bytes;
}

const MAX_JSON_OBJECT_BYTES = 4 * 1024 * 1024;
/** Fills `content` of rows kept in the store (`content_object_id`) and drops that column, so the
 * rows look as they did before the store existed. `missing: 'null'` leaves content null when the
 * object cannot be read (list views); 'throw' raises the API error (verifiers, the bridge). */
export async function withArtifactContent<T extends { content: unknown; content_object_id?: string | null }>(sql: Sql, rows: T[],
  missing: 'throw' | 'null' = 'throw'): Promise<T[]> {
  const out: T[] = [];
  for (const row of rows) {
    const { content_object_id: objectId, ...fields } = row, rest = fields as T;
    if (rest.content == null && objectId) {
      try {
        const record = await objectRow(sql, objectId);
        if (Number(record.byte_length) > MAX_JSON_OBJECT_BYTES || record.media_type !== 'application/json') throw new ApiError(502, 'ARTIFACT_OBJECT_INTEGRITY');
        (rest as { content: unknown }).content = JSON.parse(Buffer.from(await readObject(sql, objectId)).toString('utf8'));
      } catch (error) {
        if (missing === 'throw') throw error instanceof ApiError ? error : new ApiError(502, 'ARTIFACT_OBJECT_INTEGRITY');
        (rest as { content: unknown }).content = null;
      }
    }
    out.push(rest);
  }
  return out;
}

/**
 * Deletes from the store every object queued for deletion, and every staged upload older than
 * `stagedAfterMs` that nothing claimed. Bounded per call, safe to run concurrently (rows are
 * taken with SKIP LOCKED) and idempotent. Failures stay queued with a stable error code.
 */
export async function sweepArtifactObjects(db: Database, store: ArtifactStore | null = configured, options: { limit?: number; stagedAfterMs?: number } = {}) {
  if (!store) return { deleted: 0, failed: 0 };
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500), stagedAfterMs = options.stagedAfterMs ?? 15 * 60_000;
  let deleted = 0, failed = 0;
  for (let index = 0; index < limit; index++) {
    const done = await db.connect().then(async client => {
      try {
        await client.query('BEGIN');
        const row = (await client.query<ObjectRow>(`SELECT * FROM artifact_objects WHERE bucket=$1 AND (state='delete_pending'
            OR (state='staged' AND created_at < clock_timestamp() - make_interval(secs => $2::double precision / 1000)))
          ORDER BY delete_attempts,COALESCE(delete_requested_at,created_at),id LIMIT 1 FOR UPDATE SKIP LOCKED`, [store.objects.bucket, stagedAfterMs])).rows[0];
        if (!row) { await client.query('COMMIT'); return true; }
        try {
          await store.objects.delete(row.object_key);
          await client.query(`UPDATE artifact_objects SET state='deleted',deleted_at=clock_timestamp(),delete_requested_at=COALESCE(delete_requested_at,clock_timestamp()) WHERE id=$1`, [row.id]);
          deleted++;
        } catch (error) {
          const code = error instanceof ObjectStoreError ? error.code : 'OBJECT_STORE_UNAVAILABLE';
          await client.query(`UPDATE artifact_objects SET state='delete_pending',delete_requested_at=COALESCE(delete_requested_at,clock_timestamp()),
            delete_attempts=delete_attempts+1,last_error=$2 WHERE id=$1`, [row.id, code]);
          failed++;
        }
        await client.query('COMMIT');
        return false;
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    });
    if (done) break;
    // A failing store is retried on the next sweep, not hammered now.
    if (failed) break;
  }
  return { deleted, failed };
}
