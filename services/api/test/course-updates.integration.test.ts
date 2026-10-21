import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { issueLoginCode } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { ensureCatalog } from '../src/admin-routes.js';
import { digestJson } from '../src/repository.js';
import { sha256 } from '../src/course-package.js';
import { packageDirectories, readPathPackage, resolveInside } from '../src/course-package-directory.js';
import { verifyCoursePackage } from '../src/course-package.js';
import { backoffMs, publishRefusal, runAutomaticUpdates, type UpdaterOptions } from '../src/course-updates.js';
import type { PackageFetcher } from '../src/course-package-source.js';
import { buildPackage } from './course-package-fixture.js';
import { fixture } from './fixture.js';
import { recoveryFixture } from './recovery-fixture.js';

const origin = 'http://127.0.0.1:4392';
const schema = `course_updates_${randomUUID().replaceAll('-', '')}`;
let testDatabase: TestDatabase | undefined, db: Database, app: Awaited<ReturnType<typeof createServer>>;
let root: string, outside: string, updater: UpdaterOptions, rootId: string;
const recovery = recoveryFixture();
const hostFixture = Buffer.from('synthetic host fixture\n');
const network = new Map<string, () => Response>();
const fetcher: PackageFetcher = async url => network.get(url)?.() ?? new Response('missing', { status: 404 });
interface Session { userId: string; cookie: string; csrf: string }
const HOUR = 3_600_000;

async function user(workspaceId: string, role: string): Promise<Session> {
  const userId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [userId, `updates:${userId}`, `${role} example`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, userId, role]);
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  return { userId, cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: response.json().csrfToken };
}
const headers = (who: Session) => ({ cookie: who.cookie, origin, 'x-csrf-token': who.csrf });
/** A workspace with an owner and version 1.0.0 of `course` published, and its own package folder. */
async function workspace(course = fixture()) {
  const workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `updates-${workspaceId}`, 'Updates']);
  const owner = await user(workspaceId, 'owner');
  const compiled = compileCourse(course), releaseId = randomUUID();
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner.userId]);
  const catalogId = await ensureCatalog(db, releaseId);
  const folder = `ws-${workspaceId.slice(0, 8)}`;
  await mkdir(path.join(root, folder));
  const base = `/api/admin/courses/${catalogId}/updates`;
  const get = async (who = owner) => (await app.inject({ url: base, headers: headers(who) })).json();
  const put = async (what: 'source' | 'settings', body: Record<string, unknown>, who = owner) =>
    app.inject({ method: 'PUT', url: `${base}/${what}`, headers: headers(who), payload: { expectedRevision: (await get(owner)).revision, ...body } });
  const check = (who = owner) => app.inject({ method: 'POST', url: `${base}/check`, headers: headers(who), payload: {} });
  const write = async (name: string, bytes: Buffer) => writeFile(path.join(root, folder, name), bytes);
  return { workspaceId, owner, catalogId, releaseId, folder, get, put, check, write, course };
}
const version = (v: string, change?: (c: ReturnType<typeof fixture>) => void) => { const c = fixture(); c.version = v; change?.(c); return c; };
const source = async (w: Awaited<ReturnType<typeof workspace>>, subpath = w.folder) => {
  const response = await w.put('source', { source: { kind: 'path', directoryId: rootId, subpath } });
  expect(response.statusCode, response.body).toBe(200);
};
const row = async (w: { workspaceId: string }) => (await db.query('SELECT * FROM course_update_sources WHERE workspace_id=$1', [w.workspaceId])).rows[0];
const releases = async (w: { workspaceId: string }) => (await db.query(`SELECT r.version,r.status,v.state FROM course_releases r JOIN admin_release_reviews v ON v.release_id=r.id
  WHERE r.workspace_id=$1 ORDER BY r.created_at`, [w.workspaceId])).rows;
