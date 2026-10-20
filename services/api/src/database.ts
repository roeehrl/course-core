import pg from 'pg';
import type { PoolClient } from 'pg';
import { telemetry } from '@course-core/supervisor/telemetry';

/** A stable code from a connection error (a Postgres SQLSTATE such as 57P01, or a socket code such
 * as ECONNRESET). Messages can carry server or query details, so they are never logged. */
export function connectionErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN';
}
function reportLostConnection(error: unknown) {
  process.stderr.write(`${JSON.stringify({ event: 'db.connection_lost', code: connectionErrorCode(error) })}\n`);
}

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  // A Postgres restart, pg_terminate_backend or a network drop ends server connections and pg
  // reports it as an 'error' event. Unhandled, that event is an uncaught exception that exits the
  // process. Each client gets a listener for its whole life: when idle the pool also discards it
  // (and opens a new one on demand); when checked out its holder's next query fails and release()
  // discards it. Reported once per client, as a code only.
  const reported = new WeakSet<object>();
  pool.on('connect', client => client.on('error', error => {
    if (reported.has(client)) return;
    reported.add(client); reportLostConnection(error);
  }));
  // The pool re-emits an idle client's error after removing it; already reported above.
  pool.on('error', () => undefined);
  return pool;
}
export type Database = ReturnType<typeof createDatabase>;

const transactionAttributes = { 'db.system.name': 'postgresql', 'db.operation.name': 'transaction' };
/** Traced only as a child of an already recording request or run span; never records SQL or values. */
export async function transaction<T>(db: Database, body: (client: PoolClient) => Promise<T>): Promise<T> {
  return telemetry().span('db.transaction', transactionAttributes, async span => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      span.setAttributes({ 'course.db.outcome': 'commit' });
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      span.setAttributes({ 'course.db.outcome': 'rollback' });
      throw error;
    } finally { client.release(); }
  }, { childOnly: true });
}
