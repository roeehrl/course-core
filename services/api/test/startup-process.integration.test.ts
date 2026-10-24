import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './test-database.js';

// The real API entry point started as a process: one structured line on a failed start, the
// failing step named, a non-zero exit; step timings at debug level on success.
const root = fileURLToPath(new URL('..', import.meta.url));
let testDatabase: TestDatabase | undefined;
beforeAll(async () => { testDatabase = await createTestDatabase(`course_startup_${randomUUID().replaceAll('-', '')}`); }, 30_000);
afterAll(async () => { await testDatabase?.drop(); });

function start(env: Record<string, string>, until?: (stdout: string, stderr: string) => boolean) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DATABASE_URL|MIGRATION_DATABASE_URL|PORT|PROVIDER_|CODE_FIXTURE|TEACHING_VERIFIER|COURSE_|SUPERVISOR_|OTEL_|LOG_LEVEL)/.test(key)));
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: root, env: { ...base, NODE_ENV: 'test', WAKEUP_INTERVAL_MS: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`startup did not finish: ${stderr}`)); }, 60_000);
    child.stdout.on('data', chunk => { stdout += chunk; if (until?.(stdout, stderr)) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (until?.(stdout, stderr)) child.kill('SIGTERM'); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise(resolve => probe.close(resolve));
  return String(port);
}
const startupLines = (stderr: string) => stderr.split('\n').filter(line => line.startsWith('{"startup"')).map(line => JSON.parse(line));

describe('API process startup', () => {
  it('a database that refuses connections fails at db_connect with one line and a non-zero exit', async () => {
    const result = await start({ DATABASE_URL: 'postgres://nobody:canary-password@127.0.0.1:1/course_core_none', PORT: await freePort() });
    expect(result.code).not.toBe(0);
    expect(startupLines(result.stderr)).toEqual([{ startup: 'failed', step: 'db_connect', code: 'ECONNREFUSED', hint: expect.any(String) }]);
    expect(result.stderr).not.toContain('canary-password');
  }, 70_000);
  it('an invalid setting fails at configuration and names it', async () => {
    const result = await start({ DATABASE_URL: testDatabase!.url, PORT: 'not-a-port' });
    expect(result.code).not.toBe(0);
    expect(startupLines(result.stderr)).toEqual([{ startup: 'failed', step: 'configuration', code: 'INVALID_CONFIGURATION', detail: 'Invalid PORT.', hint: expect.any(String) }]);
  }, 70_000);
  it('a port already in use fails at port_bind', async () => {
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
    const port = (holder.address() as { port: number }).port;
    try {
      const result = await start({ DATABASE_URL: testDatabase!.url, PORT: String(port) });
      expect(result.code).not.toBe(0);
      expect(startupLines(result.stderr)).toEqual([{ startup: 'failed', step: 'port_bind', code: 'EADDRINUSE', hint: expect.stringContaining('PORT') }]);
    } finally { holder.close(); }
  }, 70_000);
  it('a successful start logs each step\'s duration at debug level only', async () => {
    const ready = (_out: string, err: string) => err.includes('"startup":"ready"');
    const result = await start({ DATABASE_URL: testDatabase!.url, PORT: await freePort(), LOG_LEVEL: 'debug' }, ready);
    const [line] = startupLines(result.stderr);
    expect(line).toMatchObject({ startup: 'ready', level: 'debug', steps: { configuration: expect.any(Number), db_connect: expect.any(Number), migrations: expect.any(Number),
      server_setup: expect.any(Number), port_bind: expect.any(Number) } });
    const quiet = await start({ DATABASE_URL: testDatabase!.url, PORT: await freePort() }, out => out.includes('Course API listening'));
    expect(startupLines(quiet.stderr)).toEqual([]);
  }, 140_000);
});
