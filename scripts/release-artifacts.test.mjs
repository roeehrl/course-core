import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {MODULES} from './modules.mjs';
import {LICENSE_FILE_REVIEWS,reviewedLicenseFile} from './release-license-reviews.mjs';
import {REPOSITORY,REQUIRED_CI_JOBS,safePath,sourceAllowed,webAllowed,tarGzip,readTarGzip,metadata,validatePackageEntries,
  validateStandaloneManifest,validateReleaseIdentity,validateCiEvidence,parseReleaseArguments,validateRuntimeGraph,
  validateCandidateManifest,verifyCandidateBytes,FAILURE_ONLY_CI_STEPS,ciStepPassed,fetchWithTransientRetry,checksumText,cycloneDxSbom,sbomFilename,licenseDeclaration,runtimeAllowed,inventory,checkReleaseInputs,reviewTreeListing} from './release-artifacts.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),epoch=1791817000;
const releasedSdk='https://github.com/roeehrl/course-sdk/releases/download/v0.2.0/course-core-sdk-0.2.0.tgz';
const entry=(filename,text='public data')=>({path:filename,bytes:Buffer.from(text),mode:0o644});
const license=await readFile(new URL('../LICENSE',import.meta.url));
const standalone=()=>({name:'@course-core/visuals',version:'0.1.0',type:'module',license:'Apache-2.0',dependencies:{'@course-core/sdk':releasedSdk},exports:{'.':'./dist/index.js'}});
const packageEntries=()=>[entry('package/package.json',JSON.stringify(standalone())),entry('package/LICENSE',license),entry('package/README.md','Public visual package.'),entry('package/dist/index.js','export const value=1;')];
const identity=()=>({repository:REPOSITORY,tag:'v0.1.0',version:'0.1.0',commit:'a'.repeat(40),tagObject:'b'.repeat(40),tree:'c'.repeat(40),sourceEpoch:epoch,workflowRef:`${REPOSITORY}/.github/workflows/release.yml@refs/tags/v0.1.0`,workflowSha:'a'.repeat(40)});
function ciFixture(){const i=identity(),run={id:12,head_sha:i.commit,repository:{full_name:REPOSITORY},event:'workflow_dispatch',path:'.github/workflows/release.yml',run_attempt:1,html_url:`https://github.com/${REPOSITORY}/actions/runs/12`,referenced_workflows:[{sha:i.commit,path:`${REPOSITORY}/.github/workflows/ci.yml@refs/tags/v0.1.0`}]};
  const jobs=REQUIRED_CI_JOBS.map((name,index)=>({id:index+1,name:`Full CI / ${name}`,head_sha:i.commit,status:'completed',conclusion:'success',html_url:`https://github.com/${REPOSITORY}/actions/runs/12/job/${index+1}`,completed_at:'2026-10-12T20:00:00Z',steps:[{name:'Mandatory check',conclusion:'success'}]}));return {i,run,jobs};}
const sri=text=>`sha512-${createHash('sha512').update(text).digest('base64')}`;
// Registry, released-SDK, development-only and install-links copy entries, shared across module locks.
const lockedFixture=name=>({'node_modules/@course-core/sdk':{version:'0.2.0',resolved:releasedSdk,integrity:sri('sdk'),license:'Apache-2.0'},
  'node_modules/zod':{version:'4.0.0',resolved:'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz',integrity:sri('zod'),license:'MIT'},
  ...(name==='api'?{'node_modules/typescript':{version:'5.9.3',resolved:'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz',integrity:sri('ts'),license:'Apache-2.0',dev:true},
    'node_modules/@course-core/policy':{resolved:'../../packages/policy',link:true}}:{}),
  ...(name==='learner'?{'node_modules/@course-core/visuals':{version:'0.1.0',resolved:'file:../../packages/visuals',license:'Apache-2.0'},
    'node_modules/typescript':{version:'5.9.3',resolved:'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz',integrity:sri('ts'),license:'Apache-2.0'}}:{})});
