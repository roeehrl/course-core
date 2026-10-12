import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (cmd, args, cwd = root) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, `${path.basename(cmd)} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
await mkdir(path.join(root, '.local'), { recursive: true });
const temp = await mkdtemp(path.join(root, '.local', 'packed-smoke-'));
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@course-core/sdk'].version, '0.2.0');
  assert.equal(lock.packages['node_modules/@course-core/sdk'].resolved, manifest.dependencies['@course-core/sdk']);
  assert.equal((await lstat(path.join(root, 'node_modules/@course-core/policy'))).isSymbolicLink(), false);
  const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp]));
  for (const file of packed.files) assert.ok(file.path === 'package.json' || file.path === 'README.md' || /^dist\/[a-z-]+\.(?:js|d\.ts)$/.test(file.path), `Unexpected packed file: ${file.path}`);
  // Package the installed policy distribution, not its sibling source tree.
  const [policy] = JSON.parse(run('npm', ['pack', './node_modules/@course-core/policy', '--ignore-scripts', '--json', '--pack-destination', temp]));
  const consumer = path.join(temp, 'consumer'); await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'adaptation-packed-consumer', version: '1.0.0', private: true, type: 'module',
    dependencies: { '@course-core/adaptation': `file:../${packed.filename}`, '@course-core/policy': `file:../${policy.filename}`, '@course-core/sdk': manifest.dependencies['@course-core/sdk'] },
    overrides: { '@course-core/policy': '$@course-core/policy' } }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--workspaces=false', '--registry=https://registry.npmjs.org/'], consumer);
  await writeFile(path.join(consumer, 'fixture.mjs'), (await readFile(path.join(root, 'test/helpers.mjs'), 'utf8')).replace("'../dist/index.js'", "'@course-core/adaptation'"));
  await writeFile(path.join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import {fixture,bundle,command,advance} from './fixture.mjs';
import {admitAdaptation,applyAdaptation,materializeAdaptation,previewAdaptation} from '@course-core/adaptation';
const f=await fixture(), b=await bundle(f,'packed',['practice','assessment_variant']);
const preview=await previewAdaptation(f.context,f.state,command(f,'preview',b));
assert.equal(preview.reservations[0].work.additionalMinutes,4);
advance(f,await admitAdaptation(f.context,f.state,command(f,'admit',b)));
const applied=advance(f,await applyAdaptation(f.context,f.state,command(f,'apply',{admissionId:b.admissionId})));
const view=await materializeAdaptation(f.context,f.state);
assert.equal(view.planRevision,1); assert.equal(view.variants[0].canonicalFamilyId,'minimum');
assert.equal('grading' in view.learner.assessments[1],false); assert.deepEqual(applied.evidenceWrites,[]);
`);
  run(process.execPath, ['smoke.mjs'], consumer);
  await writeFile(path.join(consumer, 'consumer.mts'), `
import {admitAdaptation,generateFreshNumericalVariant,type AdaptationTransition,type RuntimeContext,type AdaptationState,type AdmitCommand,type FreshNumericalResult} from '@course-core/adaptation';
declare const context:RuntimeContext; declare const state:AdaptationState; declare const command:AdmitCommand;
const transition:AdaptationTransition=await admitAdaptation(context,state,command);
const noEvidence:[]=transition.evidenceWrites; void noEvidence;
declare const fresh:FreshNumericalResult; const kind:'assessment_variant'=fresh.artifact.kind; void kind; void generateFreshNumericalVariant;
`);
  await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noEmit: true, skipLibCheck: false, types: [], lib: ['ES2022', 'DOM'] }, files: ['consumer.mts'] }));
  run(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], consumer);
  console.log(`Packed adaptation smoke passed: ${packed.files.length} allowlisted files, isolated installed runtime and type consumer, released SDK 0.2.0.`);
} finally { await rm(temp, { recursive: true, force: true }); }
