import { inject } from 'vitest';
import { migrate } from '../src/migrations.js';
import { createDatabase as createPool } from '../src/database.js';
import { baseDatabaseUrl, claimCopy, createDatabase, databaseUrl, dropDatabase, dropWhenClosed, emptyName, migrationsDirectory, templateSchema, withBase } from './database-template.js';

export interface TestDatabase {
  /** The schema holding the application tables (the name the test asked for). */
  schema: string;
  /** This file's own database, without a search path: use it as the administrative connection. */
  rootUrl: string;
  /** The same database with `search_path` set to `schema`, as the application connects. */
  url: string;
  /** Drops the whole database once this file's connections are closed (otherwise the run's teardown does). */
  drop(): Promise<void>;
}

/**
 * Gives a test file its own database copied from the run's migrated template, with the
 * application schema renamed to `schema`. With `migrated: false` the schema is created empty
 * so the test can exercise `migrate()` itself on a fresh schema.
 */
export async function createTestDatabase(schema: string, options: { migrated?: boolean } = {}): Promise<TestDatabase> {
  const base = baseDatabaseUrl();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`Unexpected schema name: ${schema}`);
  const run = inject('courseTestDatabase');
  if (!run) throw new Error('The API test global setup did not prepare a template database.');
  const migrated = options.migrated ?? true;
  const name = await withBase(base, async client => {
    if (migrated) return (await claimCopy(client, run)).name;
    const empty = emptyName(run);
    await createDatabase(client, empty);
    return empty;
  });
  const drop = async () => { await withBase(base, client => dropWhenClosed(client, name)); };
  try {
    const root = createPool(databaseUrl(base, name));
    try {
      await root.query(migrated ? `ALTER SCHEMA ${templateSchema} RENAME TO ${schema}` : `CREATE SCHEMA ${schema}`);
    } finally { await root.end(); }
    const url = databaseUrl(base, name, schema);
    if (migrated) {
      // The copy carries the template's recorded migration digests; the production identity
      // check confirms they match these migration files and that nothing is left to apply.
      const db = createPool(url);
      try {
        const pending = await migrate(db, migrationsDirectory);
        if (pending.length) throw new Error(`Template database was missing migrations: ${pending.join(', ')}`);
      } finally { await db.end(); }
    }
    return { schema, rootUrl: databaseUrl(base, name), url, drop };
  } catch (error) {
    await withBase(base, client => dropDatabase(client, name)).catch(() => undefined);
    throw error;
  }
}