async function candidate(){
  const directory=await mkdtemp(path.join(tmpdir(),'course-candidate-test-')),source=[{path:'course-core/LICENSE',bytes:license,mode:0o644},entry('course-core/package.json',JSON.stringify({name:'@course-core/repository',version:'0.1.0',license:'Apache-2.0',private:true}))],modules=[];
  for(const [name,module] of Object.entries(MODULES)){
    const manifest={name:`@course-core/${name}`,version:'0.1.0',private:true,dependencies:{'@course-core/sdk':releasedSdk}},lock=JSON.stringify({lockfileVersion:3,packages:{'':manifest,...lockedFixture(name)}});
    source.push(entry(`course-core/${module.directory}/package.json`,JSON.stringify(manifest)),entry(`course-core/${module.directory}/package-lock.json`,lock));
    modules.push({name,directory:module.directory,packageName:manifest.name,version:manifest.version,lockSha256:sha(lock)});
  }
  const {i,run,jobs}=ciFixture(),assets=[];
  for(const [kind,filename,entries] of [['source','course-core-source-0.1.0.tar.gz',source],['runtime','course-core-runtime-0.1.0.tar.gz',source],['learner','course-core-learner-web-0.1.0.tar.gz',[entry('course-core/index.html','<!doctype html>'),{path:'course-core/LICENSE',bytes:license,mode:0o644}]],['admin','course-core-admin-web-0.1.0.tar.gz',[entry('course-core/index.html','<!doctype html>'),{path:'course-core/LICENSE',bytes:license,mode:0o644}]],['visuals','course-core-visuals-0.1.0.tgz',packageEntries()]]){
    const bytes=tarGzip(entries,epoch);await writeFile(path.join(directory,filename),bytes);assets.push({kind,filename,size:bytes.length,sha256:sha(bytes),entries:metadata(entries)});
  }
  const sbom=cycloneDxSbom(i,modules.map(row=>({...row,lock:JSON.parse(source.find(e=>e.path===`course-core/${row.directory}/package-lock.json`).bytes)})));
  await writeFile(path.join(directory,sbomFilename('0.1.0')),sbom);
  const manifest={schemaVersion:1,state:'verified_candidate',identity:i,ci:validateCiEvidence(i,run,jobs,1),modules,assets,sbom:{filename:sbomFilename('0.1.0'),size:sbom.length,sha256:sha(sbom),format:'CycloneDX',specVersion:'1.5'},installedVisuals:{status:'passed',noSiblingSource:true,headless:true,reactSsr:true,types:true,css:true},verificationScope:'source_ci_and_installed_package_only_no_live_provider_or_deployment'};
  const save=async()=>{await writeFile(path.join(directory,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');await writeFile(path.join(directory,'SHA256SUMS'),checksumText(manifest));};await save();
  // Regenerates the SBOM for the manifest's current identity, as release preparation would.
  const rebuildSbom=async()=>{const bytes=cycloneDxSbom(manifest.identity,modules.map(row=>({...row,lock:JSON.parse(source.find(e=>e.path===`course-core/${row.directory}/package-lock.json`).bytes)})));
    await rm(path.join(directory,manifest.sbom.filename));manifest.sbom={...manifest.sbom,filename:sbomFilename(manifest.identity.version),size:bytes.length,sha256:sha(bytes)};await writeFile(path.join(directory,manifest.sbom.filename),bytes);};
  return {directory,manifest,save,rebuildSbom};
}
test('importing the release tool has no generation, GitHub or publishing side effects',()=>{
  const script=new URL('./release-artifacts.mjs',import.meta.url);const out=execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(script.href)});process.stdout.write('imported');`],{encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(out,'imported');
});
test('release CLI rejects a branch, absent SHA, duplicate options and action/output confusion',()=>{
  assert.equal(parseReleaseArguments(['prepare','--tag','v0.1.0','--commit','a'.repeat(40),'--output','/tmp/candidate']).action,'prepare');
  for(const args of [['prepare','--tag','main','--commit','a'.repeat(40),'--output','/tmp/candidate'],['identity','--tag','v0.1.0'],['identity','--tag','v0.1.0','--commit','a'.repeat(40),'--tag','v0.1.0'],['verify','--tag','v0.1.0','--commit','a'.repeat(40),'--output','/tmp/candidate']])assert.throws(()=>parseReleaseArguments(args));
});
test('release generation outside the controlled workflow fails before reading a token or writing output',()=>{
  assert.throws(()=>execFileSync(process.execPath,['scripts/release-artifacts.mjs','identity','--tag','v0.1.0','--commit','a'.repeat(40)],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH},stdio:'pipe'}));
});
test('identity binds repository, package version, tag ref, checkout and workflow SHA',()=>{
  const i=identity(),bound={...i,head:i.commit,ref:'refs/tags/v0.1.0'};assert.doesNotThrow(()=>validateReleaseIdentity(bound));
  for(const changes of [{ref:'refs/heads/main'},{head:'d'.repeat(40)},{workflowSha:'d'.repeat(40)},{version:'0.2.0'},{repository:'another/public-repo'}])assert.throws(()=>validateReleaseIdentity({...bound,...changes}));
});
test('full CI evidence rejects missing, failed, duplicated, skipped or stale-source jobs',()=>{
  const {i,run,jobs}=ciFixture();assert.equal(validateCiEvidence(i,run,jobs,1).jobs.length,REQUIRED_CI_JOBS.length);
  assert.throws(()=>validateCiEvidence(i,run,jobs.slice(1),1));assert.throws(()=>validateCiEvidence(i,run,[...jobs,jobs[0]],1));
  for(const changes of [{head_sha:'d'.repeat(40)},{conclusion:'failure'},{conclusion:'skipped'},{status:'in_progress'},{steps:[{name:'Hidden failure',conclusion:'failure'}]}]){const altered=structuredClone(jobs);Object.assign(altered[0],changes);assert.throws(()=>validateCiEvidence(i,run,altered,1));}
  assert.throws(()=>validateCiEvidence(i,{...run,referenced_workflows:[]},jobs,1));assert.throws(()=>validateCiEvidence(i,{...run,run_attempt:2},jobs,1));
});
test('full CI evidence rejects skipped required steps and only tolerates skipped failure-only diagnostics',()=>{
  const {i,run,jobs}=ciFixture();
  for(const step of [{name:'Run npm run check:api',conclusion:'skipped'},{name:'Mandatory check',conclusion:null},{name:'Mandatory check',conclusion:'neutral'},{name:'Mandatory check',conclusion:'cancelled'}]){
    const altered=structuredClone(jobs);altered[0].steps.push(step);
    assert.throws(()=>validateCiEvidence(i,run,altered,1),/failed or skipped required step/);
  }
  const altered=structuredClone(jobs);altered[0].steps=[{name:FAILURE_ONLY_CI_STEPS[0],conclusion:'skipped'}];
  assert.throws(()=>validateCiEvidence(i,run,altered,1),'a job whose only step is a skipped diagnostic step proves nothing');
  altered[0].steps=[{name:'Mandatory check',conclusion:'success'},...FAILURE_ONLY_CI_STEPS.map(name=>({name,conclusion:'skipped'}))];
  assert.equal(validateCiEvidence(i,run,altered,1).jobs.length,REQUIRED_CI_JOBS.length);
  assert.equal(ciStepPassed({name:FAILURE_ONLY_CI_STEPS[0],conclusion:'failure'}),false);
});
test('only failure-diagnostic steps in ci.yml are conditional, matching the skippable allowlist',async()=>{
  const text=await readFile(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const conditional=[];let name;
  for(const line of text.split('\n')){
    const step=line.match(/^ {6}- (?:name: (.+))?/);if(step)name=step[1]?.trim()??line.trim();
    const condition=line.match(/^ {8}if: (.+)$/);if(condition)conditional.push({name,condition:condition[1].trim()});
  }
  assert.ok(conditional.length>0);
  for(const step of conditional)assert.equal(step.condition,'failure()',`Conditional CI step may be skipped on a passing run: ${step.name}`);
  assert.deepEqual([...new Set(conditional.map(step=>step.name))].sort(),[...FAILURE_ONLY_CI_STEPS].sort());
});
test('source and web allowlists include actual Expo CSS and reject private paths, maps and arbitrary code',()=>{
  assert(sourceAllowed('services/api/src/server.ts'));assert(sourceAllowed('scripts/release-artifacts.test.mjs'));assert(webAllowed('_expo/static/css/connected-abcd.css','learner'));
  for(const p of ['../escape','/absolute','a//b','a/./b','a\\b'])assert.throws(()=>safePath(p));
  assert(sourceAllowed('docs/threat-model.md'));
  for(const p of ['docs/nested/page.md','docs/diagram.png','docs/run.sh'])assert.equal(sourceAllowed(p),false);
  for(const p of ['.local/config.json','apps/learner/dist/index.html','unknown/repository.ts'])assert.equal(sourceAllowed(p),false);
  for(const p of ['assets/index.js.map','../../secret'])assert.throws(()=>webAllowed(p,'learner'));
  for(const p of ['arbitrary.ts','source/index.js'])assert(!webAllowed(p,'learner'));
  assert.throws(()=>sourceAllowed('operator/secrets.json'));assert.throws(()=>sourceAllowed('settings.env.key'));
});
test('archives are deterministic and roundtrip exact bytes and executable modes',()=>{
  const entries=[entry('course-core/a.txt'),{...entry('course-core/run.sh','#!/bin/sh\nexit 0\n'),mode:0o755}];const packed=tarGzip(entries,epoch);
  assert.deepEqual(packed,tarGzip([...entries].reverse(),epoch));assert.deepEqual(metadata(readTarGzip(packed)),metadata(entries));
  assert.throws(()=>tarGzip([...entries,entries[0]],epoch));assert.throws(()=>tarGzip(entries,NaN));
});
function alterHeader(bytes,mutate){const tar=gunzipSync(bytes);mutate(tar);tar.fill(32,148,156);const sum=tar.subarray(0,512).reduce((n,b)=>n+b,0);tar.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');return gzipSync(tar);}
test('tar reader rejects symlinks, hardlinks, traversal, PAX overrides, truncation and checksum corruption',()=>{
  const packed=tarGzip([entry('course-core/public.txt')],epoch);
  for(const type of ['1','2','x','g'])assert.throws(()=>readTarGzip(alterHeader(packed,t=>t.write(type,156,1))));
  assert.throws(()=>readTarGzip(alterHeader(packed,t=>{t.fill(0,0,100);t.write('../escape',0);})));assert.throws(()=>readTarGzip(gzipSync(gunzipSync(packed).subarray(0,514))));
  const corrupt=gunzipSync(packed);corrupt[1]^=1;assert.throws(()=>readTarGzip(gzipSync(corrupt)));
});
test('standalone packages require license, every advertised export and released remote dependencies',()=>{
  const m=standalone();assert.doesNotThrow(()=>validatePackageEntries(packageEntries(),m));
  assert.throws(()=>validatePackageEntries(packageEntries().filter(e=>e.path!=='package/LICENSE'),m));assert.throws(()=>validatePackageEntries(packageEntries().filter(e=>e.path!=='package/dist/index.js'),m));
  for(const spec of ['file:../sdk','workspace:*','link:../sdk','../sdk'])assert.throws(()=>validateStandaloneManifest({...m,dependencies:{'@course-core/sdk':spec}}));
  assert.throws(()=>validateStandaloneManifest({...m,scripts:{postinstall:'node untrusted.js'}}));assert.throws(()=>validatePackageEntries([...packageEntries(),entry('package/settings.json')],m));
});
test('runtime local references stay within the shipped graph and cannot reach a sibling course',()=>{
  const rows=[{directory:'services/api',manifest:{name:'@course-core/api',dependencies:{'@course-core/policy':'file:../../packages/policy'}}},{directory:'packages/policy',manifest:{name:'@course-core/policy'}}];assert.doesNotThrow(()=>validateRuntimeGraph(rows));
  assert.throws(()=>validateRuntimeGraph(rows.slice(0,1)));const changed=structuredClone(rows);changed[0].manifest.dependencies['@course-core/policy']='file:../../../sibling';assert.throws(()=>validateRuntimeGraph(changed));
});
test('candidate manifests cannot claim deployment, omit a module or counterfeit completed consumer acceptance',async()=>{
  const f=await candidate();try{assert.doesNotThrow(()=>validateCandidateManifest(f.manifest));for(const mutate of [m=>{m.verificationScope='production_verified';},m=>{m.modules.pop();},m=>{m.installedVisuals.types=false;},m=>{m.ci.jobs[0].conclusion='skipped';},m=>{m.assets[0].entries.push(m.assets[0].entries[0]);}]){const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>validateCandidateManifest(m));}}finally{await rm(f.directory,{recursive:true,force:true});}
});
test('actual archive and receipt verification detects changed bytes, added files and symlink replacements',async()=>{
  const f=await candidate();try{assert.equal((await verifyCandidateBytes(f.directory,f.manifest)).state,'bytes_verified');const target=path.join(f.directory,f.manifest.assets[0].filename),bytes=await readFile(target);
    await writeFile(target,Buffer.concat([bytes,Buffer.from('tampered')]));await assert.rejects(verifyCandidateBytes(f.directory,f.manifest));await writeFile(target,bytes);
    await writeFile(path.join(f.directory,'unexpected.txt'),'data');await assert.rejects(verifyCandidateBytes(f.directory,f.manifest));await rm(path.join(f.directory,'unexpected.txt'));
    const external=path.join(f.directory,'copy');await writeFile(external,bytes);await rm(target);await symlink(external,target);await assert.rejects(verifyCandidateBytes(f.directory,f.manifest));
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('rehashing a damaged runtime lock cannot launder it as the tested source dependency graph',async()=>{
  const f=await candidate();try{const asset=f.manifest.assets.find(a=>a.kind==='runtime'),entries=readTarGzip(await readFile(path.join(f.directory,asset.filename))),lock=entries.find(e=>e.path==='course-core/services/api/package-lock.json');lock.bytes=Buffer.from('{}');const bytes=tarGzip(entries,epoch);asset.size=bytes.length;asset.sha256=sha(bytes);asset.entries=metadata(entries);await writeFile(path.join(f.directory,asset.filename),bytes);await f.save();await assert.rejects(verifyCandidateBytes(f.directory,f.manifest),/Runtime dependency source changed/);}finally{await rm(f.directory,{recursive:true,force:true});}
});
test('dependency license declarations cannot silently disappear or contain injected multi-line output',()=>{assert.equal(licenseDeclaration('(MIT OR Apache-2.0)'),'(MIT OR Apache-2.0)');for(const value of [undefined,'','MIT\nforged receipt'])assert.throws(()=>licenseDeclaration(value));});
test('missing third-party license metadata requires an exact reviewed version and unchanged distributed license bytes',async()=>{
  const text=await readFile(new URL('./fixtures/unionfs-4.6.0-LICENSE.txt',import.meta.url),'utf8');const supplied=[{filename:'LICENSE',text}];
  assert.equal(reviewedLicenseFile('unionfs','4.6.0',supplied).declaration,'Unlicense');
  assert.equal(sha(text),LICENSE_FILE_REVIEWS['unionfs@4.6.0'].sha256);
  assert.throws(()=>reviewedLicenseFile('another-package','4.6.0',supplied));assert.throws(()=>reviewedLicenseFile('unionfs','4.6.1',supplied));
  assert.throws(()=>reviewedLicenseFile('unionfs','4.6.0',[{filename:'LICENSE',text:text+'altered'}]));assert.throws(()=>reviewedLicenseFile('unionfs','4.6.0',[]));
});
test('a packaging-only core patch keeps the unchanged visual component version and exact bytes',async()=>{
  const f=await candidate();try{
    const visual=f.manifest.assets.find(a=>a.kind==='visuals'),visualHash=visual.sha256;
    Object.assign(f.manifest.identity,{tag:'v0.1.1',version:'0.1.1',workflowRef:`${REPOSITORY}/.github/workflows/release.yml@refs/tags/v0.1.1`});
    for(const asset of f.manifest.assets.filter(a=>a.kind!=='visuals')){
      const old=path.join(f.directory,asset.filename),entries=readTarGzip(await readFile(old));
      const root=entries.find(e=>e.path==='course-core/package.json');if(root){const p=JSON.parse(root.bytes);p.version='0.1.1';root.bytes=Buffer.from(JSON.stringify(p));}
      const bytes=tarGzip(entries,epoch);asset.filename=asset.filename.replace('0.1.0','0.1.1');asset.sha256=sha(bytes);asset.size=bytes.length;asset.entries=metadata(entries);await rm(old);await writeFile(path.join(f.directory,asset.filename),bytes);
    }
    await f.rebuildSbom();await f.save();assert.equal((await verifyCandidateBytes(f.directory,f.manifest)).state,'bytes_verified');assert.equal(visual.filename,'course-core-visuals-0.1.0.tgz');assert.equal(visual.sha256,visualHash);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('actual runtime staging keeps executable entrypoints, excludes compiled tests and cannot hide an excluded symlink',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'course-runtime-staging-'));
  try{
    await mkdir(path.join(directory,'src'));await mkdir(path.join(directory,'test'));
    await writeFile(path.join(directory,'src','cli.js'),'export const command=true;');await writeFile(path.join(directory,'test','fixtures.js'),'export const canary="test-only";');await writeFile(path.join(directory,'src','cli.js.map'),'SOURCE_LOCATION_CANARY');
    const options={exclude:p=>p==='test',excludeSourceMaps:true},allow=p=>runtimeAllowed(`dist/${p}`,'supervisor');
    assert.deepEqual((await inventory(directory,allow,'',options)).map(e=>e.path),['src/cli.js']);
    assert(!runtimeAllowed('dist/test/fixtures.js','supervisor'));
    await rm(path.join(directory,'test'),{recursive:true});await symlink(path.join(directory,'src'),path.join(directory,'test'));
    await assert.rejects(inventory(directory,allow,'',options),/symlinks/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('public key-vault code is deliverable while credential-labelled operational files remain denied',()=>{
 assert.equal(sourceAllowed('services/api/src/key-vault.ts'),true);
 assert.equal(sourceAllowed('services/api/test/key-vault.test.ts'),true);
 assert.equal(runtimeAllowed('dist/key-vault.js','api'),true);
 for(const filename of ['services/api/src/credential-vault.ts','services/api/test/credential-vault.test.ts','services/api/src/credentials.json','services/api/src/secrets.txt'])assert.throws(()=>sourceAllowed(filename),/private or operational|private|secret/i);
 for(const filename of ['dist/credential-vault.js','dist/credentials.json'])assert.throws(()=>runtimeAllowed(filename,'api'));
 assert.equal(runtimeAllowed('dist/provider-key.bin','api'),false);
});

test('GitHub reads retry only transient failures and never mask a definitive answer', async () => {
  const sequence = statuses => { const calls = []; return { calls, fetchImpl: async () => { const status = statuses[calls.length]; calls.push(status); if (status === 'network') throw new Error('reset'); return new Response('{}', { status }); } }; };
  const wait = async () => {};
  let s = sequence([502, 'network', 200]);
  assert.equal((await fetchWithTransientRetry('https://example.invalid', {}, { fetchImpl: s.fetchImpl, wait })).status, 200);
  assert.deepEqual(s.calls, [502, 'network', 200]);
  s = sequence([403, 200]);
  assert.equal((await fetchWithTransientRetry('https://example.invalid', {}, { fetchImpl: s.fetchImpl, wait })).status, 403);
  assert.equal(s.calls.length, 1);
  s = sequence([502, 503, 500, 502, 200]);
  assert.equal((await fetchWithTransientRetry('https://example.invalid', {}, { fetchImpl: s.fetchImpl, wait })).status, 502);
  assert.equal(s.calls.length, 4);
});

test('Public CI refuses tracked paths the release build would refuse',async()=>{
  // The repository's own tree at HEAD must pass the same review the release build applies.
  const own=await checkReleaseInputs();assert.equal(own.state,'release_inputs_reviewed');assert.ok(own.files>100);
  const repo=await mkdtemp(path.join(tmpdir(),'course-release-inputs-'));
  const run=(...args)=>execFileSync('git',['-C',repo,'-c','user.name=t','-c','user.email=t@example.invalid','-c','commit.gpgSign=false',...args]);
  try{
    run('init','-q');await writeFile(path.join(repo,'LICENSE'),'license');await mkdir(path.join(repo,'services/api/src'),{recursive:true});
    await writeFile(path.join(repo,'services/api/src/password-input.ts'),'export {};');run('add','-A');run('commit','-q','-m','ok');
    assert.equal((await checkReleaseInputs(repo)).files,2);
    for(const [name,pattern] of [['services/api/src/secret-input.ts',/private or operational copy/],['services/api/src/credentials.ts',/private or operational copy/],['notes/unreviewed.md',/unreviewed source path/]]){
      await mkdir(path.dirname(path.join(repo,name)),{recursive:true});await writeFile(path.join(repo,name),'export {};');run('add','-A');run('commit','-q','-m','add '+name);
      await assert.rejects(checkReleaseInputs(repo),pattern);
      run('rm','-q',name);run('commit','-q','-m','remove '+name);assert.equal((await checkReleaseInputs(repo)).files,2);
    }
    await symlink('LICENSE',path.join(repo,'services/api/src/link.ts'));run('add','-A');run('commit','-q','-m','link');
    await assert.rejects(checkReleaseInputs(repo),/symlink/);
    assert.throws(()=>reviewTreeListing('160000 commit '+'a'.repeat(40)+'\tsub\0'),/submodule/);
  }finally{await rm(repo,{recursive:true,force:true});}
});

test('the candidate SBOM is a deterministic CycloneDX inventory of every module lock',async()=>{
  const f=await candidate();try{
    const bytes=await readFile(path.join(f.directory,f.manifest.sbom.filename)),bom=JSON.parse(bytes);
    assert.equal(f.manifest.sbom.filename,'course-core-sbom-0.1.0.cdx.json');
    assert.deepEqual([bom.bomFormat,bom.specVersion,bom.version],['CycloneDX','1.5',1]);
    assert.match(bom.serialNumber,/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(bom.metadata.timestamp,new Date(epoch*1000).toISOString());
    assert.deepEqual(bom.metadata.properties.map(p=>p.value),['v0.1.0','a'.repeat(40),'c'.repeat(40)]);
    const byRef=new Map(bom.components.map(c=>[c['bom-ref'],c]));
    assert.equal(bom.components.length,Object.keys(MODULES).length+3,'modules plus sdk, zod and typescript, each once');
    const zod=byRef.get('pkg:npm/zod@4.0.0');
    assert.deepEqual(zod.hashes,[{alg:'SHA-512',content:createHash('sha512').update('zod').digest('hex')}]);
    assert.deepEqual(zod.licenses,[{license:{name:'MIT'}}]);
    assert.equal(zod.properties.find(p=>p.name==='course-core:lockedBy').value.split(',').length,Object.keys(MODULES).length);
    const sdk=byRef.get('pkg:npm/%40course-core/sdk@0.2.0');assert.deepEqual([sdk.group,sdk.name,sdk.externalReferences[0].url],['@course-core','sdk',releasedSdk]);
    // Development-only only when no module locks it for runtime; install-links copies and links are modules, not packages.
    assert.equal(byRef.get('pkg:npm/typescript@5.9.3').properties.some(p=>p.name==='course-core:developmentOnly'),false);
    assert.ok(!bom.components.some(c=>c.purl?.includes('%40course-core/visuals')||c.purl?.includes('%40course-core/policy')));
    assert.ok(byRef.get('course-core:services/api').properties.some(p=>p.name==='course-core:lockSha256'&&p.value===f.manifest.modules.find(m=>m.name==='api').lockSha256));
    assert.ok(checksumText(f.manifest).includes(`${f.manifest.sbom.sha256}  ${f.manifest.sbom.filename}\n`),'SHA256SUMS lists the SBOM');
    assert.equal(checksumText(f.manifest).trim().split('\n').length,f.manifest.assets.length+1);
    assert.equal((await verifyCandidateBytes(f.directory,f.manifest)).state,'bytes_verified');
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('a tampered, missing, misnamed or unlisted SBOM is rejected',async()=>{
  const f=await candidate();try{
    const target=path.join(f.directory,f.manifest.sbom.filename),original=await readFile(target);
    // Hide a vulnerable package and rewrite every receipt to match: regeneration from the archived locks still fails.
    const bom=JSON.parse(original);bom.components=bom.components.filter(c=>c.name!=='zod');const edited=Buffer.from(JSON.stringify(bom,null,2)+'\n');
    await writeFile(target,edited);
    await assert.rejects(verifyCandidateBytes(f.directory,f.manifest),/SBOM bytes changed/);
    Object.assign(f.manifest.sbom,{size:edited.length,sha256:sha(edited)});await f.save();
    await assert.rejects(verifyCandidateBytes(f.directory,f.manifest),/SBOM does not match the archived dependency locks/);
    await writeFile(target,original);Object.assign(f.manifest.sbom,{size:original.length,sha256:sha(original)});await f.save();
    assert.equal((await verifyCandidateBytes(f.directory,f.manifest)).state,'bytes_verified');
    // The checksum receipt must list it.
    await writeFile(path.join(f.directory,'SHA256SUMS'),checksumText({...f.manifest,sbom:{...f.manifest.sbom,filename:'zzz-unused'}}).replace(/^.*zzz-unused\n/m,''));
    await assert.rejects(verifyCandidateBytes(f.directory,f.manifest),/Checksum receipt changed/);await f.save();
    for(const mutate of [m=>{delete m.sbom;},m=>{m.sbom.filename='course-core-sbom-9.9.9.cdx.json';},m=>{m.sbom.format='SPDX';},m=>{m.sbom.specVersion='1.4';},m=>{m.sbom.size=0;},m=>{m.sbom.sha256='0';},m=>{m.sbom.extra=true;}]){
      const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>validateCandidateManifest(m),/SBOM|candidate manifest fields/);
    }
    await rm(target);
    await assert.rejects(verifyCandidateBytes(f.directory,f.manifest),/Unexpected or missing files/);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('SBOM generation refuses locks without integrity or with conflicting bytes for one version',()=>{
  const i={repository:REPOSITORY,tag:'v0.1.0',version:'0.1.0',commit:'a'.repeat(40),tree:'c'.repeat(40),sourceEpoch:epoch};
  const row=(directory,packages)=>({directory,packageName:'@course-core/api',version:'0.1.0',lockSha256:'d'.repeat(64),lock:{lockfileVersion:3,packages:{'':{},...packages}}});
  const zod=integrity=>({'node_modules/zod':{version:'4.0.0',resolved:'https://registry.npmjs.org/zod/-/zod-4.0.0.tgz',integrity}});
  assert.throws(()=>cycloneDxSbom(i,[row('services/api',zod(undefined))]),/SHA-512 integrity/);
  assert.throws(()=>cycloneDxSbom(i,[row('services/api',zod('sha1-abc'))]),/SHA-512 integrity/);
  assert.throws(()=>cycloneDxSbom(i,[row('services/api',zod(sri('a'))),row('apps/admin',zod(sri('b')))]),/Conflicting locked bytes/);
  assert.throws(()=>cycloneDxSbom(i,[{...row('services/api',{}),lock:{lockfileVersion:2,packages:{}}}]),/lockfileVersion 3/);
  assert.throws(()=>cycloneDxSbom(i,[row('services/api',{'node_modules/evil':{version:'1.0.0',resolved:'file:../evil'}})]),/SHA-512 integrity/);
  assert.ok(cycloneDxSbom(i,[row('services/api',zod(sri('a')))]).equals(cycloneDxSbom(i,[row('services/api',zod(sri('a')))])));
});
