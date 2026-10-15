import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { fromVisualExperience, VisualRuntime } from '@course-core/visuals/headless';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { svgRenderer } from '../src/svg-renderer.js';
import { teachingContext } from '../src/provider-context.js';
import { fixture } from './fixture.js';
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

const origin='http://localhost:4310', schema=`course_interactive_${randomUUID().replaceAll('-','')}`;
let db: Database, root: Database, app: Awaited<ReturnType<typeof createServer>>, workspaceId: string, releaseId: string;
const visual=visualContextFixture(), runtime=new VisualRuntime(fromVisualExperience(visual));
const frame={schemaVersion:1,sceneVersion:1,episodeId:'min',blockId:'diagram-one',visualId:visual.id,rendererId:visual.rendererId,
  sceneFingerprint:runtime.exportReplay().sceneFingerprint,state:{amount:4,enabled:true,mode:'square'},timeMs:500,layout:'compact',reducedMotion:false};
beforeAll(async()=> {
  if(process.env.DATABASE_URL || !process.env.TEST_DATABASE_URL)throw new Error('Use the disposable TEST_DATABASE_URL only.');
  const url=new URL(process.env.TEST_DATABASE_URL);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !/^\/course_core_(ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)throw new Error('Disposable loopback database required.');
  root=createDatabase(url.href); await root.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options',`-csearch_path=${schema}`); db=createDatabase(url.href);
  await migrate(db,fileURLToPath(new URL('../migrations',import.meta.url)));
  const renderer=await svgRenderer(); app=await createServer(db, { loginCodes: true,origin,secureCookies:false,installedExtensions:[renderer]});
  const source=fixture(); source.visuals.push(visual); source.chapters[0]!.episodes[0]!.blocks.push({id:'diagram-one',type:'visual',visualId:visual.id});
  source.extensions.push({id:renderer.id,version:renderer.version,integrity:renderer.integrity,execution:'declarative',entrypoint:'renderers/svg-v1.js',platforms:['web'],capabilities:['visual.render'],accessibility:{keyboard:true,reducedMotion:true,textAlternative:visual.accessibility.description}});
  const compiled=compileCourse(source), owner=randomUUID(); workspaceId=randomUUID(); releaseId=randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)',[owner,`interactive:${owner}`,'Test author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)',[workspaceId,'interactive','Interactive tests']);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",[releaseId,workspaceId,source.id,source.version,compiled.digest,JSON.stringify(compiled.server),JSON.stringify(compiled.learner),owner]);
});
afterAll(async()=> {await app?.close();await db?.end();if(root){await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await root.end();}});
async function fresh(){
  const user=randomUUID();await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)',[user,`interactive:${user}`,'Test learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')",[workspaceId,user]);
  const login=await app.inject({method:'POST',url:'/auth/redeem',headers:{origin},payload:{token:await issueLoginCode(db,user)}});
  expect(login.statusCode,login.body).toBe(200);
  const headers={origin,cookie:login.cookies.map(c=>`${c.name}=${c.value}`).join('; '),'x-csrf-token':login.json().csrfToken};
  const enrolled=await app.inject({method:'POST',url:'/api/enrollments',headers,payload:{releaseId}});expect(enrolled.statusCode,enrolled.body).toBe(200);
  return {id:enrolled.json().id as string,user,headers};
}
async function revision(id:string){return Number((await db.query('SELECT revision FROM enrollments WHERE id=$1',[id])).rows[0].revision);}
it('explicit companion request stores recomputed context, survives replay and reaches teaching context without evidence or rich Temporal payloads',async()=> {
  const f=await fresh(), key=randomUUID(), payload={expectedRevision:await revision(f.id),idempotencyKey:key,episodeId:'min',blockId:'diagram-one',content:'Why does this result change?',interactiveContext:frame};
  const post=()=>app.inject({method:'POST',url:`/api/enrollments/${f.id}/companion`,headers:f.headers,payload});
  const response=await post();expect(response.statusCode,response.body).toBe(200);expect((await post()).json()).toEqual(response.json());
  const stored=(await db.query('SELECT context FROM companion_messages WHERE id=$1',[response.json().messageId])).rows[0].context;
  expect(stored.interactiveContext).toMatchObject({authority:'context-only',provenance:'learner-reported-state',timeMs:500});
  expect(stored.interactiveContext.settings).toHaveLength(3);
  expect(stored.interactiveContext.settings).toEqual(expect.arrayContaining([{key:'amount',label:'Amount',value:4},{key:'enabled',label:'Show result',value:true},{key:'mode',label:'Rule',value:'square'}]));
  expect(stored.interactiveContext.readout.join(' ')).toContain('16');
  expect(stored.interactiveContext).not.toHaveProperty('nodes');
  // The learner model is read on behalf of an admitted supervisor job of this enrollment.
  const jobId=randomUUID();
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES($1,$2,$3,$4,'companion','running',1,'{}')`,[jobId,f.id,workspaceId,`interactive-${jobId}`]);
  const teaching=await teachingContext(db,{jobId,workspaceId,enrollmentId:f.id,generation:1},{kind:'learning_event',eventId:response.json().eventId,eventType:'companion.requested',courseReleaseId:releaseId,episodeId:'min',blockId:'diagram-one',messageId:response.json().messageId});
  expect(teaching.interactiveContext).toEqual(stored.interactiveContext);
  expect(teaching.constraints.resolvedPolicy).toMatchObject({authority:'server_resolved_policy_not_model_permission',scopeId:'episode:min',policyRevision:1,extensionConsent:'a_suggestion_is_not_consent_or_a_grant'});
  expect(teaching.revisions!.enrollment).toBe(await revision(f.id));
  expect(teaching.constraints.resolvedPolicy!.ancestorScopeIds).toEqual(['course','chapter:order','episode:min']);
  expect((await db.query('SELECT count(*) FROM evidence WHERE enrollment_id=$1',[f.id])).rows[0].count).toBe('0');
  const event=(await db.query('SELECT payload FROM learning_events WHERE id=$1',[response.json().eventId])).rows[0].payload;
  expect(event).not.toHaveProperty('interactiveContext');expect(JSON.stringify(event)).not.toContain('square');
});
it('context for an unknown lesson is rejected instead of quietly switching to the first lesson',async()=>{
  const f=await fresh();
  await expect(teachingContext(db,{jobId:randomUUID(),workspaceId,enrollmentId:f.id,generation:1},{kind:'learning_event',eventId:randomUUID(),eventType:'learning.updated',courseReleaseId:releaseId,episodeId:'foreign'})).rejects.toMatchObject({code:'PROVIDER_CONTEXT_NOT_FOUND'});
});
it('forged or stale context rolls back help consent, message, revision and outbox effects',async()=> {
  const f=await fresh();
  const challenge=await app.inject({method:'POST',url:`/api/enrollments/${f.id}/challenges`,headers:f.headers,payload:{expectedRevision:await revision(f.id),idempotencyKey:randomUUID(),episodeId:'min',assessmentId:'min-a',mode:'independent'}});expect(challenge.statusCode,challenge.body).toBe(200);
  const before=await revision(f.id);
  for(const invalid of [{...frame,sceneFingerprint:'123-a-b'},{...frame,state:{...frame.state,amount:900}},{...frame,readout:['FORGED_RESULT']},{...frame,episodeId:'max'}]){
    const response=await app.inject({method:'POST',url:`/api/enrollments/${f.id}/companion`,headers:f.headers,payload:{expectedRevision:before,idempotencyKey:randomUUID(),episodeId:'min',blockId:'diagram-one',content:'Explain this.',allowAssessmentAssistance:true,interactiveContext:invalid}});
    expect([400,409]).toContain(response.statusCode);expect(await revision(f.id)).toBe(before);
  }
  expect((await db.query('SELECT independent_eligible FROM assessment_challenges WHERE id=$1',[challenge.json().challengeId])).rows[0].independent_eligible).toBe(true);
  expect((await db.query('SELECT count(*) FROM companion_messages WHERE enrollment_id=$1',[f.id])).rows[0].count).toBe('0');
  expect((await db.query("SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.requested'",[f.id])).rows[0].count).toBe('0');
});