/** Runs only this workspace's due update (other tests' rows are pushed out of the way). */
async function runFor(w: { workspaceId: string }, now: Date) {
  await db.query("UPDATE course_update_sources SET next_check_at=now()+interval '100 years' WHERE workspace_id<>$1 AND level<>'off'", [w.workspaceId]);
  return runAutomaticUpdates(db, updater, now);
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'course-updates-root-')));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), 'course-updates-outside-')));
  const directories = packageDirectories(JSON.stringify([root]));
  rootId = directories[0]!.id;
  const coursePackages = { hostFiles: [{ name: 'fixture.py', sha256: sha256(hostFixture) }], coreVersion: '0.1.46', remote: { fetcher } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: recovery.runtime, coursePackages, coursePackageDirectories: directories });
  updater = { directories, packages: { ...coursePackages, adaptation: recovery.runtime, installedExtensions: [] }, admin: { installedExtensions: [] } };
}, 60000);
afterAll(async () => {
  await app?.close(); await db?.end(); await testDatabase?.drop();
  await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
});

describe('package directory confinement', () => {
  it('refuses .., absolute subpaths, unknown directories and symlinks that escape', async () => {
    await mkdir(path.join(root, 'inside'), { recursive: true });
    await writeFile(path.join(outside, 'secret.course.tgz'), buildPackage(fixture()).bytes);
    await symlink(outside, path.join(root, 'escape'));
    await symlink(path.join(outside, 'secret.course.tgz'), path.join(root, 'inside', 'linked.course.tgz'));
    const directories = updater.directories;
    for (const [subpath, code] of [['../', 'COURSE_PACKAGE_PATH_INVALID'], ['inside/../..', 'COURSE_PACKAGE_PATH_INVALID'], [outside, 'COURSE_PACKAGE_PATH_INVALID'],
      ['inside//x', 'COURSE_PACKAGE_PATH_INVALID'], ['./inside', 'COURSE_PACKAGE_PATH_INVALID'], ['escape', 'COURSE_PACKAGE_PATH_OUTSIDE_DIRECTORY'],
      ['escape/secret.course.tgz', 'COURSE_PACKAGE_PATH_OUTSIDE_DIRECTORY'], ['inside/linked.course.tgz', 'COURSE_PACKAGE_PATH_OUTSIDE_DIRECTORY'], ['absent', 'COURSE_PACKAGE_PATH_NOT_FOUND']] as const)
      await expect(resolveInside(directories, rootId, subpath), subpath).rejects.toMatchObject({ code });
    await expect(resolveInside(directories, 'f'.repeat(16), 'inside')).rejects.toMatchObject({ code: 'COURSE_PACKAGE_DIRECTORY_UNKNOWN' });
    await expect(resolveInside(directories, rootId, 'inside')).resolves.toMatchObject({ target: path.join(root, 'inside') });
    // A symlinked package file inside a folder is never read, even when it is the only candidate.
    await expect(readPathPackage(directories, rootId, 'inside', 'ordering')).rejects.toMatchObject({ code: 'COURSE_PACKAGE_ASSET_NOT_FOUND' });
    expect(() => packageDirectories('["relative"]')).toThrow();
    expect(() => packageDirectories('["/"]')).toThrow();
    expect(packageDirectories(undefined)).toEqual([]);
  });
  it('the source route refuses escapes and never returns host paths', async () => {
    const w = await workspace();
    for (const subpath of ['../', 'escape', '/etc']) expect((await w.put('source', { source: { kind: 'path', directoryId: rootId, subpath } })).statusCode, subpath).toBeGreaterThanOrEqual(400);
    await source(w);
    const view = await w.get();
    expect(view.source).toEqual({ kind: 'path', directoryId: rootId, directory: path.basename(root), subpath: w.folder });
    expect(view.directories).toEqual([{ id: rootId, name: path.basename(root) }]);
    expect(JSON.stringify(view)).not.toContain(root);
  });
});

