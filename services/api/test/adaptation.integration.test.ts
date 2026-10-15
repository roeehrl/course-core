import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { digestTeachingArtifact, type CourseAdaptation, type CourseManifest, type TeachingArtifact } from '@course-core/sdk';
import { createNumericalExerciseGenerator, createNumericalArtifactVerifier } from '@course-core/adaptation';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { issueLoginCode, type Actor } from '../src/auth.js';
import { migrate } from '../src/migrations.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { gateDecision, gradeDeterministic } from '../src/learning.js';
import { ApiError } from '../src/errors.js';
import { digestJson, type Enrollment, type Release } from '../src/repository.js';
import { approveAdaptationRegistry, boundedNumericalAdapter, authoredVariantBankAdapter, createAdaptationRuntime,
  resolveEnrollmentCourse, stageVerifiedAdaptation, requestFreshQuestion, type AdaptationConfiguration, type TrustedAdaptationAdapter } from '../src/adaptation-store.js';
import { fixture as baseFixture } from './fixture.js';
import { legacyGate } from './legacy-gate.js';

// Real PostgreSQL only. Every row/trigger below belongs to a fresh random schema;
// no production DSN, application migration CLI or mock database is used.
const schema = `course_adaptation_${randomUUID().replaceAll('-', '')}`, origin = 'http://localhost:4310';
const workspace = randomUUID(), foreignWorkspace = randomUUID();
const numeric = boundedNumericalAdapter(), bank = authoredVariantBankAdapter();
const wrongReference: TrustedAdaptationAdapter = { ...numeric, id: 'deliberately-wrong-reference', implementationDigest: 'd'.repeat(64),
  async createPorts({ course, profile, verifier }) {
    const config = { course, canonicalAssessmentId: profile.canonicalAssessmentId!, templateId: profile.templateId!, generatorId: profile.generatorId };
    return { generator: await createNumericalExerciseGenerator(config), verifier: await createNumericalArtifactVerifier({ ...config, registration: verifier }, {
      verifierId: verifier.id, verifierVersion: verifier.version, checkId: 'reference', async evaluate({ variables }) { return variables.a! + variables.b!; },
    }) };
  } };
