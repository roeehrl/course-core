import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse, canonicalJson } from '@course-core/sdk/compiler';
import type { HostBridge, RunRef } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { appendEvent } from '../src/events.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, recordSupervisorVerification, storeSupervisorArtifact, type SupervisorBridgeOptions } from '../src/supervisor-bridge.js';
import { artifactStoreFromEnvironment, configureArtifactStore, readObject, S3ObjectStore, stageObject, sweepArtifactObjects, withArtifactContent, type ArtifactStore } from '../src/artifact-store.js';
import { eraseWithin } from '../src/data-lifecycle.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { credentialVault } from '../src/key-vault.js';
import { WorkspaceProviders } from '../src/provider-setup.js';
import { createMediaJobService, workspaceMediaResolver, type MediaJobService } from '../src/media-jobs.js';
import { MEDIA_CREDENTIAL, ScriptedVideo, SYNTHETIC_MP4, mediaJobPolicy, mediaConfiguration } from './media-fixture.js';
import { fixture } from './fixture.js';
import { FakeS3 } from './fake-s3.js';

const schema = `artifact_store_${randomUUID().replaceAll('-', '')}`;
const accessKeyId = 'synthetic-access-key', secretAccessKey = 'synthetic-secret-key-not-a-credential';
const s3 = new FakeS3('course-test-artifacts', accessKeyId, secretAccessKey);
let db: Database, store: ArtifactStore;
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  await s3.start();
  store = { prefix: 'test', inlineLimitBytes: 64, objects: new S3ObjectStore({ endpoint: s3.endpoint, bucket: s3.bucket, region: 'us-east-1', accessKeyId, secretAccessKey, timeoutMs: 2000 }) };
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  configureArtifactStore(store);
}, 30_000);
afterAll(async () => {
  configureArtifactStore(null);
  await mediaApp?.close();
  await db?.end(); await testDatabase?.drop(); await s3.stop();
});
const objects = async (where = 'true', values: unknown[] = []) => (await db.query(`SELECT * FROM artifact_objects WHERE ${where} ORDER BY created_at`, values)).rows;

describe('configuration', () => {
  it('is off by default and validates every S3 setting without echoing values', () => {
    expect(artifactStoreFromEnvironment({})).toBeNull();
    expect(artifactStoreFromEnvironment({ COURSE_ARTIFACT_STORE: 'postgres' })).toBeNull();
    expect(() => artifactStoreFromEnvironment({ COURSE_ARTIFACT_STORE: 'disk' })).toThrow(/postgres or s3/);
    const base = { COURSE_ARTIFACT_STORE: 's3', COURSE_ARTIFACT_S3_ENDPOINT: 'https://objects.example.com', COURSE_ARTIFACT_S3_BUCKET: 'course-artifacts',
      COURSE_ARTIFACT_S3_ACCESS_KEY_ID: 'synthetic-id', COURSE_ARTIFACT_S3_SECRET_ACCESS_KEY: 'SECRET_VALUE_CANARY' };
    expect(artifactStoreFromEnvironment(base)).toMatchObject({ prefix: 'course-core', inlineLimitBytes: 16384 });
    for (const name of ['COURSE_ARTIFACT_S3_ENDPOINT', 'COURSE_ARTIFACT_S3_BUCKET', 'COURSE_ARTIFACT_S3_ACCESS_KEY_ID', 'COURSE_ARTIFACT_S3_SECRET_ACCESS_KEY'])
      expect(() => artifactStoreFromEnvironment({ ...base, [name]: '' })).toThrow(name);
    // Plain HTTP only on loopback; no credentials or paths in the endpoint.
    expect(() => artifactStoreFromEnvironment({ ...base, COURSE_ARTIFACT_S3_ENDPOINT: 'http://objects.example.com' })).toThrow(/https/);
    expect(artifactStoreFromEnvironment({ ...base, COURSE_ARTIFACT_S3_ENDPOINT: 'http://127.0.0.1:9000' })).not.toBeNull();
    for (const [name, value] of [['COURSE_ARTIFACT_S3_BUCKET', 'Bad_Bucket'], ['COURSE_ARTIFACT_INLINE_LIMIT_BYTES', '-1'], ['COURSE_ARTIFACT_S3_PREFIX', '../x'],
      ['COURSE_ARTIFACT_S3_ENDPOINT', 'https://user:password@example.com'], ['COURSE_ARTIFACT_S3_ENDPOINT', 'https://objects.example.com/path']]) {
      let message = '';
      try { artifactStoreFromEnvironment({ ...base, [name!]: value! }); } catch (error) { message = (error as Error).message; }
      expect(message).not.toBe('');
      expect(message).not.toContain('SECRET_VALUE_CANARY'); expect(message).not.toContain('password');
    }
  });
  it('signs every request; a wrong secret is refused by the store', async () => {
    await store.objects.check();
    const wrong = new S3ObjectStore({ endpoint: s3.endpoint, bucket: s3.bucket, region: 'us-east-1', accessKeyId, secretAccessKey: 'another-secret' });
    await expect(wrong.check()).rejects.toMatchObject({ code: 'OBJECT_STORE_REFUSED' });
    expect(s3.requests.every(r => r.signed || r.path === `/${s3.bucket}`)).toBe(true);
  });
});

