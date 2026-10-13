import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DockerSandbox, QUALIFIED_IMAGES, type Case } from '@course-core/sandbox';
import { createDatabase } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { codeEvaluator } from '../src/code-evaluator.js';
import { codeRecoveryFixture,comparisonFixtures } from '../test/code-recovery-fixture.js';

// Required explicit real-Docker/real-Postgres qualification, separate from fast API tests.
if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error('Use only a disposable TEST_DATABASE_URL.');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash) throw new Error('Disposable loopback test database required.');
const schema = `course_code_${randomUUID().replaceAll('-', '')}`, admin = createDatabase(url.toString());
const root = fileURLToPath(new URL('../.local/', import.meta.url)); await mkdir(root, { recursive: true, mode: 0o700 });
const storage = await mkdtemp(path.join(root, 'practical-test-'));
await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
const db = createDatabase(url.toString());
let app: Awaited<ReturnType<typeof createServer>> | undefined;
try {
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const image = process.env.COURSE_SANDBOX_IMAGE ?? QUALIFIED_IMAGES[process.arch as keyof typeof QUALIFIED_IMAGES];
  assert(image, 'Pin a qualified image for this platform.');
  const sandbox = new DockerSandbox({ image, storageDirectory: storage });
  assert.equal((await sandbox.readiness()).ready, true, 'Real Docker isolation and the pinned image are required.');
  const fixtureData:{schemaVersion:number;id:string;version:string;fixtures:{id:string;language:string;cases:Case[]}[]}=structuredClone(comparisonFixtures);
  fixtureData.fixtures.push({id:'large-maximum',language:'python',cases:[{id:'long-a',input:{a:0,b:1,n:6500},expected:Array(6500).fill(1)},{id:'long-b',input:{a:1,b:0,n:6500},expected:Array(6500).fill(1)},{id:'long-c',input:{a:-1,b:0,n:6500},expected:Array(6500).fill(0)}]});
  const registry = await codeEvaluator(Buffer.from(JSON.stringify(fixtureData)), sandbox);
  const recovery=codeRecoveryFixture(registry),course=recovery.course;
  course.assessments.push({id:'large-max-code',type:'code',familyId:'implementation',objectiveIds:['maximum'],language:'python',starterCode:'def solve(data):\n    pass\n',prompt:'Return n copies of the maximum of a and b from the supplied JSON object.',grading:{evaluatorId:registry.id,fixtureRef:'large-maximum'}});
  course.gates[1]!.assessmentIds.push('large-max-code');course.gates[1]!.minimumIndependentFamilies=3;
  const workspaceId = randomUUID(), userId = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `test:${userId}`, 'Practical learner']);
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, 'practical', 'Practical qualification']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, userId]);
  app = await createServer(db, { origin: 'http://localhost:4310', secureCookies: false, installedExtensions: [registry],adaptation:recovery.runtime });
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin: 'http://localhost:4310' }, payload: { token: await issueLoginCode(db, userId) } });
  assert.equal(login.statusCode, 200);
  let headers = { origin: 'http://localhost:4310', cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
  const send = (method: 'GET' | 'POST', url: string, payload?: object) => app!.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const imported = await send('POST', `/api/workspaces/${workspaceId}/releases`, course); assert.equal(imported.statusCode, 200, imported.body);
  const releaseId = imported.json().id;
  const registryUrl=`/api/admin/releases/${releaseId}/adaptation-registry`;
  const bad=structuredClone(recovery.config);bad.profiles[0]!.bank![0]!.hiddenFixtures={selfAwarded:true};
  const rejected=await send('POST',registryUrl,{expectedRegistryRevision:0,configuration:bad});assert.equal(rejected.statusCode,409);assert.equal(rejected.json().error,'CODE_BANK_PROFILE_INVALID');
  assert.equal((await send('GET',registryUrl)).json().registryRevision,0);
  const approved=await send('POST',registryUrl,{expectedRegistryRevision:0,configuration:recovery.config});assert.equal(approved.statusCode,200,approved.body);
  const published = await send('POST', `/api/releases/${releaseId}/publish`); assert.equal(published.statusCode, 200, published.body);
  const enrolled = await send('POST', '/api/enrollments', { releaseId }); assert.equal(enrolled.statusCode, 200, enrolled.body);
  let enrollmentId = enrolled.json().id;
  async function command(action: string, body: Record<string, unknown>) {
    const snapshot = (await send('GET', `/api/enrollments/${enrollmentId}`)).json();
    const result = await send('POST', `/api/enrollments/${enrollmentId}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), ...body });
    assert.equal(result.statusCode, 200, result.body); return result.json();
  }
  const issued = await command('challenges', { episodeId: 'min', assessmentId: 'min-code', mode: 'independent' });
  assert.equal(issued.question.type, 'code'); assert(!('grading' in issued.question));
  const answer = { expectedRevision: issued.revision, idempotencyKey: randomUUID(), challengeId: issued.challengeId, answer: 'def solve(values):\n    return min(values)\n' };
  const [first, duplicate] = await Promise.all([send('POST', `/api/enrollments/${enrollmentId}/answers`, answer), send('POST', `/api/enrollments/${enrollmentId}/answers`, answer)]);
  assert.equal(first.statusCode, 200, first.body); assert.deepEqual(first.json(), duplicate.json());
  assert.equal(first.json().result.passed, true); assert.equal(first.json().result.execution.passedCases, 4);
  assert.equal((await db.query('SELECT count(*) FROM attempts WHERE enrollment_id=$1', [enrollmentId])).rows[0].count, '1');
  assert.equal((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1', [enrollmentId])).rows[0].count, '1');
  const repeated = await command('challenges', { episodeId: 'min', assessmentId: 'min-code', mode: 'practice' });
  const wrong = await command('answers', { challengeId: repeated.challengeId, answer: 'def solve(values):\n    return max(values)\n' });
  assert.equal(wrong.result.passed, false); assert.equal(wrong.result.independent, false);
  assert((await db.query("SELECT result FROM attempts WHERE enrollment_id=$1 AND result->>'passed'='false'", [enrollmentId])).rowCount);

  // A separate actual enrollment fails its first code attempt. A correct repeated
  // submission cannot regain independent credit; only an unexposed variant can.
  const newEnrollment=async()=>{
    const learnerId=randomUUID();
    await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)',[learnerId,`test:${learnerId}`,'Recovery learner']);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')",[workspaceId,learnerId]);
    const login=await app!.inject({method:'POST',url:'/auth/redeem',headers:{origin:'http://localhost:4310'},payload:{token:await issueLoginCode(db,learnerId)}});assert.equal(login.statusCode,200,login.body);
    headers={origin:'http://localhost:4310',cookie:login.cookies.map(c=>`${c.name}=${c.value}`).join('; '),'x-csrf-token':login.json().csrfToken};
    assert.equal((await send('POST',registryUrl,{expectedRegistryRevision:1,configuration:recovery.config})).statusCode,403);
    const response=await send('POST','/api/enrollments',{releaseId});assert.equal(response.statusCode,200,response.body);enrollmentId=response.json().id;
    assert.equal((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1',[enrollmentId])).rows[0].count,'0');
  };
  const fresh=async()=>{
    const snapshot=(await send('GET',`/api/enrollments/${enrollmentId}`)).json();
    const payload={expectedRevision:snapshot.revision,expectedPlanRevision:snapshot.planRevision,idempotencyKey:randomUUID(),episodeId:'min',objectiveId:'minimum',familyId:'implementation',mode:'independent'};
    const response=await send('POST',`/api/enrollments/${enrollmentId}/adaptation/fresh-question`,payload);
    return {response,payload};
  };
  await newEnrollment();
  let check=await command('challenges',{episodeId:'min',assessmentId:'min-code',mode:'independent'});
  assert.equal((await command('answers',{challengeId:check.challengeId,answer:'def solve(values):\n    return max(values)\n'})).result.passed,false);
  check=await command('challenges',{episodeId:'min',assessmentId:'min-code',mode:'independent'});
  const corrected=await command('answers',{challengeId:check.challengeId,answer:'def solve(values):\n    return min(values)\n'});
  assert.equal(corrected.result.passed,true);assert.equal(corrected.result.independent,false);
  const failedPlan=(await send('GET',`/api/enrollments/${enrollmentId}`)).json().planRevision;
  registry.codeReady=false;
  const unavailable=await fresh();assert.equal(unavailable.response.statusCode,409);assert.equal(unavailable.response.json().error,'EVALUATOR_NOT_CONFIGURED');
  assert.equal((await send('GET',`/api/enrollments/${enrollmentId}`)).json().planRevision,failedPlan);registry.codeReady=true;
  const replacement=await fresh();assert.equal(replacement.response.statusCode,200,replacement.response.body);
  const variant=replacement.response.json();assert.equal(variant.question.type,'code');assert.equal(variant.independentEligible,true);
  assert(!JSON.stringify(variant).includes('fixtureRef'));assert(!('hiddenFixtures' in variant));
  const replay=await send('POST',`/api/enrollments/${enrollmentId}/adaptation/fresh-question`,replacement.payload);assert.deepEqual(replay.json(),variant);
  const result=await command('answers',{challengeId:variant.challengeId,answer:'def solve(values):\n    return values.index(min(values))\n'});
  assert.equal(result.result.passed,true);assert.equal(result.result.independent,true);assert.equal(result.result.execution.passedCases,4);
  const bound=(await db.query('SELECT family_id FROM attempts WHERE enrollment_id=$1 AND assessment_id=$2',[enrollmentId,variant.question.id])).rows[0];assert.equal(bound.family_id,'implementation');
  const beforeGate=(await send('GET',`/api/enrollments/${enrollmentId}`)).json();assert.equal(beforeGate.lessons[0].gate.passed,false);
  for(const [assessmentId,answer] of [['min-a','two'],['min-b',4]] as const){const challenge=await command('challenges',{episodeId:'min',assessmentId,mode:'independent'});assert.equal((await command('answers',{challengeId:challenge.challengeId,answer})).result.independent,true);}
  const afterGate=(await send('GET',`/api/enrollments/${enrollmentId}`)).json();assert.equal(afterGate.lessons[0].gate.passed,true);assert.equal(afterGate.lessons[0].gate.objectives[0].required,3);
  await command('read',{episodeId:'min',blockId:'min-text'});await command('complete',{episodeId:'min'});
  const large=await command('challenges',{episodeId:'max',assessmentId:'large-max-code',mode:'independent'});
  const largeResult=await command('answers',{challengeId:large.challengeId,answer:'def solve(data):\n    return [max(data["a"],data["b"])]*data["n"]'});
  assert.equal(largeResult.result.passed,true);assert.equal(largeResult.result.execution.passedCases,3);assert.equal(largeResult.result.execution.batchesCompleted,2);assert(largeResult.result.execution.outputBytes<=65536);
  const late=await command('challenges',{episodeId:'max',assessmentId:'large-max-code',mode:'practice'});
  const partial=await command('answers',{challengeId:late.challengeId,answer:'def solve(data):\n    return [1 if data["a"] < 0 else max(data["a"],data["b"])]*data["n"]'});
  assert.equal(partial.result.passed,false);assert.equal(partial.result.execution.passedCases,2);assert.equal(partial.result.execution.batchesCompleted,2);

  // Exhaust both reviewed replacements in another enrollment. No endless reuse,
  // silent credit, extra charge or misleading recovery button is allowed.
  await newEnrollment();
  for(const [assessmentId,answer] of [['min-a','two'],['min-b',4],['min-code','def solve(values): return None']] as const){const challenge=await command('challenges',{episodeId:'min',assessmentId,mode:'independent'});await command('answers',{challengeId:challenge.challengeId,answer});}
  for(let i=0;i<2;i++){const replacement=await fresh();assert.equal(replacement.response.statusCode,200,replacement.response.body);await command('answers',{challengeId:replacement.response.json().challengeId,answer:'def solve(values): return None'});}
  const exhausted=(await send('GET',`/api/enrollments/${enrollmentId}`)).json();assert.equal(exhausted.recovery[0].freshCheck,null);
  const denied=await fresh();assert.equal(denied.response.statusCode,409);assert.equal(denied.response.json().error,'APPROVED_FRESH_VARIANT_EXHAUSTED');
  assert.equal((await send('GET',`/api/enrollments/${enrollmentId}`)).json().planRevision,exhausted.planRevision);
  assert.equal((await db.query('SELECT count(*) FROM adaptation_applications WHERE enrollment_id=$1',[enrollmentId])).rows[0].count,'2');
  console.log(JSON.stringify({ verified: true, storage: 'real-postgresql', execution: 'real-container', matchingReferenceCases: 4, duplicateAnswerReplayed: true, wrongProgramRejected: true, privateOracleNotReturned: true,
    freshCodeRecovery:true,correctedRepeatIneligible:true,unchangedThreeFamilyGate:true,exhaustedBankDeniedWithoutCharge:true,unreadyGraderDeniedWithoutMutation:true,largeApiFixtureBatched:true,laterBatchFailureNotCredited:true }));
} finally {
  await app?.close(); await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); await rm(storage, { recursive: true, force: true });
}
