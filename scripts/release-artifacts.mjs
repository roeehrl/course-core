import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { lstat, readFile, writeFile, mkdir, mkdtemp, readdir, rm, realpath, appendFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDependencies, auditFilename, auditNpmrc, auditText } from './public-policy.mjs';
import { MODULES, ROOT, DEPENDENCY_FIELDS, ensure, readJson, requireNode26, sdkReleaseUrl } from './modules.mjs';
import { resolveModuleGraph } from './dependency-graph.mjs';
import { isMain } from './is-main.mjs';
import {reviewedLicenseFile} from './release-license-reviews.mjs';
import {compatibilityMatrix,directorySource} from './release-compat.mjs';
import {npmCiWithRetry,npmFetchRetryEnv} from './npm-retry.mjs';

const exec = promisify(execFile);
export const REPOSITORY = 'roeehrl/course-core';
export function requiredCiJobs(registry = MODULES) {
  return ['Public source and orchestration', ...Object.entries(registry).map(([name, module]) =>
    name === 'api' ? 'API and connected learner / Postgres 17' : module.docker ? 'Sandbox / real Docker Linux' :
      module.web || module.browser ? `Browser / ${name}` : `Module / ${name}`)];
}
export const REQUIRED_CI_JOBS = Object.freeze(requiredCiJobs());
export const RUNTIME_MODULES = Object.freeze(Object.keys(MODULES).filter(name => !MODULES[name].web));
const MODULE_PATHS = Object.values(MODULES).map(module => module.directory);
const ROOT_SOURCE = new Set(['package.json', 'package-lock.json', 'requirements-map.json', 'LICENSE', 'README.md', 'RELEASES.md', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', '.gitignore']);
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|json|md|sql|py|ya?ml|html|css|svg|txt|sh)$/i;
const BUILT_EXTENSIONS = /(?:\.d\.ts|\.js|\.css|\.json)$/;
const PRIVATE_COMPONENT = /(?:^|[._-])(?:private|secrets?|credentials?|logs?|node_modules|coverage|test-results|playwright-report|recordings?)(?:$|[._-])/i;
const sha = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const sri = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const snapshotMode = mode => mode & 0o111 ? 0o755 : 0o644;

export function safePath(filename) {
  ensure(typeof filename === 'string' && filename.length > 0 && filename.length <= 240 && /^[A-Za-z0-9_./@-]+$/.test(filename), 'Unsafe artifact path');
  ensure(!path.posix.isAbsolute(filename) && filename.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe artifact path');
  return filename;
}
function privacyPath(filename) {
  safePath(filename); auditFilename(filename);
  ensure(!filename.split('/').some(part => PRIVATE_COMPONENT.test(part)), `${filename}: private or operational copy is not a release input`);
  ensure(!/\.(?:log|map|tsbuildinfo)$/i.test(filename), `${filename}: logs, source maps and build caches are not release inputs`);
}
export function sourceAllowed(filename) {
  privacyPath(filename);
  if (ROOT_SOURCE.has(filename)) return true;
  if (filename.startsWith('.github/')) return /^\.github\/(?:workflows\/[A-Za-z0-9_-]+\.ya?ml|CODEOWNERS|dependabot\.ya?ml)$/.test(filename);
  // scripts/tests/ holds tests that need a disposable database, outside the test:infra glob.
  if (filename.startsWith('scripts/')) return /^scripts\/(?:tests\/)?[A-Za-z0-9_.-]+\.[cm]?js$/.test(filename)
    || filename==='scripts/fixtures/unionfs-4.6.0-LICENSE.txt';
  // Project documentation: flat Markdown files, and the published JSON Schemas of versioned contracts.
  if (filename.startsWith('docs/')) return /^docs\/[A-Za-z0-9_.-]+\.md$/.test(filename)
    || /^docs\/contracts\/[a-z0-9-]+\.v[0-9]+\.schema\.json$/.test(filename);
  // deploy/docker is the documented Linux/Docker self-host stack; its .env.example holds placeholders only.
  if (filename.startsWith('deploy/')) return /^deploy\/local\/(?:[A-Za-z0-9_.-]+\.mjs|README\.md)$/.test(filename)
    || /^deploy\/docker\/(?:[A-Za-z0-9_.-]+\.mjs|README\.md|compose\.yaml|Caddyfile|Dockerfile|Dockerfile\.dockerignore|\.env\.example)$/.test(filename);
  const base = MODULE_PATHS.find(directory => filename.startsWith(`${directory}/`));
  if (!base) return false;
  const relative = filename.slice(base.length + 1);
  if (['LICENSE', '.gitignore', '.npmrc', '.prettierignore', '.env.example'].includes(relative)) return true;
  if (!relative.includes('/')) return SOURCE_EXTENSIONS.test(relative);
  return /^(?:src|test|tests|browser|qualification|scripts|demo|public|assets|migrations|packs)\//.test(relative)
    && (SOURCE_EXTENSIONS.test(relative) || /\.(?:png|jpe?g|gif|webp|ico|woff2?)$/i.test(relative));
}
export function webAllowed(filename, app) {
  privacyPath(filename);
  if (filename === 'index.html' || filename === 'favicon.ico') return true;
  if (app === 'learner' && filename === 'metadata.json') return true;
  return /^(?:assets\/|_expo\/static\/js\/web\/|_expo\/static\/css\/)[A-Za-z0-9_./@-]+\.(?:js|css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf)$/.test(filename);
}
function auditBytes(filename, bytes) {
  privacyPath(filename);
  if (bytes.includes(0)) {
    ensure(/\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf)$/i.test(filename), `${filename}: unexpected binary release input`);
    return;
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  auditText(filename, text);
  if (path.posix.basename(filename) === '.npmrc') auditNpmrc(filename, text);
}
export async function inventory(directory, allowed, prefix = '', { exclude = () => false,excludeSourceMaps=false } = {}) {
  const result = [];
  async function visit(relative) {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const filename = relative ? `${relative}/${name}` : name;
      const info = await lstat(path.join(directory, filename));
      ensure(!info.isSymbolicLink(), `${filename}: symlinks are forbidden in staging`);
      if(excludeSourceMaps&&filename.endsWith('.map')){
        ensure(info.isFile(),'A source-map exclusion must be a regular build file');
        privacyPath(filename.slice(0,-4));
        continue; // Do not read or publish source-map contents/host paths.
      }
      if (exclude(filename)) { ensure(info.isDirectory(), 'Only known build directories may be excluded'); continue; }
      if (info.isDirectory()) { safePath(filename); await visit(filename); continue; }
      ensure(info.isFile(), `${filename}: special files are forbidden`);
      ensure(allowed(filename), `${filename}: file is outside the explicit release allowlist`);
      ensure(info.size <= 32 * 1024 * 1024, `${filename}: file exceeds release review limit`);
      const bytes = await readFile(path.join(directory, filename)); auditBytes(`${prefix}${filename}`, bytes);
      result.push({ path: `${prefix}${filename}`, bytes, mode: snapshotMode(info.mode), sha256: sha(bytes), size: bytes.length });
    }
  }
  await visit('');
  return result;
}
function requireLicense(bytes, label) {
  ensure(bytes && bytes.length > 1000 && bytes.toString('utf8').includes('Apache License') && bytes.toString('utf8').includes('Version 2.0'), `${label}: missing or incompatible Apache-2.0 license`);
}
export function validateStandaloneManifest(manifest) {
  ensure(manifest.name === '@course-core/visuals' && manifest.license === 'Apache-2.0' && manifest.private !== true, 'Standalone visuals identity/license is invalid');
  for (const field of DEPENDENCY_FIELDS) for (const [name, value] of Object.entries(manifest[field] ?? {})) {
    ensure(typeof value === 'string' && !/^(?:file:|link:|workspace:|\.\.?\/|\/)/.test(value), 'Standalone package has a local dependency');
    if (name === '@course-core/sdk') ensure(sdkReleaseUrl(value), 'Standalone SDK must use a versioned public SDK release URL');
  }
  ensure(sdkReleaseUrl(manifest.dependencies?.['@course-core/sdk']), 'A released SDK dependency is required');
  for (const key of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) ensure(!manifest.scripts?.[key], `Unapproved package lifecycle hook: ${key}`);
}
function exportPaths(value) { return typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(exportPaths); }
export function validatePackageEntries(entries, manifest) {
  validateStandaloneManifest(manifest);
  const paths = new Set(entries.map(entry => entry.path));
  for (const entry of entries) {
    ensure(/^package\//.test(entry.path), 'Tarball must have a package root');
    const relative = entry.path.slice(8);
    ensure(['package.json', 'README.md', 'LICENSE'].includes(relative) || relative.startsWith('dist/') && BUILT_EXTENSIONS.test(relative), `${entry.path}: unexpected packed file`);
    auditBytes(entry.path, entry.bytes);
  }
  for (const filename of ['package.json', 'README.md', 'LICENSE']) ensure(paths.has(`package/${filename}`), `Packed package is missing ${filename}`);
  requireLicense(entries.find(entry => entry.path === 'package/LICENSE')?.bytes, 'Packed visuals');
  for (const filename of exportPaths(manifest.exports)) {
    ensure(filename.startsWith('./dist/'), 'Export must target its own built dist'); safePath(filename.slice(2));
    ensure(paths.has(`package/${filename.slice(2)}`), `Advertised export is absent: ${filename}`);
  }
}

// Only regular-file USTAR archives are created/accepted. Links, PAX overrides,
// traversal, duplicate members and unexpected encodings fail before extraction.
export function tarGzip(entries, epoch) {
  ensure(Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= 8589934591, 'Invalid archive source epoch');
  ensure(entries.length <= 10000 && new Set(entries.map(e => e.path)).size === entries.length, 'Duplicate or excessive archive members');
  const parts = [];
  for (const entry of [...entries].sort((a,b) => a.path.localeCompare(b.path, 'en'))) {
    safePath(entry.path);
    ensure(Buffer.isBuffer(entry.bytes) && entry.bytes.length <= 32 * 1024 * 1024, 'Invalid archive member bytes');
    const header = Buffer.alloc(512), split = entry.path.lastIndexOf('/');
    const name = Buffer.byteLength(entry.path) <= 100 ? entry.path : entry.path.slice(split + 1);
    const prefix = name === entry.path ? '' : entry.path.slice(0, split);
    ensure(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155, 'USTAR path is too long');
    const put = (offset, size, text) => header.write(text, offset, size, 'ascii');
    const octal = (offset,size,value) => put(offset,size,`${value.toString(8).padStart(size-1,'0')}\0`);
    put(0,100,name); octal(100,8,entry.mode ?? 0o644); octal(108,8,0); octal(116,8,0); octal(124,12,entry.bytes.length); octal(136,12,epoch);
    header.fill(32,148,156); put(156,1,'0'); put(257,6,'ustar\0'); put(263,2,'00'); put(345,155,prefix);
    put(148,8,`${header.reduce((sum,value)=>sum+value,0).toString(8).padStart(6,'0')}\0 `);
    parts.push(header,entry.bytes,Buffer.alloc((512-entry.bytes.length%512)%512));
  }
  return gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]),{level:9});
}
export function readTarGzip(bytes) {
  const tar = gunzipSync(bytes,{maxOutputLength:256*1024*1024}), entries = [], seen = new Set();
  let cursor = 0;
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor,cursor+512); cursor += 512;
    if (header.every(value=>value===0)) { ensure(tar.subarray(cursor).every(value=>value===0),'Unexpected trailing tar bytes'); return entries; }
    const str = (offset,size) => header.subarray(offset,offset+size).toString('utf8').replace(/\0.*$/s,'');
    const number = (offset,size) => { const value=str(offset,size).trim(); ensure(/^[0-7]+$/.test(value),'Invalid tar numeric field'); return Number.parseInt(value,8); };
    const expected = number(148,8), checksum = header.reduce((sum,value,index)=>sum+(index>=148&&index<156?32:value),0);
    ensure(expected===checksum,'Tar header checksum mismatch');
    const prefix=str(345,155), filename=prefix?`${prefix}/${str(0,100)}`:str(0,100);
    const type=str(156,1); ensure(type===''||type==='0'||type==='5','Links and extended tar metadata are forbidden');
    const normalized=type==='5'?filename.replace(/\/$/,''):filename; safePath(normalized);
    ensure(!seen.has(normalized),'Duplicate tar member');seen.add(normalized);
    const size=number(124,12);ensure(size<=32*1024*1024&&cursor+size<=tar.length,'Truncated or oversized tar member');
    if(type==='5')ensure(size===0,'Invalid directory member');
    else entries.push({path:normalized,bytes:Buffer.from(tar.subarray(cursor,cursor+size)),mode:snapshotMode(number(100,8)),sha256:sha(tar.subarray(cursor,cursor+size)),size});
    cursor+=Math.ceil(size/512)*512;
  }
  throw new Error('Tar archive has no terminator');
}
async function extract(entries, directory) {
  for(const entry of entries){safePath(entry.path);await mkdir(path.dirname(path.join(directory,entry.path)),{recursive:true});await writeFile(path.join(directory,entry.path),entry.bytes,{flag:'wx',mode:entry.mode});}
}
async function git(root,args,buffer=false){ const {stdout}=await exec('git',args,{cwd:root,encoding:buffer?'buffer':'utf8',maxBuffer:64*1024*1024});return buffer?stdout:stdout.trim(); }
export function validateReleaseIdentity({tag,version,commit,head,ref,workflowSha,repository}) {
  ensure(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag),'A versioned vN.N.N tag is required');
  ensure(tag===`v${version}`,'Release tag does not match root version');
  ensure(/^[a-f0-9]{40}$/.test(commit)&&commit===head&&commit===workflowSha,'Release commit is not the exact workflow/checkout commit');
  ensure(ref===`refs/tags/${tag}`,'Dispatch the workflow from the requested tag, not a branch');
  ensure(repository===REPOSITORY,'Release identity must belong to the public core repository');
}
/** Steps that run only `if: failure()` (diagnostic uploads). They are the only
 * steps allowed to be skipped in a passing job; any other skipped step means a
 * required check did not run. scripts/release-artifacts.test.mjs pins this list
 * against every conditional step in .github/workflows/ci.yml. */
