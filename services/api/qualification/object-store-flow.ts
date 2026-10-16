import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase, transaction } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { artifactStoreFromEnvironment, claimObject, configureArtifactStore, ObjectStoreError, readObject, readObjectRange, releaseObject, S3ObjectStore,
  stageObject, sweepArtifactObjects } from '../src/artifact-store.js';

/**
 * Optional qualification of the artifact store against a real S3-compatible service (for
 * example a disposable local MinIO). Not part of `npm test`, which uses an in-process endpoint.
 *
 *   TEST_DATABASE_URL=postgres://…/course_core_test_<name> COURSE_ARTIFACT_STORE=s3 \
 *   COURSE_ARTIFACT_S3_ENDPOINT=http://127.0.0.1:9000 COURSE_ARTIFACT_S3_BUCKET=<existing bucket> \
 *   COURSE_ARTIFACT_S3_ACCESS_KEY_ID=… COURSE_ARTIFACT_S3_SECRET_ACCESS_KEY=… npm run test:object-store
 *
 * It writes only under a random prefix and deletes what it wrote.
 */
if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use only a disposable TEST_DATABASE_URL.');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Disposable loopback test database required.');
const configured = artifactStoreFromEnvironment();
if (!configured) throw new Error('Set COURSE_ARTIFACT_STORE=s3 and its settings to qualify an object store.');
const store = { ...configured, prefix: `qualification-${randomUUID().slice(0, 8)}`, inlineLimitBytes: 0 };
const schema = `course_objects_${randomUUID().replaceAll('-', '')}`, admin = createDatabase(url.toString());
await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
const db = createDatabase(url.toString());
const raw = store.objects as S3ObjectStore;
try {
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  configureArtifactStore(store);
  await store.objects.check();
  // A wrong secret is refused by the service itself.
  const endpoint = process.env.COURSE_ARTIFACT_S3_ENDPOINT!, bucket = process.env.COURSE_ARTIFACT_S3_BUCKET!;
  await assert.rejects(new S3ObjectStore({ endpoint, bucket, region: process.env.COURSE_ARTIFACT_S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.COURSE_ARTIFACT_S3_ACCESS_KEY_ID!, secretAccessKey: 'not-the-secret' }).check(), (e: unknown) => e instanceof ObjectStoreError && e.code === 'OBJECT_STORE_REFUSED');
  const workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `q-${workspaceId}`, 'Object store qualification']);
  const bytes = randomBytes(256 * 1024);
  const staged = await stageObject(db, store, { workspaceId, enrollmentId: null, purpose: 'media_asset', mediaType: 'video/mp4', bytes });
  assert.equal(staged.sha256, createHash('sha256').update(bytes).digest('hex'));
  await transaction(db, client => claimObject(client, staged, { workspaceId, enrollmentId: null, purpose: 'media_asset' }));
  const row = (await db.query('SELECT object_key,etag,state FROM artifact_objects WHERE id=$1', [staged.id])).rows[0];
  assert.equal(row.state, 'stored'); assert.ok(row.etag, 'the service returned an entity tag');
  assert.ok(Buffer.from(await readObject(db, staged.id)).equals(bytes));
  assert.ok(Buffer.from(await readObjectRange(db, staged.id, 1000, 1999)).equals(bytes.subarray(1000, 2000)));
  // Replaced in the bucket behind Core's back: whole and range reads are refused.
  const other = randomBytes(bytes.length);
  await raw.put(row.object_key, other, 'video/mp4', createHash('sha256').update(other).digest('hex'));
  await assert.rejects(readObject(db, staged.id), { code: 'ARTIFACT_OBJECT_INTEGRITY' });
  await assert.rejects(readObjectRange(db, staged.id, 0, 99), { code: 'ARTIFACT_OBJECT_INTEGRITY' });
  // Released and swept: the object is gone from the service.
  await db.query("UPDATE artifact_objects SET state='staged',stored_at=NULL WHERE id=$1", [staged.id]);
  await releaseObject(db, staged.id);
  assert.deepEqual(await sweepArtifactObjects(db, store), { deleted: 1, failed: 0 });
  await assert.rejects(raw.get(row.object_key, { maxBytes: bytes.length }), (e: unknown) => e instanceof ObjectStoreError && e.code === 'OBJECT_NOT_FOUND');
  await raw.delete(row.object_key); // idempotent
  process.stdout.write('Object store qualification passed (put, digest-checked read, If-Match range read, tamper refusal, sweep).\n');
} finally {
  configureArtifactStore(null);
  await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
}
