import { describe, expect, it } from 'vitest';
import { ConfigurationError, failureLine, Startup, StartupError, StepFailure, STARTUP_STEPS, startupHint, untilReady, sandboxStartupTimeout } from '../src/startup.js';

describe('API startup diagnostics', () => {
  it('prints one line naming the step, a fixed code and a hint, and never an error message', () => {
    const secret = Object.assign(new Error('connect ECONNREFUSED postgres://course_ci:course_ci_test_only@127.0.0.1:5432/course_core_test'), { code: 'ECONNREFUSED' });
    const line = JSON.parse(failureLine('db_connect', secret));
    expect(line).toEqual({ startup: 'failed', step: 'db_connect', code: 'ECONNREFUSED', hint: expect.stringContaining('PostgreSQL is not accepting connections') });
    expect(JSON.stringify(line)).not.toContain('course_ci_test_only');
    // An error without a safe code is UNKNOWN with the step's general hint.
    expect(JSON.parse(failureLine('migrations', new Error('relation "x" already exists at /home/me')))).toMatchObject({ code: 'UNKNOWN', hint: expect.stringContaining('migration') });
    expect(JSON.parse(failureLine('port_bind', Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).hint).toMatch(/Another process already listens/);
    expect(JSON.parse(failureLine('sandbox_image_inspect', new StartupError('image_missing'))).hint).toMatch(/npm run sandbox:pull/);
  });
  it('configuration problems carry our own fixed text, never a URL', () => {
    expect(JSON.parse(failureLine('configuration', new ConfigurationError('Invalid PORT.')))).toMatchObject({ code: 'INVALID_CONFIGURATION', detail: 'Invalid PORT.' });
    expect(JSON.parse(failureLine('configuration', new ConfigurationError('ADDITIONAL_ORIGINS: bad https://user:password@example.com')))).not.toHaveProperty('detail');
  });
  it('every step has a general hint', () => {
    for (const step of STARTUP_STEPS) expect(startupHint(step, 'NOT_A_CODE').length).toBeGreaterThan(20);
  });
  it('times steps, keeps the step of a nested failure, and writes timings only at debug level', async () => {
    const lines: string[] = [], startup = new Startup(line => lines.push(line));
    await startup.step('configuration', () => undefined);
    const failure = await startup.step('docker_info', () => { throw new StepFailure('sandbox_image_inspect', new StartupError('image_missing')); }).catch(error => error);
    startup.failed(failure);
    expect(JSON.parse(lines[0]!)).toMatchObject({ step: 'sandbox_image_inspect', code: 'image_missing' });
    startup.ready('info'); expect(lines).toHaveLength(1);
    startup.ready('debug');
    expect(JSON.parse(lines[1]!)).toMatchObject({ startup: 'ready', level: 'debug', steps: { configuration: expect.any(Number), docker_info: expect.any(Number) } });
  });
  it('retries a slow dependency until its deadline and throws the last failure; a definite failure is not retried', async () => {
    const waits: number[] = [], sleep = async (ms: number) => { waits.push(ms); };
    let calls = 0;
    await expect(untilReady(async () => { calls++; if (calls < 3) throw new StartupError('docker_timeout'); return 'ready'; }, () => true, 60_000, sleep)).resolves.toBe('ready');
    expect(waits).toEqual([1_000, 2_000]);
    calls = 0;
    await expect(untilReady(async () => { calls++; throw new StartupError('TEACHING_VERIFIER_QUALIFICATION_FAILED'); }, error => (error as StartupError).code !== 'TEACHING_VERIFIER_QUALIFICATION_FAILED', 60_000, sleep))
      .rejects.toMatchObject({ code: 'TEACHING_VERIFIER_QUALIFICATION_FAILED' });
    expect(calls).toBe(1);
    await expect(untilReady(async () => { throw new StartupError('docker_unavailable'); }, () => true, 1_500, sleep)).rejects.toMatchObject({ code: 'docker_unavailable' });
  });
  it('bounds SANDBOX_STARTUP_TIMEOUT_MS', () => {
    expect(sandboxStartupTimeout(undefined)).toBe(120_000);
    expect(() => sandboxStartupTimeout('10')).toThrow(ConfigurationError);
    expect(() => sandboxStartupTimeout('abc')).toThrow(ConfigurationError);
  });
});