const runtime = createAdaptationRuntime([numeric, bank, wrongReference]);
let db: Database, adminDb: Database, app: FastifyInstance, core: Awaited<ReturnType<typeof createServer>>;
type Session = { actor: Actor; cookie: string; csrf: string };
let admin: Session, foreign: Session;
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
const path = (enrollmentId: string) => `/api/enrollments/${enrollmentId}/adaptation`;
async function session(ws = workspace, role = 'learner'): Promise<Session> {
  const actor = { id: randomUUID(), displayName: 'Synthetic test learner' };
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [actor.id, `adaptation-test:${actor.id}`, actor.displayName]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [ws,actor.id,role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  expect(login.statusCode, login.body).toBe(200);
  return { actor, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: login.json().csrfToken };
}
function adaptiveCourse(adapter = numeric): CourseManifest {
  const c = baseFixture(); c.id = `course-${randomUUID()}`;
  c.policy.work = { additionalMinutes: 8, additionalEpisodes: 4, remediationCyclesPerConcept: 4 };
  const extension = (id: string, capability: string, digest: string) => ({ id, version: '1.0.0', platforms: ['web' as const], execution: 'server' as const,
    capabilities: [capability], entrypoint: `extensions/${id}.js`, integrity: `sha256-${digest}`,
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Reviewed public numerical/language examples.' } });
  c.extensions = [extension('num-generator-extension','teaching.generate',adapter.implementationDigest), extension('num-verifier-extension','teaching.verify',adapter.implementationDigest),
    extension('bank-generator-extension','teaching.generate',bank.implementationDigest), extension('bank-verifier-extension','teaching.verify',bank.implementationDigest)];
  c.sources = ['teaching','reference'].map(id => ({ id, title: 'Public synthetic author reference', url: `urn:example:${id}`, reviewedAt: '2026-01-01T00:00:00Z' }));
  c.adaptation = { schemaVersion: 1, sourceRefs: ['teaching','reference'], profileFieldIds: [],
    targets: [{ episodeId: 'min', objectiveIds: ['minimum'], allowedOperations: ['add_assessment_variant'], replaceableBlockIds: [] }],
    families: [{ familyId: 'select', canonicalAssessmentId: 'min-b', generatorIds: ['numeric-creator'], verifierIds: ['numeric-checker'], numericalRecipeIds: ['minimum-recipe'], maxVariantsPerPlan: 20 },
      { familyId: 'compare', canonicalAssessmentId: 'min-a', generatorIds: ['bank-creator'], verifierIds: ['bank-checker'], numericalRecipeIds: [], maxVariantsPerPlan: 20 }],
    generators: [{ id: 'numeric-creator', version: '1.0.0', extensionId: 'num-generator-extension', sourceRefs: ['teaching'], artifactKinds: ['assessment_variant'] },
      { id: 'bank-creator', version: '1.0.0', extensionId: 'bank-generator-extension', sourceRefs: ['teaching'], artifactKinds: ['assessment_variant'] }],
    verifiers: [{ id: 'numeric-checker', version: '1.0.0', extensionId: 'num-verifier-extension', sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], requiredCheckIds: ['reference'] },
      { id: 'bank-checker', version: '1.0.0', extensionId: 'bank-verifier-extension', sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], requiredCheckIds: ['authored-bank-match'] }],
    numericalRecipes: [{ id: 'minimum-recipe', version: '1.0.0', sourceRefs: ['teaching'], promptTemplate: 'Choose the smaller of {{a}} and {{b}}.',
      variables: [{ name: 'a', minimum: 1, maximum: 50, integer: true },{ name: 'b', minimum: 51, maximum: 100, integer: true }],
      expression: { type: 'binary', operator: 'min', left: { type: 'variable', name: 'a' }, right: { type: 'variable', name: 'b' } }, maxNodes: 3, maxDepth: 2, maxAbsoluteValue: 1000,
      referenceCheck: { verifierId: 'numeric-checker', verifierVersion: '1.0.0', checkId: 'reference', absoluteTolerance: 0 } }],
    limits: { maxOperations: 5, maxArtifacts: 5, maxArtifactBytes: 30000, maxPlannedMinutesPerAssignment: 5,
      maxAdditionalEpisodesPerAssignment: 1, allowedClassifications: ['required','optional'] } };
  return c;
}
function configuration(adapter = numeric): AdaptationConfiguration {
  return { authorizationMinutes: 10, verifiers: [{ id: 'numeric-checker', version: '1.0.0', implementationDigest: adapter.implementationDigest,
    sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], checkIds: ['reference'] }, { id: 'bank-checker', version: '1.0.0', implementationDigest: bank.implementationDigest,
    sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], checkIds: ['authored-bank-match'] }], profiles: [
    { id: 'numeric-profile', episodeId: 'min', operation: 'add_assessment_variant', generatorId: 'numeric-creator', verifierId: 'numeric-checker', adapterId: adapter.id,
      adapterDigest: adapter.implementationDigest, canonicalAssessmentId: 'min-b', templateId: 'minimum-recipe', classification: 'required', plannedMinutes: 2, additionalEpisodes: 1 },
    { id: 'bank-profile', episodeId: 'min', operation: 'add_assessment_variant', generatorId: 'bank-creator', verifierId: 'bank-checker', adapterId: bank.id,
      adapterDigest: bank.implementationDigest, canonicalAssessmentId: 'min-a', classification: 'required', plannedMinutes: 2, additionalEpisodes: 1,
      bank: [6,7].map(n => ({ id: `bank-${n}`, sourceRefs: ['teaching'], hiddenFixtures: { canary: 'UNISSUED_BANK_FIXTURE' }, assessment: {
        id: `authored-question-${n}`, type: 'choice', objectiveIds: ['minimum'], familyId: 'compare', prompt: `Which is smaller, ${n} or ${n+5}?`,
        options: [{ id: 'smaller', text: String(n) }, { id: 'larger', text: String(n+5) }], grading: { correctOptionId: 'smaller', explanation: 'The first quantity is smaller.' } } })) },
  ] };
}
async function fresh(options: { adapter?: TrustedAdaptationAdapter; minutes?: number; classification?: 'required'|'optional'; configureCourse?: (c:CourseManifest)=>void; configureRegistry?: (c:AdaptationConfiguration)=>void } = {}) {
  const adapter = options.adapter ?? numeric, learner = await session(), course = adaptiveCourse(adapter), config = configuration(adapter);
  if (options.minutes !== undefined) course.policy.work!.additionalMinutes = options.minutes;
  if (options.classification) config.profiles[0]!.classification = options.classification;
  options.configureCourse?.(course);
  options.configureRegistry?.(config);
  const compiled = compileCourse(course), releaseId = randomUUID(), enrollmentId = randomUUID();
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
    VALUES($1,$2,$3,'1.0.0',$4,$5,$6,'published',$7)`, [releaseId,workspace,course.id,compiled.digest,JSON.stringify(course),JSON.stringify(compiled.learner),admin.actor.id]);
  const approved=await core.inject({method:'POST',url:`/api/admin/releases/${releaseId}/adaptation-registry`,headers:headers(admin),payload:{expectedRegistryRevision:0,configuration:config}});
  expect(approved.statusCode,approved.body).toBe(200);
  const policy = initialPolicy(course,enrollmentId,learner.actor.id,new Date().toISOString());
  await db.query('INSERT INTO enrollments(id,workspace_id,course_release_id,user_id,policy) VALUES($1,$2,$3,$4,$5)', [enrollmentId,workspace,releaseId,learner.actor.id,JSON.stringify(course.policy)]);
  await db.query('INSERT INTO policy_states(enrollment_id,policy_revision,ledger_revision,snapshot) VALUES($1,$2,$3,$4)', [enrollmentId,policy.policyRevision,policy.ledgerRevision,JSON.stringify(policy)]);
  return { learner, course, config, releaseId, enrollmentId, baseDigest: compiled.digest };
}
type Fixture = Awaited<ReturnType<typeof fresh>>;
async function rev(id: string) { return Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0]!.revision); }
async function summary(f: Fixture) {
  const response = await app.inject({ url: path(f.enrollmentId), headers: headers(f.learner) }); expect(response.statusCode,response.body).toBe(200); return response.json();
}
async function payload(f: Fixture, extra: Record<string, unknown> = {}) {
  return { expectedRevision: await rev(f.enrollmentId), expectedPlanRevision: (await summary(f)).planRevision, idempotencyKey: randomUUID(),
    episodeId: 'min', objectiveId: 'minimum', familyId: 'select', mode: 'independent', ...extra };
}
const postFresh = (f: Fixture, body: object, learner = f.learner) => app.inject({ method: 'POST', url: path(f.enrollmentId) + '/fresh-question', headers: headers(learner), payload: body });
async function failedAttempt(f: Fixture, assessmentId = 'min-b') {
  const issued = await core.inject({ method: 'POST', url: `/api/enrollments/${f.enrollmentId}/challenges`, headers: headers(f.learner),
    payload: { expectedRevision: await rev(f.enrollmentId), idempotencyKey: randomUUID(), episodeId: 'min', assessmentId, mode: 'independent' } });
  expect(issued.statusCode,issued.body).toBe(200);
  const answer = await core.inject({ method: 'POST', url: `/api/enrollments/${f.enrollmentId}/answers`, headers: headers(f.learner),
    payload: { expectedRevision: await rev(f.enrollmentId), idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer: assessmentId === 'min-a' ? 'five' : 99 } });
  expect(answer.statusCode,answer.body).toBe(200); expect(answer.json().result.passed).toBe(false);
}
async function counts(id: string) {
  const names = ['attempts','evidence','adaptation_proposals','adaptation_proofs','adaptation_authorizations','adaptation_artifacts','adaptation_applications','assessment_challenges'];
  return Object.fromEntries(await Promise.all(names.map(async table => [table, Number((await db.query(`SELECT count(*) FROM ${table} WHERE enrollment_id=$1`,[id])).rows[0]!.count)])));
}
async function resolved(f: Fixture) {
  return transaction(db, async client => {
    const enrollment = (await client.query<Enrollment>('SELECT * FROM enrollments WHERE id=$1 FOR UPDATE',[f.enrollmentId])).rows[0]!;
    const release = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1',[f.releaseId])).rows[0]!;
    return resolveEnrollmentCourse(client,enrollment,release);
  });
}
async function staged(f: Fixture, ordinal = 2) {
  const snapshot = await summary(f), generator = await createNumericalExerciseGenerator({ course: f.course, canonicalAssessmentId: 'min-b', templateId: 'minimum-recipe', generatorId: 'numeric-creator' });
  const draft = await generator.generate({ baseCourseDigest: f.baseDigest, objectiveIds: ['minimum'], canonicalAssessment: f.course.assessments.find(a => a.id==='min-b')!, sourceRefs: ['teaching'],
    specification: { artifactId: `artifact-${randomUUID()}`, assessmentId: `assessment-${randomUUID()}`, ordinal } }, {});
  const artifact = { ...draft, digest: await digestTeachingArtifact(draft as TeachingArtifact) } as TeachingArtifact;
  const operationId = `operation-${randomUUID()}`;
  const proposal: Omit<CourseAdaptation,'proofReceipts'> = { schemaVersion: 1, id: `proposal-${randomUUID()}`, baseCourseDigest: f.baseDigest,
    expectedPlanRevision: snapshot.planRevision, expectedPlanDigest: snapshot.planDigest, rationale: 'Trusted pipeline candidate.', artifacts: [artifact],
    operations: [{ id: operationId, type: 'add_assessment_variant', episodeId: 'min', artifactId: artifact.id }] };
  return { proposal, profiles: [{ operationId, profileId: 'numeric-profile' }] };
}
async function stage(f: Fixture, ordinal = 2) {
  return stageVerifiedAdaptation(db,admin.actor,{ ...await staged(f,ordinal), enrollmentId:f.enrollmentId, expectedRevision:await rev(f.enrollmentId),
    expectedPlanRevision:(await summary(f)).planRevision,idempotencyKey:randomUUID() },runtime);
}
async function apply(f: Fixture, proposalId: string, extra: Record<string,unknown> = {}, actor = admin) {
  return app.inject({ method:'POST',url:path(f.enrollmentId)+`/${proposalId}/apply`,headers:headers(actor),payload:{
    expectedRevision:await rev(f.enrollmentId),expectedPlanRevision:(await summary(f)).planRevision,idempotencyKey:randomUUID(),...extra } });
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase=await createTestDatabase(schema);
  adminDb=createDatabase(testDatabase.rootUrl);
  const version=Number((await adminDb.query("SELECT current_setting('server_version_num') AS version")).rows[0]!.version);
  if (version<170000 || version>=180000) throw new Error('Real PostgreSQL 17 required.');
  db=createDatabase(testDatabase.url);
  expect(await migrate(db,fileURLToPath(new URL('../migrations',import.meta.url)))).toEqual([]);
  core=await createServer(db, { loginCodes: true,origin,secureCookies:false,adaptation:runtime});app=core;
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3),($4,$5,$6)',[workspace,'adaptation','Adaptation tests',foreignWorkspace,'foreign','Foreign']);
  admin=await session(workspace,'admin');foreign=await session(foreignWorkspace,'admin');
},30000);
afterAll(async()=> { await app?.close();await core?.close();await db?.end();if(adminDb){await adminDb.end();await testDatabase?.drop();} });

describe('verified adaptation transactions on real PostgreSQL',()=> {
  it('hides a reached canonical-family limit and denies another charge without weakening its gate',async()=>{
    const f=await fresh({configureCourse(c){c.adaptation!.families.find(f=>f.familyId==='select')!.maxVariantsPerPlan=1;}});await failedAttempt(f);
    const response=await postFresh(f,await payload(f));expect(response.statusCode,response.body).toBe(200);
    const wrong=await core.inject({method:'POST',url:`/api/enrollments/${f.enrollmentId}/answers`,headers:headers(f.learner),payload:{expectedRevision:await rev(f.enrollmentId),idempotencyKey:randomUUID(),challengeId:response.json().challengeId,answer:99}});expect(wrong.statusCode,wrong.body).toBe(200);
    expect((await summary(f)).approvedFamilies.some((p:any)=>p.familyId==='select')).toBe(false);
    const before=await counts(f.enrollmentId),policy=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot;
    const denied=await postFresh(f,await payload(f));expect(denied.statusCode).toBe(409);expect(denied.json().error).toBe('APPROVED_FRESH_VARIANT_EXHAUSTED');
    expect(await counts(f.enrollmentId)).toEqual(before);expect((await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot).toEqual(policy);
    expect(legacyGate((await resolved(f)).server_bundle.gates[0]).minimumIndependentFamilies).toBe(2);
  });
  it('selects another approved profile in the same family after the first bank is used, then reports exhaustion',async()=>{
    const f=await fresh({configureRegistry(c){const original=c.profiles.find(p=>p.id==='bank-profile')!,second=structuredClone(original);original.id='a-first-bank';original.bank=original.bank!.slice(0,1);second.id='z-second-bank';second.bank=second.bank!.slice(1);c.profiles.push(second);}});await failedAttempt(f,'min-a');
    for(const value of [6,7]){
      const result=await postFresh(f,await payload(f,{familyId:'compare'}));expect(result.statusCode,result.body).toBe(200);expect(result.json().question.prompt).toBe(`Which is smaller, ${value} or ${value+5}?`);
      const wrong=await core.inject({method:'POST',url:`/api/enrollments/${f.enrollmentId}/answers`,headers:headers(f.learner),payload:{expectedRevision:await rev(f.enrollmentId),idempotencyKey:randomUUID(),challengeId:result.json().challengeId,answer:'larger'}});expect(wrong.statusCode,wrong.body).toBe(200);
    }
    const summaryResponse=await summary(f);expect(summaryResponse.approvedFamilies.some((p:any)=>p.familyId==='compare')).toBe(false);expect(JSON.stringify(summaryResponse)).not.toMatch(/bank-6|bank-7|Which is smaller|correctOptionId/);
    const before=await counts(f.enrollmentId),denied=await postFresh(f,await payload(f,{familyId:'compare'}));expect(denied.statusCode).toBe(409);expect(denied.json().error).toBe('APPROVED_FRESH_VARIANT_EXHAUSTED');expect(await counts(f.enrollmentId)).toEqual(before);
  });
  it('an unissued staff draft does not consume a learner variant, while applying it after fresh delivery is fenced',async()=>{
    const f=await fresh();await failedAttempt(f,'min-a');
    const entry=f.config.profiles.find(p=>p.id==='bank-profile')!.bank![0]!,candidate=await staged(f);
    const artifact:TeachingArtifact={id:candidate.proposal.artifacts[0]!.id,kind:'assessment_variant',digest:'',generator:{id:'bank-creator',version:'1.0.0'},objectiveIds:['minimum'],sourceRefs:entry.sourceRefs,canonicalAssessmentId:'min-a',assessment:{...structuredClone(entry.assessment),id:'unapplied-bank-question'},hiddenFixtures:entry.hiddenFixtures!};
    artifact.digest=await digestTeachingArtifact(artifact);candidate.proposal.artifacts=[artifact];candidate.profiles[0]!.profileId='bank-profile';
    const prepared=await stageVerifiedAdaptation(db,admin.actor,{...candidate,enrollmentId:f.enrollmentId,expectedRevision:await rev(f.enrollmentId),expectedPlanRevision:0,idempotencyKey:randomUUID()},runtime);
    const result=await postFresh(f,await payload(f,{familyId:'compare'}));expect(result.statusCode,result.body).toBe(200);expect(result.json().question.prompt).toBe('Which is smaller, 6 or 11?');
    const before=await counts(f.enrollmentId),stale=await apply(f,prepared.proposalId);expect(stale.statusCode).toBe(409);expect(await counts(f.enrollmentId)).toEqual(before);
    expect((await db.query("SELECT count(*) FROM adaptation_proposals WHERE enrollment_id=$1 AND status='verified'",[f.enrollmentId])).rows[0]!.count).toBe('1');
  });
  it('registry approval uses production authentication, workspace ownership and revision checks',async()=>{
    const f=await fresh(),url=`/api/admin/releases/${f.releaseId}/adaptation-registry`,payload={expectedRegistryRevision:1,configuration:f.config};
    expect((await core.inject({method:'POST',url,headers:headers(f.learner),payload})).statusCode).toBe(403);
    expect((await core.inject({method:'POST',url,headers:headers(foreign),payload})).statusCode).toBe(403);
    const stale=await core.inject({method:'POST',url,headers:headers(admin),payload:{...payload,expectedRegistryRevision:0}});expect(stale.statusCode).toBe(409);expect(stale.json().error).toBe('STALE_REGISTRY');
    expect((await core.inject({url:'/api/runtime/adaptation-adapters'})).statusCode).toBe(401);
    const descriptors=await core.inject({url:'/api/runtime/adaptation-adapters',headers:headers(admin)});expect(descriptors.statusCode).toBe(200);expect(descriptors.body).not.toContain('bank-6');expect(descriptors.json().adapters.length).toBe(3);
  });
  it('a failed first answer retains the family standard and gets a qualified recovery path through production delivery',async()=>{
    const f=await fresh();await failedAttempt(f,'min-a');await failedAttempt(f,'min-b');
    const snapshot=await core.inject({url:`/api/enrollments/${f.enrollmentId}`,headers:headers(f.learner)});expect(snapshot.statusCode,snapshot.body).toBe(200);
    expect(snapshot.json().recovery[0]).toMatchObject({episodeId:'min',required:true,freshCheck:{plannedMinutes:2,additionalEpisodes:1}});
    const next=snapshot.json().recovery[0].freshCheck;
    const generated=await postFresh(f,await payload(f,{familyId:next.familyId,objectiveId:next.objectiveId}));expect(generated.statusCode,generated.body).toBe(200);expect(generated.json().independentEligible).toBe(true);
    expect(snapshot.body).not.toMatch(/UNISSUED_BANK_FIXTURE|correctOptionId/);
    expect(legacyGate((await resolved(f)).server_bundle.gates.find(g=>g.id==='min-gate')).minimumIndependentFamilies).toBe(2);
  });
  it('generates, independently verifies, atomically applies and issues a fresh question while retaining base evidence',async()=> {
    const f=await fresh();await failedAttempt(f);const before=(await db.query('SELECT to_jsonb(e) AS data FROM evidence e WHERE enrollment_id=$1',[f.enrollmentId])).rows;
    const response=await postFresh(f,await payload(f));expect(response.statusCode,response.body).toBe(200);
    const result=response.json();expect(result.planRevision).toBe(1);expect(result.baseCourseDigest).toBe(f.baseDigest);expect(result.question.type).toBe('numeric');
    expect(result.question.grading).toBeUndefined();expect(result.independentEligible).toBe(true);expect(response.body).not.toContain('hiddenFixtures');
    const projected=await resolved(f);expect(projected.digest).toBe(f.baseDigest);expect(projected.baseCourseDigest).toBe(f.baseDigest);
    const variant=projected.server_bundle.assessments.find(a=>a.id===result.question.id)!;expect(variant.familyId).toBe('select');
    const gate=legacyGate(projected.server_bundle.gates.find(g=>g.id==='min-gate'));expect(gate.minimumIndependentFamilies).toBe(2);expect(gate.assessmentIds).toContain(result.question.id);
    expect(gradeDeterministic(variant,1).passed).toBe(true);
    expect((await db.query('SELECT to_jsonb(e) AS data FROM evidence e WHERE enrollment_id=$1',[f.enrollmentId])).rows).toEqual(before);
    expect((await db.query('SELECT digest,server_bundle FROM course_releases WHERE id=$1',[f.releaseId])).rows[0]).toMatchObject({digest:f.baseDigest,server_bundle:f.course});
    const saved=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot;
    expect(saved.reservations).toHaveLength(1);expect(saved.reservations[0]).toMatchObject({state:'committed',work:{additionalMinutes:2,additionalEpisodes:1,remediation:[{conceptId:'minimum',cycles:1}]}});
    const proof=(await db.query('SELECT trusted_record,verification_evidence FROM adaptation_proofs WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!;
    expect(proof.trusted_record.authenticationRef).toContain('registry:');expect(proof.verification_evidence).toHaveLength(1);
    expect(Number((await db.query("SELECT count(*) FROM outbox o JOIN learning_events e ON e.id=o.event_id WHERE e.enrollment_id=$1 AND e.event_type='adaptation.applied'",[f.enrollmentId])).rows[0]!.count)).toBe(1);
    const summaryResponse=await app.inject({url:path(f.enrollmentId),headers:headers(f.learner)});expect(summaryResponse.body).not.toMatch(/UNISSUED_BANK_FIXTURE|Choose the smaller|correctOptionId|minimum-recipe/);
    const priorEvidence={id:randomUUID(),objective_id:'minimum',family_id:'compare',assessment_id:'min-a',course_digest:f.baseDigest,independent:true,result:{passed:true}};
    const freshEvidence={...priorEvidence,id:randomUUID(),assessment_id:variant.id,family_id:variant.familyId};
    expect(gateDecision(f.course,gate,[priorEvidence,freshEvidence],f.baseDigest).passed).toBe(true);
    expect(gateDecision(f.course,gate,[freshEvidence,{...freshEvidence,id:randomUUID()}],f.baseDigest).passed).toBe(false);
  });

  it('same-key concurrency returns one response, one application, one artifact and one reservation',async()=> {
    const f=await fresh();await failedAttempt(f);const body=await payload(f);
    const responses=await Promise.all(Array.from({length:6},()=>postFresh(f,body)));
    expect(responses.map(r=>r.statusCode)).toEqual([200,200,200,200,200,200]);expect(new Set(responses.map(r=>r.body)).size).toBe(1);
    const saved=await counts(f.enrollmentId);expect(saved.adaptation_applications).toBe(1);expect(saved.adaptation_artifacts).toBe(1);expect(saved.adaptation_proofs).toBe(1);
    expect((await postFresh(f,{...body,mode:'practice'})).json().error).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('production answer and snapshot routes consume a verified fresh variant without exposing its key or inventing another family', async()=> {
    const f=await fresh(); await failedAttempt(f);
    const generated=await postFresh(f,await payload(f)); expect(generated.statusCode,generated.body).toBe(200);
    const receipt=generated.json();
    const snapshot=await core.inject({url:`/api/enrollments/${f.enrollmentId}`,headers:headers(f.learner)});
    expect(snapshot.statusCode,snapshot.body).toBe(200);
    expect(snapshot.json().planRevision).toBe(1);
    expect(snapshot.json().activeChallenges).toContainEqual(expect.objectContaining({challengeId:receipt.challengeId}));
    expect(snapshot.body).not.toMatch(/correctOptionId|hiddenFixtures|\"expected\"|minimum-recipe/);
    const answered=await core.inject({method:'POST',url:`/api/enrollments/${f.enrollmentId}/answers`,headers:headers(f.learner),payload:{
      expectedRevision:await rev(f.enrollmentId),idempotencyKey:randomUUID(),challengeId:receipt.challengeId,answer:1}});
    expect(answered.statusCode,answered.body).toBe(200); expect(answered.json().result.passed).toBe(true);
    const record=(await db.query('SELECT a.family_id,a.course_digest,e.independent FROM assessment_challenges c JOIN attempts a ON a.id=c.attempt_id JOIN evidence e ON e.attempt_id=a.id WHERE c.id=$1',[receipt.challengeId])).rows[0]!;
    expect(record).toMatchObject({family_id:'select',course_digest:f.baseDigest,independent:true});
    const after=await core.inject({url:`/api/enrollments/${f.enrollmentId}`,headers:headers(f.learner)});
    expect(after.json().lessons.find((l:any)=>l.id==='min').gate.passed).toBe(false);
  });

  it('optional-only objectives remain metered but do not become required because adaptation is enabled', async()=> {
    const f=await fresh({configureCourse(c){c.chapters[0]!.episodes[1]!.requirement='optional';c.objectives.find(o=>o.id==='maximum')!.critical=false;}});
    await failedAttempt(f); const response=await postFresh(f,await payload(f)); expect(response.statusCode,response.body).toBe(200);
    const policy=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot;
    expect(policy.coreObjectiveIds).toEqual(['minimum']); expect(policy.conceptIds).toContain('maximum');
  });

  it('concurrent requests cannot overdraw the last allowance; rebased retry still fails quota with no partial effects',async()=> {
    const f=await fresh({minutes:2});await failedAttempt(f);const body=await payload(f,{allowAssessmentAssistance:true});
    const responses=await Promise.all(Array.from({length:6},()=>postFresh(f,{...body,idempotencyKey:randomUUID()})));
    expect(responses.filter(r=>r.statusCode===200)).toHaveLength(1);expect(responses.filter(r=>r.statusCode===409)).toHaveLength(5);
    const before=await counts(f.enrollmentId);const retry=await postFresh(f,await payload(f,{allowAssessmentAssistance:true}));expect(retry.json().error).toBe('QUOTA_EXCEEDED');
    expect(await counts(f.enrollmentId)).toEqual(before);
    const policy=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot;
    expect(policy.reservations).toHaveLength(1);expect(policy.reservations[0].state).toBe('committed');
  });

  it('browser proofs, variables, grading keys, optional classification and cost overrides are all rejected',async()=> {
    const f=await fresh();await failedAttempt(f);
    for(const [field,value]of Object.entries({proofReceipts:[],grading:{expected:1},variables:{a:1,b:2},classification:'optional',plannedMinutes:0,adapterId:numeric.id,mastery:true})){
      const response=await postFresh(f,await payload(f,{[field]:value}));expect(response.statusCode,response.body).toBe(400);
    }
    expect((await counts(f.enrollmentId)).adaptation_proposals).toBe(0);
    const optional=await fresh({minutes:1,classification:'optional'});await failedAttempt(optional);
    expect((await postFresh(optional,await payload(optional))).json().error).toBe('QUOTA_EXCEEDED');
  });

  it('a deliberately wrong independent numerical reference rolls back every candidate/proof/plan write',async()=> {
    const f=await fresh({adapter:wrongReference});await failedAttempt(f);const before=await counts(f.enrollmentId);
    const response=await postFresh(f,await payload(f));expect(response.statusCode,response.body).toBe(409);expect(response.json().error).toBe('NUMERICAL_VERIFICATION_FAILED');
    expect(await counts(f.enrollmentId)).toEqual(before);expect((await summary(f)).planRevision).toBe(0);
  });

  it('the trusted authored bank works through the same family/receipt path and keeps its keys private',async()=> {
    const f=await fresh();await failedAttempt(f,'min-a');
    const response=await postFresh(f,await payload(f,{familyId:'compare'}));expect(response.statusCode,response.body).toBe(200);
    expect(response.json().question.type).toBe('choice');expect(response.body).not.toContain('correctOptionId');expect(response.body).not.toContain('UNISSUED_BANK_FIXTURE');
    const projected=await resolved(f);expect(projected.server_bundle.assessments.find(a=>a.id===response.json().question.id)?.familyId).toBe('compare');
    expect(JSON.stringify(projected.learner_bundle)).not.toContain('correctOptionId');
  });

  it('requires explicit assistance consent, downgrades outstanding challenges atomically, and records fresh exposure',async()=> {
    const f=await fresh();await failedAttempt(f);
    const issued=await core.inject({method:'POST',url:`/api/enrollments/${f.enrollmentId}/challenges`,headers:headers(f.learner),payload:{expectedRevision:await rev(f.enrollmentId),
      idempotencyKey:randomUUID(),episodeId:'min',assessmentId:'min-a',mode:'independent'}});expect(issued.statusCode,issued.body).toBe(200);
    const denied=await postFresh(f,await payload(f));expect(denied.json().error).toBe('ASSESSMENT_HELP_CONSENT_REQUIRED');
    const accepted=await postFresh(f,await payload(f,{allowAssessmentAssistance:true,mode:'practice'}));expect(accepted.statusCode,accepted.body).toBe(200);
    expect(accepted.json().independentEligible).toBe(false);expect(accepted.json().downgradedChallengeIds).toEqual([issued.json().challengeId]);
    const old=(await db.query('SELECT assistance,independent_eligible FROM assessment_challenges WHERE id=$1',[issued.json().challengeId])).rows[0]!;
    expect(old).toEqual({assistance:'hint',independent_eligible:false});
    const bound=(await db.query('SELECT course_digest,adaptation_artifact_digest,adaptation_plan_revision,canonical_assessment_id FROM assessment_challenges WHERE id=$1',[accepted.json().challengeId])).rows[0]!;
    expect(bound).toMatchObject({course_digest:f.baseDigest,adaptation_plan_revision:1,canonical_assessment_id:'min-b'});expect(bound.adaptation_artifact_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses existing actor/CSRF scopes and rejects unapproved objectives, families and absent adapters',async()=> {
    const f=await fresh();await failedAttempt(f);const body=await payload(f), other=await session();
    expect((await app.inject({url:path(f.enrollmentId)})).statusCode).toBe(401);
    expect((await postFresh(f,body,other)).statusCode).toBe(404);expect((await postFresh(f,body,foreign)).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:path(f.enrollmentId)+'/fresh-question',headers:{...headers(f.learner),origin:'https://invalid.example'},payload:body})).statusCode).toBe(403);
    expect((await postFresh(f,{...body,objectiveId:'maximum'})).json().error).toBe('ADAPTATION_OBJECTIVE_OUT_OF_SCOPE');
    expect((await postFresh(f,{...body,familyId:'invented'})).json().error).toBe('APPROVED_FRESH_VARIANT_UNAVAILABLE');
    await expect(requestFreshQuestion(db,f.learner.actor,{...body,enrollmentId:f.enrollmentId} as never,createAdaptationRuntime([]))).rejects.toMatchObject({code:'ADAPTATION_ADAPTER_NOT_INSTALLED'});
    await expect(approveAdaptationRegistry(db,f.learner.actor,{releaseId:f.releaseId,expectedRegistryRevision:1,configuration:f.config},runtime)).rejects.toMatchObject({code:'FORBIDDEN'});
  });

  it('staff apply replays exactly once, refuses duplicate new-key apply, and denies learner classification/cost overrides',async()=> {
    const f=await fresh(), prepared=await stage(f);
    expect((await apply(f,prepared.proposalId,{},f.learner)).statusCode).toBe(403);
    expect((await apply(f,prepared.proposalId,{classification:'optional',plannedMinutes:0})).statusCode).toBe(400);
    const body={expectedRevision:await rev(f.enrollmentId),expectedPlanRevision:0,idempotencyKey:randomUUID()};
    const responses=await Promise.all(Array.from({length:5},()=>app.inject({method:'POST',url:path(f.enrollmentId)+`/${prepared.proposalId}/apply`,headers:headers(admin),payload:body})));
    expect(responses.map(r=>r.statusCode)).toEqual([200,200,200,200,200]);expect(new Set(responses.map(r=>r.body)).size).toBe(1);
    expect((await apply(f,prepared.proposalId)).json().error).toBe('ADAPTATION_ALREADY_APPLIED');
    expect((await counts(f.enrollmentId)).adaptation_applications).toBe(1);
    const policy=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot;
    expect(policy.reservations).toHaveLength(1);expect(policy.reservations[0].work.additionalMinutes).toBe(2);
  });

  it('competing staged plans cannot both apply; a refreshed HTTP fence does not silently rebase the losing proposal',async()=> {
    const f=await fresh(), first=await stage(f,2), second=await stage(f,3);
    const expectedRevision=await rev(f.enrollmentId);
    const responses=await Promise.all([first,second].map(s=>app.inject({method:'POST',url:path(f.enrollmentId)+`/${s.proposalId}/apply`,headers:headers(admin),
      payload:{expectedRevision,expectedPlanRevision:0,idempotencyKey:randomUUID()}})));
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
    const loser=responses[0]!.statusCode===409?first:second;
    const retry=await apply(f,loser.proposalId);expect(retry.statusCode,retry.body).toBe(409);expect(retry.json().error).toBe('STALE_PLAN');
    expect((await summary(f)).planRevision).toBe(1);expect((await counts(f.enrollmentId)).adaptation_applications).toBe(1);
  });

  it('new evidence and replaced/revoked stored registry approvals fence already verified drafts',async()=> {
    const f=await fresh(), prepared=await stage(f);await failedAttempt(f);
    expect((await apply(f,prepared.proposalId)).json().error).toBe('STALE_EVIDENCE');
    const g=await fresh(), candidate=await stage(g);
    await approveAdaptationRegistry(db,admin.actor,{releaseId:g.releaseId,expectedRegistryRevision:1,configuration:g.config},runtime);
    expect((await apply(g,candidate.proposalId)).json().error).toBe('STALE_REGISTRY');
    const h=await fresh(), revoked=await stage(h);
    await db.query("UPDATE adaptation_registries SET status='revoked' WHERE course_release_id=$1",[h.releaseId]);
    expect((await apply(h,revoked.proposalId)).json().error).toBe('ADAPTATION_NOT_APPROVED');
    expect((await counts(h.enrollmentId)).adaptation_applications).toBe(0);
    const changed=await fresh(), policyDraft=await stage(changed);
    const policy=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[changed.enrollmentId])).rows[0]!.snapshot;
    policy.policyRevision++;
    await db.query('UPDATE policy_states SET policy_revision=$2,snapshot=$3 WHERE enrollment_id=$1',[changed.enrollmentId,policy.policyRevision,JSON.stringify(policy)]);
    expect((await apply(changed,policyDraft.proposalId)).json().error).toBe('STALE_POLICY_REVISION');
    const invalidated=await fresh();await failedAttempt(invalidated);const evidenceDraft=await stage(invalidated);
    await db.query("UPDATE evidence SET invalidated_at=clock_timestamp(),invalidation_reason='synthetic review' WHERE enrollment_id=$1",[invalidated.enrollmentId]);
    expect((await apply(invalidated,evidenceDraft.proposalId)).json().error).toBe('STALE_EVIDENCE');
  });

  it('never accepts supplied proof claims, changed numerical keys/sources or a forged canonical family through the service hook',async()=> {
    const f=await fresh();
    for(const mode of ['proof','key','source','family','requirement']) {
      const candidate=await staged(f);
      if(mode==='proof')Object.assign(candidate.proposal,{proofReceipts:[{outcome:'passed',authenticated:true}]});
      const artifact=candidate.proposal.artifacts[0]!;
      if(artifact.kind!=='assessment_variant')throw new Error('test fixture');
      if(mode==='key'&&artifact.assessment.type==='numeric')artifact.assessment.grading.expected=999;
      if(mode==='source')artifact.sourceRefs=['reference'];
      if(mode==='family')artifact.assessment.familyId='new-independent-family';
      if(mode==='requirement')Object.assign(candidate.proposal.operations[0]!,{requirement:'optional'});
      artifact.digest=await digestTeachingArtifact(artifact);
      await expect(stageVerifiedAdaptation(db,admin.actor,{...candidate,enrollmentId:f.enrollmentId,expectedRevision:await rev(f.enrollmentId),
        expectedPlanRevision:0,idempotencyKey:randomUUID()},runtime)).rejects.toMatchObject({code:mode==='proof'?'INVALID_REQUEST':mode==='key'?'RECIPE_OUTPUT_MISMATCH':mode==='source'?'SOURCE_BINDING':mode==='family'?'UNKNOWN_FAMILY':'SCHEMA'});
    }
    expect((await counts(f.enrollmentId)).adaptation_proofs).toBe(0);expect((await counts(f.enrollmentId)).adaptation_proposals).toBe(0);
  });

  it('stored proof/artifact provenance is immutable and staged variants are absent from the effective gate',async()=> {
    const f=await fresh(), prepared=await stage(f), before=await resolved(f);
    expect(before.server_bundle.assessments).toHaveLength(f.course.assessments.length);expect(before.planRevision).toBe(0);
    await expect(db.query("UPDATE adaptation_proofs SET trusted_record='{}' WHERE enrollment_id=$1",[f.enrollmentId])).rejects.toMatchObject({code:'23514'});
    await expect(db.query("UPDATE adaptation_artifacts SET body='{}' WHERE enrollment_id=$1",[f.enrollmentId])).rejects.toMatchObject({code:'23514'});
    await expect(db.query('DELETE FROM adaptation_registry_versions WHERE course_release_id=$1',[f.releaseId])).rejects.toMatchObject({code:'23514'});
    expect((await apply(f,prepared.proposalId)).statusCode).toBe(200);
    const after=await resolved(f);expect(after.server_bundle.assessments).toHaveLength(f.course.assessments.length+1);
  });

  it('a late event/outbox failure rolls back artifact publication, plan, policy, challenge, proof and command receipt together',async()=> {
    const f=await fresh();await failedAttempt(f);const before=await counts(f.enrollmentId), revisionBefore=await rev(f.enrollmentId), body=await payload(f);
    await db.query(`CREATE FUNCTION adaptation_test_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.enrollment_id='${f.enrollmentId}'::uuid AND NEW.event_type='adaptation.applied' THEN RAISE EXCEPTION 'synthetic event failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER adaptation_test_fail_event BEFORE INSERT ON learning_events FOR EACH ROW EXECUTE FUNCTION adaptation_test_fail_event()`);
    try {
      const response=await postFresh(f,body);expect(response.statusCode).toBe(500);
      expect(await counts(f.enrollmentId)).toEqual(before);expect(await rev(f.enrollmentId)).toBe(revisionBefore);expect((await summary(f)).planRevision).toBe(0);
      const snapshot=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot;expect(snapshot.reservations).toEqual([]);
      expect(Number((await db.query('SELECT count(*) FROM command_receipts WHERE enrollment_id=$1 AND idempotency_key=$2',[f.enrollmentId,body.idempotencyKey])).rows[0]!.count)).toBe(0);
    } finally {await db.query('DROP TRIGGER adaptation_test_fail_event ON learning_events; DROP FUNCTION adaptation_test_fail_event()');}
    expect((await postFresh(f,body)).statusCode).toBe(200);
  });

  it('deferred commit-time clock rejects publication even when every earlier policy/precommit check passed',async()=> {
    const f=await fresh(), prepared=await stage(f);
    const policy=(await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot;
    const deadline=(await db.query("SELECT clock_timestamp()+interval '2 seconds' AS deadline")).rows[0]!.deadline.toISOString();
    policy.scopes[0].hardDeadline={at:deadline,timeZone:'UTC',disambiguation:'reject'};
    await db.query('UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1',[f.enrollmentId,JSON.stringify(policy)]);
    await db.query(`CREATE FUNCTION adaptation_test_commit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.enrollment_id='${f.enrollmentId}'::uuid THEN PERFORM pg_sleep(2.2); END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER aaa_adaptation_test_commit_delay AFTER INSERT ON adaptation_applications
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION adaptation_test_commit_delay()`);
    try {
      const response=await apply(f,prepared.proposalId);expect(response.statusCode,response.body).toBe(409);expect(response.json().error).toBe('ADAPTATION_COMMIT_DEADLINE');
      expect((await counts(f.enrollmentId)).adaptation_applications).toBe(0);expect((await summary(f)).planRevision).toBe(0);
      expect((await db.query('SELECT snapshot FROM policy_states WHERE enrollment_id=$1',[f.enrollmentId])).rows[0]!.snapshot.reservations).toEqual([]);
      expect((await db.query('SELECT status FROM adaptation_proposals WHERE id=$1',[prepared.proposalId])).rows[0]!.status).toBe('verified');
    } finally {await db.query('DROP TRIGGER aaa_adaptation_test_commit_delay ON adaptation_applications; DROP FUNCTION adaptation_test_commit_delay()');}
  },10000);

  it('effective projection is compatible with a consistent read-only snapshot and preserves prior evidence after another plan revision',async()=> {
    const f=await fresh();await failedAttempt(f);const first=await postFresh(f,await payload(f));expect(first.statusCode,first.body).toBe(200);
    const before=(await db.query('SELECT to_jsonb(e) AS data FROM evidence e WHERE enrollment_id=$1 ORDER BY id',[f.enrollmentId])).rows;
    const second=await postFresh(f,await payload(f,{mode:'practice',allowAssessmentAssistance:true}));expect(second.statusCode,second.body).toBe(200);
    const projected=await transaction(db,async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const enrollment=(await client.query<Enrollment>('SELECT * FROM enrollments WHERE id=$1',[f.enrollmentId])).rows[0]!;
      const release=(await client.query<Release>('SELECT * FROM course_releases WHERE id=$1',[f.releaseId])).rows[0]!;
      return resolveEnrollmentCourse(client,enrollment,release);
    });
    expect(projected.planRevision).toBe(2);expect(projected.digest).toBe(f.baseDigest);
    expect((await db.query('SELECT to_jsonb(e) AS data FROM evidence e WHERE enrollment_id=$1 ORDER BY id',[f.enrollmentId])).rows).toEqual(before);
    expect(legacyGate(projected.server_bundle.gates.find(g=>g.id==='min-gate')).assessmentIds).toEqual(expect.arrayContaining([first.json().question.id,second.json().question.id,'min-a','min-b']));
  });

  it('the default independent rational path checks addition, subtraction, multiplication, division and unary arithmetic',async()=> {
    const a={type:'variable' as const,name:'a'},b={type:'variable' as const,name:'b'};
    const cases=[
      {operator:'add' as const,answer:52}, {operator:'subtract' as const,answer:-50}, {operator:'multiply' as const,answer:51},
      {operator:'divide' as const,answer:1/51}, {operator:'max' as const,answer:51},
    ];
    for(const example of cases){
      const f=await fresh({configureCourse(c){const recipe=c.adaptation!.numericalRecipes[0]!;recipe.expression={type:'binary',operator:example.operator,left:a,right:b};
        recipe.promptTemplate=`Apply ${example.operator} to {{a}} and {{b}}.`;recipe.referenceCheck.absoluteTolerance=1e-12;}});
      await failedAttempt(f);const response=await postFresh(f,await payload(f));expect(response.statusCode,response.body).toBe(200);
      const course=await resolved(f),item=course.server_bundle.assessments.find(i=>i.id===response.json().question.id)!;
      expect(gradeDeterministic(item,example.answer).passed).toBe(true);
    }
    const f=await fresh({configureCourse(c){const recipe=c.adaptation!.numericalRecipes[0]!;recipe.expression={type:'unary',operator:'abs',value:{type:'unary',operator:'negate',value:b}};
      recipe.promptTemplate='Take the magnitude of negative {{b}}.';recipe.maxDepth=3;}});
    await failedAttempt(f);const response=await postFresh(f,await payload(f));expect(response.statusCode,response.body).toBe(200);
    const course=await resolved(f);expect(gradeDeterministic(course.server_bundle.assessments.find(i=>i.id===response.json().question.id)!,51).passed).toBe(true);
  });

  it('a changed authored-bank key cannot produce an authenticated proof even when its SDK shape and hashes are valid',async()=> {
    const f=await fresh(),candidate=await staged(f),entry=f.config.profiles[1]!.bank![0]!;
    const old=candidate.proposal.artifacts[0]!;
    const artifact:TeachingArtifact={id:old.id,digest:old.digest,kind:'assessment_variant',generator:{id:'bank-creator',version:'1.0.0'},
      objectiveIds:['minimum'],sourceRefs:['teaching'],canonicalAssessmentId:'min-a',assessment:{...structuredClone(entry.assessment),id:'bank-forged-key'},hiddenFixtures:entry.hiddenFixtures!};
    if(artifact.assessment.type!=='choice')throw new Error('fixture');artifact.assessment.grading.correctOptionId='larger';artifact.digest=await digestTeachingArtifact(artifact);
    candidate.proposal.artifacts=[artifact];candidate.profiles[0]!.profileId='bank-profile';
    await expect(stageVerifiedAdaptation(db,admin.actor,{...candidate,enrollmentId:f.enrollmentId,expectedRevision:await rev(f.enrollmentId),expectedPlanRevision:0,idempotencyKey:randomUUID()},runtime))
      .rejects.toMatchObject({code:'ADAPTATION_VERIFICATION_FAILED'});
    expect((await counts(f.enrollmentId)).adaptation_proofs).toBe(0);
  });
});
