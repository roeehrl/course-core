import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDatabase, transaction } from './database.js';
import { migrate } from './migrations.js';
import { issueLoginCode } from './auth.js';

const args = process.argv.slice(2);
if (args.length !== 3 || !/^[a-z][a-z0-9-]{0,99}$/.test(args[0]!) || !args[1]?.trim() || !args[2]?.trim()) {
  throw new Error('Usage: bootstrap <workspace-slug> <user-subject> <display-name>. Run only on the trusted server host.');
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const db = createDatabase(process.env.DATABASE_URL);
try {
  await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
  const result = await transaction(db, async client => {
    const workspace = await client.query<{ id: string }>('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$2) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id', [randomUUID(), args[0]]);
    const user = await client.query<{ id: string }>('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id', [randomUUID(), args[1], args[2]]);
    await client.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING", [workspace.rows[0]!.id, user.rows[0]!.id]);
    return { workspaceId: workspace.rows[0]!.id, userId: user.rows[0]!.id };
  });
  const code = await issueLoginCode(db, result.userId);
  const url = new URL(process.env.PUBLIC_ORIGIN ?? 'http://localhost:4310');
  url.hash = `signin=${code}`;
  process.stdout.write(JSON.stringify({ ...result, expiresInMinutes: 10, oneTimeSignInUrl: url.toString() }) + '\n');
} finally { await db.end(); }
