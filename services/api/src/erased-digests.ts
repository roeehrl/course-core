import type { PoolClient } from 'pg';
import { requireCondition } from './errors.js';

/**
 * Digests of erased content.
 *
 * Receipts and provenance rows keep a plain SHA-256 of the request or record they bind (an
 * answer, a profile edit, a reviewer's findings, a supervisor tool call, a learner-model source
 * event). Hashing is not redaction: when the input comes from a small domain (a 0-10 number, a
 * toggle, one of four options) anyone holding the row can hash every candidate and find the
 * erased value. Erasure therefore overwrites each such digest with ERASED_DIGEST, a fixed
 * marker that is not a hash of anything and so matches no candidate.
 *
 * The rows stay, so idempotency keys stay reserved and audit keeps its skeleton (who, when,
 * which operation, which key). A replay after erasure finds its receipt and is refused with 410
 * ENROLLMENT_ERASED (requireSameRequest); it is never treated as a new request and never applied
 * again.
 *
 * Why a tombstone rather than keying digests with a per-enrollment secret that erasure deletes:
 * the secret would only protect rows written after it existed, so already-stored and
 * already-erased rows would need this tombstone anyway; several digests are compared across
 * components (supervisor tool outcomes, model selections, source-event references) and would all
 * need the secret; and a keyed digest that outlives its key still looks like a live value to an
 * auditor, where 'erased' says what happened.
 *
 * The statements live in the SQL function erase_enrollment_digests (migration 065) so the same
 * code tombstones new erasures and, once, enrollments erased before it existed. A new digest
 * column over learner data needs one more statement there (a later migration replaces the
 * function and re-runs it for erased enrollments), requireSameRequest at its replay check, and
 * an entry in the coverage list of test/erased-digests.integration.test.ts.
 */
export const ERASED_DIGEST = 'erased';

/** Idempotent-replay check for a receipt erasure may have tombstoned. */
export function requireSameRequest(stored: unknown, digest: string, conflictCode: string, conflictStatus = 409) {
  requireCondition(stored !== ERASED_DIGEST, 'ENROLLMENT_ERASED', 410);
  requireCondition(stored === digest, conflictCode, conflictStatus);
}

/** Runs inside the erasure transaction; returns rows changed per label. */
export async function eraseEnrollmentDigests(client: PoolClient, enrollmentId: string): Promise<Record<string, number>> {
  const row = (await client.query<{ counts: Record<string, number | string> }>('SELECT erase_enrollment_digests($1) AS counts', [enrollmentId])).rows[0]!;
  return Object.fromEntries(Object.entries(row.counts).map(([label, n]) => [label, Number(n)]));
}
