import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerSandbox, QUALIFIED_IMAGES } from '../dist/index.js';

const exec = promisify(execFile), image = process.env.COURSE_SANDBOX_IMAGE ?? QUALIFIED_IMAGES[process.arch];
assert(image, 'A digest-pinned native test image is required.');
await exec('docker', ['image', 'inspect', image], { timeout: 10000, maxBuffer: 65536 });
const local = fileURLToPath(new URL('../.local/', import.meta.url)); await mkdir(local, { recursive: true, mode: 0o700 });
const root = await mkdtemp(path.join(local, 'hardening-'));
const ownedLogs = [];
// Only IDs returned by real Docker creates made through these trusted test drivers are eligible for cleanup.
after(async () => {
  for (const log of ownedLogs) {
    let ids = ''; try { ids = await readFile(log, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const id of ids.trim().split('\n').filter(Boolean)) {
      assert.match(id, /^[a-f0-9]{64}$/);
      let object;
      try { object = JSON.parse((await exec('docker', ['inspect', id], { timeout: 5000, maxBuffer: 65536 })).stdout)[0]; }
      catch (error) { if ((error.stderr ?? '').trim().toLowerCase() === `error: no such object: ${id}`) continue; throw error; }
      assert.equal(object.Config.Labels['course-core.sandbox'], 'true');
      assert(object.Mounts.some(mount => mount.Destination === '/work' && mount.Source.startsWith(root + path.sep)));
      await exec('docker', ['rm', '--force', id], { timeout: 10000, maxBuffer: 4096 });
    }
  }
  await rm(root, { recursive: true, force: true });
});
async function driver(mode) {
  const folder = path.join(root, mode); await mkdir(folder);
  const file = path.join(folder, 'docker-driver.mjs'), trace = path.join(folder, 'trace.jsonl'), ids = path.join(folder, 'owned-ids'); ownedLogs.push(ids);
  // This driver only perturbs real Docker acknowledgements. Learner code is NEVER run in Node/on the host.
  await writeFile(file, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ command: args[0], target: args.at(-1) }) + '\\n');