export const FAILURE_ONLY_CI_STEPS = Object.freeze(['Retain disposable-database browser failure diagnostics','Retain public-demo browser failure diagnostics']);
export function ciStepPassed(step) {
  return step?.conclusion==='success'||(step?.conclusion==='skipped'&&FAILURE_ONLY_CI_STEPS.includes(step.name));
}
export function validateCiEvidence(identity, run, jobs, attempt) {
  ensure(run.head_sha===identity.commit&&run.repository?.full_name===REPOSITORY&&run.event==='workflow_dispatch','CI run is for another source or event');
  ensure(run.path?.split('@')[0]==='.github/workflows/release.yml'&&run.run_attempt===attempt,'CI workflow/attempt does not match');
  ensure(run.referenced_workflows?.some(item=>item.sha===identity.commit&&item.path.startsWith(`${REPOSITORY}/.github/workflows/ci.yml@`)),'Same-commit reusable full CI was not recorded');
  const selected=REQUIRED_CI_JOBS.map(name=>{
    const matches=jobs.filter(job=>job.name===name||job.name.endsWith(` / ${name}`));
    ensure(matches.length===1,`Required full-CI job is missing or ambiguous: ${name}`);
    const job=matches[0];ensure(job.head_sha===identity.commit&&job.status==='completed'&&job.conclusion==='success',`Required full-CI job did not pass: ${name}`);
    ensure(job.steps?.some(step=>step.conclusion==='success')&&job.steps.every(ciStepPassed),`Full-CI job contains a failed or skipped required step: ${name}`);
    return {id:job.id,name:job.name,conclusion:job.conclusion,url:job.html_url,completedAt:job.completed_at};
  });
  for(const job of jobs.filter(job=>job.name.startsWith('Full CI /'))) ensure(job.conclusion==='success'&&job.status==='completed',`Additional full-CI job did not pass: ${job.name}`);
  return {runId:run.id,attempt,url:run.html_url,workflow:run.path,headSha:run.head_sha,jobs:selected};
}
/** Read-only GitHub calls are idempotent. Retry ONLY transient failures (network
 * errors, 429, 5xx) with bounded backoff; every response is still fully verified,
 * and 4xx answers such as a missing tag or forbidden token fail immediately. */
