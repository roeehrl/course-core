import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requireHostedLinux, requirePracticalBuild, runDockerGate, selectSandboxImage, verifyDockerServer, verifySandboxImage } from './sandbox-ci.mjs';

// These are approved image identities, not evidence of execution qualification.
const images = {
  x64: 'python@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a',
  arm64: 'python@sha256:55432fc4ef6d07e33c10449312f0ec00071bbb310bb9bd7ba626a31fbbc2cb0d',
};

test('sandbox source pins match the reviewed architecture-specific image identities', async () => {
  const source = await readFile(new URL('../packages/sandbox/src/index.ts', import.meta.url), 'utf8');
  const block = /export const QUALIFIED_IMAGES\s*=\s*\{([^}]+)\}/.exec(source)?.[1];
  assert.ok(block, 'QUALIFIED_IMAGES must be declared explicitly');
  const observed = Object.fromEntries([...block.matchAll(/\b(x64|arm64)\s*:\s*['"](python@sha256:[a-f0-9]{64})['"]/g)].map((match) => [match[1], match[2]]));
  assert.deepEqual(observed, images);
});

test('root Docker qualification fails outside GitHub-hosted Linux instead of skipping', () => {
  const hosted = { GITHUB_ACTIONS: 'true', SANDBOX_RUNNER_ENVIRONMENT: 'github-hosted' };
  assert.doesNotThrow(() => requireHostedLinux(hosted, 'linux'));
  for (const [environment, platform] of [[hosted, 'darwin'], [hosted, 'win32'], [{}, 'linux'],
    [{ ...hosted, SANDBOX_RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux']]) {
    assert.throws(() => requireHostedLinux(environment, platform), /GitHub-hosted Linux/);
  }
});

test('image selection is native and digest-only, with no tag or unknown-architecture fallback', () => {
  assert.deepEqual(selectSandboxImage(images, 'x64'), { arch: 'x64', image: images.x64, platform: 'linux/amd64' });
  assert.deepEqual(selectSandboxImage(images, 'arm64'), { arch: 'arm64', image: images.arm64, platform: 'linux/arm64' });
  assert.throws(() => selectSandboxImage(images, 'riscv64'), /qualified/);
  for (const image of [undefined, 'python:latest', 'example/python@sha256:' + 'a'.repeat(64)]) {
    assert.throws(() => selectSandboxImage({ x64: image }, 'x64'), /digest-pinned/);
  }
  const selected = selectSandboxImage(images, 'x64');
  assert.doesNotThrow(() => verifyDockerServer(selected, { os: 'linux', architecture: 'x86_64' }));
  assert.throws(() => verifyDockerServer(selected, { os: 'linux', architecture: 'aarch64' }), /mismatched/);
  assert.throws(() => verifyDockerServer(selected, { os: 'windows', architecture: 'amd64' }), /mismatched/);
  assert.throws(() => verifySandboxImage(selected, { os: 'linux', architecture: 'amd64', repoDigests: [images.arm64] }), /digest/);
});

test('CI preparation pulls before inspecting; the test phase never pulls and runs the real package command', async () => {
  const selection = selectSandboxImage(images, 'x64');
  const calls = [];
  // Command-planning assertions only; these do not claim a Docker test pass.
  const invoke = async (command, args, env) => {
    calls.push({ command, args, env });
    if (args[0] === 'info') return JSON.stringify({ os: 'linux', architecture: 'x86_64' });
    if (args[0] === 'image') return JSON.stringify({ os: 'linux', architecture: 'amd64', repoDigests: ['docker.io/library/' + images.x64] });
    return '';
  };
  await runDockerGate('pull', selection, invoke);
  assert.deepEqual(calls.map((call) => call.args[0]), ['info', 'pull', 'image']);
  assert.deepEqual(calls[1].args, ['pull', '--platform', 'linux/amd64', images.x64]);
  calls.length = 0;
  await runDockerGate('test', selection, invoke);
  assert.deepEqual(calls.map((call) => call.command), ['docker', 'docker', 'npm']);
  assert.deepEqual(calls[2].args, ['--workspaces=false', 'run', 'test:docker']);
  assert.deepEqual(calls[2].env, { COURSE_SANDBOX_IMAGE: images.x64 });
  assert.ok(!calls.some((call) => call.args[0] === 'pull'));
});

test('missing image, failed pulls and failed Docker tests all fail the gate', async () => {
  const selection = selectSandboxImage(images, 'arm64');
  for (const [action, failAt] of [['pull', 'pull'], ['test', 'image'], ['test', 'npm']]) {
    const calls = [];
    await assert.rejects(runDockerGate(action, selection, async (command, args) => {
      calls.push([command, ...args]);
      if (command === failAt || args[0] === failAt) throw new Error('synthetic failure');
      return args[0] === 'info' ? JSON.stringify({ os: 'linux', architecture: 'aarch64' })
        : JSON.stringify({ os: 'linux', architecture: 'arm64', repoDigests: [images.arm64] });
    }), /synthetic failure/);
    if (failAt !== 'npm') assert.ok(!calls.some(([command]) => command === 'npm'));
  }
});

test('a network-class pull failure is retried; a definitive one, and the inspect and test phases, are not', async () => {
  const selection = selectSandboxImage(images, 'x64');
  const run = async (pullOutputs, action = 'pull') => {
    const calls = [], waits = [];
    const invoke = async (command, args) => {
      calls.push(args[0]);
      if (args[0] === 'info') return JSON.stringify({ os: 'linux', architecture: 'x86_64' });
      if (args[0] === 'image') return JSON.stringify({ os: 'linux', architecture: 'amd64', repoDigests: ['docker.io/library/' + images.x64] });
      if (args[0] === 'pull') {
        const output = pullOutputs[calls.filter((call) => call === 'pull').length - 1];
        if (output) throw Object.assign(new Error('docker pull failed (1); Docker qualification did not pass'), { output });
      }
      return '';
    };
    const result = runDockerGate(action, selection, invoke, {}, { wait: async (ms) => { waits.push(ms); }, log: () => {} });
    return { result, calls, waits };
  };
  let attempt = await run(['read tcp 10.1.0.4:52144->104.18.1.1:443: read: connection reset by peer', 'net/http: TLS handshake timeout']);
  await attempt.result;
  assert.deepEqual(attempt.calls, ['info', 'pull', 'pull', 'pull', 'image']);
  assert.equal(attempt.waits.length, 2);
  for (const output of ['manifest unknown', 'toomanyrequests: You have reached your pull rate limit.']) {
    attempt = await run([output]);
    await assert.rejects(attempt.result, /docker pull failed/);
    assert.deepEqual(attempt.calls, ['info', 'pull']);
  }
  attempt = await run(['connection reset by peer', 'connection reset by peer', 'connection reset by peer', undefined]);
  await assert.rejects(attempt.result, /docker pull failed/);
  assert.deepEqual(attempt.calls, ['info', 'pull', 'pull', 'pull'], 'bounded at three attempts');
});

test('API practical qualification requires built API output and its real qualification entrypoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'course-core-practical-build-'));
  try {
    await assert.rejects(requirePracticalBuild(directory), /built API entry point/);
    await mkdir(path.join(directory, 'dist'));
    await writeFile(path.join(directory, 'dist/main.js'), '// Synthetic file-presence fixture.');
    await assert.rejects(requirePracticalBuild(directory), /practical qualification/);
    await mkdir(path.join(directory, 'qualification'));
    await writeFile(path.join(directory, 'qualification/practical-flow.ts'), '// Synthetic file-presence fixture.');
    await assert.doesNotReject(requirePracticalBuild(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('API practical command gets only the validated test DB and same pinned image, never a pull', async () => {
  const selection = selectSandboxImage(images, 'x64');
  const environment = { TEST_DATABASE_URL: 'postgres://course_ci:course_ci_test_only@127.0.0.1:5432/course_core_ci', UNRELATED_SETTING: 'not-forwarded' };
  const calls = [];
  await runDockerGate('api-practical', selection, async (command, args, env) => {
    calls.push({ command, args, env });
    return args[0] === 'info' ? JSON.stringify({ os: 'linux', architecture: 'amd64' })
      : JSON.stringify({ os: 'linux', architecture: 'amd64', repoDigests: [images.x64] });
  }, environment);
  assert.deepEqual(calls.map(({ command, args }) => [command, args[0]]), [['docker', 'info'], ['docker', 'image'], ['npm', '--workspaces=false']]);
  assert.deepEqual(calls[2].args, ['--workspaces=false', 'run', 'test:practical']);
  assert.deepEqual(calls[2].env, { COURSE_SANDBOX_IMAGE: images.x64, TEST_DATABASE_URL: environment.TEST_DATABASE_URL });
  for (const invalid of [{}, { ...environment, DATABASE_URL: environment.TEST_DATABASE_URL }]) {
    let invoked = false;
    await assert.rejects(runDockerGate('api-practical', selection, async () => { invoked = true; }, invalid));
    assert.equal(invoked, false);
  }
});

test('API practical failure is not masked and missing images never fall back to a pull', async () => {
  const selection = selectSandboxImage(images, 'arm64');
  const environment = { TEST_DATABASE_URL: 'postgres://course_ci:course_ci_test_only@127.0.0.1:5432/course_core_ci' };
  for (const failure of ['image', 'npm']) {
    const calls = [];
    await assert.rejects(runDockerGate('api-practical', selection, async (command, args) => {
      calls.push([command, ...args]);
      if (command === failure || args[0] === failure) throw new Error('synthetic practical failure');
      return args[0] === 'info' ? JSON.stringify({ os: 'linux', architecture: 'aarch64' })
        : JSON.stringify({ os: 'linux', architecture: 'arm64', repoDigests: [images.arm64] });
    }, environment), /synthetic practical failure/);
    assert.ok(!calls.some(([, action]) => action === 'pull'));
    if (failure === 'image') assert.ok(!calls.some(([command]) => command === 'npm'));
  }
});
