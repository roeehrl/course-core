import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Case { id: string; input: Json; expected: Json; absoluteTolerance?: number; relativeTolerance?: number }
export interface Submission { source: string; cases: Case[]; signal?: AbortSignal }
export interface Options { image: string; storageDirectory: string; dockerBinary?: string; timeoutMs?: number; memoryMiB?: number; maxOutputBytes?: number; concurrency?: number }
export interface GradeReport { status: 'graded' | 'timeout' | 'output_limit' | 'cancelled' | 'execution_failed' | 'unavailable' | 'busy' | 'cleanup_failed';
  passed: boolean; cases: { id: string; passed: boolean; reason: string }[]; sourceDigest: string; durationMs: number; runtime: { protocol: 'python-json-v1'; image: string } }

export const QUALIFIED_IMAGES = {
  arm64: 'python@sha256:55432fc4ef6d07e33c10449312f0ec00071bbb310bb9bd7ba626a31fbbc2cb0d',
  x64: 'python@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a',
} as const;
// Registry manifests observed 2026-10-12; qualification is established by test:docker,
// not by the variable name or digest alone. Re-run qualification when an image changes.

function finiteJson(value: unknown, depth = 0, count = { value: 0 }): asserts value is Json {
  if (depth > 32 || ++count.value > 20000) throw new Error('JSON_ENVELOPE_EXCEEDED');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { if (!(i in value)) throw new Error('INVALID_JSON'); finiteJson(value[i], depth + 1, count); } return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('INVALID_JSON');
      finiteJson(descriptor.value, depth + 1, count);
    }
    return;
  }
  throw new Error('INVALID_JSON');
}
export function validateSubmission(input: Submission) {
  if (typeof input.source !== 'string' || !input.source.trim() || Buffer.byteLength(input.source) > 64000 || !Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 100) throw new Error('INVALID_SUBMISSION');
  const ids = new Set<string>();
  for (const item of input.cases) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) throw new Error('INVALID_CASE');
    ids.add(item.id); finiteJson(item.input); finiteJson(item.expected);
    for (const value of [item.absoluteTolerance ?? 0, item.relativeTolerance ?? 0]) if (!Number.isFinite(value) || value < 0 || value > 0.1) throw new Error('INVALID_TOLERANCE');
  }
  if (Buffer.byteLength(JSON.stringify(input.cases)) > 1024 * 1024) throw new Error('INPUT_ENVELOPE_EXCEEDED');
}
export function equivalent(actual: Json, expected: Json, absoluteTolerance = 0, relativeTolerance = 0): boolean {
  finiteJson(actual); finiteJson(expected);
  function compare(a: Json, b: Json): boolean {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= absoluteTolerance + relativeTolerance * Math.abs(b);
    if (a === null || b === null || typeof a !== typeof b) return a === b;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => compare(value, b[index]!));
    if (typeof a === 'object' && typeof b === 'object') {
      const keys = Object.keys(a).sort();
      return keys.join('\0') === Object.keys(b).sort().join('\0') && keys.every(key => compare(a[key]!, b[key]!));
    }
    return a === b;
  }
  return compare(actual, expected);
}
export function gradeOutput(stdout: string, cases: Case[]): GradeReport['cases'] {
  const lines = stdout.trim().split('\n').filter(Boolean), rows = new Map<string, Record<string, unknown>>();
  try {
    if (lines.length !== cases.length) throw new Error();
    for (const line of lines) {
      const row = JSON.parse(line); finiteJson(row);
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || rows.has(row.id)
        || !cases.some(item => item.id === row.id) || Object.keys(row).sort().join(',') !== 'id,output') throw new Error();
      rows.set(row.id, row);
    }
    return cases.map(item => {
      const row = rows.get(item.id)!;
      const passed = equivalent(row.output as Json, item.expected, item.absoluteTolerance, item.relativeTolerance);
      return { id: item.id, passed, reason: passed ? 'matched_reference' : 'output_mismatch' };
    });
  } catch { return cases.map(item => ({ id: item.id, passed: false, reason: 'invalid_output_protocol' })); }
}

