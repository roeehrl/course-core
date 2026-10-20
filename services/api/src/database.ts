import pg from 'pg';
import type { PoolClient } from 'pg';
import { telemetry } from '@course-core/supervisor/telemetry';

export function createDatabase(connectionString: string) {
  return new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
}
export type Database = ReturnType<typeof createDatabase>;

/** A SQLSTATE or socket code; messages can carry server or query details and are never logged. */
function rollbackErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN';
}
const transactionAttributes = { 'db.system.name': 'postgresql', 'db.operation.name': 'transaction' };
/** Traced only as a child of an already recording request or run span; never records SQL or values. */
export async function transaction<T>(db: Database, body: (client: PoolClient) => Promise<T>): Promise<T> {
  return telemetry().span('db.transaction', transactionAttributes, async span => {
    const client = await db.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      span.setAttributes({ 'course.db.outcome': 'commit' });
      return result;
    } catch (error) {
      // The server rolls back on its own when the connection is lost. A failed ROLLBACK
      // (usually that lost connection) must not hide why the transaction failed: the caller
      // gets the original error, and the rollback failure is logged as a code only.
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) {
        broken = true;
        process.stderr.write(`${JSON.stringify({ event: 'db.rollback_failed', code: rollbackErrorCode(rollbackError) })}\n`);
      }
      span.setAttributes({ 'course.db.outcome': 'rollback' });
      throw error;
    } finally {
      // A client whose ROLLBACK failed may still be inside the transaction: destroy it, never reuse it.
      client.release(broken || undefined);
    }
  }, { childOnly: true });
}
