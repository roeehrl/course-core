import { fileURLToPath } from 'node:url';
import { createDatabase } from './database.js';
import { migrate } from './migrations.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const db = createDatabase(process.env.DATABASE_URL);
try {
  const migrations = await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  process.stdout.write(`${JSON.stringify({ applied: migrations })}\n`);
} finally { await db.end(); }
