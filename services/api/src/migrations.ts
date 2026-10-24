import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from './database.js';
import { transaction } from './database.js';

export async function migrate(db: Database, directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('course-core:migrations'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied: string[] = [];
    for (const name of files) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const old = await client.query<{ digest: string }>('SELECT digest FROM schema_migrations WHERE name = $1', [name]);
      if (old.rowCount) {
        if (old.rows[0]!.digest !== digest) throw Object.assign(new Error(`Applied migration changed: ${name}`), { code: 'MIGRATION_CHANGED' });
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, digest) VALUES ($1, $2)', [name, digest]);
      applied.push(name);
    }
    return applied;
  });
}