describe('finding the newest package', () => {
  it('picks the newest version of this course in a folder, lists ties, packs an unpacked folder', async () => {
    const w = await workspace();
    for (const v of ['1.1.0', '1.3.0', '1.2.0']) await w.write(`ordering-${v}.course.tgz`, buildPackage(version(v)).bytes);
    const other = fixture(); other.id = 'other-course'; other.version = '9.0.0';
    await w.write('other-9.0.0.course.tgz', buildPackage(other).bytes);
    await w.write('broken.course.tgz', Buffer.from('not a package'));
    const read = await readPathPackage(updater.directories, rootId, w.folder, 'ordering');
    expect(read.source).toEqual({ kind: 'path', directoryId: rootId, directory: path.basename(root), subpath: w.folder, file: 'ordering-1.3.0.course.tgz' });
    await w.write('ordering-1.3.0-rebuilt.course.tgz', buildPackage(version('1.3.0', c => { c.summary = 'Rebuilt.'; })).bytes);
    await expect(readPathPackage(updater.directories, rootId, w.folder, 'ordering')).rejects.toMatchObject({ code: 'COURSE_PACKAGE_ASSET_CHOICE_REQUIRED',
      details: { assets: ['ordering-1.3.0-rebuilt.course.tgz', 'ordering-1.3.0.course.tgz'] } });
    // An unpacked package folder is packed and verified like a file.
    const unpacked = path.join(root, w.folder, 'unpacked');
    await mkdir(unpacked);
    const course = version('2.0.0'), compiled = compileCourse(course), manifest = Buffer.from(JSON.stringify(course));
    await writeFile(path.join(unpacked, 'course.json'), manifest);
    await writeFile(path.join(unpacked, 'course-package.json'), JSON.stringify({ format: 'course-package', formatVersion: 1, courseId: 'ordering', courseVersion: '2.0.0',
      courseDigest: compiled.digest, sdkVersion: '0.5.0', minimumCoreVersion: '0.1.0', source: {}, members: [{ name: 'course.json', bytes: manifest.length, sha256: sha256(manifest), role: 'course-manifest' }] }));
    const packed = await readPathPackage(updater.directories, rootId, `${w.folder}/unpacked`, 'ordering');
    expect(packed.source.file).toBeNull();
    expect((await verifyCoursePackage(packed.bytes)).descriptor.courseVersion).toBe('2.0.0');
    await symlink(path.join(outside, 'secret.course.tgz'), path.join(unpacked, 'extra.json'));
    await expect(readPathPackage(updater.directories, rootId, `${w.folder}/unpacked`, 'ordering')).rejects.toMatchObject({ code: 'PACKAGE_LINK_ENTRY' });
  });
});

