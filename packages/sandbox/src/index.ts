import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Case { id: string; input: Json; expected: Json; absoluteTolerance?: number; relativeTolerance?: number }
export interface Submission { source: string; cases: Case[]; signal?: AbortSignal; batchCaseCounts?: number[] }
/**
 * `timeoutMs` is the learner's time limit: the execution of their code, summed over every batch of
 * one submission. Its clock runs from the runner's ready line (written before the submission is
 * loaded) until the container's process ends. `setupTimeoutMs` bounds everything else in that
 * submission (admission, Docker checks, container create and start up to the ready line, cleanup
 * between batches). Running past it is `setup_timeout`: the sandbox was slow, which says nothing
 * about the learner's code, so callers must not grade it or count it as an attempt.
 */
export interface Options { image: string; storageDirectory: string; dockerBinary?: string; timeoutMs?: number; setupTimeoutMs?: number; memoryMiB?: number; maxOutputBytes?: number; concurrency?: number }
/** `durationMs` is wall time; `executionMs` is what `timeoutMs` limits, and `setupMs` the rest. */
export interface GradeReport { status: 'graded' | 'timeout' | 'output_limit' | 'cancelled' | 'execution_failed' | 'setup_timeout' | 'unavailable' | 'busy' | 'cleanup_failed';
  passed: boolean; cases: { id: string; passed: boolean; reason: string }[]; sourceDigest: string; durationMs: number; executionMs: number; setupMs: number; outputBytes: number; batchesCompleted: number; runtime: { protocol: 'python-json-v1'; image: string } }

/** The runner's first stdout line (runner.py). It is written before learner code is loaded, so
 * learner code can neither end setup early nor print it first. It is not graded output. */
export const RUNNER_READY_LINE = 'course-core-sandbox-ready python-json-v1';
/** Default bound for sandbox setup in one submission; generous because a cold or loaded Docker
 * host can create and start containers several times slower than usual. */
