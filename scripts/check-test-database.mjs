import { isMain } from './is-main.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, ensure, testDatabaseUrl, requireNode26 } from './modules.mjs';

export async function checkTestDatabase(environment = process.env) {
  requireNode26();
  const url = testDatabaseUrl(environment);
  const require = createRequire(path.join(ROOT, 'services/api/package.json'));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  try {
    const { rows } = await pool.query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version");
    ensure(rows[0].database === url.pathname.slice(1), 'Connected database does not match the explicit test database');
    ensure(rows[0].version >= 170000 && rows[0].version < 180000, 'API integration tests require real PostgreSQL 17');
    console.log('Disposable Postgres 17 connection verified. API tests own migration and concurrency assertions.');
  } catch (error) {
    // Do not expose connection strings, credentials, or arbitrary database error bodies.
    if (error.message === 'API integration tests require real PostgreSQL 17' || error.message.startsWith('Connected database')) throw error;
    throw new Error('Disposable Postgres check failed; inspect the local service without posting connection credentials.');
  } finally { await pool.end(); }
}
if (isMain(import.meta.url)) {
  checkTestDatabase().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
