import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { digestJson as sdkDigest, type CourseManifest } from '@course-core/sdk';
import { proposalValidationStatistics, clearValidatedProposals } from '@course-core/adaptation';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { issueLoginCode } from '../src/auth.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { initialPolicy } from '../src/policy-adapter.js';
import type { Enrollment, Release } from '../src/repository.js';
import { boundedNumericalAdapter, createAdaptationRuntime, deliveredCourseStatistics, resolveEnrollmentCourse } from '../src/adaptation-store.js';
import { fixture as baseFixture } from './fixture.js';

// Regression for per-request revalidation of every applied adaptation: on Core 0.1.34 each
// enrollment request re-ran SDK proposal validation against the whole course once per
// applied adaptation, so request time grew with every recovery. On Core 0.1.35 every
// request of an adapted enrollment still copied, hashed, validated, projected and compiled
// the whole course again, so request time jumped at the first recovery. Real PostgreSQL only.
const schema = `course_scaling_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4310', workspace = randomUUID();
const numeric = boundedNumericalAdapter(), runtime = createAdaptationRuntime([numeric]);
const RECOVERIES = 10;
let db: Database, rootDb: Database, app: Awaited<ReturnType<typeof createServer>>;
type Session = { id: string; cookie: string; csrf: string };
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
type Statistics = ReturnType<typeof proposalValidationStatistics>;
async function counted<T>(work: () => Promise<T>) {
  const before: Statistics = proposalValidationStatistics(), built = deliveredCourseStatistics().builds, result = await work(), after = proposalValidationStatistics();
  return { result, sdk: after.sdkValidations - before.sdkValidations, retained: after.retainedValidations - before.retainedValidations,
    /** Whole-course work: projections of the adapted course, delivered-course builds, course hashes and validations. */
    course: { projections: after.projections - before.projections, deliveries: deliveredCourseStatistics().builds - built,
      digests: after.courseDigests - before.courseDigests, validations: after.courseValidations - before.courseValidations } };
}
const NONE = { projections: 0, deliveries: 0, digests: 0, validations: 0 };
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, `scaling:${id}`, 'Synthetic test user']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(login.statusCode, login.body).toBe(200);
  return { id, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: login.json().csrfToken };
}
/** Public synthetic course, padded with reviewed text so full-course validation is not free. */
function course(): CourseManifest {
  const c = baseFixture(); c.id = `scaling-${randomUUID()}`;
  c.policy.work = { additionalMinutes: 200, additionalEpisodes: 100, remediationCyclesPerConcept: 100 };
  const extension = (id: string, capability: string) => ({ id, version: '1.0.0', platforms: ['web' as const], execution: 'server' as const, capabilities: [capability],
    entrypoint: `extensions/${id}.js`, integrity: `sha256-${numeric.implementationDigest}`, accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Numerical ordering tasks.' } });
  c.extensions = [extension('scaling-generator', 'teaching.generate'), extension('scaling-verifier', 'teaching.verify')];
  c.sources = ['teaching', 'reference'].map(id => ({ id, title: 'Public synthetic author reference', url: `urn:example:${id}`, reviewedAt: '2026-01-01T00:00:00Z' }));
  const filler = 'Compare each value with every other member of the set before naming the maximum. '.repeat(8);
  for (let i = 0; i < 60; i++) c.chapters[0]!.episodes[1]!.blocks.push({ id: `reading-${i}`, type: 'text', markdown: `${i + 1}. ${filler}` });
  c.adaptation = { schemaVersion: 1, sourceRefs: ['teaching', 'reference'], profileFieldIds: [],
    targets: [{ episodeId: 'min', objectiveIds: ['minimum'], allowedOperations: ['add_assessment_variant'], replaceableBlockIds: [] }],
    families: [{ familyId: 'select', canonicalAssessmentId: 'min-b', generatorIds: ['creator'], verifierIds: ['checker'], numericalRecipeIds: ['recipe'], maxVariantsPerPlan: 50 }],
    generators: [{ id: 'creator', version: '1.0.0', extensionId: 'scaling-generator', sourceRefs: ['teaching'], artifactKinds: ['assessment_variant'] }],
    verifiers: [{ id: 'checker', version: '1.0.0', extensionId: 'scaling-verifier', sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], requiredCheckIds: ['reference'] }],
    numericalRecipes: [{ id: 'recipe', version: '1.0.0', sourceRefs: ['teaching'], promptTemplate: 'Choose the smaller of {{a}} and {{b}}.',
      variables: [{ name: 'a', minimum: 1, maximum: 50, integer: true }, { name: 'b', minimum: 51, maximum: 100, integer: true }],
      expression: { type: 'binary', operator: 'min', left: { type: 'variable', name: 'a' }, right: { type: 'variable', name: 'b' } }, maxNodes: 3, maxDepth: 2, maxAbsoluteValue: 1000,
      referenceCheck: { verifierId: 'checker', verifierVersion: '1.0.0', checkId: 'reference', absoluteTolerance: 0 } }],
    limits: { maxOperations: 5, maxArtifacts: 5, maxArtifactBytes: 30000, maxPlannedMinutesPerAssignment: 5, maxAdditionalEpisodesPerAssignment: 1, allowedClassifications: ['required'] } };
  return c;
}
async function enrolled() {
  const admin = await session('admin'), learner = await session('learner'), c = course(), compiled = compileCourse(c), releaseId = randomUUID(), enrollmentId = randomUUID();
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,'1.0.0',$4,$5,$6,'published',$7)`,
    [releaseId, workspace, c.id, compiled.digest, JSON.stringify(c), JSON.stringify(compiled.learner), admin.id]);
  const configuration = { authorizationMinutes: 10,
    verifiers: [{ id: 'checker', version: '1.0.0', implementationDigest: numeric.implementationDigest, sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], checkIds: ['reference'] }],
    profiles: [{ id: 'numeric-profile', episodeId: 'min', operation: 'add_assessment_variant', generatorId: 'creator', verifierId: 'checker', adapterId: numeric.id,
      adapterDigest: numeric.implementationDigest, canonicalAssessmentId: 'min-b', templateId: 'recipe', classification: 'required', plannedMinutes: 2, additionalEpisodes: 1 }] };
  const approved = await app.inject({ method: 'POST', url: `/api/admin/releases/${releaseId}/adaptation-registry`, headers: headers(admin), payload: { expectedRegistryRevision: 0, configuration } });
  expect(approved.statusCode, approved.body).toBe(200);
  const policy = initialPolicy(c, enrollmentId, learner.id, new Date().toISOString());
  await db.query('INSERT INTO enrollments(id,workspace_id,course_release_id,user_id,policy) VALUES($1,$2,$3,$4,$5)', [enrollmentId, workspace, releaseId, learner.id, JSON.stringify(c.policy)]);
  await db.query('INSERT INTO policy_states(enrollment_id,policy_revision,ledger_revision,snapshot) VALUES($1,$2,$3,$4)', [enrollmentId, policy.policyRevision, policy.ledgerRevision, JSON.stringify(policy)]);
  return { learner, releaseId, enrollmentId };
}
type Enrolled = Awaited<ReturnType<typeof enrolled>>;
const revision = async (f: Enrolled) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [f.enrollmentId])).rows[0]!.revision);
const snapshot = (f: Enrolled) => app.inject({ url: `/api/enrollments/${f.enrollmentId}`, headers: headers(f.learner) });
async function answer(f: Enrolled, challengeId: string, value: number | string) {
  const response = await app.inject({ method: 'POST', url: `/api/enrollments/${f.enrollmentId}/answers`, headers: headers(f.learner),
    payload: { expectedRevision: await revision(f), idempotencyKey: randomUUID(), challengeId, answer: value } });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}