// ---- Supervisor artifacts (the bridge harness of supervisor-bridge.integration.test.ts) ----
interface Seed { workspaceId: string; enrollmentId: string; userId: string; releaseId: string }
const serviceToken = 'synthetic-test-service-token-not-a-credential';
async function seed(): Promise<Seed> {
  const userId = randomUUID(), enrollmentId = randomUUID(), workspaceId = randomUUID(), releaseId = randomUUID();
  const course = compileCourse(fixture());
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `synthetic:${userId}`, 'Synthetic learner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `w-${workspaceId}`, 'Synthetic workspace']);
  await db.query(`INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
    VALUES ($1,$2,$3,'1.0.0',$4,$5,$6,'published',$7)`, [releaseId, workspaceId, course.server.id, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), userId]);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, userId]);
  const policy = initialPolicy(course.server, enrollmentId, userId, new Date().toISOString());
  await db.query(`INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,current_episode_id) VALUES ($1,$2,$3,$4,$5,'min')`, [enrollmentId, workspaceId, releaseId, userId, JSON.stringify(course.server.policy)]);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)', [enrollmentId, JSON.stringify(policy)]);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId, enrollmentId }, { microUsd: 10_000, tokens: 10_000 });
  return { workspaceId, enrollmentId, releaseId, userId };
}
function options(s: Seed): SupervisorBridgeOptions {
  return { serviceToken, workspaceIds: [s.workspaceId], jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } };
}
async function companionJob(s: Seed) {
  const b = createPostgresSupervisorBridge(db, options(s));
  const e = await transaction(db, async client => {
    const messageId = randomUUID();
    await client.query(`INSERT INTO companion_messages (id,enrollment_id,role,content,context) VALUES ($1,$2,'learner',$3,$4)`, [messageId, s.enrollmentId, 'Synthetic question', JSON.stringify({ episodeId: 'min', blockId: 'min-text' })]);
    return appendEvent(client, { workspaceId: s.workspaceId, enrollmentId: s.enrollmentId, actorId: s.userId, actorKind: 'learner',
      type: 'companion.requested', payload: { messageId, episodeId: 'min', blockId: 'min-text', requestKind: 'question' }, idempotencyKey: randomUUID(), supervise: true });
  });
  const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === e.id)!;
  const refs = await b.prepareOutbox(lease); await b.ackOutbox(lease);
  const ref = refs[0]!;
  const claimed = await b.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
  return { b, ref, op: claimed.snapshot.operations[0]! };
}
async function settle(job: { b: HostBridge; ref: RunRef; op: { id: string; ownerId: string } }, output: { artifactId: string; digest: string }) {
  await job.b.transition({ type: 'settle', ref: job.ref, operationId: job.op.id, ownerId: job.op.ownerId, outcome: { status: 'succeeded', artifact: output, usage: { microUsd: 25, tokens: 40 } } });
}
async function verifier(s: Seed) {
  const id = randomUUID();
  await db.query(`INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,'Synthetic verifier',true,true)`, [id, s.workspaceId]);
  return id;
}
const longText = 'A worked explanation of the running minimum. '.repeat(8).trim();

