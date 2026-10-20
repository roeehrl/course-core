import type { Database } from './database.js';

/** Ended sessions are kept this long after they stop working, then deleted. */
export const ENDED_SESSION_RETENTION_DAYS = 7;

/**
 * Deletes sign-in sessions that ended (expired, or revoked by sign-out, a password change, staff
 * revocation or account erasure) more than `retentionDays` ago. A session row holds only hashes
 * of its secrets, the account id and times; no audit record refers to it, and the account's last
 * sign-in is kept on app_users (migration 080). Bounded batches; rows locked by a concurrent
 * revocation are skipped and taken next time. Idempotent and safe to run from several processes.
 */
export async function purgeEndedSessions(db: Database, options: { retentionDays?: number; batchSize?: number; maxBatches?: number } = {}) {
  const retentionDays = options.retentionDays ?? ENDED_SESSION_RETENTION_DAYS;
  const batchSize = options.batchSize ?? 1000, maxBatches = options.maxBatches ?? 20;
  let purged = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const deleted = (await db.query(`DELETE FROM auth_sessions WHERE id IN (
        SELECT id FROM auth_sessions WHERE LEAST(revoked_at, expires_at) < clock_timestamp() - make_interval(days => $1)
        LIMIT $2 FOR UPDATE SKIP LOCKED)`, [retentionDays, batchSize])).rowCount ?? 0;
    purged += deleted;
    if (deleted < batchSize) break;
  }
  return { purged };
}