describe('check for updates', () => {
  it('needs a source, reports up to date, then finds, previews, installs and settles an update', async () => {
    const w = await workspace();
    expect((await w.check()).json().error).toBe('COURSE_UPDATE_SOURCE_REQUIRED');
    await source(w);
    await w.write('ordering-1.0.0.course.tgz', buildPackage(fixture()).bytes);
    let checked = (await w.check()).json();
    expect(checked.outcome).toMatchObject({ result: 'up_to_date', version: '1.0.0', newestInstalled: '1.0.0' });
    expect(checked.updates.status).toMatchObject({ lastResult: 'up_to_date', lastTrigger: 'manual', availableVersion: null });
    const pkg = buildPackage(version('1.1.0', c => { c.assessments.find(a => a.id === 'min-b')!.prompt = 'Minimum of 3 and 8?'; }));
    await w.write('ordering-1.1.0.course.tgz', pkg.bytes);
    checked = (await w.check()).json();
    expect(checked.outcome).toMatchObject({ result: 'update_available', version: '1.1.0', sha256: pkg.sha256, newestInstalled: '1.0.0',
      preview: { course: { version: '1.1.0' }, installable: true, packageSource: { kind: 'path', file: 'ordering-1.1.0.course.tgz' } },
      diff: { from: { version: '1.0.0' }, to: { version: '1.1.0' }, identical: false } });
    expect(checked.outcome.diff.kinds.assessments.changed).toEqual(['min-b']);
    expect(checked.updates.status).toMatchObject({ lastResult: 'update_available', availableVersion: '1.1.0' });
    const installed = await app.inject({ method: 'POST', url: `/api/admin/course-packages/${pkg.sha256}/install`, headers: headers(w.owner),
      payload: { workspaceId: w.workspaceId, idempotencyKey: `install-${randomUUID()}`, approveAndPublish: { confirmVersion: '1.1.0' } } });
    expect(installed.json().installation).toMatchObject({ state: 'published', package: { source: { kind: 'path', file: 'ordering-1.1.0.course.tgz' } } });
    expect((await w.check()).json().outcome.result).toBe('up_to_date');
    const audit = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='course_update.checked' ORDER BY sequence", [w.workspaceId])).rows;
    expect(audit.map(e => e.payload.result)).toEqual(['up_to_date', 'update_available', 'up_to_date']);
    expect((await db.query('SELECT count(*)::int AS n FROM course_update_attempts WHERE workspace_id=$1', [w.workspaceId])).rows[0].n).toBe(3);
  });
  it('checks a GitHub source through the injected fetcher', async () => {
    const w = await workspace();
    const pkg = buildPackage(version('1.4.0')), name = 'ordering-1.4.0.course.tgz', base = 'https://github.com/example/updates/releases/download/v1.4.0/';
    network.set('https://api.github.com/repos/example/updates/releases/latest', () => new Response(JSON.stringify({ tag_name: 'v1.4.0', assets: [{ name, size: 1, browser_download_url: base + name }] })));
    network.set(base + name, () => new Response(pkg.bytes));
    expect((await w.put('source', { source: { kind: 'github', url: 'https://github.com/example/updates' } })).statusCode).toBe(200);
    expect((await w.put('source', { source: { kind: 'github', url: 'https://example.org/updates' } })).json().error).toBe('COURSE_PACKAGE_URL_UNSUPPORTED');
    expect((await w.check()).json().outcome).toMatchObject({ result: 'update_available', version: '1.4.0', preview: { packageSource: { kind: 'github', repo: 'updates' } } });
    network.set('https://api.github.com/repos/example/updates/releases/latest', () => new Response('{}', { status: 404 }));
    expect((await w.check()).json()).toMatchObject({ outcome: { result: 'failed', code: 'GITHUB_REPOSITORY_NOT_PUBLIC_OR_MISSING' }, updates: { status: { lastResult: 'failed', availableVersion: '1.4.0' } } });
  });
});