export async function fetchWithTransientRetry(url,init,{attempts=4,fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),delays=[2000,5000,15000]}={}) {
  for(let attempt=1;;attempt++){
    let response;
    try{response=await fetchImpl(url,{...init,signal:AbortSignal.timeout(30000)});}
    catch(error){if(attempt>=attempts)throw error;await wait(delays[Math.min(attempt-1,delays.length-1)]);continue;}
    if((response.status===429||response.status>=500)&&attempt<attempts){await wait(delays[Math.min(attempt-1,delays.length-1)]);continue;}
    return response;
  }
}
/** fetchWithTransientRetry plus the JSON body read. A body cut short by a reset or a
 * timeout is fetched again (bounded); malformed JSON is a definitive answer. Resolves to
 * { response, body } (body only for a 2xx). */
export async function fetchJsonWithTransientRetry(url,init,options={}) {
  const wait=options.wait??(ms=>new Promise(r=>setTimeout(r,ms))),attempts=options.attempts??4,delays=options.delays??[2000,5000,15000];
  for(let attempt=1;;attempt++){
    const response=await fetchWithTransientRetry(url,init,options);
    if(!response.ok)return {response};
    try{return {response,body:await response.json()};}
    catch(error){if(error instanceof SyntaxError||attempt>=attempts)throw error;await wait(delays[Math.min(attempt-1,delays.length-1)]);}
  }
}
async function github(endpoint,{allow404=false}={}) {
  const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
  if(process.env.GITHUB_TOKEN)headers.Authorization=`Bearer ${process.env.GITHUB_TOKEN}`;
  const {response,body}=await fetchJsonWithTransientRetry(`https://api.github.com/repos/${REPOSITORY}/${endpoint}`,{headers});
  if(response.status===404&&allow404)return null;
  ensure(response.ok,`GitHub release verification failed (HTTP ${response.status}); no candidate was approved`);
  return body;
}
async function remoteTag(tag) {
  const ref=await github(`git/ref/tags/${encodeURIComponent(tag)}`),tagObject=ref.object.sha;
  let object=ref.object;
  for(let depth=0;object.type==='tag'&&depth<5;depth++)object=(await github(`git/tags/${object.sha}`)).object;
  ensure(object.type==='commit','Release tag does not resolve to a commit');
  return {tagObject,commit:object.sha};
}
async function identity(root,tag,commit,{ci=false}={}) {
  const env=process.env;ensure(env.GITHUB_ACTIONS==='true','Candidate generation is restricted to the tag-bound GitHub workflow');
  const manifest=await readJson(path.join(root,'package.json'));
  validateReleaseIdentity({tag,version:manifest.version,commit,head:await git(root,['rev-parse','HEAD']),ref:env.GITHUB_REF,workflowSha:env.GITHUB_WORKFLOW_SHA,repository:env.GITHUB_REPOSITORY});
  ensure(env.GITHUB_SHA===commit&&env.GITHUB_WORKFLOW_REF===`${REPOSITORY}/.github/workflows/release.yml@refs/tags/${tag}`,'Workflow ref/SHA identity mismatch');
  ensure((await git(root,['status','--porcelain','--untracked-files=all']))==='','The release checkout contains uncommitted or untracked source');
  ensure(await git(root,['rev-parse',`${tag}^{commit}`])===commit,'Local tag points elsewhere');
  const remote=await remoteTag(tag);ensure(remote.commit===commit,'Remote tag moved or does not match the tested commit');
  const result={repository:REPOSITORY,tag,version:manifest.version,commit,tagObject:remote.tagObject,tree:await git(root,['rev-parse',`${commit}^{tree}`]),sourceEpoch:Number(await git(root,['show','-s','--format=%ct',commit])),workflowRef:env.GITHUB_WORKFLOW_REF,workflowSha:env.GITHUB_WORKFLOW_SHA};
  if(ci){
    ensure(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT??''),'Missing CI run identity');
    const run=await github(`actions/runs/${env.GITHUB_RUN_ID}`),jobs=[];
    for(let page=1;page<=10;page++){const data=await github(`actions/runs/${run.id}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`);jobs.push(...data.jobs);if(jobs.length>=data.total_count)break;ensure(page<10,'CI jobs pagination limit exceeded');}
    result.ci=validateCiEvidence(result,run,jobs,Number(env.GITHUB_RUN_ATTEMPT));
  }
  return result;
}

