import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { QUALIFIED_IMAGES } from '../dist/index.js';
import { DockerSandbox, localRoot } from './environment.mjs';

const exec = promisify(execFile);
const root = await mkdtemp(path.join(await localRoot(), 'sandbox-qualification-'));
const image = process.env.COURSE_SANDBOX_IMAGE ?? QUALIFIED_IMAGES[process.arch];
assert(image, 'Explicit qualified image required for this architecture.');
// Missing Docker/image is a failed required qualification, never a skipped passing test.
await exec('docker', ['image', 'inspect', image], { timeout: 10000, maxBuffer: 65536 });
const broker = name => new DockerSandbox({ image, storageDirectory: path.join(root, name), timeoutMs: 4000 });
after(async () => { await rm(root, { recursive: true, force: true }); });

test('real Python computes fresh varied inputs, while wrong and self-awarded results fail', async () => {
  const cases = Array.from({ length: 12 }, (_, i) => ({ id: `case-${i}`, input: [i - 6, 3 * i - 4], expected: (i - 6) + (3 * i - 4) }));
  const runner = broker('arithmetic');
  const good = await runner.grade({ source: 'def solve(x):\n    return sum(x)\n', cases });
  assert.equal(good.status, 'graded'); assert.equal(good.passed, true);
  const wrong = await runner.grade({ source: 'def solve(x):\n    return x[0] - x[1]\n', cases });
  assert.equal(wrong.status, 'graded'); assert.equal(wrong.passed, false);
  const spoof = await runner.grade({ source: 'import os\nprint("{\\"passed\\": true}", flush=True)\nos._exit(0)\n', cases });
  assert.equal(spoof.passed, false);
  assert((await readdir(path.join(root, 'arithmetic'))).length === 0);
});
test('student process has no host files, provider environment, writable root or network', async () => {
  const marker = path.join(root, 'private-host-canary'); await writeFile(marker, 'not-mounted');
  const source = `import os, socket\ndef solve(x):\n    result = {"host": os.path.exists(${JSON.stringify(marker)}), "key": "COURSE_PROVIDER_TEST_API_KEY" in os.environ}\n    try:\n        open("/root/should-not-exist", "w").write("bad")\n        result["rootWrite"] = True\n    except OSError:\n        result["rootWrite"] = False\n    try:\n        socket.create_connection(("1.1.1.1", 443), timeout=0.1)\n        result["network"] = True\n    except OSError:\n        result["network"] = False\n    return result\n`;
  process.env.COURSE_PROVIDER_TEST_API_KEY = 'synthetic-unforwarded-canary';
  try {
    const result = await broker('isolation').grade({ source, cases: [{ id: 'isolation', input: null, expected: { host: false, key: false, rootWrite: false, network: false } }] });
    assert.equal(result.status, 'graded'); assert.equal(result.passed, true);
  } finally { delete process.env.COURSE_PROVIDER_TEST_API_KEY; }
});
test('infinite execution and output floods are stopped, then the same broker can grade valid code', async () => {
  const runner = new DockerSandbox({ image, storageDirectory: path.join(root, 'limits'), timeoutMs: 2000, maxOutputBytes: 4096 });
  const cases = [{ id: 'a', input: 2, expected: 4 }];
  const infinite = await runner.grade({ source: 'def solve(x):\n    while True: pass\n', cases });
  assert.equal(infinite.status, 'timeout'); assert.equal(infinite.passed, false);
  const flood = await runner.grade({ source: 'def solve(x):\n    return "x" * 100000\n', cases });
  assert.equal(flood.status, 'output_limit'); assert.equal(flood.passed, false);
  const recovered = await runner.grade({ source: 'def solve(x): return x * 2', cases });
  assert.equal(recovered.passed, true);
});
test('128MiB memory limit contains a large allocation and reports no earned credit', async () => {
  const result = await broker('memory').grade({ source: 'def solve(x):\n    x = bytearray(1024 * 1024 * 1024)\n    return len(x)\n', cases: [{ id: 'memory', input: null, expected: 1073741824 }] });
  assert.equal(result.status, 'execution_failed'); assert.equal(result.passed, false);
});
test('shared broker storage prevents a second instance admitting another container and cancellation cleans up', async () => {
  const directory = path.join(root, 'shared'), a = new DockerSandbox({ image, storageDirectory: directory, timeoutMs: 5000 }), b = new DockerSandbox({ image, storageDirectory: directory });
  const controller = new AbortController();
  const pending = a.grade({ source: 'import time\ndef solve(x):\n    time.sleep(4)\n    return x\n', cases: [{ id: 'wait', input: 1, expected: 1 }], signal: controller.signal });
  let name;
  for (let i = 0; i < 100; i++) {
    try {
      name = JSON.parse(await readFile(path.join(directory, 'broker.lock'), 'utf8')).containerName;
      const { stdout } = await exec('docker', ['inspect', '--format', '{{.State.Running}}', name], { timeout: 2000 });
      if (stdout.trim() === 'true') break;
    } catch { /* creation still pending */ }
    await delay(20);
  }
  assert(name);
  const second = await b.grade({ source: 'def solve(x): return x', cases: [{ id: 'blocked', input: 1, expected: 1 }] });
  assert.equal(second.status, 'busy');
  controller.abort();
  const result = await pending; assert.equal(result.status, 'cancelled');
  await assert.rejects(exec('docker', ['inspect', name], { timeout: 2000 }));
  const third = await b.grade({ source: 'def solve(x): return x', cases: [{ id: 'after', input: 'ñ', expected: 'ñ' }] });
  assert.equal(third.passed, true);
});

