import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { digestTeachingArtifact, type TeachingArtifact } from '@course-core/sdk';
import { proposalValidationStatistics } from '@course-core/adaptation';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode, type Actor } from '../src/auth.js';
import { svgRenderer } from '../src/svg-renderer.js';
import { authoredTeachingBankAdapter, authoredVariantBankAdapter, boundedNumericalAdapter, createAdaptationRuntime,
  registryValidationStatistics, stageVerifiedAdaptation, type AdaptationConfiguration } from '../src/adaptation-store.js';
import { largeAdaptiveCourse, largeAdaptiveRegistry } from './large-adaptive-fixture.js';

// Regression for two slow paths on large courses (~2 MB, 39 visuals, 158 recovery profiles), on Core 0.1.38:
// - Approving the adaptation registry validated the whole course once per authored-bank profile
//   (5-7 s per approval in a private acceptance run, 3.9 s on this public fixture).
// - Each recovery (fresh question, or staged proposal then apply) validated the same proposal in full
//   three times (host, admission, application), and copied, hashed and validated the frozen base course
//   again in every numerical port, admission and application (about 8 s against 1.2 s for an ordinary
//   episode privately, 3.5-4 s per fresh question on this fixture).
// The budgets count whole-course and whole-proposal operations, not wall-clock time, so they hold on a
// loaded runner. Real PostgreSQL only.
const origin = 'http://localhost:4310', schema = `recovery_cost_${randomUUID().replaceAll('-', '')}`, workspace = randomUUID();
const adapters = { numeric: boundedNumericalAdapter(), bank: authoredVariantBankAdapter(), teaching: authoredTeachingBankAdapter() };
const runtime = createAdaptationRuntime([adapters.numeric, adapters.bank, adapters.teaching]);
const PROFILES = 158, BANK_PROFILES = Math.floor((PROFILES + 1) / 3);
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { actor: Actor; headers: Record<string, string> }
let admin: Session, releaseId: string; // One large release shared by every test keeps the suite light on a loaded runner.

