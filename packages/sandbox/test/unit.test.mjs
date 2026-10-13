import assert from 'node:assert/strict';
import test from 'node:test';
import { dockerArguments, DockerSandbox, equivalent, gradeOutput, QUALIFIED_IMAGES, validateSubmission } from '../dist/index.js';

test('batch plans must cover every case exactly once with bounded nonempty counts',()=>{
  const base={source:'def solve(x): return x',cases:[{id:'a',input:1,expected:1},{id:'b',input:2,expected:2}]};
  validateSubmission({...base,batchCaseCounts:[1,1]});
  for(const plan of [[],[1],[3],[0,2],[-1,3],[0.5,1.5],[1,,1],Array(9).fill(1)])assert.throws(()=>validateSubmission({...base,batchCaseCounts:plan}),/INVALID_BATCH_PLAN/);
});

test('grader compares actual typed values, shape and numeric tolerance independently', () => {
  assert.equal(equivalent([1, { value: 2.00001 }], [1, { value: 2 }], 0.00002), true);
  assert.equal(equivalent([1, { value: 2.01 }], [1, { value: 2 }], 0.00002), false);
  for (const bad of [[1], [1, '2'], { 0: 1, 1: 2 }, [1, 2, 3]]) assert.equal(equivalent(bad, [1, 2]), false);
  assert.equal(equivalent(false, 0), false);
  assert.throws(() => equivalent(NaN, 0)); assert.throws(() => equivalent(Infinity, Infinity));
});
test('program output cannot self-award a pass or omit, duplicate or invent cases', () => {
  const cases = [{ id: 'first', input: 3, expected: 6 }, { id: 'second', input: 5, expected: 10 }];
  assert(gradeOutput('{"id":"first","output":6}\n{"id":"second","output":10}\n', cases).every(row => row.passed));
  for (const output of ['{"passed":true}', '{"id":"first","output":6}', '{"id":"first","output":6}\n{"id":"first","output":10}',
    '{"id":"first","output":6,"passed":true}\n{"id":"second","output":10}', '{"id":"unknown","output":6}\n{"id":"second","output":10}',
    '{"id":"first","output":"6"}\n{"id":"second","output":10}']) assert(gradeOutput(output, cases).some(row => !row.passed));
});
test('case data, payload, counts and tolerances are bounded before a container is created', () => {
  const base = { source: 'def solve(x): return x', cases: [{ id: 'one', input: 1, expected: 1 }] };
  validateSubmission(base);
  for (const input of [{ ...base, source: 'x'.repeat(64001) }, { ...base, cases: [] }, { ...base, cases: [...base.cases, ...base.cases] },
    { ...base, cases: [{ ...base.cases[0], expected: NaN }] }, { ...base, cases: [{ ...base.cases[0], absoluteTolerance: 1 }] }]) assert.throws(() => validateSubmission(input));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => validateSubmission({ ...base, cases: [{ ...base.cases[0], input: cyclic }] }));
});
test('execution arguments deny network, write access, privileges, swap growth and excess processes without a shell', () => {
  const options = { image: QUALIFIED_IMAGES.arm64, dockerBinary: 'docker', timeoutMs: 1000, memoryMiB: 128, maxOutputBytes: 65536, concurrency: 1 };
  const args = dockerArguments(options, 'course-sandbox-fixture', '/safe/test-directory');
  for (const required of ['create', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65532:65532', '--memory=128m', '--memory-swap=128m', '--pids-limit=32', '--pull=never']) assert(args.includes(required));
  assert(args.includes('type=bind,source=/safe/test-directory,target=/work,readonly'));
  assert(!args.some(value => /docker\.sock|privileged|gpus|password|token/i.test(value)));
  assert.throws(() => new DockerSandbox({ image: 'python:latest', storageDirectory: '/safe/test-directory' }));
  assert.throws(() => new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: '/safe/test-directory', concurrency: 20 }));
});
