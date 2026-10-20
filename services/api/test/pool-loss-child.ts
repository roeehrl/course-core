// Child process for pool-errors.integration.test.ts: a separate process, so an unhandled pool or
// client 'error' event would crash it exactly as it would crash the API.
import { createInterface } from 'node:readline';
import { createDatabase } from '../src/database.js';

const db = createDatabase(process.env.DATABASE_URL!);
type Queryable = { query(sql: string): Promise<{ rows: Array<{ pid: number }> }> };
const pid = async (client: Queryable) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
// One client returned to the pool (idle) and one still checked out between queries.
const idle = await db.connect(), held = await db.connect();
const pids = [await pid(idle), await pid(held)];
idle.release();
process.stdout.write(`${JSON.stringify({ ready: true, pids })}\n`);
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line !== 'query') continue;
  let heldFailed = false;
  try { await held.query('SELECT 1'); } catch { heldFailed = true; }
  held.release();
  const after = await pid(db);
  process.stdout.write(`${JSON.stringify({ heldFailed, after, replaced: !pids.includes(after) })}\n`);
  break;
}
await db.end();
