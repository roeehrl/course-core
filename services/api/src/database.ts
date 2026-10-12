import pg from 'pg';
import type { PoolClient } from 'pg';

export function createDatabase(connectionString: string) {
  return new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
}
export type Database = ReturnType<typeof createDatabase>;

export async function transaction<T>(db: Database, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