async function recovery(f: Enrolled) {
  const plan = (await app.inject({ url: `/api/enrollments/${f.enrollmentId}/adaptation`, headers: headers(f.learner) })).json().planRevision;
  const response = await app.inject({ method: 'POST', url: `/api/enrollments/${f.enrollmentId}/adaptation/fresh-question`, headers: headers(f.learner),
    payload: { expectedRevision: await revision(f), expectedPlanRevision: plan, idempotencyKey: randomUUID(), episodeId: 'min', objectiveId: 'minimum', familyId: 'select', mode: 'independent' } });
  expect(response.statusCode, response.body).toBe(200); return response.json();
}
async function resolved(f: Enrolled) {
  return transaction(db, async client => {
    const enrollment = (await client.query<Enrollment>('SELECT * FROM enrollments WHERE id=$1', [f.enrollmentId])).rows[0]!;
    const release = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1', [f.releaseId])).rows[0]!;
    return resolveEnrollmentCourse(client, enrollment, release);
  });
}
async function withRecoveries(n: number) {
  const f = await enrolled();
  const issued = await app.inject({ method: 'POST', url: `/api/enrollments/${f.enrollmentId}/challenges`, headers: headers(f.learner),
    payload: { expectedRevision: await revision(f), idempotencyKey: randomUUID(), episodeId: 'min', assessmentId: 'min-b', mode: 'independent' } });
  expect(issued.statusCode, issued.body).toBe(200);
  expect((await answer(f, issued.json().challengeId, 99)).result.passed).toBe(false);
  const steps: { recovery: number; recoveryRetained: number; answer: number; snapshot: number; snapshotRetained: number }[] = [];
  const work: { answer: typeof NONE; snapshot: typeof NONE }[] = [];
  for (let i = 0; i < n; i++) {
    const fresh = await counted(() => recovery(f));
    expect(fresh.result.planRevision).toBe(i + 1);
    const wrong = await counted(() => answer(f, fresh.result.challengeId, 999));
    expect(wrong.result.result.passed).toBe(false);
    const read = await counted(() => snapshot(f));
    expect(read.result.statusCode, read.result.body).toBe(200);
    expect(read.result.json().planRevision).toBe(i + 1);
    steps.push({ recovery: fresh.sdk, recoveryRetained: fresh.retained, answer: wrong.sdk, snapshot: read.sdk, snapshotRetained: read.retained });
    work.push({ answer: wrong.course, snapshot: read.course });
  }
  return { f, steps, work };
}
async function storedState(f: Enrolled) {
  return (await db.query('SELECT snapshot FROM adaptation_states WHERE enrollment_id=$1', [f.enrollmentId])).rows[0]!.snapshot;
}
async function store(f: Enrolled, snapshot: unknown) {
  await db.query('UPDATE adaptation_states SET snapshot=$2 WHERE enrollment_id=$1', [f.enrollmentId, JSON.stringify(snapshot)]);
}
/** Recompute the unkeyed snapshot digest, as someone with direct database write access could. */
async function resealed(state: Record<string, unknown>, change: (state: any) => void) {
  const copy = structuredClone(state); change(copy);
  const { digest: _digest, ...data } = copy; copy.digest = await sdkDigest(data); return copy;
}

