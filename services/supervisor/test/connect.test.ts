import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { connectWithRetry, TemporalUnavailableError } from '../src/temporal/connect.js';
import { readConfig } from '../src/config.js';

/** A fake clock: sleeping advances time instantly and records each wait. */
function clock() {
  let time = 0; const waits: number[] = [];
  return { waits, now: () => time, sleep: async (ms: number) => { waits.push(ms); time += ms; }, advance: (ms: number) => { time += ms; } };
}

test('retries a failing first connection with capped doubling waits until it succeeds', async () => {
  const c = clock(); let calls = 0; const retries: Array<[number, number]> = [];
  const connection = await connectWithRetry(async () => { calls++; if (calls < 6) throw new Error('UNAVAILABLE: connection refused'); return 'connected'; },
    { deadlineMs: 60_000, initialDelayMs: 250, maxDelayMs: 2_000, now: c.now, sleep: c.sleep, onRetry: (attempt, delayMs) => retries.push([attempt, delayMs]) });
  assert.equal(connection, 'connected'); assert.equal(calls, 6);
  assert.deepEqual(c.waits, [250, 500, 1000, 2000, 2000]);
  assert.deepEqual(retries, [[1, 250], [2, 500], [3, 1000], [4, 2000], [5, 2000]]);
});

test('a first successful connection does not wait', async () => {
  const c = clock();
  assert.equal(await connectWithRetry(async () => 1, { deadlineMs: 1000, now: c.now, sleep: c.sleep }), 1);
  assert.deepEqual(c.waits, []);
});

test('gives up at the overall deadline, never starting an attempt after it', async () => {
  const c = clock(); const attemptsAt: number[] = [];
  // Each attempt itself takes 300 ms of the budget, as a slow refusal would.
  const failing = async () => { attemptsAt.push(c.now()); c.advance(300); throw new Error('unavailable'); };
  const error = await connectWithRetry(failing, { deadlineMs: 5_000, initialDelayMs: 250, maxDelayMs: 1_000, now: c.now, sleep: c.sleep })
    .then(() => assert.fail('expected failure'), (reason: unknown) => reason);
  assert.ok(error instanceof TemporalUnavailableError);
  assert.equal(error.reason, 'deadline'); assert.equal(error.message, 'temporal_unavailable');
  assert.equal(error.attempts, attemptsAt.length);
  assert.ok(attemptsAt.every(at => at <= 5_000), `attempt after deadline: ${attemptsAt}`);
  assert.equal(attemptsAt.at(-1), 5_000, 'the last wait is shortened to end exactly at the deadline');
  assert.ok(c.waits.every(wait => wait > 0 && wait <= 1_000));
});

test('the error text of failed attempts is never surfaced', async () => {
  const c = clock();
  const error = await connectWithRetry(async () => { throw new Error('secret-token at private.invalid'); }, { deadlineMs: 1000, now: c.now, sleep: c.sleep })
    .catch((reason: Error) => reason);
  assert.ok(error instanceof TemporalUnavailableError);
  assert.doesNotMatch(`${error.message} ${error.stack}`, /secret-token|private\.invalid/);
});

test('a stop signal ends the wait without another attempt', async () => {
  const stop = new AbortController(); let calls = 0;
  const pending = connectWithRetry(async () => { calls++; throw new Error('unavailable'); }, { deadlineMs: 60_000, initialDelayMs: 30_000, signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  const started = Date.now();
  const error = await pending.catch((reason: unknown) => reason);
  assert.ok(error instanceof TemporalUnavailableError); assert.equal(error.reason, 'stopped');
  assert.equal(calls, 1); assert.ok(Date.now() - started < 5_000);
});

test('the connection deadline is validated configuration', () => {
  const env: NodeJS.ProcessEnv = { SUPERVISOR_TEMPORAL_ADDRESS: '127.0.0.1:17233', SUPERVISOR_TEMPORAL_NAMESPACE: 'test',
    SUPERVISOR_TEMPORAL_TASK_QUEUE: 'test-queue', SUPERVISOR_HOST_URL: 'http://127.0.0.1:18080/', SUPERVISOR_HOST_TOKEN: 'test-only' };
  const ready = readConfig(env); assert.equal(ready.status, 'ready');
  if (ready.status === 'ready') assert.equal(ready.config.temporal.connectDeadlineMs, 120_000);
  for (const value of ['0', '999', '3600001', '1.5', 'soon']) {
    const result = readConfig({ ...env, SUPERVISOR_TEMPORAL_CONNECT_DEADLINE_MS: value });
    assert.deepEqual(result, { status: 'configuration_missing', fields: ['SUPERVISOR_TEMPORAL_CONNECT_DEADLINE_MS'] });
  }
});

for (const mode of ['dispatch-once', 'worker']) test(`${mode} exits with a clear code when Temporal never comes up`, async () => {
  // A loopback port with nothing listening: every connection attempt is refused.
  const port = await new Promise<number>(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const started = Date.now();
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, mode], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { PATH: process.env.PATH ?? '',
      SUPERVISOR_TEMPORAL_ADDRESS: `127.0.0.1:${port}`, SUPERVISOR_TEMPORAL_NAMESPACE: 'default', SUPERVISOR_TEMPORAL_TASK_QUEUE: 'test-queue',
      SUPERVISOR_HOST_URL: 'http://127.0.0.1:9/', SUPERVISOR_HOST_TOKEN: 'test-only', SUPERVISOR_TEMPORAL_CONNECT_DEADLINE_MS: '6000' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject); child.once('close', code => { clearTimeout(kill); resolve({ code, stderr }); });
  });
  assert.equal(code, 1);
  const lines = stderr.trim().split('\n').map(line => JSON.parse(line) as { code: string; attempts?: number });
  assert.ok(lines.some(line => line.code === 'temporal_connect_retry'), stderr);
  const last = lines.at(-1)!;
  assert.equal(last.code, 'temporal_unavailable'); assert.ok(last.attempts! >= 2);
  assert.ok(Date.now() - started < 30_000);
  assert.doesNotMatch(stderr, new RegExp(String(port)));
});
