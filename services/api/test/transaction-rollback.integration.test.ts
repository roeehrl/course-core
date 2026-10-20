import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { ApiError } from '../src/errors.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const schema = `transaction_rollback_${randomUUID().replaceAll('-', '')}`;
let testDatabase: TestDatabase | undefined, db: Database, admin: Database;
// Clients whose server connection was lost. The listener also keeps the 'error' event that a lost
// checked-out client emits from being an uncaught exception in this test process.
const lost = new WeakSet<PoolClient>();
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  db.on('connect', client => client.on('error', () => { lost.add(client); }));
  admin = createDatabase(testDatabase.rootUrl);
  await db.query('CREATE TABLE tx_probe (id uuid PRIMARY KEY)');
}, 30_000);
afterAll(async () => { await db?.end(); await admin?.end(); await testDatabase?.drop(); });
afterEach(() => { vi.restoreAllMocks(); });

const backend = async (client: PoolClient | Database) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
const probes = async (id: string) => Number((await db.query('SELECT count(*) FROM tx_probe WHERE id=$1', [id])).rows[0].count);
function captureStderr() {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.includes('db.rollback_failed')) { lines.push(text); return true; }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write);
  return lines;
}

describe('transaction() when ROLLBACK fails', () => {
  it('rethrows the original error after the connection is lost mid-transaction, destroys the client and recovers', async () => {
    const logged = captureStderr(), id = randomUUID(), original = new ApiError(409, 'SYNTHETIC_FAILURE');
    let pid = 0, release: ReturnType<typeof vi.spyOn> | undefined;
    const failure = await transaction(db, async client => {
      release = vi.spyOn(client, 'release');
      await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
      pid = await backend(client);
      expect((await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pid])).rows[0]!.ok).toBe(true);
      for (let i = 0; i < 200 && !lost.has(client); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(lost.has(client)).toBe(true);
      throw original;
    }).catch((error: unknown) => error);
    // Before the fix the caller saw the ROLLBACK's "not queryable" error instead.
    expect(failure).toBe(original);
    // Released with an error, so the pool destroys the client instead of reusing it.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release!.mock.calls[0]![0]).toBe(true);
    // Logged as a code only: no message, SQL or values.
    expect(logged.map(line => JSON.parse(line))).toEqual([{ event: 'db.rollback_failed', code: expect.stringMatching(/^[A-Z0-9_]{1,64}$/) }]);
    expect(logged.join('')).not.toMatch(/queryable|terminat|tx_probe|INSERT/i);
    // Nothing was committed, and the pool serves the next transaction on a new connection.
    expect(await probes(id)).toBe(0);
    const next = await transaction(db, async client => { await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]); return backend(client); });
    expect(next).not.toBe(pid);
    expect(await probes(id)).toBe(1);
  });

  it('unchanged when ROLLBACK succeeds: same error, rolled back, nothing logged, client reused', async () => {
    const logged = captureStderr(), id = randomUUID(), original = new ApiError(409, 'SYNTHETIC_FAILURE');
    let pid = 0, release: ReturnType<typeof vi.spyOn> | undefined;
    const failure = await transaction(db, async client => {
      release = vi.spyOn(client, 'release');
      await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
      pid = await backend(client);
      throw original;
    }).catch((error: unknown) => error);
    expect(failure).toBe(original);
    expect(await probes(id)).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release!.mock.calls[0]![0]).toBeUndefined();
    expect(logged).toEqual([]);
    // The healthy client went back to the pool and serves the next transaction.
    expect(await transaction(db, client => backend(client))).toBe(pid);
  });

  it('unchanged when ROLLBACK succeeds after a database error: the database error is rethrown', async () => {
    const logged = captureStderr(), id = randomUUID();
    await db.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
    const other = randomUUID();
    const failure = await transaction(db, async client => {
      await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [other]);
      await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
    }).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('23505');
    expect(await probes(other)).toBe(0);
    expect(logged).toEqual([]);
  });
});
