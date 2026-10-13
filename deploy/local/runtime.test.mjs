import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,chmod,lstat,readFile,mkdir,symlink,link,writeFile,readdir} from 'node:fs/promises';
import {createServer,connect} from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import path from 'node:path';
import {privateDirectory,privateFile,writePrivate,control,controlPath,controlServer,socketInfo,mutex,RotatingLog,uid,hash,portFree} from './runtime.mjs';
import {loadConfiguration,servicePlan,runPilot} from './pilot.mjs';
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
test('operational logs retain bounded fixed metadata, rotate, and reject raw output fields',()=>fixture(async state=>{
  const log=new RotatingLog(state,{bytes:1024,backups:2});assert.throws(()=>log.write('child_error',{content:'PRIVATE_OUTPUT_CANARY'}));
  for(let i=0;i<60;i++){log.write('child_output_discarded',{service:'api',stream:'stdout',bytes:i});await log.flush();}
  const files=(await readdir(state)).filter(f=>f.startsWith('services.log'));assert(files.length<=3);for(const file of files){assert((await lstat(path.join(state,file))).size<=1024);assert.equal((await lstat(path.join(state,file))).mode&0o777,0o600);assert(!(await readFile(path.join(state,file),'utf8')).includes('PRIVATE_OUTPUT_CANARY'));}
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
  await writeFile(path.join(root,'.local/bin/temporal'),`#!/usr/bin/env node\nconst http=require('node:http');const flag=n=>Number(process.argv[process.argv.indexOf(n)+1]);const servers=[flag('--port'),flag('--ui-port')].map(p=>http.createServer((q,r)=>r.end('{}')).listen(p,'127.0.0.1'));process.on('SIGTERM',()=>{servers.forEach(s=>s.close());setTimeout(()=>process.exit(0),10);});\n`,{mode:0o700});
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
