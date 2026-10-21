import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CourseManifest } from '@course-core/sdk';
import type { GradeReport } from '@course-core/sandbox';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { issueLoginCode } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { declarativeActivityRuntime, frameScriptIntegrity } from '../src/activity-runtime.js';
import type { CodeSandbox } from '../src/code-evaluator.js';
import { buildPackage } from './course-package-fixture.js';
import { sandboxedActivity, sandboxedDeclaration, sandboxedActivityRuntime, activityCourse, SANDBOX_ID } from './activity-fixture.js';

// Real HTTP and PostgreSQL: a course package brings its own sandboxed activity script and its own
// hidden code cases, and Core runs them only after an owner/admin approves exactly those bytes.
const origin = 'http://127.0.0.1:4393', schema = `course_supplied_${randomUUID().replaceAll('-', '')}`;
type App = Awaited<ReturnType<typeof createServer>>;
let testDatabase: TestDatabase | undefined, db: Database, app: App, workspaceId: string;
const servers: App[] = [];
interface Session { userId: string; cookie: string; csrf: string }
const sessions: Record<string, Session> = {};

const SCRIPT = `(() => { "use strict"; const main = document.getElementById("activity"); const p = document.createElement("p");
  p.textContent = "Course-supplied activity"; main.append(p); window.courseActivity.onInit(() => {}); })();`;
const FIXTURES = Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'supplied-lab-code', version: '1.0.0', fixtures: [{ id: 'double', language: 'python',
  cases: [{ id: 'one', input: 2, expected: 4 }, { id: 'two', input: -3, expected: -6 }] }] }));
const integrityOf = (bytes: Buffer) => `sha256-${createHash('sha256').update(bytes).digest('hex')}`;

/** Grades by matching the exact source: "double" passes, anything else fails. No Python runs here. */
const graded: string[] = [];
const sandbox: CodeSandbox = {
  readiness: async () => ({ ready: true, reason: 'ready' }),
  grade: async ({ source, cases }) => {
    graded.push(source);
    const passed = source.includes('return x * 2');
    return { status: 'graded', passed, cases: cases.map(c => ({ id: c.id, passed, reason: passed ? 'match' : 'mismatch' })), sourceDigest: 'a'.repeat(64),
      durationMs: 1, outputBytes: 2, batchesCompleted: 1, runtime: { protocol: 'python-json-v1', image: 'synthetic' } } satisfies GradeReport;
  },
};

/** A course whose sandboxed activity and code item are both supplied by its own package. */
function suppliedCourse(version = '1.0.0', script = SCRIPT): CourseManifest {
  const course = activityCourse(sandboxedActivity(), {});
  course.id = 'supplied-lab'; course.title = 'Supplied lab'; course.version = version;
  // activityCourse declares an evaluator extension this course does not use.
  course.extensions = course.extensions.filter(row => row.execution !== 'server');
  course.extensions.push({ ...sandboxedDeclaration(script), entrypoint: 'activities/supplied.js' }, {
    id: 'supplied-lab-code', version: '1.0.0', integrity: integrityOf(FIXTURES), execution: 'server', entrypoint: 'fixtures/supplied-lab.code-fixtures.json',
    platforms: ['web'], capabilities: ['assessment.evaluate'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Type Python code; results are text.' } });
  course.assessments.push({ id: 'double-code', type: 'code', objectiveIds: ['minimum'], familyId: 'code', prompt: 'Write solve(x) returning twice x.',
    language: 'python', starterCode: 'def solve(x):\n    return x\n', grading: { evaluatorId: 'supplied-lab-code', fixtureRef: 'double' } });
  course.chapters[0]!.episodes[0]!.blocks.push({ id: 'double-code-block', type: 'assessment', assessmentId: 'double-code' });
  return course;
}
const suppliedPackage = (course = suppliedCourse(), script = SCRIPT) => buildPackage(course, { extra: [
  { name: 'supplied.js', bytes: Buffer.from(script), role: 'other' },
  { name: 'supplied-lab.code-fixtures.json', bytes: FIXTURES, role: 'host-requirement' }] });

async function session(role: string, workspace = workspaceId): Promise<Session> {
  const userId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [userId, `supplied:${userId}`, `${role} example`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, userId, role]);
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(response.statusCode, response.body).toBe(200);
  return { userId, cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: response.json().csrfToken };
}
const headers = (who: Session) => ({ cookie: who.cookie, origin, 'x-csrf-token': who.csrf });
const inspect = (who: Session, bytes: Buffer, on = app, workspace = workspaceId) => on.inject({ method: 'POST', url: `/api/admin/course-packages/inspect?workspaceId=${workspace}`,
  headers: { ...headers(who), 'content-type': 'application/gzip' }, payload: bytes });
const install = (who: Session, digest: string, extra: Record<string, unknown> = {}, on = app, workspace = workspaceId) => on.inject({ method: 'POST',
  url: `/api/admin/course-packages/${digest}/install`, headers: headers(who), payload: { workspaceId: workspace, idempotencyKey: `install-${randomUUID()}`, ...extra } });
const frame = (on = app) => on.inject({ method: 'GET', url: `/api/activity-frames/${SANDBOX_ID}/1.0.0` });
async function server(options: { codeSandbox?: CodeSandbox; installedExtensions?: Parameters<typeof createServer>[1]['installedExtensions'] } = {}) {
  const created = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [declarativeActivityRuntime()], ...options });
  servers.push(created);
  return created;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await server({ codeSandbox: sandbox });
  workspaceId = randomUUID();
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, 'supplied', 'Supplied']);
  for (const role of ['owner', 'admin', 'author', 'learner']) sessions[role] = await session(role);
}, 60000);
afterAll(async () => {
  for (const created of servers) await created.close();
  await db?.end(); await testDatabase?.drop();
});

