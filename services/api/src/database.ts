import pg from 'pg';
import type { PoolClient } from 'pg';
import { telemetry } from '@course-core/supervisor/telemetry';

export function createDatabase(connectionString: string) {
  return new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
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
