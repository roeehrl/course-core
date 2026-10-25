import assert from 'node:assert/strict';
import test from 'node:test';
import { dockerArguments, DockerSandbox, equivalent, gradeOutput, QUALIFIED_IMAGES, RUNNER_READY_LINE, validateSubmission } from '../dist/index.js';

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

test('preflight names the failing Docker step with a fixed reason and never returns Docker output', async () => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'sandbox-preflight-'));
  const info = JSON.stringify({ OSType: 'linux', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'], Architecture: 'aarch64' });
  const fake = async (name, body) => { const file = path.join(root, name); await writeFile(file, `#!/bin/sh\n${body}\n`); await chmod(file, 0o755); return file; };
  const run = async (dockerBinary, timeoutMs) => new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: path.join(root, 'store'), dockerBinary }).preflight(timeoutMs);
  try {
    assert.deepEqual(await run(path.join(root, 'missing-docker')), { ok: false, step: 'docker_info', reason: 'docker_not_installed' });
    assert.deepEqual(await run(await fake('down', 'echo "Cannot connect to the Docker daemon at unix:///secret" >&2; exit 1')), { ok: false, step: 'docker_info', reason: 'docker_unavailable' });
    assert.deepEqual(await run(await fake('slow', 'sleep 5'), 200), { ok: false, step: 'docker_info', reason: 'docker_timeout' });
    assert.deepEqual(await run(await fake('weak', `echo '${JSON.stringify({ OSType: 'linux' })}'`)), { ok: false, step: 'docker_info', reason: 'required_isolation_unavailable' });
    assert.deepEqual(await run(await fake('noimage', `if [ "$1" = info ]; then echo '${info}'; else echo "No such image" >&2; exit 1; fi`)), { ok: false, step: 'sandbox_image_inspect', reason: 'image_missing' });
    assert.deepEqual(await run(await fake('amd', `if [ "$1" = info ]; then echo '${info}'; else echo '[{"Os":"linux","Architecture":"amd64"}]'; fi`)), { ok: false, step: 'sandbox_image_inspect', reason: 'native_image_architecture_required' });
    assert.deepEqual(await run(await fake('good', `if [ "$1" = info ]; then echo '${info}'; else echo '[{"Os":"linux","Architecture":"arm64"}]'; fi`)), { ok: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// A scripted stand-in for the Docker CLI: no container and no learner code runs. It answers the
// readiness checks, creates and starts after the given delays, and then behaves as the runner
// would (`answer`: the ready line, then one output per case after `execDelay` seconds). Waits are
// detached from the output pipes so a killed command ends its streams at once.
async function scriptedDocker(root, label, { createDelay = 0, startDelay = 0, execDelay = 0, start = 'answer' } = {}) {
  const { writeFile, chmod } = await import('node:fs/promises');
  const path = await import('node:path');
  const info = JSON.stringify({ OSType: 'linux', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'], Architecture: 'aarch64' });
  const wait = seconds => seconds ? `sleep ${seconds} </dev/null >/dev/null 2>&1` : ':';
  const run = {
    answer: `printf '%s\\n' '${RUNNER_READY_LINE}'; ${wait(execDelay)}; sed -E 's/^\\{"id":"([^"]*)".*$/{"id":"\\1","output":6}/'`,
    spin: `printf '%s\\n' '${RUNNER_READY_LINE}'; cat >/dev/null; exec sleep 30`,
    silent: 'cat >/dev/null; exit 0',
    early: `cat >/dev/null; printf '%s\\n' '{"id":"one","output":6}'`,
  }[start];
  const file = path.join(root, `docker-${label}`);
  await writeFile(file, `#!/bin/sh
case "$1" in
  info) echo '${info}';;
  image) echo '[{"Os":"linux","Architecture":"arm64"}]';;
  create) ${wait(createDelay)}; echo ${'c'.repeat(64)};;
  start) ${wait(startDelay)}; ${run};;
  rm) echo "$3";;
  *) exit 1;;
esac
`);
  await chmod(file, 0o755);
  return file;
}
async function scratch() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  return mkdtemp(path.join(tmpdir(), 'sandbox-clocks-'));
}
const doubling = { source: 'def solve(x): return x * 2', cases: [{ id: 'one', input: 3, expected: 6 }] };

test('slow container create and start do not use the learner time limit', async () => {
  const { rm, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = await scratch();
  try {
    const dockerBinary = await scriptedDocker(root, 'slow-setup', { createDelay: 1.2, startDelay: 1.2 });
    const runner = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: path.join(root, 'store'), dockerBinary, timeoutMs: 1000 });
    const result = await runner.grade(doubling);
    assert.equal(result.status, 'graded'); assert.equal(result.passed, true);
    // Setup alone took more than twice the time limit; none of it counted against the code.
    assert(result.setupMs >= 2400, `setup ${result.setupMs} ms`); assert(result.executionMs < 1000, `execution ${result.executionMs} ms`);
    assert(result.durationMs > 2 * 1000); assert.equal(result.durationMs, result.setupMs + result.executionMs);
    assert.deepEqual(runner.setupDiagnostics(), { setupTimeouts: 0, lastSetupTimeoutAt: null });
    assert.deepEqual(await readdir(path.join(root, 'store')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('code that runs past the limit after a slow start is still a time limit', async () => {
  const { rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = await scratch();
  try {
    const dockerBinary = await scriptedDocker(root, 'slow-spin', { startDelay: 1.2, start: 'spin' });
    const result = await new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: path.join(root, 'store'), dockerBinary, timeoutMs: 500 }).grade(doubling);
    assert.equal(result.status, 'timeout'); assert.equal(result.passed, false);
    assert(result.executionMs >= 450 && result.executionMs < 1200, `execution ${result.executionMs} ms`); assert(result.setupMs >= 1200, `setup ${result.setupMs} ms`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup past its own bound is setup_timeout, never a time limit, and leaves the broker ready', async () => {
  const { rm, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = await scratch(), storageDirectory = path.join(root, 'store');
  try {
    const stalled = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory, dockerBinary: await scriptedDocker(root, 'stalled', { startDelay: 5 }), timeoutMs: 15000, setupTimeoutMs: 1000 });
    const before = Date.now(), result = await stalled.grade(doubling);
    assert.equal(result.status, 'setup_timeout'); assert.equal(result.passed, false); assert.deepEqual(result.cases, []);
    assert.equal(result.executionMs, 0); assert(result.setupMs >= 1000 && Date.now() - before < 4000, `setup ${result.setupMs} ms`);
    const diagnostics = stalled.setupDiagnostics();
    assert.equal(diagnostics.setupTimeouts, 1); assert(diagnostics.lastSetupTimeoutAt >= before);
    // The known container was removed and the lock released: the same storage grades again at once.
    assert.deepEqual(await readdir(storageDirectory), []);
    assert.deepEqual(await stalled.readiness(), { ready: true, reason: 'configured' });
    const fresh = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory, dockerBinary: await scriptedDocker(root, 'fresh') });
    assert.equal((await fresh.grade(doubling)).passed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a create slower than the setup bound is unacknowledged and still quarantines the broker', async () => {
  const { rm, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = await scratch(), storageDirectory = path.join(root, 'store');
  try {
    const runner = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory, dockerBinary: await scriptedDocker(root, 'late-create', { createDelay: 3 }), setupTimeoutMs: 1000 });
    assert.equal((await runner.grade(doubling)).status, 'cleanup_failed');
    assert((await readFile(path.join(storageDirectory, 'broker.lock'), 'utf8')).includes('course-sandbox-'));
    assert.equal((await runner.readiness()).ready, false);
    assert.equal(runner.setupDiagnostics().setupTimeouts, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a start that ends or prints anything before the ready line is unavailable, not a result', async () => {
  const { rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = await scratch();
  try {
    for (const start of ['silent', 'early']) {
      const runner = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: path.join(root, start), dockerBinary: await scriptedDocker(root, start, { start }) });
      const result = await runner.grade(doubling);
      assert.equal(result.status, 'unavailable', start); assert.equal(result.passed, false); assert.equal(result.executionMs, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one execution limit covers every batch, while setup between batches does not use it', async () => {
  const { rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = await scratch();
  try {
    const cases = ['a', 'b'].map(id => ({ id, input: 3, expected: 6 }));
    const slowSetup = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: path.join(root, 'setup'), dockerBinary: await scriptedDocker(root, 'batch-setup', { createDelay: 0.6, startDelay: 0.6 }), timeoutMs: 600 });
    const both = await slowSetup.grade({ source: doubling.source, cases, batchCaseCounts: [1, 1] });
    assert.equal(both.status, 'graded'); assert.equal(both.passed, true); assert.equal(both.batchesCompleted, 2); assert(both.setupMs >= 2400);
    const slowCode = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: path.join(root, 'code'), dockerBinary: await scriptedDocker(root, 'batch-code', { execDelay: 0.5 }), timeoutMs: 700 });
    const second = await slowCode.grade({ source: doubling.source, cases, batchCaseCounts: [1, 1] });
    assert.equal(second.status, 'timeout'); assert.equal(second.passed, false); assert.equal(second.batchesCompleted, 1);
    assert(second.executionMs >= 650, `execution ${second.executionMs} ms`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the runner writes the ready line before it loads the submission', async () => {
  const { readFile } = await import('node:fs/promises');
  const runner = await readFile(new URL('../src/runner.py', import.meta.url), 'utf8');
  const ready = runner.indexOf(`sys.stdout.write("${RUNNER_READY_LINE}\\n")`), flushed = runner.indexOf('sys.stdout.flush()', ready);
  assert(ready > 0 && flushed > ready, 'ready line missing'); assert(flushed < runner.indexOf('spec_from_file_location'));
  assert.equal(runner.match(/course-core-sandbox-ready/g).length, 1);
  assert.throws(() => new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: '/safe/test-directory', setupTimeoutMs: 999 }));
  assert.throws(() => new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory: '/safe/test-directory', setupTimeoutMs: 300001 }));
});