describe('automatic updates', () => {
  it('are off by default and run nothing', async () => {
    const w = await workspace();
    await source(w);
    await w.write('ordering-1.1.0.course.tgz', buildPackage(version('1.1.0')).bytes);
    expect((await w.get()).settings).toMatchObject({ level: 'off', intervalHours: 24 });
    await runFor(w, new Date(Date.now() + 1000 * HOUR));
    expect((await row(w)).last_checked_at).toBeNull();
    expect(await releases(w)).toHaveLength(1);
  });
  it('check level records the update without installing, then waits one interval', async () => {
    const w = await workspace();
    await source(w);
    await w.write('ordering-1.1.0.course.tgz', buildPackage(version('1.1.0')).bytes);
    expect((await w.put('settings', { level: 'check', intervalHours: 0 })).statusCode).toBe(400);
    expect((await w.put('settings', { level: 'check', intervalHours: 6 })).statusCode).toBe(200);
    const now = new Date(Date.now() + HOUR);
    expect(await runFor(w, now)).toMatchObject({ ran: true });
    expect(await row(w)).toMatchObject({ last_result: 'update_available', available_version: '1.1.0', last_trigger: 'automatic', consecutive_failures: 0 });
    expect((await row(w)).next_check_at.getTime()).toBe(now.getTime() + 6 * HOUR);
    expect(await releases(w)).toHaveLength(1);
    // Not due again before the interval has passed.
    await runFor(w, new Date(now.getTime() + 5 * HOUR));
    expect((await db.query('SELECT count(*)::int AS n FROM course_update_attempts WHERE workspace_id=$1', [w.workspaceId])).rows[0].n).toBe(1);
    // The overview shows the available update.
    const overview = (await app.inject({ url: `/api/admin/courses/${w.catalogId}/overview`, headers: headers(w.owner) })).json();
    expect(overview.release.update).toMatchObject({ availableVersion: '1.1.0', level: 'check' });
  });
  it('install level installs a draft in review and stages the registry', async () => {
    const course = structuredClone(recovery.course); course.id = 'recovery-install';
    const w = await workspace(course);
    await source(w);
    const next = structuredClone(course); next.version = '1.1.0';
    await w.write('recovery-1.1.0.course.tgz', buildPackage(next, { registry: recovery.config }).bytes);
    expect((await w.put('settings', { level: 'install', intervalHours: 24 })).statusCode).toBe(200);
    await runFor(w, new Date(Date.now() + HOUR));
    expect(await row(w)).toMatchObject({ last_result: 'installed', last_error_code: null });
    expect((await releases(w)).at(-1)).toMatchObject({ version: '1.1.0', status: 'draft', state: 'pending_review' });
    const staged = (await db.query('SELECT registry_digest FROM course_release_packages WHERE workspace_id=$1', [w.workspaceId])).rows[0];
    expect(staged.registry_digest).toBe(digestJson(recovery.config));
    expect((await db.query("SELECT 1 FROM adaptation_registries r JOIN course_releases c ON c.id=r.course_release_id WHERE c.workspace_id=$1 AND c.version='1.1.0'", [w.workspaceId])).rowCount).toBe(0);
  });
  it('publish level needs both permissions and an acknowledgement, publishes, and approves a changed registry only when acknowledged', async () => {
    const course = structuredClone(recovery.course); course.id = 'recovery-publish';
    const w = await workspace(course);
    await source(w);
    const author = await user(w.workspaceId, 'author'), admin = await user(w.workspaceId, 'admin');
    expect((await w.put('settings', { level: 'publish', intervalHours: 24 }, author)).statusCode).toBe(403);
    expect((await w.put('settings', { level: 'install', intervalHours: 24 }, author)).statusCode).toBe(403);
    expect((await w.put('settings', { level: 'check', intervalHours: 24 }, author)).statusCode).toBe(200);
    expect((await w.put('settings', { level: 'check', intervalHours: 24, autoApproveRegistry: true })).statusCode).toBe(400);
    const missing = await w.put('settings', { level: 'publish', intervalHours: 24 }, admin);
    expect(missing.statusCode).toBe(428);
    expect(missing.json().error).toBe('AUTO_PUBLISH_ACKNOWLEDGEMENT_REQUIRED');
    expect((await w.put('settings', { level: 'publish', intervalHours: 24, acknowledgePublish: true }, admin)).statusCode).toBe(200);
    expect((await w.get()).settings).toMatchObject({ level: 'publish', autoApproveRegistry: false, acknowledgedBy: 'admin example' });
    const v11 = structuredClone(course); v11.version = '1.1.0';
    await w.write('recovery-1.1.0.course.tgz', buildPackage(v11, { registry: recovery.config }).bytes);
    await runFor(w, new Date(Date.now() + HOUR));
    expect(await row(w)).toMatchObject({ last_result: 'published', last_error_code: 'AUTO_REGISTRY_AWAITS_APPROVAL' });
    expect((await releases(w)).at(-1)).toMatchObject({ version: '1.1.0', status: 'published' });
    expect((await db.query("SELECT 1 FROM adaptation_registries r JOIN course_releases c ON c.id=r.course_release_id WHERE c.workspace_id=$1 AND c.version='1.1.0'", [w.workspaceId])).rowCount).toBe(0);
    // With the acknowledgement covering a changed registry, the next version's registry is approved.
    expect((await w.put('settings', { level: 'publish', intervalHours: 24, acknowledgePublish: true, autoApproveRegistry: true }, admin)).statusCode).toBe(200);
    const v12 = structuredClone(course); v12.version = '1.2.0';
    await w.write('recovery-1.2.0.course.tgz', buildPackage(v12, { registry: recovery.config }).bytes);
    await runFor(w, new Date(Date.now() + 30 * HOUR));
    expect(await row(w)).toMatchObject({ last_result: 'published', last_error_code: null });
    expect((await db.query("SELECT 1 FROM adaptation_registries r JOIN course_releases c ON c.id=r.course_release_id WHERE c.workspace_id=$1 AND c.version='1.2.0' AND r.status='active'", [w.workspaceId])).rowCount).toBe(1);
    // Enrollments stay pinned: publication changes only what new learners get.
    const events = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='course_package.installed' ORDER BY sequence", [w.workspaceId])).rows;
    expect(events.map(e => [e.payload.version, e.payload.published, e.payload.automatic])).toEqual([['1.1.0', true, true], ['1.2.0', true, true]]);
  });
  it('publish level is refused (installed for a person instead) for a missing host requirement or a newer SDK', async () => {
    for (const [change, code] of [
      [{ extra: [{ name: 'verifier.json', bytes: Buffer.from('{}'), role: 'host-requirement' }] }, 'AUTO_PUBLISH_REFUSED_HOST_REQUIREMENT'],
      [{ descriptor: (d: Record<string, unknown>) => { d.sdkVersion = '0.6.0'; } }, 'AUTO_PUBLISH_REFUSED_SDK_RANGE'],
    ] as const) {
      const w = await workspace();
      await source(w);
      await w.write('ordering-1.1.0.course.tgz', buildPackage(version('1.1.0'), change as never).bytes);
      expect((await w.put('settings', { level: 'publish', intervalHours: 24, acknowledgePublish: true })).statusCode).toBe(200);
      await runFor(w, new Date(Date.now() + HOUR));
      expect(await row(w), code).toMatchObject({ last_result: 'installed', last_error_code: code });
      expect((await releases(w)).at(-1)).toMatchObject({ version: '1.1.0', status: 'draft', state: 'pending_review' });
    }
    // A blocking problem (newer Core required) installs nothing.
    const w = await workspace();
    await source(w);
    await w.write('ordering-1.1.0.course.tgz', buildPackage(version('1.1.0'), { descriptor: d => { d.minimumCoreVersion = '9.0.0'; } }).bytes);
    expect((await w.put('settings', { level: 'publish', intervalHours: 24, acknowledgePublish: true })).statusCode).toBe(200);
    await runFor(w, new Date(Date.now() + HOUR));
    expect(await row(w)).toMatchObject({ last_result: 'failed', last_error_code: 'CORE_VERSION_TOO_OLD' });
    expect(await releases(w)).toHaveLength(1);
  });
  it('rechecks the saving actor\'s permissions on every run', async () => {
    const w = await workspace();
    await source(w);
    await w.write('ordering-1.1.0.course.tgz', buildPackage(version('1.1.0')).bytes);
    const admin = await user(w.workspaceId, 'admin');
    expect((await w.put('settings', { level: 'install', intervalHours: 24 }, admin)).statusCode).toBe(200);
    await db.query("UPDATE memberships SET role='author' WHERE user_id=$1", [admin.userId]);
    await runFor(w, new Date(Date.now() + HOUR));
    expect(await row(w)).toMatchObject({ last_result: 'failed', last_error_code: 'AUTOMATIC_UPDATE_FORBIDDEN' });
    expect(await releases(w)).toHaveLength(1);
  });
  it('backs off after failures instead of retrying, and is single-flight', async () => {
    const w = await workspace();
    await source(w);
    await rm(path.join(root, w.folder), { recursive: true });
    await db.query('UPDATE course_update_sources SET level=$2,interval_hours=2,next_check_at=NULL WHERE workspace_id=$1', [w.workspaceId, 'check']);
    let now = new Date(Date.now() + HOUR);
    await runFor(w, now);
    expect(await row(w)).toMatchObject({ last_result: 'failed', last_error_code: 'COURSE_PACKAGE_PATH_NOT_FOUND', consecutive_failures: 1 });
    expect((await row(w)).next_check_at.getTime()).toBe(now.getTime() + 4 * HOUR);
    await runFor(w, new Date(now.getTime() + 3 * HOUR));
    expect((await row(w)).consecutive_failures).toBe(1);
    now = new Date(now.getTime() + 4 * HOUR);
    await runFor(w, now);
    expect(await row(w)).toMatchObject({ consecutive_failures: 2 });
    expect((await row(w)).next_check_at.getTime()).toBe(now.getTime() + 8 * HOUR);
    expect(backoffMs(24, 10)).toBe(7 * 24 * HOUR);
    // Another holder of the lock makes a run a no-op.
    const other = await db.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtext('course-core:course-updates'))");
      expect(await runAutomaticUpdates(db, updater, new Date(now.getTime() + 100 * HOUR))).toEqual({ ran: false, attempts: 0 });
      await other.query("SELECT pg_advisory_unlock(hashtext('course-core:course-updates'))");
    } finally { other.release(); }
  });
  it('explains each publish refusal', () => {
    const ok = { problems: [], runtime: { runnable: true }, hostRequirements: [{ status: 'identical' }], core: { satisfied: true }, sdk: { status: 'supported' },
      courseSupplied: { files: [], approvalRequired: [] } } as never;
    expect(publishRefusal(ok)).toBeNull();
    const variant = (patch: Record<string, unknown>) => publishRefusal({ ...(ok as object), ...patch } as never);
    expect(variant({ problems: [{ severity: 'blocking', code: 'X' }] })).toBe('AUTO_PUBLISH_REFUSED_BLOCKING_PROBLEM');
    expect(variant({ runtime: { runnable: false } })).toBe('AUTO_PUBLISH_REFUSED_RUNTIME_CHECK');
    expect(variant({ hostRequirements: [{ status: 'missing' }] })).toBe('AUTO_PUBLISH_REFUSED_HOST_REQUIREMENT');
    expect(variant({ hostRequirements: [{ status: 'different' }] })).toBe('AUTO_PUBLISH_REFUSED_HOST_REQUIREMENT');
    // Files a course brings: already approved bytes may publish; new ones wait for a person.
    expect(variant({ hostRequirements: [{ status: 'course_supplied' }] })).toBeNull();
    expect(variant({ courseSupplied: { files: [], approvalRequired: ['sha256-' + 'a'.repeat(64)] } })).toBe('AUTO_PUBLISH_REFUSED_COURSE_CODE');
    expect(variant({ core: { satisfied: false } })).toBe('AUTO_PUBLISH_REFUSED_CORE_VERSION');
    expect(variant({ sdk: { status: 'newer' } })).toBe('AUTO_PUBLISH_REFUSED_SDK_RANGE');
    expect(variant({ sdk: { status: 'older' } })).toBe('AUTO_PUBLISH_REFUSED_SDK_RANGE');
  });
});

