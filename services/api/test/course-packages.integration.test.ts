import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { issueLoginCode } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { ensureCatalog } from '../src/admin-routes.js';
import { digestJson } from '../src/repository.js';
import { sha256 } from '../src/course-package.js';
import type { PackageFetcher } from '../src/course-package-source.js';
import { buildPackage } from './course-package-fixture.js';
import { SDK_VERSION } from '@course-core/sdk';
import { fixture } from './fixture.js';
import { recoveryFixture } from './recovery-fixture.js';

const origin = 'http://127.0.0.1:4391';
const schema = `course_packages_${randomUUID().replaceAll('-', '')}`;
let testDatabase: TestDatabase | undefined, db: Database;
let app: Awaited<ReturnType<typeof createServer>>, offline: Awaited<ReturnType<typeof createServer>>;
let workspaceId: string;
interface Session { userId: string; cookie: string; csrf: string }
const sessions: Record<string, Session> = {};
const recovery = recoveryFixture();
recovery.course.id = 'ordering-recovery';
const network = new Map<string, () => Response>();
const fetcher: PackageFetcher = async url => network.get(url)?.() ?? new Response('missing', { status: 404 });
const hostFixture = Buffer.from('synthetic host fixture\n');

async function session(role: string, workspace = workspaceId): Promise<Session> {
  const userId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [userId, `package-test:${userId}`, `${role} example`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, userId, role]);
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(response.statusCode, response.body).toBe(200);
  return { userId, cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: response.json().csrfToken };
}
const headers = (who: Session) => ({ cookie: who.cookie, origin, 'x-csrf-token': who.csrf });
const upload = (who: Session, bytes: Buffer, server = app) => server.inject({ method: 'POST', url: `/api/admin/course-packages/inspect?workspaceId=${workspaceId}`,
  headers: { ...headers(who), 'content-type': 'application/gzip' }, payload: bytes });