async function session(role: string): Promise<Session> {
  const actor = { id: randomUUID(), displayName: role };
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [actor.id, `recovery-cost:${actor.id}`, 'Synthetic test user']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, actor.id, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  expect(login.statusCode, login.body).toBe(200);
  return { actor, headers: { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken } };
}
async function release() {
  const course = largeAdaptiveCourse(`recovery-cost-${randomUUID().slice(0, 8)}`, await svgRenderer(), adapters), compiled = compileCourse(course), id = randomUUID();
  expect(JSON.stringify(course).length).toBeGreaterThan(1_900_000);
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,'1.0.0',$4,$5,$6,'published',$7)`,
    [id, workspace, course.id, compiled.digest, JSON.stringify(course), JSON.stringify(compiled.learner), admin.actor.id]);
  return id;
}
const registryRevision = async () => (await app.inject({ url: `/api/admin/releases/${releaseId}/adaptation-registry`, headers: admin.headers })).json().registryRevision as number;
const approve = async (configuration: AdaptationConfiguration, expectedRegistryRevision?: number) => {
  const expected = expectedRegistryRevision ?? await registryRevision();
  return app.inject({ method: 'POST', url: `/api/admin/releases/${releaseId}/adaptation-registry`, headers: admin.headers, payload: { expectedRegistryRevision: expected, configuration } });
};
const bankWork = async <T>(work: () => Promise<T>) => {
  const before = registryValidationStatistics().bankCourseValidations, result = await work();
  return { result, validations: registryValidationStatistics().bankCourseValidations - before };
};
type Counters = ReturnType<typeof proposalValidationStatistics>;
async function counted<T>(work: () => Promise<T>) {
  const before: Counters = proposalValidationStatistics(), started = performance.now(), result = await work(), after = proposalValidationStatistics();
  return { result, ms: performance.now() - started, sdk: after.sdkValidations - before.sdkValidations, reused: after.proposalReuses - before.proposalReuses,
    courseValidations: after.courseValidations - before.courseValidations, courseDigests: after.courseDigests - before.courseDigests };
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  if (process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL) throw new Error('Use only an explicit disposable TEST_DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/course_core_(ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw new Error('Disposable loopback PostgreSQL test database required.');
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: runtime });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'recovery-cost', 'Recovery cost']);
  admin = await session('owner');
  releaseId = await release();
}, 60000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

describe('registry approval of a large course', () => {
  it(`validates the course with every authored bank together once, not once per bank profile (${BANK_PROFILES})`, async () => {
    const configuration = largeAdaptiveRegistry(adapters, PROFILES);
    expect(configuration.profiles.filter(p => p.bank).length).toBe(BANK_PROFILES);
    const approved = await bankWork(() => approve(configuration));
    expect(approved.result.statusCode, approved.result.body).toBe(200);
    expect(approved.validations).toBe(1);
    const read = await app.inject({ url: `/api/admin/releases/${releaseId}/adaptation-registry`, headers: admin.headers });
    expect(read.json()).toMatchObject({ registryRevision: approved.result.json().registryRevision, configured: true });
  }, 120000);

  it('still rejects a single invalid bank entry among many valid ones, with the same code', async () => {
    const configuration = largeAdaptiveRegistry(adapters, PROFILES);
    const bad = configuration.profiles.filter(p => p.bank)[17]!;
    (bad.bank![2]!.assessment as { objectiveIds: string[] }).objectiveIds = ['unknown-objective'];
    // The batch fails and is split until only the invalid profile remains, so the work stays logarithmic.
    const versions = async () => (await db.query('SELECT count(*)::int AS n FROM adaptation_registry_versions WHERE course_release_id=$1', [releaseId])).rows[0].n as number;
    const stored = await versions();
    const rejected = await bankWork(() => approve(configuration));
    expect(rejected.result.statusCode).toBe(409); expect(rejected.result.json().error).toBe('BANK_PROFILE_INVALID');
    expect(rejected.validations).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(BANK_PROFILES)) + 1);
    // An entry that duplicates a course assessment ID is rejected too.
    const duplicate = largeAdaptiveRegistry(adapters, PROFILES);
    duplicate.profiles.filter(p => p.bank)[40]!.bank![0]!.assessment.id = 'min-b';
    const again = await approve(duplicate);
    expect(again.statusCode).toBe(409); expect(again.json().error).toBe('BANK_PROFILE_INVALID');
    expect(await versions()).toBe(stored);
  }, 120000);

  it('accepts banks that reuse each other\'s entry IDs, which each pass on their own', async () => {
    const configuration = largeAdaptiveRegistry(adapters, PROFILES);
    const banks = configuration.profiles.filter(p => p.bank);
    banks[3]!.bank![0]!.assessment.id = banks[30]!.bank![0]!.assessment.id;
    const approved = await bankWork(() => approve(configuration));
    expect(approved.result.statusCode, approved.result.body).toBe(200);
    expect(approved.validations).toBeGreaterThan(1);
  }, 120000);
});

describe('recovery on a large course', () => {
  async function enrolled() {
    expect((await approve(largeAdaptiveRegistry(adapters, PROFILES))).statusCode).toBe(200);
    const learner = await session('learner');
    const enrollment = await app.inject({ method: 'POST', url: '/api/enrollments', headers: learner.headers, payload: { releaseId } });
    expect(enrollment.statusCode, enrollment.body).toBe(200);
    return { learner, enrollmentId: enrollment.json().id as string };
  }
  const revision = async (enrollmentId: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [enrollmentId])).rows[0]!.revision);
  const planRevision = async (s: Session, enrollmentId: string) =>
    (await app.inject({ url: `/api/enrollments/${enrollmentId}/adaptation`, headers: s.headers })).json().planRevision as number;

  it('a fresh question validates its proposal once and never re-validates or re-hashes the base course', async () => {
    const { learner, enrollmentId } = await enrolled();
    const issued = await app.inject({ method: 'POST', url: `/api/enrollments/${enrollmentId}/challenges`, headers: learner.headers,
      payload: { expectedRevision: await revision(enrollmentId), idempotencyKey: randomUUID(), episodeId: 'min', assessmentId: 'min-b', mode: 'independent' } });
    expect(issued.statusCode, issued.body).toBe(200);
    const wrong = await app.inject({ method: 'POST', url: `/api/enrollments/${enrollmentId}/answers`, headers: learner.headers,
      payload: { expectedRevision: await revision(enrollmentId), idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer: 99 } });
    expect(wrong.json().result.passed).toBe(false);
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const plan = await planRevision(learner, enrollmentId), expectedRevision = await revision(enrollmentId);
      const fresh = await counted(() => app.inject({ method: 'POST', url: `/api/enrollments/${enrollmentId}/adaptation/fresh-question`, headers: learner.headers,
        payload: { expectedRevision, expectedPlanRevision: plan, idempotencyKey: randomUUID(), episodeId: 'min', objectiveId: 'minimum', familyId: 'select', mode: 'independent' } }));
      expect(fresh.result.statusCode, fresh.result.body).toBe(200);
      expect(fresh.result.json().planRevision).toBe(i + 1);
      // One full SDK validation of the new proposal; admission and application reuse it.
      expect([fresh.sdk, fresh.reused]).toEqual([1, 2]);
      // The frozen base course is validated and hashed at most once per process (the first adaptation state).
      expect(fresh.courseDigests).toBeLessThanOrEqual(i === 0 ? 1 : 0);
      expect(fresh.courseValidations).toBeLessThanOrEqual(i === 0 ? 1 : 0);
      timings.push(Math.round(fresh.ms));
      const answered = await app.inject({ method: 'POST', url: `/api/enrollments/${enrollmentId}/answers`, headers: learner.headers,
        payload: { expectedRevision: await revision(enrollmentId), idempotencyKey: randomUUID(), challengeId: fresh.result.json().challengeId, answer: 999 } });
      expect(answered.json().result.passed).toBe(false);
    }
    console.info(`fresh-question on a ~2 MB course with ${PROFILES} profiles: ${timings.join(', ')} ms`);
  }, 120000);

  it('a staged proposal is validated once at staging; applying it reuses that validation', async () => {
    const { learner, enrollmentId } = await enrolled();
    const entry = largeAdaptiveRegistry(adapters, PROFILES).profiles.find(p => p.id === 'teaching-5')!.teachingBank![0]!;
    expect(entry.kind).toBe('explanation');
    const artifactId = `artifact-${randomUUID()}`, operationId = `operation-${randomUUID()}`;
    const draft = { id: artifactId, kind: 'explanation', markdown: (entry as { markdown: string }).markdown, objectiveIds: entry.objectiveIds, sourceRefs: entry.sourceRefs,
      generator: { id: 'teaching-creator', version: '1.0.0' } };
    const artifact = { ...draft, digest: await digestTeachingArtifact(draft as TeachingArtifact) } as TeachingArtifact;
    const summary = (await app.inject({ url: `/api/enrollments/${enrollmentId}/adaptation`, headers: learner.headers })).json();
    const staged = await counted(() => stageVerifiedAdaptation(db, admin.actor, { enrollmentId, expectedRevision: 1, expectedPlanRevision: summary.planRevision,
      idempotencyKey: randomUUID(), proposal: { schemaVersion: 1, id: `proposal-${randomUUID()}`, baseCourseDigest: summary.baseCourseDigest,
        expectedPlanRevision: summary.planRevision, expectedPlanDigest: summary.planDigest, rationale: 'A reviewed note after a missed check.',
        artifacts: [artifact], operations: [{ id: operationId, type: 'append_teaching', episodeId: 'min', artifactId }] },
      profiles: [{ operationId, profileId: 'teaching-5' }] } as Parameters<typeof stageVerifiedAdaptation>[2], runtime));
    expect(staged.sdk).toBe(1);
    const applied = await counted(() => app.inject({ method: 'POST', url: `/api/enrollments/${enrollmentId}/adaptation/${staged.result.proposalId}/apply`, headers: admin.headers,
      payload: { expectedRevision: staged.result.revision, expectedPlanRevision: staged.result.planRevision, idempotencyKey: randomUUID() } }));
    expect(applied.result.statusCode, applied.result.body).toBe(200);
    expect([applied.sdk, applied.reused, applied.courseValidations, applied.courseDigests]).toEqual([0, 2, 0, 0]);
    const view = await app.inject({ url: `/api/enrollments/${enrollmentId}`, headers: learner.headers });
    expect(view.statusCode).toBe(200);
    expect(JSON.stringify(view.json().course)).toContain((entry as { markdown: string }).markdown);
  }, 120000);
});