describe('updater permissions', () => {
  it('lets course.write configure and check, observers read, others nothing', async () => {
    const w = await workspace();
    const sessions = Object.fromEntries(await Promise.all(['reviewer', 'instructor', 'observer', 'learner', 'author'].map(async role => [role, await user(w.workspaceId, role)] as const)));
    const outsider = await user((await workspace()).workspaceId, 'owner');
    for (const role of ['reviewer', 'instructor', 'observer']) {
      expect((await app.inject({ url: `/api/admin/courses/${w.catalogId}/updates`, headers: headers(sessions[role]!) })).statusCode, role).toBe(200);
      expect((await w.put('source', { source: { kind: 'path', directoryId: rootId, subpath: w.folder } }, sessions[role])).statusCode, role).toBe(403);
      expect((await w.check(sessions[role])).statusCode, role).toBe(403);
    }
    for (const who of [sessions.learner!, outsider]) expect((await app.inject({ url: `/api/admin/courses/${w.catalogId}/updates`, headers: headers(who) })).statusCode).toBe(403);
    expect((await w.put('source', { source: { kind: 'path', directoryId: rootId, subpath: w.folder } }, sessions.author)).statusCode).toBe(200);
    expect((await w.check(sessions.author)).statusCode).toBe(200);
    expect((await w.get(sessions.author)).permissions).toEqual({ configure: true, install: false, publish: false });
    // Changing the source resets automatic updates to off.
    expect((await w.put('settings', { level: 'check', intervalHours: 24 })).statusCode).toBe(200);
    await source(w);
    expect((await w.get()).settings.level).toBe('off');
  });
});