export function dockerArguments(options: Required<Omit<Options, 'storageDirectory'>>, name: string, directory: string): string[] {
  return ['create', '--pull=never', '--name', name, '--label', 'course-core.sandbox=true', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65532:65532',
    `--memory=${options.memoryMiB}m`, `--memory-swap=${options.memoryMiB}m`, '--cpus=0.5', '--pids-limit=32', '--ulimit=nofile=64:64', '--ulimit=core=0:0', '--init',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=16m', '--mount', `type=bind,source=${directory},target=/work,readonly`, '--env=PYTHONDONTWRITEBYTECODE=1', '--env=PYTHONHASHSEED=0', '-i',
    options.image, 'python', '-I', '-B', '/work/runner.py'];
}
export class DockerSandbox {
  private readonly config: Required<Omit<Options, 'storageDirectory'>>;
  private readonly storageDirectory: string;
  private active = 0;
  private unhealthy = false;
  constructor(options: Options) {
    this.storageDirectory = options.storageDirectory;
    this.config = { image: options.image, dockerBinary: options.dockerBinary ?? 'docker', timeoutMs: options.timeoutMs ?? 5000, memoryMiB: options.memoryMiB ?? 128,
      maxOutputBytes: options.maxOutputBytes ?? 65536, concurrency: options.concurrency ?? 1 };
    if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(options.image) || !path.isAbsolute(options.storageDirectory) || /[,\n\r\0]/.test(options.storageDirectory)
      || !Number.isInteger(this.config.timeoutMs) || this.config.timeoutMs < 200 || this.config.timeoutMs > 15000
      || !Number.isInteger(this.config.memoryMiB) || this.config.memoryMiB < 64 || this.config.memoryMiB > 512
      || !Number.isInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < 1024 || this.config.maxOutputBytes > 1048576
      || this.config.concurrency !== 1) throw new Error('INVALID_SANDBOX_CONFIGURATION');
  }
  async readiness(): Promise<{ ready: boolean; reason: string }> {
    if (this.unhealthy) return { ready: false, reason: 'cleanup_required' };
    if (this.active) return { ready: false, reason: 'busy' };
    try {
      await lstat(path.join(this.storageDirectory, 'broker.lock'));
      return { ready: false, reason: 'broker_locked' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ready: false, reason: 'storage_unavailable' };
    }
    return this.runtimeReadiness();
  }
  private async runtimeReadiness(): Promise<{ ready: boolean; reason: string }> {
    const exec = promisify(execFile);
    try {
      const result = await exec(this.config.dockerBinary, ['info', '--format', '{{json .}}'], { timeout: 5000, maxBuffer: 262144 });
      const info = JSON.parse(result.stdout);
      if (info.OSType !== 'linux' || !info.MemoryLimit || !info.SwapLimit || !info.CpuCfsQuota || !info.PidsLimit
        || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some((item: unknown) => typeof item === 'string' && item.startsWith('name=seccomp'))) return { ready: false, reason: 'required_isolation_unavailable' };
      const inspected = await exec(this.config.dockerBinary, ['image', 'inspect', this.config.image], { timeout: 5000, maxBuffer: 65536 });
      const image = JSON.parse(inspected.stdout)[0];
      const architecture = ({ aarch64: 'arm64', x86_64: 'amd64', arm64: 'arm64', amd64: 'amd64' } as Record<string, string>)[info.Architecture];
      if (!architecture || image.Os !== 'linux' || image.Architecture !== architecture) return { ready: false, reason: 'native_image_architecture_required' };
      return { ready: !this.unhealthy, reason: this.unhealthy ? 'cleanup_required' : 'configured' };
    } catch { return { ready: false, reason: 'docker_or_pinned_image_unavailable' }; }
  }
  async grade(input: Submission): Promise<GradeReport> {
    validateSubmission(input);
    // Freeze the host reference/source snapshot before any asynchronous boundary.
    input = { source: input.source, cases: structuredClone(input.cases), ...(input.signal ? { signal: input.signal } : {}) };
    const startedAt = Date.now(), sourceDigest = createHash('sha256').update(input.source).digest('hex');
    const report = (status: GradeReport['status'], cases: GradeReport['cases'] = []): GradeReport => ({ status, passed: status === 'graded' && cases.length === input.cases.length && cases.every(item => item.passed), cases, sourceDigest, durationMs: Date.now() - startedAt, runtime: { protocol: 'python-json-v1', image: this.config.image } });
    if (input.signal?.aborted) return report('cancelled');
    if (this.unhealthy) return report('unavailable');
    if (this.active >= this.config.concurrency) return report('busy');
    // Reserve admission before readiness or filesystem I/O, so concurrent requests cannot
    // fan out unbounded Docker preflight subprocesses while the execution slot looks idle.
    this.active += 1;
    const name = `course-sandbox-${randomUUID()}`;
    let directory: string | undefined, final: GradeReport, lock: FileHandle | undefined;
    let createAttempted = false, creationUncertain = false, containerId: string | undefined;
    const lockPath = path.join(this.storageDirectory, 'broker.lock');
    try {
      await mkdir(this.storageDirectory, { recursive: true, mode: 0o700 });
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { this.active -= 1; return report('busy'); } throw error; }
      await lock.writeFile(JSON.stringify({ containerName: name, pid: process.pid, createdAt: new Date().toISOString() }));
      await lock.sync();
      if (!(await this.runtimeReadiness()).ready) final = report('unavailable');
      else if (input.signal?.aborted) final = report('cancelled');
      else {
        directory = await mkdtemp(path.join(this.storageDirectory, 'run-'));
        await writeFile(path.join(directory, 'submission.py'), input.source, { mode: 0o644 });
        await copyFile(new URL('./runner.py', import.meta.url), path.join(directory, 'runner.py'));
        await chmod(path.join(directory, 'runner.py'), 0o644); await chmod(directory, 0o755);
        const stdin = input.cases.map(item => JSON.stringify({ id: item.id, input: item.input })).join('\n') + '\n';
        const beforeCreate = this.config.timeoutMs - (Date.now() - startedAt);
        if (beforeCreate <= 0) final = report('timeout');
        else if (input.signal?.aborted) final = report('cancelled');
        else {
          // Any dispatched create without a valid acknowledgement is ambiguous, including
          // nonzero exits and malformed stdout. A momentary absence cannot fence a late create.
          createAttempted = creationUncertain = true;
          const created = await this.run(dockerArguments(this.config, name, directory), '', input.signal, beforeCreate);
          if (created.status !== 'completed' || !/^[a-f0-9]{64}\s*$/.test(created.stdout)) final = report(created.status === 'completed' ? 'unavailable' : created.status);
          else {
            containerId = created.stdout.trim(); creationUncertain = false;
            // Start and cleanup use the acknowledged immutable ID, not a replaceable name.
            const remaining = this.config.timeoutMs - (Date.now() - startedAt);
            if (remaining <= 0) final = report('timeout');
            else {
              const result = await this.run(['start', '--attach', '--interactive', containerId], stdin, input.signal, remaining);
              final = result.status === 'completed' ? report('graded', gradeOutput(result.stdout, input.cases)) : report(result.status);
            }
          }
        }
      }
    } catch { final = report('unavailable'); }
    try {
      const cleaned = !createAttempted || await this.cleanup(containerId ?? name);
      if (!cleaned || creationUncertain) { this.unhealthy = true; return report('cleanup_failed'); }
      if (directory) await rm(directory, { recursive: true, force: true });
      if (lock) { await lock.close(); await unlink(lockPath); }
      return final;
    } catch { this.unhealthy = true; return report('cleanup_failed'); }
    finally { await lock?.close().catch(() => {}); this.active -= 1; }
  }
  private async cleanup(name: string): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn(this.config.dockerBinary, ['rm', '--force', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0, overflow = false;
      const collect = (data: Buffer, output: 'stdout' | 'stderr') => {
        bytes += data.length;
        if (bytes > 4096) { overflow = true; child.kill('SIGKILL'); return; }
        if (output === 'stdout') stdout += data.toString('utf8'); else stderr += data.toString('utf8');
      };
      child.stdout.on('data', data => collect(data, 'stdout')); child.stderr.on('data', data => collect(data, 'stderr'));
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5000);
      child.once('error', () => { clearTimeout(timeout); resolve(false); });
      child.once('close', code => {
        clearTimeout(timeout);
        const error = stderr.trim().toLowerCase();
        const absent = code === 1 && !stdout.trim() && [
          `error response from daemon: no such container: ${name}`,
          `error: no such container: ${name}`,
          `error: no such object: ${name}`,
        ].includes(error);
        resolve(!overflow && ((code === 0 && stdout.trim() === name && !stderr.trim()) || absent));
      });
    });
  }
  private async run(args: string[], input: string, signal?: AbortSignal, timeoutMs = this.config.timeoutMs): Promise<{ status: 'completed' | 'timeout' | 'output_limit' | 'cancelled' | 'execution_failed' | 'unavailable'; stdout: string }> {
    return new Promise(resolve => {
      const child = spawn(this.config.dockerBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', bytes = 0, status: 'timeout' | 'output_limit' | 'cancelled' | undefined;
      const decoder = new StringDecoder('utf8');
      const stop = (reason: typeof status) => { status ??= reason; child.kill('SIGKILL'); };
      const timeout = setTimeout(() => stop('timeout'), timeoutMs);
      const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > this.config.maxOutputBytes) stop('output_limit'); else stdout += decoder.write(data); });
      child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > this.config.maxOutputBytes) stop('output_limit'); });
      child.stdin.on('error', () => {});
      const done = (result: Awaited<ReturnType<DockerSandbox['run']>>) => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); resolve(result); };
      child.once('error', () => done({ status: 'unavailable', stdout: '' }));
      child.once('close', code => { stdout += decoder.end(); done({ status: status ?? (code === 0 ? 'completed' : 'execution_failed'), stdout }); });
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  }
}