// A cold or loaded host: the real Docker CLI, with container create and start delayed before they
// reach the daemon. The wait is detached from the output pipes, so a killed command ends at once.
// Each acknowledged create ID is logged, so a test can check that exactly those containers are gone.
async function delayedDocker(name, commands, seconds) {
  const file = path.join(root, `${name}.sh`), ids = `${file}.ids`;
  await writeFile(file, `#!/bin/sh
case "$1" in ${commands.join('|')}) sleep ${seconds} </dev/null >/dev/null 2>&1;; esac
if [ "$1" = create ]; then out=$(docker "$@"); code=$?; printf '%s\\n' "$out" >> '${ids}'; printf '%s\\n' "$out"; exit $code; fi
exec docker "$@"
`, { mode: 0o700 });
  return { file, created: async () => (await readFile(ids, 'utf8')).trim().split('\n').filter(Boolean) };
}
const removed = async id => { await assert.rejects(exec('docker', ['inspect', id], { timeout: 5000 }), /no such object/i); };
test('slow container create and start on a real host do not use the learner time limit', async () => {
  const docker = await delayedDocker('cold-host', ['create', 'start'], 2);
  const runner = new DockerSandbox({ image, storageDirectory: path.join(root, 'cold-host'), dockerBinary: docker.file, timeoutMs: 1500 });
  const cases = [{ id: 'a', input: 2, expected: 4 }];
  const good = await runner.grade({ source: 'def solve(x):\n    return x * 2\n', cases });
  assert.equal(good.status, 'graded'); assert.equal(good.passed, true);
  assert(good.setupMs >= 4000, `setup ${good.setupMs} ms`); assert(good.executionMs < 1500, `execution ${good.executionMs} ms`);
  // The learner's own code is still held to the limit after the same slow start.
  const infinite = await runner.grade({ source: 'def solve(x):\n    while True: pass\n', cases });
  assert.equal(infinite.status, 'timeout'); assert.equal(infinite.passed, false);
  assert(infinite.executionMs >= 1450, `execution ${infinite.executionMs} ms`); assert(infinite.setupMs >= 4000, `setup ${infinite.setupMs} ms`);
  assert.equal((await docker.created()).length, 2); for (const id of await docker.created()) await removed(id);
  assert.deepEqual(await readdir(path.join(root, 'cold-host')), []);
});
test('a container start that outlasts the setup bound is setup_timeout and leaves no container or lock', async () => {
  const directory = path.join(root, 'stalled-start'), docker = await delayedDocker('stalled-start', ['start'], 20);
  const stalled = new DockerSandbox({ image, storageDirectory: directory, dockerBinary: docker.file, setupTimeoutMs: 3000 });
  const result = await stalled.grade({ source: 'def solve(x):\n    return x\n', cases: [{ id: 'a', input: 1, expected: 1 }] });
  assert.equal(result.status, 'setup_timeout'); assert.equal(result.passed, false); assert.deepEqual(result.cases, []); assert.equal(result.executionMs, 0);
  assert.equal(stalled.setupDiagnostics().setupTimeouts, 1);
  const [created] = await docker.created(); assert.match(created, /^[a-f0-9]{64}$/); await removed(created);
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await stalled.readiness()).ready, true);
  assert.equal((await broker('stalled-start').grade({ source: 'def solve(x): return x', cases: [{ id: 'b', input: 2, expected: 2 }] })).passed, true);
});
