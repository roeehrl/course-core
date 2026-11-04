import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DockerSandbox, QUALIFIED_IMAGES, RUNNER_READY_LINE } from '@course-core/sandbox';
import { qualifyIsolatedTeachingVerifier } from '../src/isolated-teaching-verifier.js';
import { failureLine, Startup, type StartupRetry } from '../src/startup.js';
import { isolatedOrderingDefinition } from './isolated-teaching-fixture.js';

// Startup qualification of a teaching verifier (main.ts, step verifier_qualification) against a
// sandbox that is only slow, and one that has disabled itself. No container runs: the sandbox is
// either a stub object or the real broker driving a scripted stand-in for the Docker CLI.

const definition = async () => Buffer.from(JSON.stringify((await isolatedOrderingDefinition()).definition));
function recorder() {
  const lines: string[] = [], retries: StartupRetry[] = [], startup = new Startup(line => lines.push(line));
  return { lines, retries, parsed: () => lines.map(line => JSON.parse(line)),
    onRetry: (retry: StartupRetry) => { retries.push(retry); startup.retrying('verifier_qualification', retry, 120_000); } };
}

/** A Docker CLI stand-in that answers the checks and logs each command; `create` outlives the
 * broker's setup budget, so the container it may have made can never be confirmed removed. */
async function lateCreateDocker(root: string) {
  const info = JSON.stringify({ OSType: 'linux', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'], Architecture: 'aarch64' });
  const file = path.join(root, 'docker'), log = path.join(root, 'docker.log');
  await writeFile(file, `#!/bin/sh
echo "$1" >> '${log}'
case "$1" in
  info) echo '${info}';;
  image) echo '[{"Os":"linux","Architecture":"arm64"}]';;
  create) sleep 3 </dev/null >/dev/null 2>&1; echo ${'c'.repeat(64)};;
  start) printf '%s\\n' '${RUNNER_READY_LINE}'; cat >/dev/null;;
  rm) echo "$3";;
  *) exit 1;;
esac
`);
  await chmod(file, 0o755);
  return { file, commands: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

describe('teaching verifier qualification at startup', () => {
  it('a sandbox that disabled itself after a cleanup it could not confirm fails at once, naming the cause', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'startup-quarantine-')), storageDirectory = path.join(root, 'store');
    try {
      const docker = await lateCreateDocker(root), log = recorder(), sleeps: number[] = [];
      const sandbox = new DockerSandbox({ image: QUALIFIED_IMAGES.arm64, storageDirectory, dockerBinary: docker.file, setupTimeoutMs: 1000 });
      const started = Date.now();
      const error = await qualifyIsolatedTeachingVerifier(await definition(), sandbox, { deadlineMs: 120_000, onRetry: log.onRetry, sleep: async ms => { sleeps.push(ms); } }).catch(caught => caught);
      // The first attempt's create ran past its limit: the broker quarantined itself and kept its lock.
      expect(error).toMatchObject({ code: 'TEACHING_VERIFIER_SANDBOX_QUARANTINED' });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(sleeps).toEqual([]);
      expect(log.retries).toEqual([]);
      expect((await docker.commands()).filter(command => command === 'create')).toHaveLength(1);
      expect(await readFile(path.join(storageDirectory, 'broker.lock'), 'utf8')).toContain('course-sandbox-');
      // Asked again in the same process it refuses without calling Docker, and is still not retried.
      const before = (await docker.commands()).length;
      await expect(qualifyIsolatedTeachingVerifier(await definition(), sandbox, { deadlineMs: 120_000, onRetry: log.onRetry, sleep: async ms => { sleeps.push(ms); } }))
        .rejects.toMatchObject({ code: 'TEACHING_VERIFIER_SANDBOX_QUARANTINED' });
      expect(await docker.commands()).toHaveLength(before);
      expect(sleeps).toEqual([]);
      // The one failure line says what happened and what the operator does.
      const line = JSON.parse(failureLine('verifier_qualification', error));
      expect(line).toMatchObject({ startup: 'failed', step: 'verifier_qualification', code: 'TEACHING_VERIFIER_SANDBOX_QUARANTINED' });
      expect(line.hint).toMatch(/broker\.lock/);
      expect(line.hint).toMatch(/course-sandbox-\* containers/);
      expect(line.hint).toMatch(/start again/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 20_000);

  it('a stub sandbox reporting cleanup_failed or cleanup_required is never retried', async () => {
    const bytes = await definition();
    for (const sandbox of [
      { readiness: async () => ({ ready: true, reason: 'configured' }), grade: async () => ({ status: 'cleanup_failed', passed: false }) },
      { readiness: async () => ({ ready: false, reason: 'cleanup_required' }) },
    ]) {
      const log = recorder();
      await expect(qualifyIsolatedTeachingVerifier(bytes, sandbox as unknown as DockerSandbox, { deadlineMs: 120_000, onRetry: log.onRetry, sleep: async () => {} }))
        .rejects.toMatchObject({ code: 'TEACHING_VERIFIER_SANDBOX_QUARANTINED' });
      expect(log.lines).toEqual([]);
    }
  });

  it('a transient sandbox failure is retried, each retry logged with its reason and elapsed time, then qualifies', async () => {
    const statuses = ['busy', 'setup_timeout', 'unavailable', 'timeout', 'graded'];
    let grades = 0;
    const sandbox = { readiness: async () => ({ ready: true, reason: 'configured' }), grade: async () => ({ status: statuses[grades++], passed: true }) } as unknown as DockerSandbox;
    const log = recorder(), sleeps: number[] = [];
    const extension = await qualifyIsolatedTeachingVerifier(await definition(), sandbox, { deadlineMs: 120_000, onRetry: log.onRetry, sleep: async ms => { sleeps.push(ms); } });
    expect(extension.adaptationAdapter?.kind).toBe('generated-teaching');
    expect(grades).toBe(5);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 5_000]);
    expect(log.parsed()).toEqual(['TEACHING_VERIFIER_SANDBOX_UNAVAILABLE', 'TEACHING_VERIFIER_SANDBOX_UNAVAILABLE', 'TEACHING_VERIFIER_SANDBOX_UNAVAILABLE', 'TEACHING_VERIFIER_QUALIFICATION_TIMEOUT']
      .map((code, index) => ({ startup: 'retrying', level: 'warn', step: 'verifier_qualification', code, attempt: index + 1, elapsedMs: expect.any(Number), nextAttemptInMs: sleeps[index], deadlineMs: 120_000 })));
  });

  it('a broker.lock left by another broker is retried and logged; at the deadline it fails with a hint naming the lock', async () => {
    const sandbox = { readiness: async () => ({ ready: false, reason: 'broker_locked' }) } as unknown as DockerSandbox;
    const log = recorder();
    const error = await qualifyIsolatedTeachingVerifier(await definition(), sandbox, { deadlineMs: 1_500, onRetry: log.onRetry, sleep: async () => {} }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'TEACHING_VERIFIER_SANDBOX_LOCKED' });
    expect(log.parsed()).toEqual([expect.objectContaining({ startup: 'retrying', code: 'TEACHING_VERIFIER_SANDBOX_LOCKED', attempt: 1 })]);
    expect(JSON.parse(failureLine('verifier_qualification', error)).hint).toMatch(/broker\.lock/);
  });
});