describe('supervisor artifacts above the inline limit', () => {
  it('are stored as one digest-checked object, verified and applied like inline ones', async () => {
    const s = await seed(), job = await companionJob(s);
    const value = { kind: 'companion_message' as const, text: longText };
    const output = await storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, value);
    const row = (await db.query('SELECT content,content_object_id,content_kind,digest FROM supervisor_artifacts WHERE id=$1', [output.artifactId])).rows[0];
    expect(row).toMatchObject({ content: null, content_kind: 'companion_message', digest: output.digest });
    const [object] = await objects('id=$1', [row.content_object_id]);
    expect(object).toMatchObject({ state: 'stored', purpose: 'supervisor_artifact', sha256: output.digest, media_type: 'application/json', workspace_id: s.workspaceId, enrollment_id: s.enrollmentId });
    // The key names identifiers only; the bytes are the canonical JSON whose SHA-256 is the digest.
    expect(object.object_key).toBe(`test/artifacts/${s.workspaceId}/${object.id}`);
    expect(s3.objects.get(object.object_key)!.body.toString('utf8')).toBe(canonicalJson(value));
    // A replayed staging returns the first receipt and uploads nothing more.
    expect(await storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, value)).toEqual(output);
    expect(await objects('enrollment_id=$1', [s.enrollmentId])).toHaveLength(1);
    await settle(job, output);
    await recordSupervisorVerification(db, job.ref, await verifier(s), 'verified');
    expect((await job.b.transition({ type: 'verify', ref: job.ref })).snapshot.state).toBe('ready');
    await job.b.transition({ type: 'apply', ref: job.ref });
    expect((await db.query("SELECT content FROM companion_messages WHERE job_id=$1 AND role='assistant'", [job.ref.jobId])).rows.map(r => r.content)).toEqual([longText]);
  });

  it('keep small artifacts and supervised plans inline', async () => {
    const s = await seed(), job = await companionJob(s);
    const output = await storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, { kind: 'companion_message', text: 'Short.' });
    expect((await db.query('SELECT content,content_object_id FROM supervisor_artifacts WHERE id=$1', [output.artifactId])).rows[0])
      .toEqual({ content: { kind: 'companion_message', text: 'Short.' }, content_object_id: null });
    expect(await objects('enrollment_id=$1', [s.enrollmentId])).toHaveLength(0);
  });

  it('refuse a changed object, and report an unreachable store as retryable', async () => {
    const s = await seed(), job = await companionJob(s);
    const output = await storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, { kind: 'companion_message', text: longText });
    await settle(job, output);
    const verifierId = await verifier(s);
    const [object] = await objects('enrollment_id=$1', [s.enrollmentId]);
    const original = s3.objects.get(object.object_key)!;
    // Unreachable: a 503, nothing recorded, and the same call succeeds later.
    s3.failures.push({ method: 'GET', status: 503 });
    await expect(recordSupervisorVerification(db, job.ref, verifierId, 'verified')).rejects.toMatchObject({ code: 'ARTIFACT_STORE_UNAVAILABLE', statusCode: 503 });
    expect((await db.query('SELECT count(*)::int AS n FROM supervisor_verifications WHERE job_id=$1', [job.ref.jobId])).rows[0].n).toBe(0);
    // Replaced in the bucket (new entity tag), or altered under the same tag: both are mismatches.
    s3.objects.set(object.object_key, { ...original, body: Buffer.from(canonicalJson({ kind: 'companion_message', text: 'Tampered text.' })), etag: '"changed"' });
    await expect(recordSupervisorVerification(db, job.ref, verifierId, 'verified')).rejects.toMatchObject({ code: 'SUPERVISOR_ARTIFACT_MISMATCH' });
    s3.objects.set(object.object_key, { ...original, body: Buffer.from(canonicalJson({ kind: 'companion_message', text: longText.replace('minimum', 'maximum') })) });
    await expect(recordSupervisorVerification(db, job.ref, verifierId, 'verified')).rejects.toMatchObject({ code: 'SUPERVISOR_ARTIFACT_MISMATCH' });
    // Views that list artifacts show it as unreadable instead of failing; verifiers and exports throw.
    const listed = await withArtifactContent(db, (await db.query('SELECT content,content_object_id FROM supervisor_artifacts WHERE id=$1', [output.artifactId])).rows, 'null');
    expect(listed).toEqual([{ content: null }]);
    s3.objects.set(object.object_key, original);
    await recordSupervisorVerification(db, job.ref, verifierId, 'verified');
  });

  it('record nothing when the upload fails, and sweep the abandoned upload', async () => {
    const s = await seed(), job = await companionJob(s);
    s3.failures.push({ method: 'PUT', status: 500 });
    await expect(storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, { kind: 'companion_message', text: longText })).rejects.toMatchObject({ code: 'ARTIFACT_STORE_UNAVAILABLE' });
    expect((await db.query('SELECT count(*)::int AS n FROM supervisor_artifacts WHERE operation_id=$1', [job.op.id])).rows[0].n).toBe(0);
    const [abandoned] = await objects('enrollment_id=$1', [s.enrollmentId]);
    expect(abandoned).toMatchObject({ state: 'delete_pending', last_error: 'OBJECT_STORE_UNAVAILABLE' });
    expect((await sweepArtifactObjects(db, store)).failed).toBe(0);
    expect((await objects('id=$1', [abandoned.id]))[0].state).toBe('deleted');
    // The retry stores it.
    const output = await storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, { kind: 'companion_message', text: longText });
    expect((await db.query('SELECT content_object_id FROM supervisor_artifacts WHERE id=$1', [output.artifactId])).rows[0].content_object_id).not.toBeNull();
  });

  it('a staged upload nobody claimed is deleted after the grace period only', async () => {
    const s = await seed();
    const staged = await stageObject(db, store, { workspaceId: s.workspaceId, enrollmentId: s.enrollmentId, purpose: 'supervisor_artifact', mediaType: 'application/json', bytes: Buffer.from('{"kind":"x"}') });
    const key = (await objects('id=$1', [staged.id]))[0].object_key;
    await sweepArtifactObjects(db, store);
    expect(s3.objects.has(key)).toBe(true);
    await sweepArtifactObjects(db, store, { stagedAfterMs: 0 });
    expect(s3.objects.has(key)).toBe(false);
    expect((await objects('id=$1', [staged.id]))[0].state).toBe('deleted');
    await expect(readObject(db, staged.id)).rejects.toMatchObject({ code: 'ARTIFACT_OBJECT_GONE' });
  });

  it('erasure lets go of the object; the sweep deletes it from the store and retries failures', async () => {
    const s = await seed(), job = await companionJob(s);
    const output = await storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, { kind: 'companion_message', text: longText });
    await settle(job, output);
    const [object] = await objects('enrollment_id=$1', [s.enrollmentId]);
    await transaction(db, client => eraseWithin(client, { id: s.enrollmentId, workspace_id: s.workspaceId }));
    expect((await db.query('SELECT content,content_object_id FROM supervisor_artifacts WHERE id=$1', [output.artifactId])).rows[0]).toEqual({ content: { erased: true }, content_object_id: null });
    expect((await objects('id=$1', [object.id]))[0]).toMatchObject({ state: 'delete_pending' });
    expect(s3.objects.has(object.object_key)).toBe(true);
    s3.failures.push({ method: 'DELETE', status: 503 });
    expect(await sweepArtifactObjects(db, store)).toMatchObject({ failed: 1 });
    expect((await objects('id=$1', [object.id]))[0]).toMatchObject({ state: 'delete_pending', delete_attempts: 1, last_error: 'OBJECT_STORE_UNAVAILABLE' });
    expect(await sweepArtifactObjects(db, store)).toMatchObject({ failed: 0 });
    expect((await objects('id=$1', [object.id]))[0]).toMatchObject({ state: 'deleted' });
    expect(s3.objects.has(object.object_key)).toBe(false);
  });
});

