import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,readdir,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DockerSandbox,QUALIFIED_IMAGES} from '../dist/index.js';
const exec=promisify(execFile),base=fileURLToPath(new URL('../.local/',import.meta.url));await mkdir(base,{recursive:true,mode:0o700});const root=await mkdtemp(path.join(base,'batch-qualification-'));
const image=process.env.COURSE_SANDBOX_IMAGE??QUALIFIED_IMAGES[process.arch];assert(image);await exec('docker',['image','inspect',image]);
after(async()=>{
  // A failed test must not erase an unreconciled creation/cleanup quarantine.
  for(const name of await readdir(root)){try{await readFile(path.join(root,name,'broker.lock'));return;}catch(e){if(e.code!=='ENOENT')throw e;}}
  await rm(root,{recursive:true,force:true});
});
const directory=name=>path.join(root,name),cases=[1,2,3,4].map(x=>({id:'case-'+x,input:x,expected:x*x}));

test('all batches contribute required cases; a later wrong result cannot earn partial credit',async()=>{
  const d=directory('all-cases'),runner=new DockerSandbox({image,storageDirectory:d});
  const good=await runner.grade({source:'def solve(x): return x*x',cases,batchCaseCounts:[2,2]});assert.equal(good.passed,true);assert.equal(good.batchesCompleted,2);assert.deepEqual(good.cases.map(c=>c.id),cases.map(c=>c.id));assert(good.outputBytes>0);
  const bad=await runner.grade({source:'def solve(x): return x*x if x < 4 else -1',cases,batchCaseCounts:[2,2]});assert.equal(bad.status,'graded');assert.equal(bad.passed,false);assert.equal(bad.batchesCompleted,2);assert.equal(bad.cases.filter(c=>c.passed).length,3);assert.deepEqual(await readdir(d),[]);
});
test('combined output limit applies across batches and the broker recovers after cleanup',async()=>{
  const d=directory('combined-output'),runner=new DockerSandbox({image,storageDirectory:d,maxOutputBytes:4096});
  const rows=[1,2].map(n=>({id:'large-'+n,input:3000,expected:'x'.repeat(3000)}));
  const result=await runner.grade({source:'def solve(x): return "x"*x',cases:rows,batchCaseCounts:[1,1]});assert.equal(result.status,'output_limit');assert.equal(result.passed,false);assert.equal(result.batchesCompleted,1);assert(result.outputBytes>4096);
  assert.deepEqual(await readdir(d),[]);assert.equal((await runner.grade({source:'def solve(x): return x*x',cases})).passed,true);
});
test('a single deadline includes all batches instead of restarting the timeout',async()=>{
  // The former 2.6-second fixture could expire during the second Docker create,
  // where missing acknowledgement correctly quarantines admission. Qualify the
  // running timeout separately, leaving ample room for acknowledged creation.
  const starts=[],creates=[];
  class DeadlineRunner extends DockerSandbox{async run(args,input,signal,timeoutMs,outputLimit){
    const result=await super.run(args,input,signal,timeoutMs,outputLimit);
    if(args[0]==='create')creates.push({status:result.status,acknowledged:/^[a-f0-9]{64}\s*$/.test(result.stdout)});
    if(args[0]==='start')starts.push({status:result.status,timeoutMs});
    return result;
  }}
  const d=directory('combined-time'),runner=new DeadlineRunner({image,storageDirectory:d,timeoutMs:15000});
  const rows=[1,2].map(x=>({id:'sleep-'+x,input:x,expected:x}));
  const result=await runner.grade({source:'import time\ndef solve(x):\n    time.sleep(8)\n    return x',cases:rows,batchCaseCounts:[1,1]});
  assert.deepEqual(creates,[{status:'completed',acknowledged:true},{status:'completed',acknowledged:true}]);
  assert.equal(starts.length,2);assert.equal(starts[0].status,'completed');assert.equal(starts[1].status,'timeout');
  assert(starts[1].timeoutMs<starts[0].timeoutMs-7500,'Second batch must retain elapsed first-batch time');
  assert.equal(result.status,'timeout');assert.equal(result.passed,false);assert.equal(result.batchesCompleted,1);assert.deepEqual(await readdir(d),[]);
});
test('shared admission remains held between containers and cancellation cannot publish earlier success',async()=>{
  const d=directory('admission'),a=new DockerSandbox({image,storageDirectory:d}),b=new DockerSandbox({image,storageDirectory:d}),controller=new AbortController();
  const pending=a.grade({source:'import time\ndef solve(x):\n    time.sleep(0.7)\n    return x',cases:[{id:'one',input:1,expected:1},{id:'two',input:2,expected:2}],batchCaseCounts:[1,1],signal:controller.signal});
  let first,changed=false;
  for(let i=0;i<200;i++){try{const record=JSON.parse(await readFile(path.join(d,'broker.lock'),'utf8'));first??=record.containerName;if(record.containerName!==first){
    // Running proves this broker received the immutable create ID and started it.
    // Cancelling an in-flight unacknowledged create legitimately quarantines it.
    const state=(await exec('docker',['inspect','--format','{{.State.Running}}',record.containerName],{timeout:2000})).stdout.trim();if(state==='true'){changed=true;break;}
  }}catch{}await delay(10);}
  assert(changed,'Second batch must retain the shared lock');assert.equal((await b.grade({source:'def solve(x): return x*x',cases})).status,'busy');controller.abort();const result=await pending;assert.equal(result.status,'cancelled');assert.equal(result.passed,false);assert.deepEqual(await readdir(d),[]);
});
test('failed cleanup in a later batch quarantines the shared broker and is never silently retried',async()=>{
  const d=directory('quarantine');let calls=0,owned;
  class FaultRunner extends DockerSandbox{async cleanup(id){calls++;if(calls===2){owned=id;return false;}return super.cleanup(id);}}
  const runner=new FaultRunner({image,storageDirectory:d});
  try{
    const result=await runner.grade({source:'def solve(x): return x*x',cases,batchCaseCounts:[2,2]});assert.equal(result.status,'cleanup_failed');assert.equal(result.passed,false);assert.equal(calls,2);assert.equal((await runner.readiness()).ready,false);
    const other=new DockerSandbox({image,storageDirectory:d});assert.equal((await other.grade({source:'def solve(x): return x*x',cases})).status,'busy');assert((await readdir(d)).includes('broker.lock'));
  }finally{
    if(owned){const obj=JSON.parse((await exec('docker',['inspect',owned])).stdout)[0];assert.equal(obj.Config.Labels['course-core.sandbox'],'true');assert(obj.Mounts.some(m=>m.Destination==='/work'&&m.Source.startsWith(d+path.sep)));await exec('docker',['rm','--force',owned]);await unlink(path.join(d,'broker.lock'));}
  }
});
test('batch plan and source/reference snapshots are captured before asynchronous execution',async()=>{
  const d=directory('snapshot'),runner=new DockerSandbox({image,storageDirectory:d}),plan=[2,2],input={source:'def solve(x): return x*x',cases:structuredClone(cases),batchCaseCounts:plan};
  const promise=runner.grade(input);plan.splice(0,2,4);input.source='def solve(x): return -1';input.cases[0].expected=-1;
  const result=await promise;assert.equal(result.passed,true);assert.equal(result.batchesCompleted,2);assert.deepEqual(await readdir(d),[]);
});
test('cancellation during final confirmed cleanup cannot publish an already computed pass',async()=>{
  const d=directory('final-cancellation'),controller=new AbortController();let calls=0;
  class CancellingRunner extends DockerSandbox{async cleanup(id){const cleaned=await super.cleanup(id);if(++calls===2)controller.abort();return cleaned;}}
  const result=await new CancellingRunner({image,storageDirectory:d}).grade({source:'def solve(x): return x*x',cases,batchCaseCounts:[2,2],signal:controller.signal});
  assert.equal(result.status,'cancelled');assert.equal(result.passed,false);assert.equal(result.batchesCompleted,2);assert.deepEqual(await readdir(d),[]);
});