describe('course-supplied extensions', () => {
  it('lists the files a course brings, and installs only with approval of exactly those bytes', async () => {
    const pkg = suppliedPackage();
    const preview = await inspect(sessions.admin!, pkg.bytes);
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json();
    expect(body.runtime).toEqual({ runnable: true });
    expect(body.courseSupplied.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ extensionId: SANDBOX_ID, kind: 'sandboxed_web', member: 'supplied.js', status: 'approvable' }),
      expect.objectContaining({ extensionId: 'supplied-lab-code', kind: 'code_fixtures', member: 'supplied-lab.code-fixtures.json', status: 'approvable' })]));
    expect(body.courseSupplied.approvalRequired.sort()).toEqual([frameScriptIntegrity(SCRIPT), integrityOf(FIXTURES)].sort());
    // The host requirement is met by the course's own copy, so it is not reported as missing.
    expect(body.hostRequirements).toEqual([expect.objectContaining({ name: 'supplied-lab.code-fixtures.json', status: 'course_supplied' })]);
    expect(body.problems.map((p: { code: string }) => p.code)).toContain('COURSE_SUPPLIED_APPROVAL_REQUIRED');
    expect(body.problems.map((p: { code: string }) => p.code)).not.toContain('HOST_REQUIREMENT_MISSING');

    // Nothing runs before approval: no approval, or approval of only part of the files, installs nothing.
    for (const extra of [{}, { approveCourseSupplied: { integrities: [frameScriptIntegrity(SCRIPT)] } },
      { approveCourseSupplied: { integrities: [frameScriptIntegrity(SCRIPT), 'sha256-' + 'f'.repeat(64)] } }]) {
      const refused = await install(sessions.admin!, pkg.sha256, extra);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ error: 'COURSE_SUPPLIED_APPROVAL_REQUIRED', details: { integrities: expect.any(Array) } });
    }
    expect((await db.query("SELECT count(*)::int AS n FROM course_releases WHERE course_key='supplied-lab'")).rows[0].n).toBe(0);
    expect((await frame()).statusCode).toBe(404);

    const installed = await install(sessions.admin!, pkg.sha256, { approveCourseSupplied: { integrities: body.courseSupplied.approvalRequired },
      approveAndPublish: { confirmVersion: '1.0.0' } });
    expect(installed.statusCode, installed.body).toBe(200);
    const releaseId = installed.json().releaseId as string;
    expect(installed.json().installation.state).toBe('published');
    const rows = (await db.query('SELECT extension_id,kind,integrity,approved_by FROM course_supplied_extensions WHERE release_id=$1 ORDER BY extension_id', [releaseId])).rows;
    expect(rows).toEqual([
      { extension_id: 'supplied-lab-code', kind: 'code_fixtures', integrity: integrityOf(FIXTURES), approved_by: sessions.admin!.userId },
      { extension_id: SANDBOX_ID, kind: 'sandboxed_web', integrity: frameScriptIntegrity(SCRIPT), approved_by: sessions.admin!.userId }]);
    const event = (await db.query("SELECT payload FROM learning_events WHERE event_type='course_package.installed' AND payload->>'releaseId'=$1", [releaseId])).rows[0];
    expect(event.payload.courseSupplied).toHaveLength(2);
    await expect(db.query('UPDATE course_supplied_extensions SET version=version WHERE release_id=$1', [releaseId])).rejects.toThrow(/immutable/);

    // The approved script is served only in the sandboxed frame, under Core's frame CSP.
    const served = await frame();
    expect(served.statusCode).toBe(200);
    expect(served.body).toContain('Course-supplied activity');
    expect(served.headers['content-security-policy']).toContain("connect-src 'none'");

    // A learner runs the activity and is graded by Core's own evaluator against the supplied cases.
    const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(sessions.learner!), payload: { releaseId } });
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const enrollment = enrolled.json().id as string;
    const launched = await app.inject({ method: 'POST', url: `/api/enrollments/${enrollment}/activities`, headers: headers(sessions.learner!),
      payload: { episodeId: 'min', blockId: 'min-activity', target: 'web_desktop' } });
    expect(launched.statusCode, launched.body).toBe(200);
    expect(launched.json()).toMatchObject({ mode: 'run' });
    const answer = async (source: string) => {
      const snapshot = (await app.inject({ method: 'GET', url: `/api/enrollments/${enrollment}`, headers: headers(sessions.learner!) })).json();
      const issued = await app.inject({ method: 'POST', url: `/api/enrollments/${enrollment}/challenges`, headers: headers(sessions.learner!),
        payload: { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), episodeId: 'min', assessmentId: 'double-code', mode: 'practice' } });
      expect(issued.statusCode, issued.body).toBe(200);
      const next = (await app.inject({ method: 'GET', url: `/api/enrollments/${enrollment}`, headers: headers(sessions.learner!) })).json();
      const graded = await app.inject({ method: 'POST', url: `/api/enrollments/${enrollment}/answers`, headers: headers(sessions.learner!),
        payload: { expectedRevision: next.revision, idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer: source } });
      expect(graded.statusCode, graded.body).toBe(200);
      return graded.json();
    };
    expect(await answer('def solve(x):\n    return x * 2\n')).toMatchObject({ result: { passed: true, execution: { passedCases: 2 } } });
    expect(await answer('def solve(x):\n    return x\n')).toMatchObject({ result: { passed: false } });
    expect(graded).toHaveLength(2);
  });

  it('loads approved files again after a restart, and a second install of the same bytes needs no approval', async () => {
    const restarted = await server({ codeSandbox: sandbox });
    expect((await frame(restarted)).statusCode).toBe(200);
    const other = randomUUID();
    await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [other, 'supplied-other', 'Other']);
    const otherAdmin = await session('admin', other);
    const pkg = suppliedPackage(suppliedCourse('1.0.0'));
    const preview = (await inspect(otherAdmin, pkg.bytes, restarted, other)).json();
    expect(preview.courseSupplied.approvalRequired).toEqual([]);
    expect(preview.courseSupplied.files.every((file: { status: string }) => file.status === 'installed')).toBe(true);
    const installed = await install(otherAdmin, pkg.sha256, {}, restarted, other);
    expect(installed.statusCode, installed.body).toBe(200);
  });

  it('never replaces an installed extension of the same id, and refuses bytes that do not match the declaration', async () => {
    // A host-installed runtime with the same id but other bytes wins; the course's file is unavailable.
    const hostScript = SCRIPT.replace('Course-supplied', 'Host-installed');
    const host = await server({ codeSandbox: sandbox, installedExtensions: [declarativeActivityRuntime(), sandboxedActivityRuntime(hostScript)] });
    const otherScript = SCRIPT.replace('activity', 'activity, version two');
    const pkg = suppliedPackage(suppliedCourse('1.1.0', otherScript), otherScript);
    const preview = (await inspect(sessions.owner!, pkg.bytes, host)).json();
    expect(preview.courseSupplied.files).toEqual(expect.arrayContaining([expect.objectContaining({ extensionId: SANDBOX_ID, status: 'unavailable', code: 'EXTENSION_ID_CONFLICT' })]));
    expect(preview.runtime.runnable).toBe(false);
    expect(preview.installable).toBe(false);
    expect((await frame(host)).body).toContain('Host-installed');

    // A listed member whose bytes are not the declared integrity is not the course's file at all.
    const tampered = buildPackage(suppliedCourse('1.2.0'), { extra: [{ name: 'supplied.js', bytes: Buffer.from(SCRIPT + ' '), role: 'other' },
      { name: 'supplied-lab.code-fixtures.json', bytes: FIXTURES, role: 'host-requirement' }] });
    const tamperedPreview = (await inspect(sessions.owner!, tampered.bytes)).json();
    expect(tamperedPreview.courseSupplied.files.map((file: { kind: string }) => file.kind)).toEqual(['code_fixtures']);
  });

  it('cannot use hidden code cases on a host without a grading sandbox, and only owners and admins install', async () => {
    const bare = await server();
    const pkg = suppliedPackage(suppliedCourse('2.0.0'));
    const preview = (await inspect(sessions.owner!, pkg.bytes, bare)).json();
    expect(preview.courseSupplied.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'code_fixtures', status: 'unavailable', code: 'NO_SANDBOX' })]));
    expect(preview.problems.map((p: { code: string }) => p.code)).toContain('COURSE_SUPPLIED_UNAVAILABLE');
    expect(preview.installable).toBe(false);
    const author = await inspect(sessions.author!, pkg.bytes);
    expect(author.statusCode).toBe(403);
  });
});
