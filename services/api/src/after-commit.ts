import type { PoolClient } from 'pg';
import { transaction, type Database } from './database.js';

/** Work queued by the open after-commit transaction on each client. */
const queues = new WeakMap<PoolClient, (() => void)[]>();

/**
 * Queues `effect` (telemetry, typically) to run only if the transaction that `client` belongs to
 * commits, so a rolled-back write is never counted. Throws when `client` is not inside
 * `afterCommitTransaction`, so a call site cannot silently emit early.
 */
export function onCommit(client: PoolClient, effect: () => void) {
  const queue = queues.get(client);
  if (!queue) throw new Error('onCommit must be called inside afterCommitTransaction.');
  queue.push(effect);
}

/**
 * `transaction` that runs the effects queued with `onCommit` after COMMIT, in order. Nothing
 * runs on rollback (including a failed COMMIT). An effect that throws is ignored: the writes
 * it describes are already committed.
 */
export async function afterCommitTransaction<T>(db: Database, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const queue: (() => void)[] = [];
  const result = await transaction(db, async client => {
    queues.set(client, queue);
    try { return await body(client); } finally { queues.delete(client); }
  });
  for (const effect of queue) try { effect(); } catch { /* best effort after commit */ }
  return result;
}