if (mode === 'slow_info' && args[0] === 'info') await new Promise(resolve => setTimeout(resolve, 350));
if (mode === 'cleanup_ambiguous' && args[0] === 'rm') {
  process.stderr.write('Error response from daemon: No such container: ' + args.at(-1) + '\\nTransport outcome unknown\\n');
  process.exit(1);
}
const result = spawnSync('docker', args, { input: args[0] === 'start' ? readFileSync(0) : undefined, encoding: 'utf8', maxBuffer: 2097152 });
if (args[0] === 'create' && result.status === 0 && /^[a-f0-9]{64}\\s*$/.test(result.stdout)) {
  appendFileSync(${JSON.stringify(ids)}, result.stdout.trim() + '\\n');
  if (mode === 'create_malformed') { process.stdout.write('malformed acknowledgement\\n'); process.exit(0); }
  if (mode === 'create_failed_ack') { process.stderr.write('simulated transport failure after create\\n'); process.exit(1); }
  if (mode === 'create_delayed_ack') await new Promise(resolve => setTimeout(resolve, 6000));
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`, { mode: 0o700 }); await chmod(file, 0o700);
  return { folder, file, trace, commands: async () => (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
const simple = { source: 'def solve(x): return x * 2', cases: [{ id: 'one', input: 3, expected: 6 }] };

for (const mode of ['create_malformed', 'create_failed_ack', 'cleanup_ambiguous', 'create_delayed_ack']) {
  test(`real Docker ${mode} quarantines the broker across instances instead of admitting another container`, async () => {
    const fault = await driver(mode), directory = path.join(fault.folder, 'storage');
    const runner = new DockerSandbox({ image, storageDirectory: directory, dockerBinary: fault.file, timeoutMs: mode === 'create_delayed_ack' ? 5000 : 10000 });
    const result = await runner.grade(simple);
    assert.equal(result.status, 'cleanup_failed'); assert.equal(result.passed, false);
    assert((await readFile(path.join(directory, 'broker.lock'), 'utf8')).includes('course-sandbox-'));
    assert.equal((await runner.readiness()).ready, false);
    assert.equal((await runner.grade(simple)).status, 'unavailable');
    const other = new DockerSandbox({ image, storageDirectory: directory, dockerBinary: fault.file, timeoutMs: 10000 });
    assert.equal((await other.grade(simple)).status, 'busy');
    assert.equal((await fault.commands()).filter(row => row.command === 'create').length, 1);
  });
}

test('admission is reserved before asynchronous Docker readiness checks', async () => {
  const fault = await driver('slow_info'), runner = new DockerSandbox({ image, storageDirectory: path.join(fault.folder, 'storage'), dockerBinary: fault.file, timeoutMs: 10000 });
  const pending = runner.grade(simple);
  for (let i = 0; i < 100; i++) {
    try { if ((await fault.commands()).some(row => row.command === 'info')) break; } catch { /* preflight not entered */ }
    await delay(10);
  }
  const rejected = await Promise.all(Array.from({ length: 5 }, () => runner.grade(simple)));
  const result = await pending;
  assert(rejected.every(row => row.status === 'busy')); assert.equal(result.passed, true);
  assert.equal((await fault.commands()).filter(row => row.command === 'info').length, 1);
  assert.equal((await fault.commands()).filter(row => row.command === 'create').length, 1);
});

test('reference and source snapshots cannot change while Docker preflight is waiting', async () => {
  const fault = await driver('snapshot_wait');
  // Reuse the slow-info transport mode without running any learner code in the host process.
  const text = await readFile(fault.file, 'utf8');
  await writeFile(fault.file, text.replace('const args = process.argv.slice(2), mode = "snapshot_wait";', 'const args = process.argv.slice(2), mode = "slow_info";'));
  const runner = new DockerSandbox({ image, storageDirectory: path.join(fault.folder, 'storage'), dockerBinary: fault.file, timeoutMs: 10000 });
  const submission = structuredClone(simple), digest = createHash('sha256').update(submission.source).digest('hex');
  const pending = runner.grade(submission);
  for (let i = 0; i < 100; i++) {
    try { if ((await fault.commands()).some(row => row.command === 'info')) break; } catch { /* preflight not entered */ }
    await delay(10);
  }
  submission.source = 'def solve(x): return 999'; submission.cases[0].expected = 123;
  const result = await pending;
  assert.equal(result.passed, true); assert.equal(result.sourceDigest, digest);
});

test('actual guest observes non-root seccomp/cgroup limits and cannot raise them or write the code mount', async () => {
  const runner = new DockerSandbox({ image, storageDirectory: path.join(root, 'guest-envelope'), timeoutMs: 5000 });
  const source = `import os, resource\ndef solve(x):\n    s = open('/proc/self/status').read()\n    def denied(fn):\n        try:\n            fn()\n            return False\n        except (OSError, ValueError):\n            return True\n    return {\n      'uid': os.getuid(),\n      'caps': [line.split()[1] for line in s.splitlines() if line.startswith('CapEff:')][0],\n      'noNewPrivileges': 'NoNewPrivs:\\t1' in s,\n      'seccomp': 'Seccomp:\\t2' in s,\n      'memory': open('/sys/fs/cgroup/memory.max').read().strip(),\n      'swap': open('/sys/fs/cgroup/memory.swap.max').read().strip(),\n      'pids': open('/sys/fs/cgroup/pids.max').read().strip(),\n      'cpu': open('/sys/fs/cgroup/cpu.max').read().strip(),\n      'cannotRoot': denied(lambda: os.setuid(0)),\n      'cannotRaiseFDs': denied(lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (1024,1024))),\n      'cannotChangeCode': denied(lambda: open('/work/runner.py','w')),\n      'noDockerSocket': not os.path.exists('/var/run/docker.sock')\n    }\n`;
  const result = await runner.grade({ source, cases: [{ id: 'limits', input: null, expected: { uid: 65532, caps: '0000000000000000', noNewPrivileges: true, seccomp: true,
    memory: '134217728', swap: '0', pids: '32', cpu: '50000 100000', cannotRoot: true, cannotRaiseFDs: true, cannotChangeCode: true, noDockerSocket: true } }] });
  assert.equal(result.status, 'graded'); assert.equal(result.passed, true);
});

test('actual bounded fork attempt hits the PID cap and leaves no work behind', async () => {
  const directory = path.join(root, 'pids'), runner = new DockerSandbox({ image, storageDirectory: directory, timeoutMs: 5000 });
  const source = `import os, time, signal, errno\ndef solve(x):\n    children=[]\n    blocked=False\n    try:\n        for i in range(64):\n            pid=os.fork()\n            if pid==0:\n                time.sleep(2)\n                os._exit(0)\n            children.append(pid)\n    except OSError as e:\n        blocked=e.errno in (errno.EAGAIN, errno.ENOMEM)\n    finally:\n        for pid in children:\n            try: os.kill(pid, signal.SIGKILL)\n            except ProcessLookupError: pass\n        for pid in children: os.waitpid(pid,0)\n    return {'blocked':blocked, 'bounded':len(children)<32}\n`;
  const result = await runner.grade({ source, cases: [{ id: 'forks', input: null, expected: { blocked: true, bounded: true } }] });
  assert.equal(result.status, 'graded'); assert.equal(result.passed, true);
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await runner.grade(simple)).passed, true);
});

test('reference answers never enter the guest and monkey-patched runner output cannot self-award credit', async () => {
  const oracle = `HOST_ONLY_ORACLE_${randomUUID()}`, marker = path.join(root, 'host-reference.json'); await writeFile(marker, JSON.stringify({ expected: oracle }), { mode: 0o600 });
  const runner = new DockerSandbox({ image, storageDirectory: path.join(root, 'oracle'), timeoutMs: 5000 });
  const probe = `import os, sys, json\nrequests=[json.loads(line) for line in sys.stdin]\nfor r in requests:\n    print(json.dumps({'id':r['id'],'output':{'hostOracle':os.path.exists(${JSON.stringify(marker)}),'expectedInRequest':'expected' in r,'onlyMountedFiles':sorted(os.listdir('/work'))}}),flush=True)\nos._exit(0)\n`;
  const result = await runner.grade({ source: probe, cases: [{ id: 'probe', input: { public: true }, expected: { hostOracle: false, expectedInRequest: false, onlyMountedFiles: ['runner.py', 'submission.py'] } }] });
  assert.equal(result.status, 'graded'); assert.equal(result.passed, true);
  const forge = `import json, builtins\ndef solve(x):\n    json.dumps=lambda *args,**kwargs: '{"id":"secret","output":{"passed":true,"score":1,"expected":"guessed"},"passed":true}'\n    return None\n`;
  const forged = await runner.grade({ source: forge, cases: [{ id: 'secret', input: null, expected: oracle }] });
  assert.equal(forged.status, 'graded'); assert.equal(forged.passed, false); assert.equal(forged.cases[0].reason, 'invalid_output_protocol');
});