// ---- Generated clips (the media flow of media-jobs.integration.test.ts) ----
const origin = 'http://localhost:4310', workspace = randomUUID();
const mediaOptions = { pollIntervalMs: 1000, maxPolls: 6, providerCallTimeoutMs: 2000, maxActivePerWorkspace: 10 };
let mediaApp: Awaited<ReturnType<typeof createServer>> | undefined;
interface Session { id: string; cookie: string; csrf: string }
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
async function login(role: string) {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, 'test:' + id, `Media ${role}`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await mediaApp!.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
}
const post = (s: Session, url: string, payload: unknown = {}) => mediaApp!.inject({ method: 'POST', url, headers: headers(s), payload: payload as object });
const get = (s: Session, url: string, extra: Record<string, string> = {}) => mediaApp!.inject({ url, headers: { ...headers(s), ...extra } });
const key = () => 'media-' + randomUUID();

describe('generated clips in the object store', () => {
  it('are uploaded once, served by range through the API after authorization, refused when changed, and deleted on erasure', async () => {
    const video = new ScriptedVideo();
    video.asset = Uint8Array.from([...SYNTHETIC_MP4, ...randomBytes(200)]);
    const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { 'scripted-video': video.factory() });
    mediaApp = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, media: { options: mediaOptions }, artifactStore: store });
    const worker: MediaJobService = createMediaJobService(db, workspaceMediaResolver(providers), mediaOptions);
    await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'media-' + workspace, 'Media objects']);
    const owner = await login('owner'), learner = await login('learner'), other = await login('learner');
    const configured = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup`, { expectedRevision: 0, idempotencyKey: key(),
      configuration: mediaConfiguration(), jobPolicy: mediaJobPolicy(1_000_000), credentials: { [MEDIA_CREDENTIAL]: 'synthetic-media-credential' } });
    expect(configured.statusCode, configured.body).toBe(200);
    const funded = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: 0, idempotencyKey: key(), limits: { microUsd: 10_000_000, tokens: 1_000_000 }, paidWorkApproved: true });
    expect(funded.statusCode, funded.body).toBe(200);
    const imported = await post(owner, `/api/workspaces/${workspace}/releases`, fixture());
    const releaseId = imported.json().id;
    expect((await post(owner, `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
    const enrollment = (await post(learner, '/api/enrollments', { releaseId })).json().id as string;
    const enrollmentBudget = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: 0, idempotencyKey: key(), enrollmentId: enrollment,
      limits: { microUsd: 10_000_000, tokens: 1_000_000 }, paidWorkApproved: true });
    expect(enrollmentBudget.statusCode, enrollmentBudget.body).toBe(200);
    const requested = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, { episodeId: 'min', title: 'Running minimum in motion',
      objective: 'Show the running minimum keeping the smaller value at each comparison.', script: 'Narrated diagram of a running minimum.', idempotencyKey: key() });
    expect(requested.statusCode, requested.body).toBe(200);
    const id = requested.json().id as string;
    for (let i = 0, t = 0; i < 12; i++, t += 2500) {
      await worker.run({ now: new Date(Date.now() + t) });
      if ((await get(owner, `/api/admin/media-jobs/${id}`)).json().state === 'under_review') break;
    }
    const detail = (await get(owner, `/api/admin/media-jobs/${id}`)).json();
    expect(detail.state).toBe('under_review');
    const sha = createHash('sha256').update(video.asset).digest('hex');
    expect(detail.asset).toMatchObject({ sha256: sha, byteLength: video.asset.byteLength });
    // Postgres keeps the digest and the object reference, not the bytes.
    const asset = (await db.query('SELECT content,object_id FROM media_assets WHERE job_id=$1', [id])).rows[0];
    expect(asset.content).toBeNull();
    const [object] = await objects('id=$1', [asset.object_id]);
    expect(object).toMatchObject({ state: 'stored', purpose: 'media_asset', sha256: sha, media_type: 'video/mp4', enrollment_id: enrollment });
    expect(object.etag).toBeTruthy();
    expect(s3.objects.get(object.object_key)!.body.equals(Buffer.from(video.asset))).toBe(true);
    // Served only through the API, with the same authorization and range support.
    const whole = await get(owner, `/api/admin/media-jobs/${id}/asset`);
    expect(whole.statusCode).toBe(200); expect(whole.rawPayload.equals(Buffer.from(video.asset))).toBe(true);
    const ranged = await get(owner, `/api/admin/media-jobs/${id}/asset`, { range: 'bytes=4-7' });
    expect(ranged.statusCode).toBe(206); expect(ranged.rawPayload.toString('latin1')).toBe('ftyp');
    expect((await get(learner, `/api/admin/media-jobs/${id}/asset`)).statusCode).toBe(403);
    expect((await get(other, `/api/admin/media-jobs/${id}/asset`)).statusCode).toBe(403);
    expect(JSON.stringify(detail)).not.toContain(s3.endpoint); expect(JSON.stringify(detail)).not.toContain(object.object_key);
    // A replaced object is refused, for whole and partial reads alike.
    const original = s3.objects.get(object.object_key)!;
    s3.objects.set(object.object_key, { ...original, body: Buffer.from(randomBytes(original.body.length)), etag: '"replaced"' });
    expect((await get(owner, `/api/admin/media-jobs/${id}/asset`)).json().error).toBe('ARTIFACT_OBJECT_INTEGRITY');
    expect((await get(owner, `/api/admin/media-jobs/${id}/asset`, { range: 'bytes=4-7' })).json().error).toBe('ARTIFACT_OBJECT_INTEGRITY');
    s3.objects.set(object.object_key, original);
    // Erasure deletes the clip record; the object is queued and swept from the store.
    const erased = await post(learner, `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: 'Learner asked for their course data to be removed.' });
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await objects('id=$1', [object.id]))[0].state).toBe('delete_pending');
    await sweepArtifactObjects(db, store);
    expect((await objects('id=$1', [object.id]))[0].state).toBe('deleted');
    expect(s3.objects.has(object.object_key)).toBe(false);
  });
});
