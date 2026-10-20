import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

// Postgres restarts and pg_terminate_backend end server connections. pg reports that as an 'error'
// event on the client (and on the pool for an idle client); without a listener Node treats it as
// an uncaught exception and the API process exits, taking the whole pilot group down.
const schema = `pool_errors_${randomUUID().replaceAll('-', '')}`;
let testDatabase: TestDatabase | undefined, admin: Database;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  admin = createDatabase(testDatabase.rootUrl);
}, 30_000);
afterAll(async () => { await admin?.end(); await testDatabase?.drop(); });

describe('lost database connections', () => {
  const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  it('survives terminated idle and checked-out connections, logs a redacted code and reconnects', async () => {
    const child = spawn(process.execPath, [tsx, 'test/pool-loss-child.ts'], {
      cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: testDatabase!.url }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const exited = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const until = async (done: () => boolean, what: string) => {
      for (let i = 0; i < 300 && !done(); i++) {
        if (child.exitCode !== null) throw new Error(`child exited early (${child.exitCode}): ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!done()) throw new Error(`timed out waiting for ${what}: ${stderr}`);
    };
    try {
      await until(() => stdout.includes('\n'), 'ready');
      const { pids } = JSON.parse(stdout.split('\n')[0]!) as { pids: number[] };
      expect(pids).toHaveLength(2);
      const terminated = (await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend(pid) AS ok FROM unnest($1::int[]) AS pid', [pids])).rows;
      expect(terminated.map(row => row.ok)).toEqual([true, true]);
      // Both the idle and the checked-out client report the loss once each.
      await until(() => stderr.split('\n').filter(line => line.includes('db.connection_lost')).length >= 2, 'both loss reports');
      child.stdin.end('query\n');
      expect(await exited).toBe(0);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    // The checked-out client's holder sees its next query fail; the pool then opens a new connection.
    expect(result).toMatchObject({ heldFailed: true, replaced: true });
    const reports = stderr.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(reports).toEqual([
      { event: 'db.connection_lost', code: '57P01' },
      { event: 'db.connection_lost', code: '57P01' },
    ]);
    // Redacted: no server message, SQL or connection details.
    expect(stderr).not.toMatch(/terminat|administrator|postgres:|SELECT/i);
  }, 60_000);
});