beforeAll(async () => {
  if (process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL) throw new Error('Use only an explicit disposable TEST_DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/(course_core_ci|course_core_test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Disposable loopback PostgreSQL test database required.');
  rootDb = createDatabase(url.toString()); await rootDb.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-csearch_path=${schema}`); db = createDatabase(url.toString());
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: runtime });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'scaling', 'Adaptation scaling']);
}, 30000);
afterAll(async () => { await app?.close(); await db?.end(); if (rootDb) { await rootDb.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await rootDb.end(); } });

describe('applied adaptations are not revalidated on every request', () => {
  it(`validation work per request stays constant across ${RECOVERIES} recoveries`, async () => {
    const { steps } = await withRecoveries(RECOVERIES);
    // Each recovery validates only its own new proposal, once in full before staging; admission and
    // application reuse that result for the same bytes.
    for (const step of steps) expect(step).toEqual({ recovery: 1, recoveryRetained: 0, answer: 0, snapshot: 0, snapshotRetained: 0 });
  }, 120000);

  it('after a recovery the adapted course is built once; later requests do no whole-course work', async () => {
    const { f, work } = await withRecoveries(4);
    // The first read of each new adaptation state (here the answer) projects and delivers it once,
    // reusing the frozen, already-validated base course; reads after that reuse the result.
    for (const step of work) expect(step).toEqual({ answer: { projections: 1, deliveries: 1, digests: 0, validations: 0 }, snapshot: NONE });
    for (let i = 0; i < 5; i++) {
      const read = await counted(() => snapshot(f));
      expect(read.result.statusCode).toBe(200); expect(read.course).toEqual(NONE);
      const summary = await counted(() => app.inject({ url: `/api/enrollments/${f.enrollmentId}/adaptation`, headers: headers(f.learner) }));
      expect(summary.result.statusCode).toBe(200); expect(summary.course).toEqual(NONE);
    }
    const expectedRevision = await revision(f);
    const issued = await counted(() => app.inject({ method: 'POST', url: `/api/enrollments/${f.enrollmentId}/challenges`, headers: headers(f.learner),
      payload: { expectedRevision, idempotencyKey: randomUUID(), episodeId: 'min', assessmentId: 'min-a', mode: 'independent' } }));
    expect(issued.result.statusCode, issued.result.body).toBe(200); expect(issued.course).toEqual(NONE);
    const answered = await counted(() => answer(f, issued.result.json().challengeId, 'five'));
    expect(answered.result.result.passed).toBe(false); expect(answered.course).toEqual(NONE);
  }, 120000);

  it('another API process validates each stored adaptation once, then reuses it; the view is identical', async () => {
    const { f } = await withRecoveries(4), before = await resolved(f);
    clearValidatedProposals(); // As a freshly started instance that never saw these adaptations.
    const cold = await counted(() => snapshot(f));
    expect(cold.result.statusCode, cold.result.body).toBe(200);
    expect(cold.retained).toBe(4);
    const warm = await counted(() => snapshot(f));
    expect(warm.result.statusCode).toBe(200); expect(warm.sdk).toBe(0);
    expect(warm.result.json()).toEqual(cold.result.json());
    const after = await resolved(f);
    expect(after).toEqual(before);
    // Identical with and without recorded views, including key order, and the shared learner
    // bundle is exactly what compiling the delivered (variant-joined) course produces.
    clearValidatedProposals();
    const uncached = await resolved(f);
    expect(uncached.server_bundle).not.toBe(after.server_bundle);
    expect(JSON.stringify(uncached)).toBe(JSON.stringify(after));
    expect(after.learner_bundle).toEqual(compileCourse(after.server_bundle).learner);
    expect(after.server_bundle.gates.find(g => g.id === 'min-gate')!.assessmentIds.length).toBe(2 + 4);
  }, 60000);

  it('a tampered stored adaptation is rejected although the original is recorded as validated', async () => {
    const { f } = await withRecoveries(3), original = await storedState(f);
    expect((await snapshot(f)).statusCode).toBe(200); // Every record is warm for the original bytes.
    const unsealed = structuredClone(original); unsealed.admissions[1].proposal.rationale = 'Tampered rationale.';
    await store(f, unsealed);
    await expect(resolved(f)).rejects.toMatchObject({ code: 'STATE_DIGEST_MISMATCH' });
    expect((await snapshot(f)).statusCode).not.toBe(200);
    // Bytes changed and digest recomputed: the admission is validated again and its proofs no longer bind it.
    await store(f, await resealed(original, s => { s.admissions[1].proposal.rationale = 'Tampered rationale.'; }));
    await expect(resolved(f)).rejects.toMatchObject({ code: 'PROOF_BINDING' });
    expect((await snapshot(f)).statusCode).not.toBe(200);
    // A substituted variant answer key is revalidated against its digest.
    await store(f, await resealed(original, s => { s.admissions[2].proposal.artifacts[0].assessment.grading.expected = 999; }));
    await expect(resolved(f)).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });
    // A changed verifier registration on a retained admission is revalidated.
    await store(f, await resealed(original, s => { s.admissions[0].admittedVerifiers[0].version = '9.9.9'; }));
    await expect(resolved(f)).rejects.toMatchObject({ code: 'UNREGISTERED_VERIFIER' });
    // Dropping an applied adaptation breaks the published-artifact and lineage bindings.
    await store(f, await resealed(original, s => { s.admissions.pop(); s.applications.pop(); s.receipts.splice(-2); s.ledgerRevision -= 2; }));
    await expect(resolved(f)).rejects.toMatchObject({ code: expect.any(String) });
    expect((await snapshot(f)).statusCode).not.toBe(200);
    // Restored bytes resolve again, reusing the view recorded before the tampering.
    await store(f, original);
    const restored = await counted(() => snapshot(f));
    expect(restored.result.statusCode).toBe(200); expect(restored.course).toEqual(NONE);
  }, 60000);
});
