import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDatabase as createPool } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import {
  addReadyCopy, baseDatabaseUrl, claimCopy, createDatabase, databaseUrl, dropDatabase, dropStale, migrationsDirectory, newRun,
  templateSchema, withBase,
} from './database-template.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const base = baseDatabaseUrl();
const opened: TestDatabase[] = [];
const extra: string[] = [];
const schemaName = () => `harness_${randomUUID().replaceAll('-', '')}`;
async function open(options?: { migrated?: boolean }) {
  const database = await createTestDatabase(schemaName(), options);
  opened.push(database);
  return database;
}
async function exists(name: string) {
  return withBase(base, async client => (await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount === 1);
}
afterAll(async () => {
  for (const database of opened) await database.drop();
  await withBase(base, async client => { for (const name of extra) await dropDatabase(client, name); });
}, 30_000);

describe('per-file copies of the migrated template database', () => {
  it('gives each file its own fully migrated schema whose recorded migrations match the files', async () => {
    const [one, two] = await Promise.all([open(), open()]);
    expect(new URL(one.rootUrl).pathname).not.toBe(new URL(two.rootUrl).pathname);
    const db = createPool(one.url), other = createPool(two.url);
    try {
      expect((await db.query('SELECT current_schema() AS s')).rows[0].s).toBe(one.schema);
      expect((await db.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [templateSchema])).rowCount).toBe(0);
      // The production identity check: every migration is recorded with its current digest.
      expect(await migrate(db, migrationsDirectory)).toEqual([]);
      const workspace = randomUUID();
      await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'isolated', 'Isolated']);
      expect((await other.query('SELECT 1 FROM workspaces WHERE id=$1', [workspace])).rowCount).toBe(0);
      expect((await other.query('SELECT count(*)::int AS n FROM workspaces')).rows[0].n).toBe(0);
    } finally { await db.end(); await other.end(); }
  });

  it('still rejects a copy whose recorded migration no longer matches its file', async () => {
    const copy = await open();
    const db = createPool(copy.url);
    try {
      await db.query("UPDATE schema_migrations SET digest='tampered' WHERE name=(SELECT min(name) FROM schema_migrations)");
      await expect(migrate(db, migrationsDirectory)).rejects.toThrow(/Applied migration changed/);
    } finally { await db.end(); }
  });

  it('can start from an empty schema so a file exercises migrate() itself', async () => {
    const empty = await open({ migrated: false });
    const db = createPool(empty.url);
    try {
      expect((await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=current_schema()")).rows[0].n).toBe(0);
      expect((await migrate(db, migrationsDirectory)).length).toBeGreaterThan(30);
      expect(await migrate(db, migrationsDirectory)).toEqual([]);
    } finally { await db.end(); }
  }, 30_000);

  it('never hands the same ready copy to two concurrent claims', async () => {
    const run = inject('courseTestDatabase')!;
    await withBase(base, async client => { for (let i = 0; i < 3; i++) extra.push(await addReadyCopy(client, run)); });
    const claims = await Promise.all(Array.from({ length: 6 }, () => withBase(base, client => claimCopy(client, run))));
    extra.push(...claims.map(claim => claim.name));
    expect(new Set(claims.map(claim => claim.name)).size).toBe(6);
    // At least the three just added were available; the rest were made on demand.
    expect(claims.filter(claim => claim.prepared).length).toBeGreaterThanOrEqual(3);
    for (const claim of claims) expect(await exists(claim.name)).toBe(true);
  }, 30_000);

  it('cleans up only marked databases from old runs', async () => {
    const old = newRun(base, Date.now() - 7 * 60 * 60 * 1000), recent = newRun(base);
    const marked = `${old.prefix}_f000001`, unmarked = `${old.prefix}_f000002`, fresh = `${recent.prefix}_f000003`;
    extra.push(marked, unmarked, fresh);
    await withBase(base, async client => {
      await createDatabase(client, marked);
      await client.query(`CREATE DATABASE "${unmarked}" TEMPLATE template0`);
      await createDatabase(client, fresh);
      const dropped = await dropStale(client, base, 6 * 60 * 60 * 1000);
      expect(dropped).toContain(marked);
      expect(dropped).not.toContain(unmarked);
      expect(dropped).not.toContain(fresh);
    });
    expect(await exists(marked)).toBe(false);
    expect(await exists(unmarked)).toBe(true);
    expect(await exists(fresh)).toBe(true);
  }, 30_000);

  it('leaves a file database that still has an open connection to the run teardown instead of killing it', async () => {
    const copy = await createTestDatabase(schemaName());
    const name = new URL(copy.rootUrl).pathname.slice(1);
    extra.push(name);
    const client = new pg.Client({ connectionString: copy.url });
    await client.connect();
    let terminated = false;
    client.on('error', () => { terminated = true; });
    await copy.drop();
    expect(await exists(name)).toBe(true);
    expect((await client.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    expect(terminated).toBe(false);
    await client.end();
    await copy.drop();
    expect(await exists(name)).toBe(false);
  }, 30_000);

  it('refuses non-test database URLs before connecting', () => {
    expect(() => baseDatabaseUrl({ TEST_DATABASE_URL: 'postgres://user@db.example.com:5432/course_core_test' })).toThrow(/loopback/);
    expect(() => baseDatabaseUrl({ TEST_DATABASE_URL: 'postgres://user@127.0.0.1:5432/course_core_pilot' })).toThrow(/disposable/);
    expect(() => baseDatabaseUrl({ TEST_DATABASE_URL: base.href, DATABASE_URL: base.href })).toThrow(/DATABASE_URL/);
    expect(() => baseDatabaseUrl({})).toThrow(/TEST_DATABASE_URL is required/);
    expect(() => baseDatabaseUrl({ TEST_DATABASE_URL: databaseUrl(base, `course_core_test_${'x'.repeat(30)}`) })).toThrow(/at most/);
  });
});
