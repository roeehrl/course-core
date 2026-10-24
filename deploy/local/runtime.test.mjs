import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,lstat,readFile,mkdir,symlink,link,writeFile,readdir,open} from 'node:fs/promises';
import {createServer,connect} from 'node:net';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import path from 'node:path';
import {privateDirectory,privateFile,privateFileInfo,writePrivate,control,controlPath,controlServer,socketInfo,mutex,RotatingLog,uid,hash,portFree} from './runtime.mjs';
import {loadConfiguration,servicePlan,runPilot,main as pilotMain,parseOriginsArguments,manageOrigins,additionalOriginsConfiguration,MAX_ADDITIONAL_ORIGINS,managePackageDirectories,parsePackageDirectoriesArguments,MAX_COURSE_PACKAGE_DIRECTORIES,parseSecurityArguments,manageSecurity,allowInsecureOriginsConfiguration,mediaToolsConfiguration} from './pilot.mjs';
import {manager,launchdDefinition,plist} from './service.mjs';
async function fixture(body){const directory=await mkdtemp('/tmp/cc-rt-');try{return await body(await privateDirectory(directory));}finally{await rm(directory,{recursive:true,force:true});}}
async function executableFixture(root){for(const filename of ['.local/bin/temporal','services/api/dist/main.js','services/supervisor/dist/src/cli.js','apps/learner/dist/index.html','apps/admin/dist/index.html']){const target=path.join(root,filename);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await writeFile(target,filename.endsWith('.html')?'<!doctype html>':'#!/usr/bin/env node\nprocess.exit(0);\n',{mode:0o700});}}
const config=()=>({schemaVersion:1,publicOrigin:'http://127.0.0.1:44310',databaseUrl:'postgresql://test_runner@127.0.0.1/course_core_test',temporalPort:44311,temporalUiPort:44312,serviceToken:randomBytes(32).toString('hex'),workspaceIds:[],codeFixtureFiles:[]});
test('private state refuses permissive directories, symlinks and multiply-linked secret files',()=>fixture(async state=>{
  const file=path.join(state,'protected.json');await writePrivate(file,'{}');assert.equal((await lstat(file)).mode&0o777,0o600);
  await symlink(file,path.join(state,'alias'));await assert.rejects(privateFile(path.join(state,'alias')));
  await link(file,path.join(state,'hard'));await assert.rejects(privateFile(file));await rm(path.join(state,'hard'));
  await chmod(file,0o644);await assert.rejects(privateFile(file));await chmod(state,0o755);await assert.rejects(privateDirectory(state,false));
}));
test('an inode replaced after open is a whole earlier version, never an insecure file',()=>fixture(async state=>{
  // Deterministic form of the race below: hold the old inode open across a rename() replacement.
  const file=path.join(state,'owner.json');await writePrivate(file,JSON.stringify({version:0}));
  const held=await open(file,'r');
  try{
    await writePrivate(file,JSON.stringify({version:1}),true);
    const stale=await held.stat();assert.equal(stale.nlink,0);
    assert.equal(privateFileInfo(stale),stale);assert.equal(JSON.parse(await held.readFile('utf8')).version,0);
    assert.equal(JSON.parse((await privateFile(file)).text).version,1);
    const permissive=Object.assign(Object.create(Object.getPrototypeOf(stale)),stale,{mode:stale.mode|0o044});
    assert.throws(()=>privateFileInfo(permissive),/insecure_private_file/);
    assert.throws(()=>privateFileInfo(stale,1),/insecure_private_file/);
  }finally{await held.close();}
  await link(file,path.join(state,'hard'));
  const linked=await open(file,'r');try{const info=await linked.stat();assert.equal(info.nlink,2);assert.throws(()=>privateFileInfo(info),/insecure_private_file/);}finally{await linked.close();}
  await assert.rejects(privateFile(file),/insecure_private_file/);
}));
test('a reader racing atomic replacements reads a whole version, never a false insecure-file refusal',()=>fixture(async state=>{
  // Opening the old file just before rename() replaces it leaves the reader holding an inode with nlink 0,
  // and under CPU contention that can repeat many times in a row. Several writers keep replacements dense.
  const file=path.join(state,'owner.json');await writePrivate(file,JSON.stringify({version:0}));
  let writing=true,version=0;const writers=Array.from({length:3},()=>(async()=>{while(writing)await writePrivate(file,JSON.stringify({version:++version}),true);})());
  try{for(let i=0;i<10000;i++){const {text}=await privateFile(file);assert(Number.isInteger(JSON.parse(text).version));}}
  finally{writing=false;await Promise.all(writers);}
  assert(version>0);
}));
test('exclusive writes and mutex ownership prevent overwrite or racing transitions',()=>fixture(async state=>{
  const file=path.join(state,'one.json');await writePrivate(file,'first');await assert.rejects(writePrivate(file,'replacement'));assert.equal((await privateFile(file)).text,'first');
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const first=mutex(state,'test.lock',async()=>{enter();await held;return 'done';});await entered;await assert.rejects(mutex(state,'test.lock',async()=>{}),/transition_busy/);release();assert.equal(await first,'done');assert(!((await readdir(state)).includes('test.lock')));
}));
test('authenticated control on a real Unix socket requires owner identity and one-use challenge before stop',()=>fixture(async state=>{
  let stops=0;const owner={schemaVersion:2,kind:'course-core-local-pilot',state,root:state,uid:uid(),instanceId:randomUUID(),controlToken:randomBytes(32).toString('hex'),pid:process.pid,ports:[44310,44311,44312],children:{},pending:null,phase:'running',socket:null};
  const server=controlServer(owner,()=>({status:'running',instanceId:owner.instanceId}),()=>{stops++;});
  await new Promise(resolve=>server.server.listen(controlPath(state),resolve));await chmod(controlPath(state),0o600);owner.socket=await socketInfo(state);await writePrivate(path.join(state,'owner.json'),JSON.stringify(owner));
  try{
    const closed=await new Promise(resolve=>{const socket=connect(controlPath(state));socket.on('error',()=>{});socket.on('connect',()=>socket.write(JSON.stringify({protocol:2,action:'stop',instanceId:owner.instanceId,nonce:'a'.repeat(64),mac:'b'.repeat(64)})+'\n'));socket.on('close',()=>resolve(true));});assert(closed);assert.equal(stops,0);
    assert.equal((await control(state,'status')).status,'running');assert.equal(stops,0);assert.equal((await control(state,'stop')).status,'stopping');assert.equal(stops,1);
    await server.close();const received=[];
    const replacement=createServer(socket=>socket.once('data',bytes=>{received.push(JSON.parse(bytes.toString()).action);socket.destroy();}));
    await new Promise(resolve=>replacement.listen(controlPath(state),resolve));await chmod(controlPath(state),0o600);
    // Linux can immediately reuse the unlinked socket inode. Authentication
    // still has to fail before the client sends any stop action.
    try{await assert.rejects(control(state,'stop'),/socket_identity_changed|control_unverified_or_unavailable/);assert.equal(stops,1);assert(received.every(action=>action==='hello'));}finally{await new Promise(resolve=>replacement.close(resolve));}
  }finally{if(server.server.listening)await server.close();}
}));
test('legacy owner records fail closed without sending a command or signaling a PID',()=>fixture(async state=>{
  await writePrivate(path.join(state,'owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await assert.rejects(control(state,'stop'),/legacy_or_unknown_owner/);assert.doesNotThrow(()=>process.kill(process.pid,0));
}));
test('fresh queues are stable, while existing Temporal state requires an explicit preserved queue',()=>fixture(async state=>{
  await executableFixture(state);
  const c=config();await writePrivate(path.join(state,'config.json'),JSON.stringify(c));
  const one=await loadConfiguration(state,state),two=await loadConfiguration(state,state);assert.equal(one.config.temporalTaskQueue,two.config.temporalTaskQueue);assert.equal(one.config.temporalTaskQueue,`course-core-pilot-${hash(state).slice(0,24)}`);
  await writeFile(path.join(state,'temporal.db'),'synthetic persisted-state marker',{mode:0o600});await assert.rejects(loadConfiguration(state,state),/existing_temporal_queue_required/);
  c.temporalTaskQueue='old-queue-with-waiting-work';await writePrivate(path.join(state,'config.json'),JSON.stringify(c),true);assert.equal((await loadConfiguration(state,state)).config.temporalTaskQueue,c.temporalTaskQueue);
}));
test('service plans preserve queue identity across instance changes and apply bounded runtime resources',()=>fixture(async state=>{
  await executableFixture(state);
  const c=config();c.temporalTaskQueue='durable-queue';await writePrivate(path.join(state,'config.json'),JSON.stringify(c));const loaded=await loadConfiguration(state,state);
  const one=servicePlan(state,state,loaded.config,randomUUID()),two=servicePlan(state,state,loaded.config,randomUUID());
  assert.equal(one[2].env.SUPERVISOR_TEMPORAL_TASK_QUEUE,two[2].env.SUPERVISOR_TEMPORAL_TASK_QUEUE);assert.equal(one[2].env.SUPERVISOR_TEMPORAL_TASK_QUEUE,'durable-queue');
  assert(one[1].args.includes('--max-old-space-size=512'));assert(one[2].args.includes('--max-old-space-size=384'));assert(one[3].args.includes('--max-old-space-size=128'));assert.equal(one[0].env.GOMEMLIMIT,'384MiB');
  assert(!Object.hasOwn(one[2].env,'DATABASE_URL'));assert(!Object.hasOwn(one[2].env,'PROVIDER_CONFIG_FILE'));
}));
test('invalid resource and provider environment settings cannot escape the bounded process plan',()=>fixture(async state=>{
  for(const changed of [{resources:{workerConcurrency:999}},{resources:{apiHeapMiB:100000}},{temporalTaskQueue:'queue\nextra'},{providerCredentials:{NODE_OPTIONS:'--require untrusted'}}]){
    const c={...config(),...changed};await writePrivate(path.join(state,'config.json'),JSON.stringify(c),true);await assert.rejects(loadConfiguration(state,state));
  }
}));
test('media tools are optional host programs passed only to the API as the CLIP_* variables',()=>fixture(async state=>{
  await executableFixture(state);const bin=path.join(state,'tools');await mkdir(bin,{mode:0o700});
  const tool=async(name,mode=0o700)=>{const file=path.join(bin,name);await writeFile(file,'#!/bin/sh\nexit 0\n',{mode});await chmod(file,mode);return file;};
  const ffmpeg=await tool('ffmpeg'),ffprobe=await tool('ffprobe'),rasterizer=await tool('rsvg-convert'),plain=await tool('not-executable',0o600);
  await writePrivate(path.join(state,'config.json'),JSON.stringify(config()),true);
  let loaded=await loadConfiguration(state,state);assert.equal(loaded.config.mediaTools,null);
  for(const service of servicePlan(state,state,loaded.config,randomUUID()))for(const name of ['CLIP_FFMPEG_PATH','CLIP_FFPROBE_PATH','CLIP_RASTERIZER_PATH'])assert(!Object.hasOwn(service.env,name));
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),mediaTools:{ffmpeg,ffprobe,rasterizer}}),true);
  loaded=await loadConfiguration(state,state);assert.deepEqual(loaded.config.mediaTools,{ffmpeg,ffprobe,rasterizer});
  const plan=servicePlan(state,state,loaded.config,randomUUID()),api=plan.find(service=>service.name==='api');
  assert.equal(api.env.CLIP_FFMPEG_PATH,ffmpeg);assert.equal(api.env.CLIP_FFPROBE_PATH,ffprobe);assert.equal(api.env.CLIP_RASTERIZER_PATH,rasterizer);
  for(const service of plan.filter(service=>service.name!=='api'))assert(!Object.keys(service.env).some(name=>name.startsWith('CLIP_')),service.name);
  // ffmpeg alone (frame check only): the API finds ffprobe beside it; no other variable is set.
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),mediaTools:{ffmpeg}}),true);
  const only=servicePlan(state,state,(await loadConfiguration(state,state)).config,randomUUID()).find(service=>service.name==='api').env;
  assert.equal(only.CLIP_FFMPEG_PATH,ffmpeg);assert(!Object.hasOwn(only,'CLIP_FFPROBE_PATH'));assert(!Object.hasOwn(only,'CLIP_RASTERIZER_PATH'));
  for(const [bad,code,hint] of [[null,'invalid_media_tools',/only ffmpeg, ffprobe, rasterizer/],[[ffmpeg],'invalid_media_tools',/only/],[{},'invalid_media_tools',/ffmpeg is required/],
    [{ffmpeg,extra:ffmpeg},'invalid_media_tools',/only/],[{rasterizer},'invalid_media_tools',/ffmpeg is required/],[{ffmpeg:'ffmpeg'},'invalid_media_tools',/ffmpeg must be an absolute/],
    [{ffmpeg,ffprobe:`${bin}/../tools/ffprobe`},'invalid_media_tools',/ffprobe must be an absolute, normalized/],[{ffmpeg:`${ffmpeg}\n`},'invalid_media_tools',/absolute/],[{ffmpeg,rasterizer:7},'invalid_media_tools',/rasterizer/],
    [{ffmpeg:path.join(bin,'missing')},'media_tool_missing',/ffmpeg does not exist/],[{ffmpeg:bin},'media_tool_missing',/ffmpeg is not a file/],
    [{ffmpeg,rasterizer:plain},'media_tool_not_executable',/rasterizer is not executable/]]){
    await assert.rejects(mediaToolsConfiguration(bad),error=>error.code===code&&hint.test(error.hint),JSON.stringify(bad));
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),mediaTools:bad}),true);
    await assert.rejects(loadConfiguration(state,state),error=>error.code===code,JSON.stringify(bad));
  }
}));
test('operational logs retain bounded fixed metadata, rotate, and reject raw output fields',()=>fixture(async state=>{
  const log=new RotatingLog(state,{bytes:1024,backups:2});assert.throws(()=>log.write('child_error',{content:'PRIVATE_OUTPUT_CANARY'}));
  for(let i=0;i<60;i++){log.write('child_output_discarded',{service:'api',stream:'stdout',bytes:i});await log.flush();}
  const files=(await readdir(state)).filter(f=>f.startsWith('services.log'));assert(files.length<=3);for(const file of files){assert((await lstat(path.join(state,file))).size<=1024);assert.equal((await lstat(path.join(state,file))).mode&0o777,0o600);assert(!(await readFile(path.join(state,file),'utf8')).includes('PRIVATE_OUTPUT_CANARY'));}
}));
test('sign-in settings: codes stay off by default, session lifetime is bounded and API-only',()=>fixture(async state=>{
  await executableFixture(state);
  await writePrivate(path.join(state,'config.json'),JSON.stringify(config()));
  let plan=servicePlan(state,state,(await loadConfiguration(state,state)).config,randomUUID());
  assert.equal(plan[1].env.AUTH_LOGIN_CODES,'disabled');assert(!Object.hasOwn(plan[1].env,'SESSION_HOURS'));
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),loginCodes:true,sessionHours:168}),true);
  plan=servicePlan(state,state,(await loadConfiguration(state,state)).config,randomUUID());
  assert.equal(plan[1].env.AUTH_LOGIN_CODES,'enabled');assert.equal(plan[1].env.SESSION_HOURS,'168');
  for(const service of [plan[0],plan[2],plan[3]])assert(!Object.hasOwn(service.env,'SESSION_HOURS')&&!Object.hasOwn(service.env,'AUTH_LOGIN_CODES'));
  for(const changed of [{sessionHours:0},{sessionHours:721},{sessionHours:'12'},{sessionHours:-1},{loginCodes:'enabled'},{loginCodes:1}]){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),...changed}),true);await assert.rejects(loadConfiguration(state,state));
  }
}));
test('additional origins are optional, exact https origins passed only to the API',()=>fixture(async state=>{
  await executableFixture(state);
  // An existing configuration without the key keeps working unchanged.
  await writePrivate(path.join(state,'config.json'),JSON.stringify(config()));
  let loaded=await loadConfiguration(state,state);assert.deepEqual(loaded.config.additionalOrigins,[]);
  let plan=servicePlan(state,state,loaded.config,randomUUID());for(const service of plan)assert(!Object.hasOwn(service.env,'ADDITIONAL_ORIGINS'));
  const origins=['https://pilot.tailnet.example','https://other.tailnet.example:8443','http://100.99.0.1:4310','http://[fd7a:115c:a1e0::1]:4310'];
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),additionalOrigins:origins}),true);
  plan=servicePlan(state,state,(await loadConfiguration(state,state)).config,randomUUID());
  assert.equal(plan[1].env.ADDITIONAL_ORIGINS,origins.join(','));assert.equal(plan[1].env.API_HOST,'127.0.0.1');assert.equal(plan[1].env.PUBLIC_ORIGIN,'http://127.0.0.1:44310');
  for(const service of [plan[0],plan[2],plan[3]])assert(!Object.hasOwn(service.env,'ADDITIONAL_ORIGINS'));
  assert.equal(plan[2].env.SUPERVISOR_HOST_URL,'http://127.0.0.1:44310');
  const userinfo=(()=>{const url=new URL('https://pilot.tailnet.example');url.username='someone';return url.href.replace(/\/$/,'');})();
  const many=Array.from({length:MAX_ADDITIONAL_ORIGINS+1},(_,i)=>`https://n${i}.tailnet.example`);
  for(const [bad,code] of [['https://pilot.tailnet.example',/invalid_additional_origins/],[['http://pilot.tailnet.example'],/invalid_additional_origin/],[['http://127.0.0.1:4310'],/insecure_origin_refused/],
    [['https://pilot.tailnet.example/'],/invalid_additional_origin/],[['https://pilot.tailnet.example/path'],/invalid_additional_origin/],[['https://*.tailnet.example'],/invalid_additional_origin/],
    [[userinfo],/invalid_additional_origin/],[['http://192.168.1.5:4310'],/insecure_origin_refused/],[['http://100.128.0.1:4310'],/insecure_origin_refused/],
    [['http://100.63.255.255:4310'],/insecure_origin_refused/],[['http://100.99.0.1'],/invalid_additional_origin/],[['http://example.com'],/invalid_additional_origin/],[['https://Pilot.tailnet.example'],/invalid_additional_origin/],[[7],/invalid_additional_origin/],[many,/invalid_additional_origins/],
    [['https://a.tailnet.example','https://a.tailnet.example'],/duplicate_additional_origin/],[null,/invalid_additional_origins/]]){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),additionalOrigins:bad}),true);
    await assert.rejects(loadConfiguration(state,state),code,JSON.stringify(bad));
  }
  assert.deepEqual(additionalOriginsConfiguration(many.slice(0,MAX_ADDITIONAL_ORIGINS),'http://127.0.0.1:4310').length,MAX_ADDITIONAL_ORIGINS);
}));
test('the origins command edits config.json atomically, keeping every other key and the file mode',()=>fixture(async state=>{
  await executableFixture(state);
  const file=path.join(state,'config.json'),original={...config(),loginCodes:true,resources:{logBackups:2}};
  await writePrivate(file,JSON.stringify(original,null,2)+'\n',false,0o400);
  assert.deepEqual(await pilotMain(['origins','list','--state',state]),{status:'ok',publicOrigin:original.publicOrigin,additionalOrigins:[],allowInsecureOrigins:false});
  const added=await pilotMain(['origins','add','--state',state,'https://pilot.tailnet.example']);
  assert.deepEqual(added,{status:'updated',publicOrigin:original.publicOrigin,additionalOrigins:['https://pilot.tailnet.example'],allowInsecureOrigins:false,restartRequired:true});
  let text=await readFile(file,'utf8');assert.deepEqual(JSON.parse(text),{...original,additionalOrigins:['https://pilot.tailnet.example']});
  assert(text.startsWith('{\n  "schemaVersion"')&&text.endsWith('}\n'));assert.equal((await lstat(file)).mode&0o777,0o400);
  assert(!(await readdir(state)).some(name=>name.startsWith('config.json.new-')||name==='config.lock'));
  assert.equal((await manageOrigins({action:'add',state,origin:'https://pilot.tailnet.example'})).status,'unchanged');
  await manageOrigins({action:'add',state,origin:'https://second.tailnet.example'});
  assert.deepEqual((await loadConfiguration(state,state)).config.additionalOrigins,['https://pilot.tailnet.example','https://second.tailnet.example']);
  const before=await readFile(file,'utf8');
  for(const bad of ['http://pilot.tailnet.example','http://100.99.0.1','https://pilot.tailnet.example/','https://*.tailnet.example','pilot.tailnet.example'])
    await assert.rejects(manageOrigins({action:'add',state,origin:bad}),/invalid_additional_origin/,bad);
  // Plain http outside Tailscale is refused while the insecure-address check is on (the default).
  for(const bad of ['http://pilot.tailnet.example:4310','http://192.168.1.5:4310','http://100.63.255.255:4310','http://100.128.0.1:4310','http://[fd7a:115c:a1e1::1]:4310'])
    await assert.rejects(manageOrigins({action:'add',state,origin:bad}),error=>error.code==='insecure_origin_refused'&&error.hint.includes('Turn the insecure-address check off with: node deploy/local/pilot.mjs security insecure-origin-check off --state <dir>')&&!error.hint.includes('insecure-origins '),bad);
  // Plain http is accepted only for a literal Tailscale address with an explicit port.
  for(const ip of ['http://100.99.0.1:4310','http://[fd7a:115c:a1e0::1]:4310']){
    assert.equal((await manageOrigins({action:'add',state,origin:ip})).status,'updated');
    assert.equal((await manageOrigins({action:'remove',state,origin:ip})).status,'updated');
  }
  await assert.rejects(manageOrigins({action:'add',state,origin:original.publicOrigin}),/insecure_origin_refused/);
  for(let i=0;i<MAX_ADDITIONAL_ORIGINS-2;i++)await manageOrigins({action:'add',state,origin:`https://n${i}.tailnet.example`});
  await assert.rejects(manageOrigins({action:'add',state,origin:'https://one-too-many.tailnet.example'}),/invalid_additional_origins/);
  for(let i=0;i<MAX_ADDITIONAL_ORIGINS-2;i++)await manageOrigins({action:'remove',state,origin:`https://n${i}.tailnet.example`});
  assert.equal(await readFile(file,'utf8'),before);
  assert.equal((await manageOrigins({action:'remove',state,origin:'https://absent.tailnet.example'})).status,'unchanged');
  await manageOrigins({action:'remove',state,origin:'https://second.tailnet.example'});
  const last=await manageOrigins({action:'remove',state,origin:'https://pilot.tailnet.example'});assert.deepEqual(last.additionalOrigins,[]);
  // Removing the last origin removes the key, so the file matches the original again.
  text=await readFile(file,'utf8');assert.deepEqual(JSON.parse(text),original);assert(!Object.hasOwn(JSON.parse(text),'additionalOrigins'));
  assert.equal((await lstat(file)).mode&0o777,0o400);
  // A held configuration lock refuses a concurrent edit instead of racing it.
  await mkdir(path.join(state,'config.lock'),{mode:0o700});
  await assert.rejects(manageOrigins({action:'add',state,origin:'https://pilot.tailnet.example'}),/transition_busy/);
  await rm(path.join(state,'config.lock'),{recursive:true});
  // Compact files stay compact.
  await writePrivate(file,JSON.stringify(config()),true);await manageOrigins({action:'add',state,origin:'https://pilot.tailnet.example'});
  assert(!(await readFile(file,'utf8')).includes('\n'));
}));
test('origins arguments require an action, an origin for add/remove and at most one state directory',()=>{
  assert.deepEqual(parseOriginsArguments(['origins','add','--state','/tmp/x','https://pilot.tailnet.example']),{action:'add',state:'/tmp/x',origin:'https://pilot.tailnet.example'});
  assert.deepEqual(parseOriginsArguments(['origins','list','--state','/tmp/x']),{action:'list',state:'/tmp/x'});
  for(const bad of [['origins'],['origins','set','x'],['origins','add','--state','/tmp/x'],['origins','list','--state','/tmp/x','https://a.example'],
    ['origins','add','--state','/tmp/x','--state','/tmp/y','https://a.example'],['origins','add','--state','relative','https://a.example'],
    ['origins','add','https://a.example','https://b.example'],['origins','remove','--force','https://a.example'],['origins','add','--state']])
    assert.throws(()=>parseOriginsArguments(bad),/invalid_command|invalid_arguments|invalid_path/,JSON.stringify(bad));
});
test('an upgrade check of both runtimes accepts additional origins and never rewrites the configuration',()=>fixture(async state=>{
  // upgrade.mjs loads the same state with the new and the previous runtime root before stopping anything.
  const from=path.join(state,'from'),to=path.join(state,'to');for(const root of [from,to]){await mkdir(root,{mode:0o700});await executableFixture(root);}
  const text=JSON.stringify({...config(),temporalTaskQueue:'kept',additionalOrigins:['https://pilot.tailnet.example']});
  await writePrivate(path.join(state,'config.json'),text);
  for(const root of [to,from])assert.deepEqual((await loadConfiguration(root,state)).config.additionalOrigins,['https://pilot.tailnet.example']);
  assert.equal(await readFile(path.join(state,'config.json'),'utf8'),text);
}));
test('telemetry is absent by default and, when configured, becomes standard OTLP variables for Core services only',()=>fixture(async state=>{
  await executableFixture(state);
  await writePrivate(path.join(state,'config.json'),JSON.stringify(config()));
  let plan=servicePlan(state,state,(await loadConfiguration(state,state)).config,randomUUID());
  for(const service of plan)assert(!Object.keys(service.env).some(key=>key.startsWith('OTEL_')));
  const telemetry={otlpEndpoint:'https://example.com/api/public/otel',otlpHeaders:{Authorization:'Basic c3ludGhldGljOmV4YW1wbGU='},metrics:false};
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),telemetry}),true);
  plan=servicePlan(state,state,(await loadConfiguration(state,state)).config,randomUUID());
  for(const service of [plan[1],plan[2],plan[3]])assert.deepEqual(Object.fromEntries(Object.entries(service.env).filter(([key])=>key.startsWith('OTEL_'))),
    {OTEL_EXPORTER_OTLP_ENDPOINT:'https://example.com/api/public/otel',OTEL_EXPORTER_OTLP_PROTOCOL:'http/json',OTEL_EXPORTER_OTLP_HEADERS:'Authorization=Basic%20c3ludGhldGljOmV4YW1wbGU%3D',OTEL_METRICS_EXPORTER:'none'});
  assert(!Object.keys(plan[0].env).some(key=>key.startsWith('OTEL_')));
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),telemetry:{otlpEndpoint:'http://127.0.0.1:4318'}}),true);
  plan=servicePlan(state,state,(await loadConfiguration(state,state)).config,randomUUID());
  assert.equal(plan[1].env.OTEL_EXPORTER_OTLP_ENDPOINT,'http://127.0.0.1:4318');assert(!Object.hasOwn(plan[1].env,'OTEL_METRICS_EXPORTER')&&!Object.hasOwn(plan[1].env,'OTEL_EXPORTER_OTLP_HEADERS'));
  for(const bad of [{},{otlpEndpoint:'http://collector.example.com:4318'},{otlpEndpoint:'https://user:password@example.com'},{otlpEndpoint:'https://example.com/?key=x'},
    {otlpEndpoint:'not a url'},{otlpEndpoint:'https://example.com',otlpHeaders:{'bad name':'x'}},{otlpEndpoint:'https://example.com',otlpHeaders:{a:'x\r\ninjected: 1'}},
    {otlpEndpoint:'https://example.com',metrics:'no'},{otlpEndpoint:'https://example.com',extra:true},'https://example.com',null]){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),telemetry:bad}),true);
    await assert.rejects(loadConfiguration(state,state),/invalid_telemetry_configuration/,JSON.stringify(bad));
  }
}));
test('reviewed code recovery is an explicit API-only selection, never an executable plugin path',()=>fixture(async state=>{
  await executableFixture(state);
  const selected=['bounded-numeric-v1','authored-bank-v1','authored-code-bank-v1'];
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),adaptationAdapters:selected}));
  const loaded=await loadConfiguration(state,state),plan=servicePlan(state,state,loaded.config,randomUUID());
  assert.deepEqual(JSON.parse(plan[1].env.ADAPTATION_ADAPTERS),selected);
  for(const service of [plan[0],plan[2],plan[3]])assert(!Object.hasOwn(service.env,'ADAPTATION_ADAPTERS'));
  for(const selection of [['authored-code-bank-v1','authored-code-bank-v1'],['file:untrusted.mjs'],['arbitrary-code-bank']]){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),adaptationAdapters:selection}),true);await assert.rejects(loadConfiguration(state,state),/invalid_adaptation_adapter_selection/);
  }
}));
test('creator verifier programs are private API-only files; malformed, oversized and aliased installation inputs fail closed',()=>fixture(async state=>{
  await executableFixture(state);
  const file=path.join(state,'teaching-reference.json');await writePrivate(file,'{}');
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),teachingVerifierFiles:[file]}));
  const loaded=await loadConfiguration(state,state),plan=servicePlan(state,state,loaded.config,randomUUID());
  assert.deepEqual(JSON.parse(plan[1].env.TEACHING_VERIFIER_FILES),[file]);
  for(const service of [plan[0],plan[2],plan[3]])assert(!Object.hasOwn(service.env,'TEACHING_VERIFIER_FILES'));
  for(const files of [null,'untrusted.py',[file,file],Array(21).fill(file),['missing.json'],['bad\npath']]){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),teachingVerifierFiles:files}),true);
    await assert.rejects(loadConfiguration(state,state));
  }
  await writePrivate(path.join(state,'large.json'),'x'.repeat(262145));
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),teachingVerifierFiles:[path.join(state,'large.json')]}),true);
  await assert.rejects(loadConfiguration(state,state));
}));
test('launchd definitions use bounded resource/backoff settings and escape paths as plist data',()=>{
  const definition=launchdDefinition({root:'/tmp/a & b',state:'/tmp/state',installationId:randomUUID()});assert.equal(definition.ThrottleInterval,30);assert.equal(definition.KeepAlive.SuccessfulExit,false);assert.equal(definition.HardResourceLimits.Core,0);assert(plist(definition).includes('a &amp; b'));assert(!plist(definition).includes('<string>/tmp/a & b</string>'));
});
test('manager cannot install over an existing foreground owner or remove a modified installation',()=>fixture(async state=>{
  const root=path.join(state,'root'),agents=path.join(state,'agents');await mkdir(root);await executableFixture(root);await mkdir(agents,{mode:0o700});await writePrivate(path.join(state,'config.json'),JSON.stringify(config()));
  const calls=[],loaded=new Set(),fakeLaunchctl=async args=>{calls.push(args);if(args[0]==='print')return {code:loaded.has(args[1])?0:113};if(args[0]==='bootstrap'){const text=await readFile(args[2],'utf8');const label=/<key>Label<\/key><string>([^<]+)<\/string>/.exec(text)[1];loaded.add(`${args[1]}/${label}`);return {code:0};}return {code:-1};};
  const service=manager({root,state,agentsDirectory:agents,launchctl:fakeLaunchctl});await writePrivate(path.join(state,'owner.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await assert.rejects(service.install(),/existing_owner_requires_coordination/);assert(!calls.some(a=>a[0]==='bootstrap'));await rm(path.join(state,'owner.json'));
  const installed=await service.install();assert.equal(installed.status,'installed');const receipt=JSON.parse(await readFile(path.join(state,'installation.json'),'utf8'));await writePrivate(receipt.plistPath,'changed',true);await assert.rejects(service.uninstall(),/installation_file_changed/);assert(!calls.some(a=>a[0]==='bootout'));assert((await readdir(state)).includes('installation.json'));
}));
async function freePorts(){const held=[];try{for(let i=0;i<3;i++){const s=createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));held.push(s);}return held.map(s=>s.address().port);}finally{await Promise.all(held.map(s=>new Promise(resolve=>s.close(resolve))));}}
async function waitRunning(state){const until=Date.now()+10000;while(Date.now()<until){try{const status=await control(state,'status');if(status.status==='running')return status;}catch{}await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Owned fixture pilot did not start');}
test('actual four-service start/stop/restart preserves configuration and removes only its owned children and control state',{timeout:30000},()=>fixture(async state=>{
  const root=path.join(state,'root');await mkdir(root);await executableFixture(root);const ports=await freePorts(),c=config();c.publicOrigin=`http://127.0.0.1:${ports[0]}`;c.temporalPort=ports[1];c.temporalUiPort=ports[2];c.temporalTaskQueue='persisted-fixture-queue';await writePrivate(path.join(state,'config.json'),JSON.stringify(c));
  const fakeTemporal=`#!/usr/bin/env node\nconst http=require('node:http');const flag=n=>Number(process.argv[process.argv.indexOf(n)+1]);const servers=[flag('--port'),flag('--ui-port')].map(p=>http.createServer((q,r)=>r.end('{}')).listen(p,'127.0.0.1'));process.on('SIGTERM',()=>{servers.forEach(s=>s.close());setTimeout(()=>process.exit(0),10);});\n`;
  await writeFile(path.join(root,'.local/bin/temporal'),fakeTemporal,{mode:0o700});
  // The fixture is not a pinned build: start is allowed only through the explicit configured digest.
  c.temporalCliSha256=createHash('sha256').update(fakeTemporal).digest('hex');await writePrivate(path.join(state,'config.json'),JSON.stringify(c),true);
  await writeFile(path.join(root,'services/api/dist/main.js'),`const http=require('node:http');const server=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({instanceId:process.env.CORE_INSTANCE_ID}));}).listen(Number(process.env.PORT),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`,{mode:0o700});
  await writeFile(path.join(root,'services/supervisor/dist/src/cli.js'),`console.log('PRIVATE_CHILD_OUTPUT_CANARY');setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));\n`,{mode:0o700});
  let running;
  try{
    const unchanged=await readFile(path.join(state,'config.json'),'utf8');running=runPilot({root,state});const first=await waitRunning(state);assert.equal(Object.keys(first.services).length,4);assert(first.services.worker.pid>1);assert.equal(first.providerAcceptance,'not_verified');
    await control(state,'stop');assert.equal((await running).status,'stopped');running=null;assert.equal((await control(state,'status')).status,'not_running');assert(!((await readdir(state)).includes('owner.json')));assert((await Promise.all(ports.map(portFree))).every(Boolean));
    assert.equal(await readFile(path.join(state,'config.json'),'utf8'),unchanged);assert(!(await readFile(path.join(state,'services.log'),'utf8')).includes('PRIVATE_CHILD_OUTPUT_CANARY'));
    running=runPilot({root,state});const second=await waitRunning(state);assert.notEqual(second.instanceId,first.instanceId);await control(state,'stop');assert.equal((await running).status,'stopped');running=null;
  }finally{if(running){await control(state,'stop').catch(()=>{});await running;}}
}));

test('course package directories are optional absolute directories, passed only to the API and edited atomically',()=>fixture(async state=>{
  await executableFixture(state);
  const file=path.join(state,'config.json'),original={...config(),loginCodes:true};
  await writePrivate(file,JSON.stringify(original,null,2)+'\n',false,0o600);
  let loaded=await loadConfiguration(state,state);assert.deepEqual(loaded.config.coursePackageDirectories,[]);
  for(const service of servicePlan(state,state,loaded.config,randomUUID()))assert(!Object.hasOwn(service.env,'COURSE_PACKAGE_DIRECTORIES'));
  const packages=path.join(state,'packages'),more=path.join(state,'more');await mkdir(packages);await mkdir(more);
  assert.deepEqual(await pilotMain(['package-directories','list','--state',state]),{status:'ok',coursePackageDirectories:[]});
  assert.deepEqual(await pilotMain(['package-directories','add','--state',state,packages]),{status:'updated',coursePackageDirectories:[packages],restartRequired:true});
  assert.equal((await managePackageDirectories({action:'add',state,directory:packages})).status,'unchanged');
  await managePackageDirectories({action:'add',state,directory:more});
  loaded=await loadConfiguration(state,state);assert.deepEqual(loaded.config.coursePackageDirectories,[packages,more]);
  const plan=servicePlan(state,state,loaded.config,randomUUID());
  assert.deepEqual(JSON.parse(plan[1].env.COURSE_PACKAGE_DIRECTORIES),[packages,more]);
  for(const service of [plan[0],plan[2],plan[3]])assert(!Object.hasOwn(service.env,'COURSE_PACKAGE_DIRECTORIES'));
  for(const bad of ['relative/dir','/','/tmp/../etc',`${packages}/`,'/tmp/x\ny'])
    await assert.rejects(managePackageDirectories({action:'add',state,directory:bad}),/invalid_course_package_directory/,bad);
  await assert.rejects(managePackageDirectories({action:'add',state,directory:path.join(state,'absent')}),/course_package_directory_missing/);
  const target=path.join(state,'packages-link');await symlink(packages,target);
  await assert.rejects(managePackageDirectories({action:'add',state,directory:target}),/course_package_directory_missing/);
  assert.throws(()=>parsePackageDirectoriesArguments(['package-directories','add']),/invalid_arguments/);
  assert.throws(()=>parsePackageDirectoriesArguments(['package-directories','list',packages]),/invalid_arguments/);
  await managePackageDirectories({action:'remove',state,directory:more});
  await managePackageDirectories({action:'remove',state,directory:packages});
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),original);
  for(const [bad,code] of [['/x',/invalid_course_package_directories/],[['/a','/a'],/duplicate_course_package_directory/],[[7],/invalid_course_package_directory/],
    [Array.from({length:MAX_COURSE_PACKAGE_DIRECTORIES+1},(_,i)=>`/d${i}`),/invalid_course_package_directories/],[[path.join(state,'absent')],/course_package_directory_missing/]]){
    await writePrivate(file,JSON.stringify({...original,coursePackageDirectories:bad}),true);
    await assert.rejects(loadConfiguration(state,state),code,JSON.stringify(bad));
  }
}));
test('the insecure-address check is on by default; the operator switch is a strict boolean passed to the API',()=>fixture(async state=>{
  await executableFixture(state);
  assert.equal(allowInsecureOriginsConfiguration(undefined),false);assert.equal(allowInsecureOriginsConfiguration(false),false);assert.equal(allowInsecureOriginsConfiguration(true),true);
  await writePrivate(path.join(state,'config.json'),JSON.stringify(config()));
  let loaded=await loadConfiguration(state,state);assert.equal(loaded.config.allowInsecureOrigins,false);
  let plan=servicePlan(state,state,loaded.config,randomUUID());assert.equal(plan[1].env.ALLOW_INSECURE_ORIGINS,'false');
  for(const service of [plan[0],plan[2],plan[3]])assert(!Object.hasOwn(service.env,'ALLOW_INSECURE_ORIGINS'));
  for(const bad of ['true',1,0,null,'yes',[],{}]){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),allowInsecureOrigins:bad}),true);
    await assert.rejects(loadConfiguration(state,state),/invalid_allow_insecure_origins/,JSON.stringify(bad));
  }
  // A LAN or host-name http origin is refused with the switch off, even written by hand.
  const lan=['http://192.168.1.5:4310','http://pilot.home.example:4310'];
  for(const allowInsecureOrigins of [undefined,false]){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),...(allowInsecureOrigins===undefined?{}:{allowInsecureOrigins}),additionalOrigins:lan}),true);
    await assert.rejects(loadConfiguration(state,state),/insecure_origin_refused/);
  }
  await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),allowInsecureOrigins:true,additionalOrigins:lan}),true);
  loaded=await loadConfiguration(state,state);assert.deepEqual(loaded.config.additionalOrigins,lan);
  plan=servicePlan(state,state,loaded.config,randomUUID());assert.equal(plan[1].env.ALLOW_INSECURE_ORIGINS,'true');assert.equal(plan[1].env.ADDITIONAL_ORIGINS,lan.join(','));
  // The switch never relaxes the form: port, path, credentials and wildcards are still refused.
  for(const bad of ['http://192.168.1.5','http://192.168.1.5:4310/','http://192.168.1.5:4310/path',(()=>{const url=new URL('http://192.168.1.5:4310');url.username='someone';url.password='secret';return url.href.replace(/\/$/,'');})(),'http://*.home.example:4310','http://Pilot.home.example:4310','ftp://192.168.1.5:4310']){
    await writePrivate(path.join(state,'config.json'),JSON.stringify({...config(),allowInsecureOrigins:true,additionalOrigins:[bad]}),true);
    await assert.rejects(loadConfiguration(state,state),/invalid_additional_origin/,bad);
  }
}));
test('security insecure-origin-check on|off|status flips the check atomically and refuses turning it on while insecure origins remain',()=>fixture(async state=>{
  await executableFixture(state);
  const file=path.join(state,'config.json'),original={...config(),loginCodes:true};
  await writePrivate(file,JSON.stringify(original,null,2)+'\n',false,0o400);
  assert.deepEqual(await pilotMain(['security','insecure-origin-check','status','--state',state]),{status:'ok',allowInsecureOrigins:false,insecureOriginChecks:'on',insecureOrigins:[]});
  // The check is on by default, so turning it on changes nothing.
  assert.equal((await pilotMain(['security','insecure-origin-check','on','--state',state])).status,'unchanged');
  await assert.rejects(pilotMain(['origins','add','--state',state,'http://192.168.1.5:4310']),/insecure_origin_refused/);
  assert.deepEqual(await pilotMain(['security','insecure-origin-check','off','--state',state]),{status:'updated',allowInsecureOrigins:true,insecureOriginChecks:'off',insecureOrigins:[],restartRequired:true});
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{...original,allowInsecureOrigins:true});assert.equal((await lstat(file)).mode&0o777,0o400);
  assert.equal((await manageSecurity({check:'off',state})).status,'unchanged');
  const added=await pilotMain(['origins','add','--state',state,'http://192.168.1.5:4310']);
  assert.deepEqual(added,{status:'updated',publicOrigin:original.publicOrigin,additionalOrigins:['http://192.168.1.5:4310'],allowInsecureOrigins:true,restartRequired:true});
  await manageOrigins({action:'add',state,origin:'http://100.99.0.1:4310'});
  let loaded=await loadConfiguration(state,state);assert.equal(servicePlan(state,state,loaded.config,randomUUID())[1].env.ALLOW_INSECURE_ORIGINS,'true');
  assert.deepEqual((await manageSecurity({check:'status',state})).insecureOrigins,['http://192.168.1.5:4310']);
  // Turning the check back on would leave a configuration the launcher refuses, so it is refused until they are removed.
  const before=await readFile(file,'utf8');
  await assert.rejects(pilotMain(['security','insecure-origin-check','on','--state',state]),error=>error.code==='insecure_origins_configured'&&error.hint.includes('http://192.168.1.5:4310')&&error.hint.includes('origins remove')
    &&error.hint.includes('turn the insecure-address check on with: node deploy/local/pilot.mjs security insecure-origin-check on --state <dir>')&&!error.hint.includes('insecure-origins '));
  assert.equal(await readFile(file,'utf8'),before);
  assert.equal((await manageOrigins({action:'remove',state,origin:'http://192.168.1.5:4310'})).status,'updated');
  assert.deepEqual(await pilotMain(['security','insecure-origin-check','on','--state',state]),{status:'updated',allowInsecureOrigins:false,insecureOriginChecks:'on',insecureOrigins:[],restartRequired:true});
  // Off removes the key; the Tailscale origin stays, and the launcher accepts the file.
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{...original,additionalOrigins:['http://100.99.0.1:4310']});
  loaded=await loadConfiguration(state,state);assert.equal(servicePlan(state,state,loaded.config,randomUUID())[1].env.ALLOW_INSECURE_ORIGINS,'false');
  // A hand-edited file whose LAN origin the switch no longer allows can still be listed and cleaned up.
  await writePrivate(file,JSON.stringify({...original,additionalOrigins:['http://192.168.1.5:4310']}),true);
  assert.deepEqual((await manageOrigins({action:'list',state})).additionalOrigins,['http://192.168.1.5:4310']);
  assert.deepEqual(await manageSecurity({check:'status',state}),{status:'ok',allowInsecureOrigins:false,insecureOriginChecks:'on',insecureOrigins:['http://192.168.1.5:4310']});
  assert.equal((await manageOrigins({action:'remove',state,origin:'http://192.168.1.5:4310'})).status,'updated');
  await writePrivate(file,JSON.stringify({...original,allowInsecureOrigins:'yes'}),true);
  await assert.rejects(manageSecurity({check:'status',state}),/invalid_allow_insecure_origins/);
  // A held configuration lock refuses a concurrent edit.
  await writePrivate(file,JSON.stringify(original),true);await mkdir(path.join(state,'config.lock'),{mode:0o700});
  await assert.rejects(manageSecurity({check:'off',state}),/transition_busy/);
}));
test('security arguments require the insecure-origin-check switch, an action and at most one state directory',()=>{
  assert.deepEqual(parseSecurityArguments(['security','insecure-origin-check','off','--state','/tmp/x']),{check:'off',state:'/tmp/x'});
  assert.deepEqual(parseSecurityArguments(['security','insecure-origin-check','on','--state','/tmp/x']),{check:'on',state:'/tmp/x'});
  assert.equal(parseSecurityArguments(['security','insecure-origin-check','status']).check,'status');
  // The deprecated 0.1.46 form names whether insecure origins are allowed: its on is the check's off.
  for(const [old,check] of [['on','off'],['off','on'],['status','status']]){
    const parsed=parseSecurityArguments(['security','insecure-origins',old,'--state','/tmp/x']);
    assert.equal(parsed.check,check,old);assert.equal(parsed.state,'/tmp/x');
    assert.equal(parsed.deprecated,`deprecated: "security insecure-origins ${old}" is now "node deploy/local/pilot.mjs security insecure-origin-check ${check} --state <dir>" (same effect)`);
  }
  for(const name of ['insecure-origin-check','insecure-origins'])for(const bad of [['security',name],['security',name,'enable'],['security',name,'on','--state'],
    ['security',name,'on','--state','/tmp/x','--state','/tmp/y'],['security',name,'on','--state','relative'],['security',name,'on','--force']])
    assert.throws(()=>parseSecurityArguments(bad),/invalid_command|invalid_arguments|invalid_path/,JSON.stringify(bad));
  for(const bad of [['security'],['security','tls','on'],['security','insecure-origin-checks','on'],['security','insecure-origin','on']])
    assert.throws(()=>parseSecurityArguments(bad),/invalid_command/,JSON.stringify(bad));
});
test('the deprecated security insecure-origins alias keeps its 0.1.46 semantics and notes the new form on stderr',()=>fixture(async state=>{
  await executableFixture(state);
  const file=path.join(state,'config.json'),original=config();
  await writePrivate(file,JSON.stringify(original),true);
  const write=process.stderr.write;let captured='';
  const run=async args=>{captured='';process.stderr.write=chunk=>{captured+=chunk;return true;};try{return await pilotMain(args);}finally{process.stderr.write=write;}};
  const note=(old,check)=>`deprecated: "security insecure-origins ${old}" is now "node deploy/local/pilot.mjs security insecure-origin-check ${check} --state <dir>" (same effect)\n`;
  assert.deepEqual(await run(['security','insecure-origins','status','--state',state]),{status:'ok',allowInsecureOrigins:false,insecureOriginChecks:'on',insecureOrigins:[]});
  assert.equal(captured,note('status','status'));
  assert.deepEqual(await run(['security','insecure-origins','on','--state',state]),{status:'updated',allowInsecureOrigins:true,insecureOriginChecks:'off',insecureOrigins:[],restartRequired:true});
  assert.equal(captured,note('on','off'));
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{...original,allowInsecureOrigins:true});
  assert.equal((await run(['security','insecure-origin-check','off','--state',state])).status,'unchanged');assert.equal(captured,'');
  await manageOrigins({action:'add',state,origin:'http://192.168.1.5:4310'});
  await assert.rejects(run(['security','insecure-origins','off','--state',state]),/insecure_origins_configured/);
  assert.equal(captured,note('off','on'));
  await manageOrigins({action:'remove',state,origin:'http://192.168.1.5:4310'});
  assert.deepEqual(await run(['security','insecure-origins','off','--state',state]),{status:'updated',allowInsecureOrigins:false,insecureOriginChecks:'on',insecureOrigins:[],restartRequired:true});
  assert.equal(captured,note('off','on'));
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),original);
  assert.equal((await run(['security','insecure-origin-check','on','--state',state])).status,'unchanged');assert.equal(captured,'');
}));