export const DEFAULT_SETUP_TIMEOUT_MS = 60000;

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
  if (input.batchCaseCounts !== undefined && (!Array.isArray(input.batchCaseCounts) || !input.batchCaseCounts.length || input.batchCaseCounts.length > 8
    || Array.from(input.batchCaseCounts).some(n => !Number.isSafeInteger(n) || n < 1) || input.batchCaseCounts.reduce((sum,n) => sum+n,0) !== input.cases.length)) throw new Error('INVALID_BATCH_PLAN');
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
  private setupTimeouts = 0;
  private lastSetupTimeoutAt: number | null = null;
  constructor(options: Options) {
    this.storageDirectory = options.storageDirectory;
    this.config = { image: options.image, dockerBinary: options.dockerBinary ?? 'docker', timeoutMs: options.timeoutMs ?? 5000, setupTimeoutMs: options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      memoryMiB: options.memoryMiB ?? 128, maxOutputBytes: options.maxOutputBytes ?? 65536, concurrency: options.concurrency ?? 1 };
    if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(options.image) || !path.isAbsolute(options.storageDirectory) || /[,\n\r\0]/.test(options.storageDirectory)
      || !Number.isInteger(this.config.timeoutMs) || this.config.timeoutMs < 200 || this.config.timeoutMs > 15000
      || !Number.isInteger(this.config.setupTimeoutMs) || this.config.setupTimeoutMs < 1000 || this.config.setupTimeoutMs > 300000
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
    const checked = await this.preflight();
    if (!checked.ok) return { ready: false, reason: checked.reason === 'required_isolation_unavailable' || checked.reason === 'native_image_architecture_required'
      ? checked.reason : 'docker_or_pinned_image_unavailable' };
    return { ready: !this.unhealthy, reason: this.unhealthy ? 'cleanup_required' : 'configured' };
  }
  /**
   * The two Docker checks every run makes, reported step by step for startup diagnostics:
   * `docker info` (the daemon answers and offers the required isolation) and `docker image
   * inspect` (the pinned image is present for this machine's architecture). Reasons are fixed
   * codes; Docker's own output is never returned. `timeoutMs` bounds each command.
   */
  async preflight(timeoutMs = 5000): Promise<{ ok: true } | { ok: false; step: 'docker_info' | 'sandbox_image_inspect'; reason: string }> {
    const exec = promisify(execFile);
    const failed = (error: unknown) => (error as { killed?: boolean; signal?: string } | null)?.killed || (error as { signal?: string } | null)?.signal === 'SIGTERM' ? 'timeout'
      : (error as { code?: unknown } | null)?.code === 'ENOENT' ? 'docker_not_installed' : 'unavailable';
    let info: { OSType?: unknown; MemoryLimit?: unknown; SwapLimit?: unknown; CpuCfsQuota?: unknown; PidsLimit?: unknown; SecurityOptions?: unknown; Architecture?: unknown };
    try { info = JSON.parse((await exec(this.config.dockerBinary, ['info', '--format', '{{json .}}'], { timeout: timeoutMs, maxBuffer: 262144 })).stdout); }
    catch (error) { const why = failed(error); return { ok: false, step: 'docker_info', reason: why === 'unavailable' ? 'docker_unavailable' : why === 'timeout' ? 'docker_timeout' : why }; }
    if (info.OSType !== 'linux' || !info.MemoryLimit || !info.SwapLimit || !info.CpuCfsQuota || !info.PidsLimit
      || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some((item: unknown) => typeof item === 'string' && item.startsWith('name=seccomp')))
      return { ok: false, step: 'docker_info', reason: 'required_isolation_unavailable' };
    let image: { Os?: unknown; Architecture?: unknown } | undefined;
    try { image = JSON.parse((await exec(this.config.dockerBinary, ['image', 'inspect', this.config.image], { timeout: timeoutMs, maxBuffer: 65536 })).stdout)[0]; }
    catch (error) { const why = failed(error); return { ok: false, step: 'sandbox_image_inspect', reason: why === 'timeout' ? 'image_inspect_timeout' : why === 'unavailable' ? 'image_missing' : why }; }
    const architecture = ({ aarch64: 'arm64', x86_64: 'amd64', arm64: 'arm64', amd64: 'amd64' } as Record<string, string>)[String(info.Architecture)];
    if (!architecture || image?.Os !== 'linux' || image.Architecture !== architecture) return { ok: false, step: 'sandbox_image_inspect', reason: 'native_image_architecture_required' };
    return { ok: true };
  }
  /** In-process staff diagnostics since this broker started: grades stopped by `setup_timeout`
   * (the code did not run) and when the latest one ended (epoch milliseconds, or null). */
  setupDiagnostics(): { setupTimeouts: number; lastSetupTimeoutAt: number | null } {
    return { setupTimeouts: this.setupTimeouts, lastSetupTimeoutAt: this.lastSetupTimeoutAt };
  }
  async grade(input: Submission): Promise<GradeReport> {
    validateSubmission(input);
    // Freeze the host reference/source snapshot before any asynchronous boundary.
    input = { source: input.source, cases: structuredClone(input.cases), ...(input.signal ? { signal: input.signal } : {}), ...(input.batchCaseCounts ? { batchCaseCounts: [...input.batchCaseCounts] } : {}) };
    const startedAt = Date.now(), sourceDigest = createHash('sha256').update(input.source).digest('hex');
    let outputBytes=0,batchesCompleted=0,executionMs=0;
    // Two clocks: the learner's execution (timeoutMs) and everything else in this submission (setupTimeoutMs).
    const setupLeft = () => this.config.setupTimeoutMs - (Date.now() - startedAt - executionMs);
    const report = (status: GradeReport['status'], cases: GradeReport['cases'] = []): GradeReport => {
      const durationMs = Date.now() - startedAt;
      return { status, passed: status === 'graded' && cases.length === input.cases.length && cases.every(item => item.passed), cases, sourceDigest, durationMs, executionMs, setupMs: Math.max(0, durationMs - executionMs), outputBytes, batchesCompleted, runtime: { protocol: 'python-json-v1', image: this.config.image } };
    };
    if (input.signal?.aborted) return report('cancelled');
    if (this.unhealthy) return report('unavailable');
    if (this.active >= this.config.concurrency) return report('busy');
    // Reserve admission before readiness or filesystem I/O, so concurrent requests cannot
    // fan out unbounded Docker preflight subprocesses while the execution slot looks idle.
    this.active += 1;
    let name = `course-sandbox-${randomUUID()}`;
    let directory: string | undefined, final: GradeReport, lock: FileHandle | undefined;
    let createAttempted = false, creationUncertain = false, quarantine=false,containerId: string | undefined;
    const lockPath = path.join(this.storageDirectory, 'broker.lock');
    try {
      await mkdir(this.storageDirectory, { recursive: true, mode: 0o700 });
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') { this.active -= 1; return report('busy'); } throw error; }
      await lock.writeFile(JSON.stringify({ containerName: name, pid: process.pid, createdAt: new Date().toISOString() }));
      await lock.sync();
      // The same Docker checks as readiness(), bounded by the setup budget: a daemon too slow to
      // answer is a slow sandbox (setup_timeout), not a verdict on the code.
      const checked = await this.preflight(Math.max(1, Math.min(15000, setupLeft())));
      if (!checked.ok) final = report(checked.reason === 'docker_timeout' || checked.reason === 'image_inspect_timeout' ? 'setup_timeout' : 'unavailable');
      else if (this.unhealthy) final = report('unavailable');
      else if (input.signal?.aborted) final = report('cancelled');
      else {
        directory = await mkdtemp(path.join(this.storageDirectory, 'run-'));
        await writeFile(path.join(directory, 'submission.py'), input.source, { mode: 0o644 });
        await copyFile(new URL('./runner.py', import.meta.url), path.join(directory, 'runner.py'));
        await chmod(path.join(directory, 'runner.py'), 0o644); await chmod(directory, 0o755);
        const counts=input.batchCaseCounts??[input.cases.length],results:GradeReport['cases']=[];
        let offset=0;final=report('execution_failed');
        for(let batchIndex=0;batchIndex<counts.length;batchIndex++){
          if(batchIndex){
            name=`course-sandbox-${randomUUID()}`;
            const record=JSON.stringify({containerName:name,pid:process.pid,createdAt:new Date().toISOString()});
            await lock.truncate(0);await lock.write(record,0,'utf8');await lock.sync();
          }
          const batch=input.cases.slice(offset,offset+counts[batchIndex]!);offset+=batch.length;
          const stdin = batch.map(item => JSON.stringify({ id: item.id, input: item.input })).join('\n') + '\n';
          const beforeCreate = setupLeft();
          if (beforeCreate <= 0) final = report('setup_timeout', results);
          else if (input.signal?.aborted) final = report('cancelled');
          else {
            // Any dispatched create without a valid acknowledgement is ambiguous, including
            // nonzero exits and malformed stdout. A momentary absence cannot fence a late create.
            // A create slower than the setup budget is too, and still quarantines the broker.
            createAttempted = creationUncertain = true;
            const created = await this.run(dockerArguments(this.config, name, directory), '', input.signal, beforeCreate);
            if (created.status !== 'completed' || !/^[a-f0-9]{64}\s*$/.test(created.stdout))
              final = report(created.status === 'cancelled' ? 'cancelled' : created.status === 'timeout' ? 'setup_timeout' : 'unavailable');
            else {
              containerId = created.stdout.trim(); creationUncertain = false;
              // Start and cleanup use the acknowledged immutable ID, not a replaceable name.
              const beforeStart = setupLeft();
              if (beforeStart <= 0) final = report('setup_timeout', results);
              else {
                const result = await this.execute(containerId, stdin, input.signal, beforeStart, this.config.timeoutMs - executionMs, this.config.maxOutputBytes-outputBytes);
                outputBytes+=result.bytes;executionMs+=result.executionMs;
                if(result.status==='completed'){results.push(...gradeOutput(result.stdout,batch));batchesCompleted++;final=report('graded',results);}
                else final=report(result.status,results);
              }
            }
          }
          if(createAttempted){
            const cleaned=await this.cleanup(containerId??name);
            if(!cleaned||creationUncertain){this.unhealthy=quarantine=true;final=report('cleanup_failed',results);break;}
            createAttempted=false;containerId=undefined;
          }
          if(final.status!=='graded')break;
          if(executionMs>=this.config.timeoutMs&&batchIndex+1<counts.length){final=report('timeout',results);break;}
          if(outputBytes>=this.config.maxOutputBytes&&batchIndex+1<counts.length){final=report('output_limit',results);break;}
        }
      }
    } catch { final = report('unavailable'); }
    try {
      if(quarantine)return report('cleanup_failed');
      const cleaned = !createAttempted || await this.cleanup(containerId ?? name);
      if (!cleaned || creationUncertain) { this.unhealthy = true; return report('cleanup_failed'); }
      if (directory) await rm(directory, { recursive: true, force: true });
      if (lock) { await lock.close(); await unlink(lockPath); }
      if(input.signal?.aborted&&final.status==='graded')return report('cancelled',final.cases);
      if(final.status==='setup_timeout'){this.setupTimeouts+=1;this.lastSetupTimeoutAt=Date.now();}
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
  /**
   * Starts an acknowledged container and runs it to completion on two clocks. Until the runner's
   * ready line arrives, the start is setup, bounded by `setupMs` (`setup_timeout`). From that
   * line, which is written before the submission is loaded, the learner's code runs, bounded by
   * `executionMs` (`timeout`) until the process ends. A start that ends or prints anything else
   * before the ready line is `unavailable`: no learner code ran. The line is not output.
   */
  private async execute(containerId: string, input: string, signal: AbortSignal | undefined, setupMs: number, executionMs: number, outputLimit: number): Promise<{ status: 'completed' | 'timeout' | 'setup_timeout' | 'output_limit' | 'cancelled' | 'execution_failed' | 'unavailable'; stdout: string; bytes: number; executionMs: number }> {
    return new Promise(resolve => {
      const child = spawn(this.config.dockerBinary, ['start', '--attach', '--interactive', containerId], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', bytes = 0, head = Buffer.alloc(0), readyAt: number | undefined, status: 'timeout' | 'setup_timeout' | 'output_limit' | 'cancelled' | 'unavailable' | undefined;
      const decoder = new StringDecoder('utf8');
      const stop = (reason: typeof status) => { status ??= reason; child.kill('SIGKILL'); };
      let timeout = setTimeout(() => stop('setup_timeout'), setupMs);
      const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
      const output = (data: Buffer) => { bytes += data.length; if (bytes > outputLimit) stop('output_limit'); else stdout += decoder.write(data); };
      child.stdout.on('data', (data: Buffer) => {
        if (readyAt !== undefined) return output(data);
        if (status) return;
        head = Buffer.concat([head, data]);
        const end = head.indexOf(0x0a);
        if (end < 0) { if (head.length > RUNNER_READY_LINE.length) stop('unavailable'); return; }
        if (head.subarray(0, end).toString('latin1') !== RUNNER_READY_LINE) return stop('unavailable');
        readyAt = Date.now(); clearTimeout(timeout); timeout = setTimeout(() => stop('timeout'), executionMs);
        const rest = head.subarray(end + 1); head = Buffer.alloc(0);
        if (rest.length) output(rest);
      });
      child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > outputLimit) stop('output_limit'); });
      child.stdin.on('error', () => {});
      const done = (result: Omit<Awaited<ReturnType<DockerSandbox['execute']>>, 'executionMs'>) => {
        clearTimeout(timeout); signal?.removeEventListener('abort', abort);
        resolve({ ...result, executionMs: readyAt === undefined ? 0 : Date.now() - readyAt });
      };
      child.once('error', () => done({ status: 'unavailable', stdout: '', bytes }));
      child.once('close', code => { stdout += decoder.end(); done({ status: status ?? (readyAt === undefined ? 'unavailable' : code === 0 ? 'completed' : 'execution_failed'), stdout, bytes }); });
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  }
  private async run(args: string[], input: string, signal?: AbortSignal, timeoutMs = this.config.timeoutMs,outputLimit=this.config.maxOutputBytes): Promise<{ status: 'completed' | 'timeout' | 'output_limit' | 'cancelled' | 'execution_failed' | 'unavailable'; stdout: string; bytes:number }> {
    return new Promise(resolve => {
      const child = spawn(this.config.dockerBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', bytes = 0, status: 'timeout' | 'output_limit' | 'cancelled' | undefined;
      const decoder = new StringDecoder('utf8');
      const stop = (reason: typeof status) => { status ??= reason; child.kill('SIGKILL'); };
      const timeout = setTimeout(() => stop('timeout'), timeoutMs);
      const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > outputLimit) stop('output_limit'); else stdout += decoder.write(data); });
      child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > outputLimit) stop('output_limit'); });
      child.stdin.on('error', () => {});
      const done = (result: Awaited<ReturnType<DockerSandbox['run']>>) => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); resolve(result); };
      child.once('error', () => done({ status: 'unavailable', stdout: '',bytes }));
      child.once('close', code => { stdout += decoder.end(); done({ status: status ?? (code === 0 ? 'completed' : 'execution_failed'), stdout,bytes }); });
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  }
}
