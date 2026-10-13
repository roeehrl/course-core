import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {compileCourse} from '@course-core/sdk/compiler';
import type {ProviderAdapter,UsageReceipt} from '@course-core/providers';
import type {HostBridge,ProviderRequest} from '@course-core/supervisor';
import {createDatabase,transaction,type Database} from '../src/database.js';
import {migrate} from '../src/migrations.js';
import {createServer} from '../src/server.js';
import {issueLoginCode} from '../src/auth.js';
import {appendEvent} from '../src/events.js';
import {configureSupervisorBudget,createPostgresSupervisorBridge} from '../src/supervisor-bridge.js';
import {composeProviders} from '../src/provider-composition.js';
import {supervisorSupportFixture} from './supervisor-support-fixture.js';

const schema='supervisor_tools_'+randomUUID().replaceAll('-',''),workspace=randomUUID(),origin='http://localhost:4310',token=randomUUID(),fixture=supervisorSupportFixture();
let db:Database,admin:Database,app:Awaited<ReturnType<typeof createServer>>,bridge:HostBridge,owner:{id:string;cookie:string;csrf:string},releaseId:string,calls=0;
const usage:UsageReceipt={accounting:{accountingKey:'synthetic'},providerId:'test',modelId:'planner',operation:'assess',attempts:[{attempt:1,status:200,outcome:'response',tokens:{input:10,output:20,total:30,cachedInput:0,thoughts:0,toolInput:0}}],inputCharacters:100,requestedMaxOutputTokens:1000,requestedVideoSeconds:null,observedImageCount:null,observedVideoCount:null,cost:null};
const adapter:ProviderAdapter={providerId:'test',validateModel(){},ports:{structured_assessment:{async assess(req){calls++;const count=Number(req.accounting.accountingKey.split(':round-')[1]);return {usage,output:count===0?{decision:'tool',tool:'list_support',argumentsJson:'{}',summary:''}:count===1?{decision:'tool',tool:'choose_support',argumentsJson:JSON.stringify({profileId:'ordering-support-profile',entryId:'number-line-support'}),summary:''}:{decision:'finish',tool:'none',argumentsJson:'{}',summary:'Use the reviewed number-line explanation.'}};}}}};
const jobPolicy={allowance:{microUsd:100000,tokens:600000}};
const headers=(s:{cookie:string;csrf:string})=>({cookie:s.cookie,origin,'x-csrf-token':s.csrf});
async function login(role='learner'){
  const id=randomUUID();await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)',[id,'test:'+id,'Scoped learner']);await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspace,id,role]);
  const r=await app.inject({method:'POST',url:'/auth/redeem',headers:{origin},payload:{token:await issueLoginCode(db,id)}});expect(r.statusCode,r.body).toBe(200);return {id,cookie:r.cookies.map(c=>`${c.name}=${c.value}`).join('; '),csrf:r.json().csrfToken};
}
beforeAll(async()=>{
  if(!process.env.TEST_DATABASE_URL||process.env.DATABASE_URL)throw Error('Disposable TEST_DATABASE_URL required');const url=new URL(process.env.TEST_DATABASE_URL);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname)||url.search||url.hash)throw Error('Disposable loopback database required');
  admin=createDatabase(url.href);await admin.query(`CREATE SCHEMA ${schema}`);url.searchParams.set('options','-csearch_path='+schema);db=createDatabase(url.href);await migrate(db,fileURLToPath(new URL('../migrations',import.meta.url)));
  const providers=composeProviders({registry:{revision:'tools-test',models:[{id:'planner',providerId:'test',remoteModel:'planner',providerConfig:{},enabled:true,capabilities:['structured_assessment'],limits:{maxInputCharacters:40000,maxOutputTokens:2000}}]},adapters:[{id:'test',kind:'test',credentialEnv:'COURSE_PROVIDER_TEST_API_KEY'}],roles:{supervisor:{modelId:'planner',maxInputCharacters:30000,maxOutputTokens:1000,maxToolRounds:4}}},()=> 'synthetic', {test:()=>adapter});
  app=await createServer(db,{origin,secureCookies:false,adaptation:fixture.runtime,providers,supervisor:{serviceToken:token,workspaceIds:[workspace],jobPolicy}});bridge=createPostgresSupervisorBridge(db,{workspaceIds:[workspace],jobPolicy});
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)',[workspace,'tools','Public tool qualification']);owner=await login('owner');
  const imported=await app.inject({method:'POST',url:`/api/workspaces/${workspace}/releases`,headers:headers(owner),payload:fixture.course});expect(imported.statusCode,imported.body).toBe(200);releaseId=imported.json().id;
  const publish=await app.inject({method:'POST',url:`/api/releases/${releaseId}/publish`,headers:headers(owner)});expect(publish.statusCode,publish.body).toBe(200);
  const approved=await app.inject({method:'POST',url:`/api/admin/releases/${releaseId}/adaptation-registry`,headers:headers(owner),payload:{expectedRegistryRevision:0,configuration:fixture.config}});expect(approved.statusCode,approved.body).toBe(200);
  await configureSupervisorBudget(db,{workspaceId:workspace},{microUsd:10000000,tokens:10000000});
},30000);
afterAll(async()=>{await app?.close();await db?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
async function prepare(consent=true){
  const learner=await login(),enrolled=await app.inject({method:'POST',url:'/api/enrollments',headers:headers(learner),payload:{releaseId}});expect(enrolled.statusCode,enrolled.body).toBe(200);const id=enrolled.json().id;
  const snapshot=async()=>{const r=await app.inject({url:`/api/enrollments/${id}`,headers:headers(learner)});expect(r.statusCode,r.body).toBe(200);return r.json();};
  const setting=await app.inject({method:'POST',url:`/api/enrollments/${id}/supervision`,headers:headers(learner),payload:{expectedRevision:(await snapshot()).revision,idempotencyKey:randomUUID(),adaptiveTeaching:consent}});expect(setting.statusCode,setting.body).toBe(200);
  await configureSupervisorBudget(db,{workspaceId:workspace,enrollmentId:id},{microUsd:1000000,tokens:1000000});
  const event=await transaction(db,client=>appendEvent(client,{workspaceId:workspace,enrollmentId:id,actorId:learner.id,actorKind:'learner',type:'learning.review_requested',payload:{episodeId:'min'},idempotencyKey:randomUUID(),supervise:true}));
  const outbox=(await bridge.claimOutbox(randomUUID(),100,30000)).find(e=>e.eventId===event.id)!;const [ref]=await bridge.prepareOutbox(outbox);await bridge.ackOutbox(outbox);
  const claim=await bridge.transition({type:'claim',ref:ref!,checkpointId:'generate',ownerId:randomUUID(),availability:{status:'ready'}});expect(claim.effect).toBe('invoke');const operation=claim.snapshot.operations[0]!;
  const request:ProviderRequest={schemaVersion:1,operationId:operation.id,job:claim.snapshot.specification.key,role:'supervisor',checkpoint:claim.snapshot.specification.checkpoints[0]!,fence:claim.snapshot.specification.fence};
  return {learner,id,ref:ref!,request,operation,snapshot};
}
async function invoke(job:Awaited<ReturnType<typeof prepare>>){const r=await app.inject({method:'POST',url:'/v1/operations',headers:{authorization:'Bearer '+token,'idempotency-key':job.request.operationId},payload:job.request});expect(r.statusCode,r.body).toBe(200);expect(r.json().status).toBe('succeeded');await bridge.transition({type:'settle',ref:job.ref,operationId:job.operation.id,ownerId:job.operation.ownerId,outcome:r.json()});return r.json();}
const transition=(command:unknown)=>app.inject({method:'POST',url:'/v1/supervisor/bridge',headers:{authorization:'Bearer '+token},payload:{method:'transition',command}});
it('real tools, separate verification and atomic application actually change the lesson without granting mastery',async()=>{
  const job=await prepare(),before=await job.snapshot(),count=calls;const outcome=await invoke(job);expect(calls-count).toBe(3);expect(outcome.usage.tokens).toBe(90);
  expect((await job.snapshot()).planRevision).toBe(0);
  const verified=await transition({type:'verify',ref:job.ref});expect(verified.statusCode,verified.body).toBe(200);expect(verified.json().snapshot.state).toBe('ready');
  const applied=await transition({type:'apply',ref:job.ref});expect(applied.statusCode,applied.body).toBe(200);expect(applied.json().snapshot.state).toBe('applied');
  const after=await job.snapshot();expect(after.planRevision).toBe(1);expect(after.course.chapters[0].episodes[0].blocks.some((b:any)=>b.type==='text'&&b.markdown===fixture.markdown)).toBe(true);expect(after.lessons[0].gate).toEqual(before.lessons[0].gate);expect((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1',[job.id])).rows[0].count).toBe('0');
  const replay=await transition({type:'apply',ref:job.ref});expect(replay.statusCode,replay.body).toBe(200);expect(replay.json().snapshot.applicationReceiptId).toBe(applied.json().snapshot.applicationReceiptId);expect((await db.query('SELECT count(*) FROM supervisor_plan_effects WHERE enrollment_id=$1',[job.id])).rows[0].count).toBe('1');
  const events=(await db.query("SELECT actor_kind FROM learning_events WHERE enrollment_id=$1 AND event_type='adaptation.applied'",[job.id])).rows;expect(events).toEqual([{actor_kind:'agent'}]);
},30000);
it('lack of learner opt-in prevents a model from selecting or delivering support',async()=>{
  const job=await prepare(false);await invoke(job);const verify=await transition({type:'verify',ref:job.ref});expect(verify.statusCode,verify.body).toBe(200);const applied=await transition({type:'apply',ref:job.ref});expect(applied.statusCode,applied.body).toBe(200);expect((await job.snapshot()).planRevision).toBe(0);expect((await db.query('SELECT count(*) FROM supervisor_plan_effects WHERE enrollment_id=$1',[job.id])).rows[0].count).toBe('0');
});
it('learner permission changes fence a ready job; staff cannot manufacture learner consent',async()=>{
  const job=await prepare();await invoke(job);expect((await transition({type:'verify',ref:job.ref})).json().snapshot.state).toBe('ready');
  const before=await job.snapshot(),denied=await app.inject({method:'POST',url:`/api/enrollments/${job.id}/supervision`,headers:headers(owner),payload:{expectedRevision:before.revision,idempotencyKey:randomUUID(),adaptiveTeaching:true}});expect([403,404]).toContain(denied.statusCode);
  const revoked=await app.inject({method:'POST',url:`/api/enrollments/${job.id}/supervision`,headers:headers(job.learner),payload:{expectedRevision:before.revision,idempotencyKey:randomUUID(),adaptiveTeaching:false}});expect(revoked.statusCode,revoked.body).toBe(200);
  const stale=await transition({type:'apply',ref:job.ref});expect(stale.json().snapshot.state).not.toBe('applied');expect((await job.snapshot()).planRevision).toBe(0);
});