const fromUrl = (who: Session, url: string, server = app) => server.inject({ method: 'POST', url: `/api/admin/course-packages/inspect?workspaceId=${workspaceId}`, headers: headers(who), payload: { url } });
const install = (who: Session, digest: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/admin/course-packages/${digest}/install`, headers: headers(who),
  payload: { workspaceId, idempotencyKey: `install-${randomUUID()}`, ...extra } });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const options = { loginCodes: true, origin, secureCookies: false, adaptation: recovery.runtime };
  app = await createServer(db, { ...options, coursePackages: { hostFiles: [{ name: 'fixture.py', sha256: sha256(hostFixture) }], coreVersion: '0.1.46', remote: { fetcher } } });
  offline = await createServer(db, { ...options, coursePackages: { remoteFetch: 'off', remote: { fetcher } } });
  workspaceId = randomUUID();
  const foreign = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3),($4,$5,$6)', [workspaceId, 'packages', 'Packages', foreign, 'packages-foreign', 'Foreign']);
  for (const role of ['owner', 'admin', 'author', 'reviewer', 'instructor', 'observer', 'support_observer', 'learner', 'course_scoped']) sessions[role] = await session(role);
  sessions.outsider = await session('owner', foreign);
  // An existing published course (ordering 1.0.0), as the manual import path creates it.
  const compiled = compileCourse(fixture()), releaseId = randomUUID();
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), sessions.owner!.userId]);
  const catalogId = await ensureCatalog(db, releaseId);
  // A course-scoped author on that course: still not allowed to install packages.
  await db.query(`INSERT INTO course_access_grants(id,workspace_id,catalog_id,user_id,role,reason_code,granted_by,expires_at) VALUES($1,$2,$3,$4,'author','course_author',$5,now()+interval '1 day')`,
    [randomUUID(), workspaceId, catalogId, sessions.course_scoped!.userId, sessions.owner!.userId]);
}, 60000);
afterAll(async () => {
  await app?.close(); await offline?.close(); await db?.end(); await testDatabase?.drop();
});

const version = (v: string, change?: (c: ReturnType<typeof fixture>) => void) => { const c = fixture(); c.version = v; change?.(c); return c; };

describe('course-package installation', () => {
  it('inspects an uploaded package: preview, host requirements and staging', async () => {
    const pkg = buildPackage(version('1.1.0'), { extra: [{ name: 'fixture.py', bytes: hostFixture, role: 'host-requirement' }, { name: 'verifier.json', bytes: Buffer.from('{}'), role: 'host-requirement' }] });
    const response = await upload(sessions.admin!, pkg.bytes);
    expect(response.statusCode, response.body).toBe(200);
    const preview = response.json();
    expect(preview).toMatchObject({ sha256: pkg.sha256, course: { id: 'ordering', version: '1.1.0', digest: pkg.compiled.digest },
      sdk: { status: 'supported' }, core: { minimumVersion: '0.1.0', version: '0.1.46', satisfied: true },
      existing: { status: 'new-version', newestVersion: '1.0.0' }, registry: { present: false }, runtime: { runnable: true }, installable: true,
      packageSource: { kind: 'upload' }, permissions: { install: true, approveAndPublish: true, approveRegistry: true } });
    expect(preview.hostRequirements).toEqual([
      { name: 'fixture.py', sha256: sha256(hostFixture), bytes: hostFixture.length, status: 'identical' },
      { name: 'verifier.json', sha256: sha256(Buffer.from('{}')), bytes: 2, status: 'missing' }]);
    expect(preview.problems).toEqual([expect.objectContaining({ code: 'HOST_REQUIREMENT_MISSING', severity: 'warning' })]);
    expect(JSON.stringify(preview)).not.toMatch(/\/Users\/|\/home\/|\/private\//);
    const staged = await db.query('SELECT octet_length(bytes) AS n,expires_at > now() AS live FROM course_package_staging WHERE workspace_id=$1 AND sha256=$2', [workspaceId, pkg.sha256]);
    expect(staged.rows[0]).toMatchObject({ n: pkg.bytes.length, live: true });
  });
  it('refuses invalid packages with the verifier\'s code and stages nothing', async () => {
    const tampered = buildPackage(version('1.2.0'), { descriptor: d => { d.courseDigest = 'e'.repeat(64); } });
    const response = await upload(sessions.admin!, tampered.bytes);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('PACKAGE_COURSE_DIGEST_MISMATCH');
    expect((await upload(sessions.admin!, Buffer.from('not gzip at all, sorry'))).json().error).toBe('PACKAGE_NOT_GZIP');
    expect((await db.query('SELECT 1 FROM course_package_staging WHERE sha256=$1', [tampered.sha256])).rowCount).toBe(0);
  });
  it('reports blocking problems: newer Core required, unsupported SDK, version conflict', async () => {
    const preview = (await upload(sessions.admin!, buildPackage(version('1.0.0', c => { c.summary = 'Changed content'; }), { descriptor: d => { d.minimumCoreVersion = '9.0.0'; d.sdkVersion = '1.0.0'; } }).bytes)).json();
    expect(preview.installable).toBe(false);
    expect(preview.problems.filter((p: { severity: string }) => p.severity === 'blocking').map((p: { code: string }) => p.code).sort())
      .toEqual(['CORE_VERSION_TOO_OLD', 'RELEASE_VERSION_CONFLICT', 'SDK_UNSUPPORTED']);
    const conflict = buildPackage(version('1.0.0', c => { c.summary = 'Changed content'; }));
    expect((await upload(sessions.admin!, conflict.bytes)).statusCode).toBe(200);
    const refused = await install(sessions.admin!, conflict.sha256);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('RELEASE_VERSION_CONFLICT');
  });
  it('refuses a package from a newer SDK minor than the pinned one, and accepts any patch of the pinned minor (K13)', async () => {
    const [major, minor] = SDK_VERSION.split('.').map(Number) as [number, number];
    const newer = buildPackage(version('1.4.0'), { descriptor: d => { d.sdkVersion = `${major}.${minor + 1}.0`; } });
    const preview = (await upload(sessions.admin!, newer.bytes)).json();
    expect(preview.installable).toBe(false);
    expect(preview.problems).toContainEqual(expect.objectContaining({ code: 'SDK_UNSUPPORTED', severity: 'blocking' }));
    const refused = await install(sessions.admin!, newer.sha256);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('SDK_UNSUPPORTED');
    expect((await db.query("SELECT 1 FROM course_releases WHERE workspace_id=$1 AND version='1.4.0'", [workspaceId])).rowCount).toBe(0);
    const patch = (await upload(sessions.admin!, buildPackage(version('1.4.1'), { descriptor: d => { d.sdkVersion = `${major}.${minor}.9`; } }).bytes)).json();
    expect(patch.problems.map((p: { code: string }) => p.code)).not.toContain('SDK_UNSUPPORTED');
    expect(patch.problems.map((p: { code: string }) => p.code)).not.toContain('SDK_OLDER_THAN_CORE');
  });
  it('detects an identical installed version as already installed', async () => {
    const same = buildPackage(fixture());
    const preview = (await upload(sessions.admin!, same.bytes)).json();
    expect(preview.existing).toMatchObject({ status: 'already-installed', releaseStatus: 'published' });
    const response = await install(sessions.admin!, same.sha256);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ alreadyInstalled: true, installation: null });
  });
  it('installs a draft in review with the package digest and source, idempotently and audited', async () => {
    const pkg = buildPackage(version('1.1.0'));
    expect((await upload(sessions.owner!, pkg.bytes)).statusCode).toBe(200);
    const before = Number((await db.query("SELECT count(*) FROM learning_events WHERE workspace_id=$1 AND event_type='course_package.installed'", [workspaceId])).rows[0].count);
    const response = await install(sessions.owner!, pkg.sha256, { notes: 'Synthetic package release.' });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ alreadyInstalled: false, installation: { course: { id: 'ordering', version: '1.1.0', digest: pkg.compiled.digest }, state: 'pending_review',
      package: { sha256: pkg.sha256, source: { kind: 'upload' } }, registry: { present: false }, permissions: { approve: true, publish: true } } });
    const row = (await db.query(`SELECT r.status,r.digest,v.state,v.notes,p.package_sha256 FROM course_releases r JOIN admin_release_reviews v ON v.release_id=r.id
      JOIN course_release_packages p ON p.release_id=r.id WHERE r.id=$1`, [body.releaseId])).rows[0];
    expect(row).toEqual({ status: 'draft', digest: pkg.compiled.digest, state: 'pending_review', notes: 'Synthetic package release.', package_sha256: pkg.sha256 });
    expect((await db.query('SELECT 1 FROM course_package_staging WHERE sha256=$1', [pkg.sha256])).rowCount).toBe(0);
    const replay = await install(sessions.owner!, pkg.sha256);
    expect(replay.json()).toMatchObject({ alreadyInstalled: true, releaseId: body.releaseId });
    const events = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='course_package.installed' ORDER BY sequence", [workspaceId])).rows;
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)!.payload).toMatchObject({ packageSha256: pkg.sha256, version: '1.1.0', sourceKind: 'upload', published: false });
    // The audit log shows the installation's payload to staff.
    const audit = await app.inject({ url: `/api/admin/workspaces/${workspaceId}/audit?type=course_package.installed`, headers: headers(sessions.owner!) });
    expect(audit.statusCode, audit.body).toBe(200);
    expect(audit.json().events[0]).toMatchObject({ type: 'course_package.installed', payloadWithheld: false });
    // The existing transitions apply from here: approve, then publish.
    const catalog = body.installation.catalogId;
    const transition = async (action: string) => app.inject({ method: 'POST', url: `/api/admin/courses/${catalog}/releases/${body.releaseId}/transitions`,
      headers: { ...headers(sessions.owner!), 'if-match': (await app.inject({ url: `/api/admin/courses/${catalog}`, headers: headers(sessions.owner!) })).json().revision, 'idempotency-key': randomUUID() }, payload: { action } });
    expect((await transition('approve')).statusCode).toBe(200);
    expect((await transition('publish')).json().receipt.outcome).toBe('published');
    expect((await app.inject({ url: `/api/admin/course-packages/installs/${body.releaseId}`, headers: headers(sessions.owner!) })).json()).toMatchObject({ state: 'published', availableForNewLearners: true });
  });
  it('requires an install to be staged first', async () => {
    const response = await install(sessions.admin!, 'f'.repeat(64));
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('COURSE_PACKAGE_NOT_STAGED');
  });
  it('approveAndPublish requires the exact version confirmation, then publishes', async () => {
    const pkg = buildPackage(version('2.0.0'));
    await upload(sessions.admin!, pkg.bytes);
    for (const confirmVersion of ['2.0', '2.0.0 ', '']) {
      const refused = await install(sessions.admin!, pkg.sha256, { approveAndPublish: { confirmVersion } });
      expect(refused.statusCode, confirmVersion).toBe(confirmVersion === '' ? 400 : 428);
    }
    expect((await db.query("SELECT 1 FROM course_releases WHERE workspace_id=$1 AND version='2.0.0'", [workspaceId])).rowCount).toBe(0);
    const response = await install(sessions.admin!, pkg.sha256, { approveAndPublish: { confirmVersion: '2.0.0' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().installation).toMatchObject({ state: 'published', availableForNewLearners: true });
    expect((await db.query("SELECT payload FROM learning_events WHERE event_type='course_package.installed' AND payload->>'version'='2.0.0'")).rows[0].payload.published).toBe(true);
  });
  it('refuses a version older than the newest installed unless explicitly confirmed, and records the choice', async () => {
    // 2.0.0 is installed and published (above); 1.5.0 goes back.
    const pkg = buildPackage(version('1.5.0'));
    const preview = (await upload(sessions.admin!, pkg.bytes)).json();
    expect(preview.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'OLDER_THAN_INSTALLED', severity: 'warning' })]));
    const refused = await install(sessions.admin!, pkg.sha256);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'OLDER_VERSION_CONFIRMATION_REQUIRED', details: { version: '1.5.0', newestVersion: '2.0.0' } });
    expect((await install(sessions.admin!, pkg.sha256, { confirmOlderVersion: false })).statusCode).toBe(400);
    expect((await db.query("SELECT 1 FROM course_releases WHERE workspace_id=$1 AND version='1.5.0'", [workspaceId])).rowCount).toBe(0);
    const response = await install(sessions.admin!, pkg.sha256, { confirmOlderVersion: true, approveAndPublish: { confirmVersion: '1.5.0' } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().installation).toMatchObject({ state: 'published', course: { version: '1.5.0' } });
    const event = (await db.query("SELECT payload FROM learning_events WHERE event_type='course_package.installed' AND payload->>'version'='1.5.0'")).rows[0];
    expect(event.payload).toMatchObject({ olderVersionConfirmed: true, newestVersion: '2.0.0', published: true });
  });
  it('installs a new course with its adaptation registry staged, and approves exactly that digest', async () => {
    const pkg = buildPackage(recovery.course, { registry: recovery.config });
    const preview = (await upload(sessions.owner!, pkg.bytes)).json();
    const digest = digestJson(recovery.config);
    expect(preview).toMatchObject({ existing: { status: 'new-course', catalogId: null }, registry: { present: true, digest, profileCount: recovery.config.profiles.length, approvable: true } });
    const response = await install(sessions.owner!, pkg.sha256);
    expect(response.statusCode, response.body).toBe(200);
    const { releaseId, installation } = response.json();
    expect(installation.registry).toEqual({ present: true, digest, profileCount: recovery.config.profiles.length, registryRevision: 0, approved: false });
    const approveUrl = `/api/admin/course-packages/installs/${releaseId}/registry`;
    // Digest-bound: another digest is refused; reviewers and authors cannot approve.
    expect((await app.inject({ method: 'POST', url: approveUrl, headers: headers(sessions.owner!), payload: { configurationDigest: 'a'.repeat(64), expectedRegistryRevision: 0 } })).json().error).toBe('ADAPTATION_REGISTRY_DIGEST_MISMATCH');
    for (const role of ['reviewer', 'author', 'outsider']) expect((await app.inject({ method: 'POST', url: approveUrl, headers: headers(sessions[role]!), payload: { configurationDigest: digest, expectedRegistryRevision: 0 } })).statusCode, role).toBe(403);
    const approved = await app.inject({ method: 'POST', url: approveUrl, headers: headers(sessions.owner!), payload: { configurationDigest: digest, expectedRegistryRevision: 0 } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().registry).toMatchObject({ approved: true, registryRevision: 1 });
    expect((await app.inject({ method: 'POST', url: approveUrl, headers: headers(sessions.owner!), payload: { configurationDigest: digest, expectedRegistryRevision: 0 } })).json().error).toBe('STALE_REGISTRY');
  });
  it('can approve the staged registry in the install step itself', async () => {
    const course = structuredClone(recovery.course); course.version = '1.1.0';
    const pkg = buildPackage(course, { registry: recovery.config });
    await upload(sessions.owner!, pkg.bytes);
    const response = await install(sessions.owner!, pkg.sha256, { approveRegistry: { configurationDigest: digestJson(recovery.config) } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ registryApproval: { approved: true, registryRevision: 1 }, installation: { registry: { approved: true } } });
    const wrong = buildPackage(Object.assign(structuredClone(recovery.course), { version: '1.2.0' }), { registry: recovery.config });
    await upload(sessions.owner!, wrong.bytes);
    expect((await install(sessions.owner!, wrong.sha256, { approveRegistry: { configurationDigest: 'b'.repeat(64) } })).json())
      .toMatchObject({ registryApproval: { approved: false, code: 'ADAPTATION_REGISTRY_DIGEST_MISMATCH' }, installation: { state: 'pending_review', registry: { approved: false } } });
  });
  it('inspects a GitHub release URL through the injected fetcher', async () => {
    const pkg = buildPackage(version('3.0.0'));
    const name = 'ordering-3.0.0.course.tgz', base = 'https://github.com/example/ordering/releases/download/v3.0.0/';
    network.set('https://api.github.com/repos/example/ordering/releases/latest', () => new Response(JSON.stringify({ tag_name: 'v3.0.0',
      assets: [name, `${name}.sha256`].map(n => ({ name: n, size: 1, browser_download_url: base + n })) })));
    network.set(base + name, () => new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/asset/1' } }));
    network.set('https://objects.githubusercontent.com/asset/1', () => new Response(pkg.bytes));
    network.set(`${base}${name}.sha256`, () => new Response(`${pkg.sha256}  ${name}\n`));
    const response = await fromUrl(sessions.admin!, 'https://github.com/example/ordering');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ sha256: pkg.sha256, course: { version: '3.0.0' }, packageSource: { kind: 'github', owner: 'example', repo: 'ordering', tag: 'v3.0.0', asset: name, checksumVerified: true } });
    const installed = await install(sessions.admin!, pkg.sha256);
    expect(installed.json().installation.package.source).toMatchObject({ kind: 'github', repo: 'ordering' });
    expect((await fromUrl(sessions.admin!, 'https://github.com/example/missing')).json().error).toBe('GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING');
    expect((await fromUrl(sessions.admin!, 'https://example.org/package.course.tgz')).json().error).toBe('COURSE_PACKAGE_URL_UNSUPPORTED');
    const off = await fromUrl(sessions.admin!, 'https://github.com/example/ordering', offline);
    expect(off.statusCode).toBe(403);
    expect(off.json().error).toBe('COURSE_PACKAGE_REMOTE_FETCH_DISABLED');
  });
  it('denies every role but owner/admin, before reading an upload', async () => {
    const pkg = buildPackage(version('4.0.0'));
    for (const role of ['author', 'reviewer', 'instructor', 'observer', 'support_observer', 'learner', 'course_scoped', 'outsider']) {
      const response = await upload(sessions[role]!, pkg.bytes);
      expect(response.statusCode, role).toBe(403);
      expect((await fromUrl(sessions[role]!, 'https://github.com/example/ordering')).statusCode, role).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: `/api/admin/course-packages/inspect?workspaceId=${workspaceId}`, headers: { origin, 'content-type': 'application/gzip' }, payload: pkg.bytes })).statusCode).toBe(401);
    // CSRF is required for uploads too.
    expect((await app.inject({ method: 'POST', url: `/api/admin/course-packages/inspect?workspaceId=${workspaceId}`, headers: { cookie: sessions.admin!.cookie, origin, 'content-type': 'application/gzip' }, payload: pkg.bytes })).json().error).toBe('CSRF_REJECTED');
    await upload(sessions.admin!, pkg.bytes);
    for (const role of ['author', 'reviewer', 'instructor', 'observer', 'learner', 'course_scoped', 'outsider'])
      expect((await install(sessions[role]!, pkg.sha256)).statusCode, role).toBe(403);
    const view = (await db.query("SELECT release_id FROM course_release_packages WHERE workspace_id=$1 LIMIT 1", [workspaceId])).rows[0].release_id;
    for (const role of ['author', 'reviewer', 'outsider'])
      expect((await app.inject({ url: `/api/admin/course-packages/installs/${view}`, headers: headers(sessions[role]!) })).statusCode, role).toBe(403);
  });
  it('refuses an upload over 64 MiB without buffering it', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/admin/course-packages/inspect?workspaceId=${workspaceId}`,
      headers: { ...headers(sessions.admin!), 'content-type': 'application/gzip' }, payload: Buffer.alloc(64 * 1024 * 1024 + 1, 0x1f) });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe('PACKAGE_TOO_LARGE');
  });
  it('keeps at most a few staged packages per workspace', async () => {
    for (let i = 0; i < 6; i++) expect((await upload(sessions.admin!, buildPackage(version(`5.0.${i}`)).bytes)).statusCode).toBe(200);
    expect(Number((await db.query('SELECT count(*) FROM course_package_staging WHERE workspace_id=$1', [workspaceId])).rows[0].count)).toBeLessThanOrEqual(4);
  });
});