async function npmEnvironment(scratch) {
  const config=path.join(scratch,'npm-config');await mkdir(config,{recursive:true});
  await writeFile(path.join(config,'user.npmrc'),'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nworkspaces=false\n');
  await writeFile(path.join(config,'global.npmrc'),'');
  const env=Object.fromEntries(['PATH','HOME','TMPDIR','TMP','TEMP','LANG','SystemRoot','USERPROFILE'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
  return {...env,PATH:`${path.dirname(process.execPath)}${path.delimiter}${env.PATH??''}`,CI:'true',EXPO_NO_TELEMETRY:'1',NPM_CONFIG_USERCONFIG:path.join(config,'user.npmrc'),NPM_CONFIG_GLOBALCONFIG:path.join(config,'global.npmrc'),NPM_CONFIG_CACHE:path.join(config,'cache'),NPM_CONFIG_REGISTRY:'https://registry.npmjs.org/',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_WORKSPACES:'false',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',...npmFetchRetryEnv()};
}
/** A registry-reading npm command (`ci`, or `install --package-lock-only`) under the shared
 * retry policy of scripts/npm-retry.mjs: network-class failures only, with the partial
 * node_modules removed between attempts; lockfile, integrity, usage and 4xx failures stop at
 * once. Output is captured only to classify the failure and is never printed into the
 * public release evidence; `label` is a repository-relative module name, not a host path. */
export async function npmWithRetry(args,cwd,env,label,options={}) {
  try{
    return await npmCiWithRetry(cwd,async()=>{
      try{await exec('npm',args,{cwd,env,maxBuffer:32*1024*1024});return {ok:true};}
      catch(error){return {ok:false,output:`${error.stdout??''}\n${error.stderr??''}`};}
    },{label,action:`npm ${args[0]}`,...options});
  }catch{throw new Error(`npm ${args[0]} failed in ${label}; no verified candidate was produced`);}
}
async function command(binary,args,cwd,env) {
  try{return await exec(binary,args,{cwd,env,maxBuffer:32*1024*1024});}
  catch(error){
    // Do not print subprocess environments or raw failure output into public evidence.
    throw new Error(`${path.basename(binary)} ${args[0]??''} failed with exit ${error.code??'unknown'}; no verified candidate was produced`);
  }
}
/** Every tracked path at `commit` must be a release input: a regular file, a
 * reviewed source path and no private or operational name. The release build and
 * Public CI (`check-inputs`) apply this same check, so a PR fails when it adds a
 * name the release would refuse. */
export function reviewTreeListing(listing) {
  const names=[];
  for(const record of listing.split('\0').filter(Boolean)){
    const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(record);
    ensure(match,'Source snapshot contains a symlink, submodule or unsupported object');
    const filename=match[3];ensure(sourceAllowed(filename),`${filename}: unreviewed source path; update the explicit profile before releasing`);names.push(filename);
  }
  return names;
}
export async function checkReleaseInputs(root=ROOT,commit='HEAD') {
  const resolved=await git(root,['rev-parse','--verify',`${commit}^{commit}`]);
  const names=reviewTreeListing(await git(root,['ls-tree','-r','-z',resolved]));
  ensure(names.includes('LICENSE'),'Source license is missing');
  return {state:'release_inputs_reviewed',commit:resolved,files:names.length};
}
async function snapshot(root,commit,directory,{visualsOnly=false}={}) {
  const selected=visualsOnly?['packages/visuals','LICENSE','package.json']:[];
  const names=reviewTreeListing(await git(root,['ls-tree','-r','-z',commit,...selected]));
  ensure(names.includes('LICENSE'),'Source license is missing');
  const archive=await git(root,['archive','--format=tar',commit,...selected],true);
  // git archive emits a global PAX commit comment. Extract only the previously
  // reviewed immutable tree paths using git archive's trusted writer.
  const tarPath=path.join(path.dirname(directory),'snapshot.tar');await writeFile(tarPath,archive);await mkdir(directory,{recursive:true});
  await command('tar',['-xf',tarPath,'-C',directory],root,process.env);await rm(tarPath);
  const entries=await inventory(directory,sourceAllowed);ensure(entries.length===names.length,'Snapshot inventory differs from reviewed Git tree');
  return entries;
}
export function runtimeAllowed(relative,name,registry=MODULES) {
  privacyPath(relative);
  if(['package.json','package-lock.json','README.md','LICENSE'].includes(relative))return true;
  if(registry[name]?.web)return relative.startsWith('dist/')&&webAllowed(relative.slice(5),name);
  if(relative.startsWith('dist/')){
    if(/^dist\/(?:test|tests|browser|qualification)\//.test(relative))return false;
    return BUILT_EXTENSIONS.test(relative)||name==='sandbox'&&relative==='dist/runner.py';
  }
  // Private modules are shipped together, including public runtime source/data.
  // Dev tests, operator configs, caches and logs are never included.
  return /^(?:src|scripts|packs|migrations)\//.test(relative)&&/\.(?:[cm]?[jt]sx?|json|sql|py|css|svg)$/.test(relative);
}
export function validateRuntimeGraph(moduleRecords) {
  const byName=new Map(moduleRecords.map(record=>[record.manifest.name,record]));
  for(const record of moduleRecords)for(const field of DEPENDENCY_FIELDS)for(const [name,value] of Object.entries(record.manifest[field]??{})){
    if(name==='@course-core/sdk')ensure(sdkReleaseUrl(value),'Runtime SDK may not be a local or private copy');
    if(!value.startsWith('file:'))continue;
    const target=byName.get(name);ensure(target,`Runtime dependency is absent: ${name}`);
    ensure(path.posix.normalize(path.posix.join(record.directory,value.slice(5)))===target.directory,'Runtime local dependency escapes or breaks the preserved module graph');
  }
}
async function buildSnapshot(directory,names,env) {
  const graph=await resolveModuleGraph(names,{root:directory});
  for(const name of graph.order){
    const module=graph.modules.get(name),lock=await readJson(path.join(module.directory,'package-lock.json'));
    auditDependencies(module.manifest,lock,module.directory,directory,MODULES[name].directory);
    console.log(`Building audited module: ${name}`);
    await npmWithRetry(['ci','--ignore-scripts','--workspaces=false'],module.directory,env,MODULES[name].directory);
    await command('npm',['run',module.build,'--workspaces=false'],module.directory,env);
  }
  return graph;
}
async function stageVisuals(source,output,rootLicense,env) {
  const manifest=await readJson(path.join(source,'package.json'));validateStandaloneManifest(manifest);
  const stage=path.join(output,'visuals-stage');await mkdir(stage,{recursive:true});
  for(const filename of ['package.json','README.md'])await writeFile(path.join(stage,filename),await readFile(path.join(source,filename)));
  let license;try{license=await readFile(path.join(source,'LICENSE'));}catch(error){if(error.code!=='ENOENT')throw error;license=rootLicense;}
  requireLicense(license,'Visuals');await writeFile(path.join(stage,'LICENSE'),license);
  const dist=await inventory(path.join(source,'dist'),filename=>BUILT_EXTENSIONS.test(filename));
  for(const entry of dist){const dest=path.join(stage,'dist',entry.path);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,entry.bytes);}
  const {stdout}=await command('npm',['pack','--json','--ignore-scripts','--workspaces=false'],stage,env);
  const metadata=JSON.parse(stdout);ensure(metadata.length===1&&typeof metadata[0].filename==='string','Unexpected npm pack result');
  safePath(metadata[0].filename);
  const bytes=await readFile(path.join(stage,metadata[0].filename));
  const entries=readTarGzip(bytes);validatePackageEntries(entries,JSON.parse(entries.find(entry=>entry.path==='package/package.json').bytes));
  ensure(metadata[0].integrity===sri(bytes),'npm pack integrity does not match candidate bytes');
  return {bytes,filename:metadata[0].filename,entries,manifest};
}

export const CONSUMER_RUNTIME = `import assert from 'node:assert/strict';
import {realpathSync,readFileSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {VisualRuntime,toVisualExperience,fromVisualExperience,parseScene} from '@course-core/visuals/headless';
import {VisualPlayer} from '@course-core/visuals/react';
import {motionDemo} from '@course-core/visuals/demos';
const installed=path.join(process.cwd(),'node_modules/@course-core/visuals');
assert.equal(lstatSync(installed).isSymbolicLink(),false);
for(const specifier of ['@course-core/visuals','@course-core/visuals/headless','@course-core/visuals/react','@course-core/visuals/demos','@course-core/visuals/styles.css']) {
 const resolved=realpathSync(fileURLToPath(import.meta.resolve(specifier)));
 assert(resolved.startsWith(realpathSync(process.cwd())+path.sep),'Consumer resolved outside its own installation');
}
const scene=parseScene(motionDemo),runtime=new VisualRuntime(scene);
runtime.seek(1000);assert.equal(runtime.getSnapshot().frame.timeMs,1000);
assert.equal(fromVisualExperience(toVisualExperience(scene)).id,scene.id);
const markup=renderToStaticMarkup(createElement(VisualPlayer,{scene}));
assert(markup.includes('<svg'));assert(markup.includes(scene.title));
assert(readFileSync(fileURLToPath(import.meta.resolve('@course-core/visuals/styles.css')),'utf8').length>100);
assert.throws(()=>parseScene({...scene,untrustedExtra:true}));
console.log('Installed visuals headless, React SSR, CSS and export-boundary smoke passed.');
`;
export const CONSUMER_TYPES = `import {createElement} from 'react';
import {VisualRuntime,parseScene,toVisualExperience,fromVisualExperience,type Scene} from '@course-core/visuals/headless';
import {VisualPlayer,SceneView} from '@course-core/visuals/react';
import {motionDemo} from '@course-core/visuals/demos';
const scene:Scene=parseScene(motionDemo);
const runtime=new VisualRuntime(fromVisualExperience(toVisualExperience(scene)));
createElement(VisualPlayer,{scene});
createElement(SceneView,{frame:runtime.getSnapshot().frame,title:scene.title});
`;
export async function installedVisualsSmoke(packed,lock,scratch,env) {
  const consumer=path.join(scratch,'consumer');await mkdir(consumer,{recursive:true});
  const server=createServer((request,response)=>{
    if(request.url!==`/${packed.filename}`){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':packed.bytes.length});response.end(packed.bytes);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{
    const localUrl=`http://127.0.0.1:${server.address().port}/${packed.filename}`;
    const selected=['react','react-dom','@types/react','@types/react-dom','typescript'];
    const dependencies={'@course-core/visuals':localUrl};
    for(const name of selected){const entry=lock.packages[`node_modules/${name}`];ensure(entry?.version&&entry.integrity,`Missing locked consumer dependency: ${name}`);dependencies[name]=entry.version;}
    await writeFile(path.join(consumer,'package.json'),json({name:'course-core-installed-visuals-proof',version:'1.0.0',private:true,type:'module',dependencies}));
    await npmWithRetry(['install','--package-lock-only','--ignore-scripts','--workspaces=false'],consumer,env,'installed visuals consumer');
    const consumerLock=await readJson(path.join(consumer,'package-lock.json'));
    for(const [location,entry] of Object.entries(consumerLock.packages)){
      if(!location)continue;
      ensure(!entry.link&&typeof entry.integrity==='string'&&/^sha512-/.test(entry.integrity),'Consumer dependency is unpinned or a local link');
      if(location==='node_modules/@course-core/visuals')ensure(entry.resolved===localUrl&&entry.integrity===sri(packed.bytes),'Consumer did not resolve the exact candidate tarball');
      else{
        const remote=new URL(entry.resolved);ensure(remote.origin==='https://registry.npmjs.org'||sdkReleaseUrl(entry.resolved),'Consumer dependency is not public/released');
        if(location==='node_modules/@course-core/sdk')ensure(entry.integrity===lock.packages[location]?.integrity,'SDK consumer integrity drifted from the tested module lock');
        if(selected.some(name=>location===`node_modules/${name}`))ensure(entry.integrity===lock.packages[location]?.integrity,'Consumer tool/peer integrity drifted');
      }
    }
    await npmWithRetry(['ci','--ignore-scripts','--workspaces=false'],consumer,env,'installed visuals consumer');
    await writeFile(path.join(consumer,'smoke.mjs'),CONSUMER_RUNTIME);await writeFile(path.join(consumer,'types.ts'),CONSUMER_TYPES);
    await writeFile(path.join(consumer,'tsconfig.json'),json({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:false,noEmit:true},include:['types.ts']}));
    await command(process.execPath,['smoke.mjs'],consumer,env);
    await command(process.execPath,['node_modules/typescript/bin/tsc','--noEmit'],consumer,env);
    // Relocation must work: no dependency may reach the source/build/pack tree.
    for(const name of ['@course-core/visuals','@course-core/sdk',...selected])ensure((await realpath(path.join(consumer,'node_modules',name))).startsWith(`${await realpath(consumer)}${path.sep}`),'Consumer reached a sibling checkout');
    return {status:'passed',headless:true,reactSsr:true,types:true,css:true,noSiblingSource:true,tarballIntegrity:sri(packed.bytes),dependencies:selected.map(name=>({name,version:dependencies[name],integrity:consumerLock.packages[`node_modules/${name}`].integrity})),sdk:{url:consumerLock.packages['node_modules/@course-core/sdk'].resolved,integrity:consumerLock.packages['node_modules/@course-core/sdk'].integrity}};
  }finally{await new Promise(resolve=>server.close(resolve));}
}

const archiveNames = (version,visualsVersion=version) => ({
  source: `course-core-source-${version}.tar.gz`,
  runtime: `course-core-runtime-${version}.tar.gz`,
  learner: `course-core-learner-web-${version}.tar.gz`,
  admin: `course-core-admin-web-${version}.tar.gz`,
  visuals: `course-core-visuals-${visualsVersion}.tgz`,
});
export const SBOM_FORMAT = Object.freeze({format:'CycloneDX',specVersion:'1.5'});
export const sbomFilename = version => `course-core-sbom-${version}.cdx.json`;
const purl = (name,version) => `pkg:npm/${name.startsWith('@')?`%40${name.slice(1)}`:name}@${version}`;
const sriHex = integrity => { const match=/^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity??''); ensure(match,'Locked dependency lacks a SHA-512 integrity'); return Buffer.from(match[1],'base64').toString('hex'); };
/** A deterministic CycloneDX 1.5 inventory of every package locked by every
 * module in the immutable source tree (build tools included and marked), plus
 * the Course Core modules themselves. It is derived only from the reviewed lock
 * files and release identity, so verification regenerates it byte for byte. It
 * lists what the locks resolve; it is not a vulnerability or license opinion. */
export function cycloneDxSbom(identity, modules) {
  const components=new Map();
  for(const module of [...modules].sort((a,b)=>a.directory<b.directory?-1:1)){
    ensure(module.lock?.lockfileVersion===3&&module.lock.packages&&typeof module.lock.packages==='object','SBOM requires lockfileVersion 3');
    for(const [key,entry] of Object.entries(module.lock.packages)){
      if(key===''||entry.link||!key.includes('node_modules/'))continue;
      const name=entry.name??key.slice(key.lastIndexOf('node_modules/')+'node_modules/'.length);
      ensure(/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]{1,214}$/i.test(name)&&typeof entry.version==='string'&&/^[0-9A-Za-z.+-]{1,100}$/.test(entry.version)&&typeof entry.resolved==='string','Invalid locked package identity');
      // install-links copies of in-repository modules appear as file: entries; they are listed as modules below.
      if(entry.resolved.startsWith('file:')&&name.startsWith('@course-core/')&&Object.hasOwn(MODULES,name.slice('@course-core/'.length)))continue;
      const ref=purl(name,entry.version),hash=sriHex(entry.integrity),dev=entry.dev===true||entry.devOptional===true;
      const previous=components.get(ref);
      if(previous){ensure(previous.hash===hash&&previous.resolved===entry.resolved,`Conflicting locked bytes for ${ref}`);previous.modules.add(module.directory);previous.dev&&=dev;continue;}
      ensure(entry.license===undefined||(typeof entry.license==='string'&&entry.license.length<=200&&!/[\r\n\x00]/.test(entry.license)),'Invalid locked license declaration');
      components.set(ref,{ref,name,version:entry.version,hash,resolved:entry.resolved,license:entry.license,dev,modules:new Set([module.directory])});
    }
  }
  const scoped=name=>name.startsWith('@')?{group:name.slice(0,name.indexOf('/')),name:name.slice(name.indexOf('/')+1)}:{name};
  const own=[...modules].sort((a,b)=>a.directory<b.directory?-1:1).map(module=>({type:'library','bom-ref':`course-core:${module.directory}`,...scoped(module.packageName),version:module.version,
    licenses:[{license:{id:'Apache-2.0'}}],properties:[{name:'course-core:directory',value:module.directory},{name:'course-core:lockSha256',value:module.lockSha256}]}));
  const locked=[...components.values()].sort((a,b)=>a.ref<b.ref?-1:a.ref>b.ref?1:0).map(c=>({type:'library','bom-ref':c.ref,...scoped(c.name),version:c.version,purl:c.ref,
    hashes:[{alg:'SHA-512',content:c.hash}],...(c.license?{licenses:[{license:{name:c.license}}]}:{}),
    externalReferences:[{type:'distribution',url:c.resolved}],
    properties:[...(c.dev?[{name:'course-core:developmentOnly',value:'true'}]:[]),{name:'course-core:lockedBy',value:[...c.modules].sort().join(',')}]}));
  const serial=createHash('sha256').update(`${identity.repository}\0${identity.tag}\0${identity.commit}\0${identity.tree}`).digest('hex');
  const bom={bomFormat:SBOM_FORMAT.format,specVersion:SBOM_FORMAT.specVersion,
    serialNumber:`urn:uuid:${serial.slice(0,8)}-${serial.slice(8,12)}-5${serial.slice(13,16)}-${(8|parseInt(serial[16],16)&3).toString(16)}${serial.slice(17,20)}-${serial.slice(20,32)}`,version:1,
    metadata:{timestamp:new Date(identity.sourceEpoch*1000).toISOString(),
      tools:{components:[{type:'application',name:'course-core release-artifacts',version:identity.version}]},
      component:{type:'application','bom-ref':`course-core@${identity.version}`,group:'@course-core',name:'repository',version:identity.version,licenses:[{license:{id:'Apache-2.0'}}],
        externalReferences:[{type:'vcs',url:`https://github.com/${identity.repository}/tree/${identity.commit}`}]},
      properties:[{name:'course-core:tag',value:identity.tag},{name:'course-core:commit',value:identity.commit},{name:'course-core:tree',value:identity.tree}]},
    components:[...own,...locked]};
  return Buffer.from(json(bom));
}
/** The SBOM for a candidate, rebuilt from the module locks inside its source archive. */
function sbomFromSource(manifest,source){
  return cycloneDxSbom(manifest.identity,manifest.modules.map(row=>{
    const bytes=source.find(e=>e.path===`course-core/${row.directory}/package-lock.json`)?.bytes;ensure(bytes&&sha(bytes)===row.lockSha256,'Source dependency lock receipt changed');
    return {...row,lock:JSON.parse(bytes)};
  }));
}
export function metadata(entries) {
  return entries.map(({path: filename,bytes,mode})=>({path:filename,size:bytes.length,sha256:sha(bytes),mode:mode??0o644})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function exactKeys(value, keys, label) {
  ensure(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).sort().join('\0')===[...keys].sort().join('\0'),`Invalid ${label} fields`);
}
/** The compatibility matrix recorded in a candidate manifest (scripts/release-compat.mjs). */
export function validateCompatibility(matrix,version) {
  exactKeys(matrix,['schemaVersion','core','sdk','node','postgres','migrations'],'candidate compatibility matrix');
  const semver=/^\d+\.\d+\.\d+$/;
  ensure(matrix.schemaVersion===1&&matrix.core===version,'Compatibility matrix belongs to another version');
  exactKeys(matrix.sdk,['release','coursePackages'],'compatibility SDK');exactKeys(matrix.sdk.coursePackages,['supported','sameMajorOutsideRange','otherMajor'],'compatibility course packages');
  ensure(semver.test(matrix.sdk.release)&&semver.test(matrix.sdk.coursePackages.supported?.min)&&semver.test(matrix.sdk.coursePackages.supported?.maxExclusive)
    &&matrix.sdk.coursePackages.sameMajorOutsideRange==='install_with_warning'&&matrix.sdk.coursePackages.otherMajor==='refused','Invalid compatibility SDK range');
  exactKeys(matrix.node,['engines','testedMajor','modules'],'compatibility Node');
  ensure(typeof matrix.node.engines==='string'&&Number.isSafeInteger(matrix.node.testedMajor)&&Object.keys(matrix.node.modules).every(name=>Object.hasOwn(MODULES,name)),'Invalid compatibility Node versions');
  exactKeys(matrix.postgres,['major'],'compatibility PostgreSQL');ensure(Number.isSafeInteger(matrix.postgres.major)&&matrix.postgres.major>=17,'Invalid compatibility PostgreSQL major');
  exactKeys(matrix.migrations,['count','last','sha256'],'compatibility migrations');
  ensure(Number.isSafeInteger(matrix.migrations.count)&&matrix.migrations.count>0&&/^\d{3}_[a-z0-9_]+\.sql$/.test(matrix.migrations.last)&&/^[a-f0-9]{64}$/.test(matrix.migrations.sha256),'Invalid compatibility migration receipt');
}
export function validateCandidateManifest(manifest) {
  exactKeys(manifest,['schemaVersion','state','identity','ci','modules','assets','sbom','compatibility','installedVisuals','verificationScope'],'candidate manifest');
  ensure(manifest.schemaVersion===1 && manifest.state==='verified_candidate','Unsupported candidate state');
  const identity=manifest.identity;
  exactKeys(identity,['repository','tag','version','commit','tagObject','tree','sourceEpoch','workflowRef','workflowSha'],'candidate identity');
  validateReleaseIdentity({...identity,head:identity.commit,ref:`refs/tags/${identity.tag}`});
  ensure(identity.workflowRef===`${REPOSITORY}/.github/workflows/release.yml@refs/tags/${identity.tag}` && /^[a-f0-9]{40}$/.test(identity.tagObject)
    && /^[a-f0-9]{40}$/.test(identity.tree) && Number.isSafeInteger(identity.sourceEpoch) && identity.sourceEpoch>0,'Invalid source provenance');
  const expected=archiveNames(identity.version,manifest.modules?.find(m=>m.name==='visuals')?.version);
  ensure(Array.isArray(manifest.assets) && manifest.assets.length===Object.keys(expected).length,'Missing or excessive candidate assets');
  const seen=new Set();
  for(const asset of manifest.assets){
    exactKeys(asset,['kind','filename','size','sha256','entries'],'candidate asset');
    ensure(Object.hasOwn(expected,asset.kind) && expected[asset.kind]===asset.filename && !seen.has(asset.kind),'Candidate asset identity mismatch');seen.add(asset.kind);
    ensure(Number.isSafeInteger(asset.size)&&asset.size>0&&asset.size<=256*1024*1024&&/^[a-f0-9]{64}$/.test(asset.sha256),'Invalid asset digest/size');
    ensure(Array.isArray(asset.entries)&&asset.entries.length>0&&asset.entries.length<=10000,'Invalid asset inventory');
    const paths=new Set();
    for(const entry of asset.entries){
      exactKeys(entry,['path','size','sha256','mode'],'candidate archive member');safePath(entry.path);
      ensure(!paths.has(entry.path)&&Number.isSafeInteger(entry.size)&&entry.size>=0&&entry.size<=32*1024*1024&&/^[a-f0-9]{64}$/.test(entry.sha256)&&[0o644,0o755].includes(entry.mode),'Invalid or duplicate archive inventory');paths.add(entry.path);
    }
  }
  exactKeys(manifest.sbom,['filename','size','sha256','format','specVersion'],'candidate SBOM');
  ensure(manifest.sbom.filename===sbomFilename(identity.version)&&manifest.sbom.format===SBOM_FORMAT.format&&manifest.sbom.specVersion===SBOM_FORMAT.specVersion
    &&Number.isSafeInteger(manifest.sbom.size)&&manifest.sbom.size>0&&manifest.sbom.size<=64*1024*1024&&/^[a-f0-9]{64}$/.test(manifest.sbom.sha256),'Invalid candidate SBOM receipt');
  validateCompatibility(manifest.compatibility,identity.version);
  ensure(Array.isArray(manifest.modules)&&manifest.modules.length===Object.keys(MODULES).length&&new Set(manifest.modules.map(m=>m.name)).size===manifest.modules.length,'Runtime module coverage mismatch');
  for(const module of manifest.modules){
    exactKeys(module,['name','directory','packageName','version','lockSha256'],'runtime module receipt');
    ensure(Object.hasOwn(MODULES,module.name)&&MODULES[module.name].directory===module.directory&&module.packageName===`@course-core/${module.name}`&&typeof module.version==='string'&&/^[a-f0-9]{64}$/.test(module.lockSha256),'Invalid runtime module receipt');
  }
  ensure(manifest.installedVisuals?.status==='passed' && manifest.installedVisuals.noSiblingSource===true && manifest.installedVisuals.headless===true
    && manifest.installedVisuals.reactSsr===true && manifest.installedVisuals.types===true && manifest.installedVisuals.css===true,'Installed package acceptance is missing');
  ensure(manifest.verificationScope==='source_ci_and_installed_package_only_no_live_provider_or_deployment','Candidate must state its actual verification scope');
  ensure(manifest.ci?.headSha===identity.commit&&Number.isSafeInteger(manifest.ci.runId)&&manifest.ci.runId>0&&Number.isSafeInteger(manifest.ci.attempt)&&manifest.ci.attempt>0,'CI provenance mismatch');
  ensure(Array.isArray(manifest.ci.jobs)&&manifest.ci.jobs.length===REQUIRED_CI_JOBS.length&&new Set(manifest.ci.jobs.map(j=>j.id)).size===manifest.ci.jobs.length,'Missing CI job receipts');
  for(const name of REQUIRED_CI_JOBS)ensure(manifest.ci.jobs.filter(j=>(j.name===name||j.name.endsWith(` / ${name}`))&&j.conclusion==='success').length===1,`Missing passed job receipt: ${name}`);
  return manifest;
}
export function checksumText(manifest) {
  // The SBOM is listed so `sha256sum -c SHA256SUMS` covers every published file except the manifest and this receipt.
  return [...manifest.assets,manifest.sbom].sort((a,b)=>a.filename<b.filename?-1:1).map(asset=>`${asset.sha256}  ${asset.filename}\n`).join('');
}
export async function verifyCandidateBytes(directory, manifest) {
  validateCandidateManifest(manifest);
  const expected=new Set([...manifest.assets.map(a=>a.filename),manifest.sbom.filename,'release-manifest.json','SHA256SUMS']);
  const files=await readdir(directory);ensure(files.length===expected.size&&files.every(f=>expected.has(f)),'Unexpected or missing files in candidate directory');
  for(const filename of files){const info=await lstat(path.join(directory,filename));ensure(info.isFile()&&!info.isSymbolicLink(),'Candidate files must be regular files');}
  ensure(await readFile(path.join(directory,'SHA256SUMS'),'utf8')===checksumText(manifest),'Checksum receipt changed');
  ensure(await readFile(path.join(directory,'release-manifest.json'),'utf8')===json(manifest),'Manifest representation changed');
  const byKind=new Map();
  for(const asset of manifest.assets){
    const info=await lstat(path.join(directory,asset.filename));ensure(info.size===asset.size,'Asset size changed');
    const bytes=await readFile(path.join(directory,asset.filename));ensure(sha(bytes)===asset.sha256,'Asset bytes changed');
    const entries=readTarGzip(bytes);ensure(JSON.stringify(metadata(entries))===JSON.stringify(asset.entries),'Archive inventory differs from its receipt');
    byKind.set(asset.kind,entries);
    if(asset.kind==='visuals')validatePackageEntries(entries,JSON.parse(entries.find(e=>e.path==='package/package.json')?.bytes??'null'));
    else for(const entry of entries){
      ensure(entry.path.startsWith('course-core/'),'Archive root differs from the release protocol');
      const relative=entry.path.slice('course-core/'.length);auditBytes(relative,entry.bytes);
      if(asset.kind==='source')ensure(sourceAllowed(relative),'Source member is not approved');
      if(asset.kind==='learner'||asset.kind==='admin')ensure(relative==='LICENSE'||relative==='DEPENDENCY_NOTICES.txt'||webAllowed(relative,asset.kind),'Web member is not approved');
      if(asset.kind==='runtime')ensure(sourceAllowed(relative)||builtRuntimePath(relative)||relative==='DEPENDENCY_NOTICES.txt','Runtime member is not approved');
    }
    if(asset.kind!=='visuals')requireLicense(entries.find(e=>e.path==='course-core/LICENSE')?.bytes,`${asset.kind} archive`);
  }
  // Lock bytes and graph references must be the same in both source and runtime,
  // not merely syntactically valid package names in a hand-written manifest.
  const source=byKind.get('source'),runtime=byKind.get('runtime'),records=[];
  const rootManifest=source.find(e=>e.path==='course-core/package.json')?.bytes;
  ensure(rootManifest&&rootManifest.equals(runtime.find(e=>e.path==='course-core/package.json')?.bytes??Buffer.alloc(0)),'Root package source differs between archives');
  const rootPackage=JSON.parse(rootManifest);ensure(rootPackage.name==='@course-core/repository'&&rootPackage.version===manifest.identity.version,'Root package does not match the core release version');
  for(const row of manifest.modules){
    const lookup=(entries,filename)=>entries.find(e=>e.path===`course-core/${row.directory}/${filename}`)?.bytes;
    const sourceManifest=lookup(source,'package.json'),sourceLock=lookup(source,'package-lock.json');
    ensure(sourceManifest&&sourceLock&&sha(sourceLock)===row.lockSha256,'Source dependency lock receipt changed');
    ensure(sourceManifest.equals(lookup(runtime,'package.json')??Buffer.alloc(0))&&sourceLock.equals(lookup(runtime,'package-lock.json')??Buffer.alloc(0)),'Runtime dependency source changed');
    const declared=JSON.parse(sourceManifest);ensure(declared.name===row.packageName&&declared.version===row.version,'Module receipt does not describe its package');
    records.push({directory:row.directory,manifest:declared});
  }
  validateRuntimeGraph(records);
  // The SBOM must be exactly what the archived locks produce, so an edited inventory fails
  // even when its manifest digest and checksum line were rewritten to match.
  const sbomPath=path.join(directory,manifest.sbom.filename),sbomInfo=await lstat(sbomPath),sbom=await readFile(sbomPath);
  ensure(sbomInfo.size===manifest.sbom.size&&sha(sbom)===manifest.sbom.sha256,'SBOM bytes changed');
  ensure(sbom.equals(sbomFromSource(manifest,source)),'SBOM does not match the archived dependency locks');
  return {state:'bytes_verified',assets:manifest.assets.length,commit:manifest.identity.commit,publication:'not_performed'};
}
function builtRuntimePath(relative) {
  const found=Object.entries(MODULES).find(([,module])=>relative.startsWith(`${module.directory}/dist/`));
  return Boolean(found&&runtimeAllowed(relative.slice(found[1].directory.length+1),found[0]));
}
export function licenseDeclaration(value) {
  // Preserve the exact declaration rather than infer which dependencies were
  // included by a bundler. This inventory is not a legal compliance opinion.
  ensure(typeof value==='string'&&value.length>0&&value.length<=200&&!/[\r\n\x00]/.test(value),'Dependency lacks a bounded license declaration');
  return value;
}
async function dependencyNotices(graph) {
  const records=new Map();
  async function visitNodeModules(directory,depth=0){
    ensure(depth<=8,'Dependency notice nesting is excessive');
    let names;try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
    const packages=[];
    for(const name of names){
      if(name.startsWith('.'))continue;
      if(name.startsWith('@'))for(const sub of await readdir(path.join(directory,name)))packages.push(path.join(directory,name,sub));
      else packages.push(path.join(directory,name));
    }
    for(const folder of packages){
      const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())continue;
      let manifest;try{manifest=await readJson(path.join(folder,'package.json'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const key=`${manifest.name}@${manifest.version}`,files=await readdir(folder),texts=[];
      ensure(typeof manifest.name==='string' && /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]{1,214}$/.test(manifest.name),'Invalid installed dependency identity');
      for(const filename of files.filter(name=>/^(?:license|licence|copying|notice)(?:[._-]|$)|^thirdparty.*\.(?:txt|md)$/i.test(name)).sort()){
        const p=path.join(folder,filename),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())continue;
        ensure(s.size<=2*1024*1024,'Dependency notice exceeds review limit');const text=(await readFile(p)).toString('utf8');
        ensure(!text.includes('\0'),'Binary dependency notice');texts.push({filename,text});
      }
      let declaration,licenseReview;
      if(manifest.license!==undefined)declaration=licenseDeclaration(manifest.license);
      else{licenseReview=reviewedLicenseFile(manifest.name,manifest.version,texts);declaration=licenseReview.declaration;}
      const record={name:manifest.name,version:manifest.version,license:declaration,...(licenseReview?{licenseReview}:{}),texts};
      if(records.has(key))ensure(JSON.stringify(records.get(key))===JSON.stringify(record),'Conflicting installed dependency notices');else records.set(key,record);
      ensure(records.size<=5000,'Excessive dependency notice inventory');await visitNodeModules(path.join(folder,'node_modules'),depth+1);
    }
  }
  for(const module of graph.modules.values())await visitNodeModules(path.join(module.directory,'node_modules'));
  const heading='Course Core dependency attribution inventory\nIncludes installed build and runtime dependencies; presence does not assert bundling.\nExact package license declarations and distributed notices are retained below.\nPackages that omit a notice file are identified as metadata-only; their original source repository remains authoritative.\n\n';
  const text=heading+[...records.values()].sort((a,b)=>`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`,'en')).map(record=>
    `${record.name}@${record.version}\n${record.licenseReview?'Reviewed file license':'Declared license'}: ${record.license}\n${record.licenseReview?`Primary review: ${record.licenseReview.source}\nLicense SHA-256: ${record.licenseReview.sha256}\n`:''}${record.texts.length?record.texts.map(t=>`--- ${t.filename} ---\n${t.text}\n`).join('\n'):'No notice file distributed in this package.\n'}`).join('\n');
  ensure(Buffer.byteLength(text)<=32*1024*1024,'Combined notices exceed artifact bound');return Buffer.from(text);
}
export function parseReleaseArguments(args) {
  const action=args[0];ensure(['identity','prepare','verify'].includes(action),'Use identity, prepare or verify');
  const options={action};
  for(let i=1;i<args.length;i+=2){
    const name=args[i];ensure(['--tag','--commit','--output','--directory'].includes(name)&&args[i+1]&&!Object.hasOwn(options,name.slice(2)),'Invalid or duplicate release argument');options[name.slice(2)]=args[i+1];
  }
  ensure(typeof options.tag==='string'&&/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.tag)&&typeof options.commit==='string'&&/^[a-f0-9]{40}$/.test(options.commit),'Exact tag and commit are required');
  ensure(action==='prepare'?options.output&&!options.directory:action==='verify'?options.directory&&!options.output:!options.output&&!options.directory,'Output arguments do not match the action');
  return options;
}
async function prepareCandidates(root,options) {
  const original=await identity(root,options.tag,options.commit,{ci:true}),output=path.resolve(options.output);
  ensure(output!==root&&!output.startsWith(`${root}${path.sep}`),'Candidate output must be outside the source checkout');
  const parent=await realpath(path.dirname(output));ensure(parent===path.dirname(output),'Candidate parent may not redirect through a symlink');
  await mkdir(output,{mode:0o700});
  const scratch=await mkdtemp(path.join(tmpdir(),'course-core-release-'));
  try{
    const source=path.join(scratch,'source'),sourceEntries=await snapshot(root,original.commit,source),env=await npmEnvironment(scratch);
    const graph=await buildSnapshot(source,Object.keys(MODULES),env),license=await readFile(path.join(source,'LICENSE'));
    requireLicense(license,'Source release');
    const notices=await dependencyNotices(graph),runtimeEntries=[...sourceEntries],assets=[],names=archiveNames(original.version,graph.modules.get('visuals').manifest.version);
    const add=(kind,bytes,entries)=>assets.push({kind,filename:names[kind],size:bytes.length,sha256:sha(bytes),entries:metadata(entries),bytes});
    const rooted=entries=>entries.map(entry=>({...entry,path:`course-core/${entry.path}`}));
    add('source',tarGzip(rooted(sourceEntries),original.sourceEpoch),rooted(sourceEntries));
    for(const [name,module] of graph.modules){
      const dist=path.join(module.directory,'dist');
      try{
        const built=await inventory(dist,filename=>MODULES[name].web?webAllowed(filename,name):runtimeAllowed(`dist/${filename}`,name),'',
          {exclude:filename=>['test','tests','browser','qualification'].includes(filename),excludeSourceMaps:true});
        runtimeEntries.push(...built.map(entry=>({...entry,path:`${MODULES[name].directory}/dist/${entry.path}`})));
      }catch(error){if(error.code!=='ENOENT'||module.manifest.exports||MODULES[name].web||name==='api'||name==='supervisor')throw error;}
    }
    runtimeEntries.push({path:'DEPENDENCY_NOTICES.txt',bytes:notices,mode:0o644});
    add('runtime',tarGzip(rooted(runtimeEntries),original.sourceEpoch),rooted(runtimeEntries));
    for(const name of ['learner','admin']){
      const web=await inventory(path.join(graph.modules.get(name).directory,'dist'),filename=>webAllowed(filename,name));
      web.push({path:'LICENSE',bytes:license,mode:0o644},{path:'DEPENDENCY_NOTICES.txt',bytes:notices,mode:0o644});
      add(name,tarGzip(rooted(web),original.sourceEpoch),rooted(web));
    }
    const packed=await stageVisuals(graph.modules.get('visuals').directory,scratch,license,env);
    ensure(packed.filename===names.visuals,'Packed package version/name does not match its component receipt');add('visuals',packed.bytes,packed.entries);
    const installedVisuals=await installedVisualsSmoke(packed,await readJson(path.join(graph.modules.get('visuals').directory,'package-lock.json')),scratch,env);
    const {ci,...boundIdentity}=original;
    const modules=await Promise.all(Object.entries(MODULES).map(async([name,module])=>{const manifest=await readJson(path.join(source,module.directory,'package.json'));return {name,directory:module.directory,packageName:manifest.name,version:manifest.version,lockSha256:sha(await readFile(path.join(source,module.directory,'package-lock.json')))};}));
    const sbom=cycloneDxSbom(boundIdentity,await Promise.all(modules.map(async row=>({...row,lock:await readJson(path.join(source,row.directory,'package-lock.json'))}))));
    const sbomReceipt={filename:sbomFilename(original.version),size:sbom.length,sha256:sha(sbom),...SBOM_FORMAT};
    const compatibility=await compatibilityMatrix(directorySource(source));
    const manifest={schemaVersion:1,state:'verified_candidate',identity:boundIdentity,ci,modules,assets:assets.map(({bytes,...record})=>record),sbom:sbomReceipt,compatibility,installedVisuals,verificationScope:'source_ci_and_installed_package_only_no_live_provider_or_deployment'};
    validateCandidateManifest(manifest);
    for(const asset of assets)await writeFile(path.join(output,asset.filename),asset.bytes,{flag:'wx',mode:0o600});
    await writeFile(path.join(output,sbomReceipt.filename),sbom,{flag:'wx',mode:0o600});
    await writeFile(path.join(output,'release-manifest.json'),json(manifest),{flag:'wx',mode:0o600});
    await writeFile(path.join(output,'SHA256SUMS'),checksumText(manifest),{flag:'wx',mode:0o600});
    await verifyCandidateBytes(output,manifest);
    const fresh=await identity(root,options.tag,options.commit,{ci:true});ensure(fresh.tagObject===original.tagObject&&fresh.tree===original.tree,'Release tag/source changed during preparation');
    return {state:'verified_candidate',directory:output,commit:original.commit,assets:assets.map(a=>({filename:a.filename,sha256:a.sha256})),sbom:{filename:sbomReceipt.filename,sha256:sbomReceipt.sha256},publication:'not_performed'};
  }catch(error){await writeFile(path.join(output,'FAILED'), 'Candidate generation failed. Do not publish this directory.\n',{flag:'wx',mode:0o600}).catch(()=>{});throw error;}
  finally{await rm(scratch,{recursive:true,force:true});}
}
async function verifyCandidates(root,options) {
  const fresh=await identity(root,options.tag,options.commit,{ci:true}),directory=await realpath(options.directory),manifest=await readJson(path.join(directory,'release-manifest.json'));
  validateCandidateManifest(manifest);
  const {ci,...sourceIdentity}=fresh;
  ensure(JSON.stringify(manifest.identity)===JSON.stringify(sourceIdentity)&&manifest.ci.runId===ci.runId&&manifest.ci.attempt===ci.attempt,'Candidate belongs to another source/run/attempt');
  const scratch=await mkdtemp(path.join(tmpdir(),'course-core-verify-'));
  try{
    const expected=await snapshot(root,fresh.commit,path.join(scratch,'source'));
    const archived=readTarGzip(await readFile(path.join(directory,archiveNames(fresh.version).source))).map(e=>({...e,path:e.path.slice('course-core/'.length)}));
    ensure(JSON.stringify(metadata(expected))===JSON.stringify(metadata(archived)),'Archived source does not equal the immutable Git tree');
    ensure(JSON.stringify(await compatibilityMatrix(directorySource(path.join(scratch,'source'))))===JSON.stringify(manifest.compatibility),'Compatibility matrix does not match the archived source');
    return await verifyCandidateBytes(directory,manifest);
  }finally{await rm(scratch,{recursive:true,force:true});}
}
export async function releaseMain(args=process.argv.slice(2),root=ROOT) {
  requireNode26();
  if(args[0]==='check-inputs'){ensure(args.length<=2,'Use check-inputs [commit]');return checkReleaseInputs(root,args[1]??'HEAD');}
  const options=parseReleaseArguments(args);
  if(options.action==='identity'){
    const result=await identity(root,options.tag,options.commit);
    ensure(process.env.GITHUB_OUTPUT,'GitHub output path is missing');
    await appendFile(process.env.GITHUB_OUTPUT,`tag=${result.tag}\ncommit=${result.commit}\n`);
    return {state:'identity_bound',tag:result.tag,commit:result.commit};
  }
  return options.action==='prepare'?prepareCandidates(root,options):verifyCandidates(root,options);
}
/** Local component qualification of immutable public source. This deliberately
 * has no release/tag/CI authority and never publishes an artifact. */
export async function qualifyInstalledVisuals(root=ROOT,commit) {
  requireNode26();const pinned=commit??await git(root,['rev-parse','HEAD']);ensure(/^[a-f0-9]{40}$/.test(pinned),'Use an immutable commit');
  const scratch=await mkdtemp(path.join(tmpdir(),'course-core-package-qualification-'));
  try{
    const source=path.join(scratch,'source');await snapshot(root,pinned,source,{visualsOnly:true});const env=await npmEnvironment(scratch);
    const graph=await buildSnapshot(source,['visuals'],env),module=graph.modules.get('visuals');
    const packed=await stageVisuals(module.directory,scratch,await readFile(path.join(source,'LICENSE')),env);
    const result=await installedVisualsSmoke(packed,await readJson(path.join(module.directory,'package-lock.json')),scratch,env);
    return {scope:'installed_visuals_component_only',sourceCommit:pinned,filename:packed.filename,sha256:sha(packed.bytes),...result,releaseAuthority:'not_granted'};
  }finally{await rm(scratch,{recursive:true,force:true});}
}
if(isMain(import.meta.url))releaseMain().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
