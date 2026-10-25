import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { runRefSchema, type Snapshot } from '@course-core/supervisor';
import type { authService } from './auth.js';
import { workspaceRole } from './course-access.js';
import type { Database } from './database.js';
import { afterCommitTransaction } from './after-commit.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { digestJson } from './repository.js';
import { transitionWithin } from './supervisor-bridge.js';

/**
 * AI calls whose cost stayed unknown, and the owner's explicit, audited decision on each
 * (docs/provider-stalls.md).
 *
 * A supervised call that was sent but got no reply, or that stopped before the provider reported
 * how much it used, ends `uncertain`: its whole reservation stays charged against the budgets
 * (`provider_spend_ledger` row `uncertain`, not settled). Core never guesses the amount and never
 * releases it on a timer, because the provider may have billed for it. Once nothing can settle it
 * any more (its gateway receipt is final and uncertain, or none was recorded and the run's last
 * possible step is long past), a workspace owner or administrator sees it in AI services /
 * Spending with what happened, checks the provider's own usage page, and settles it:
 * - at zero: the reservation is released to the workspace and learner budgets (through the job's
 *   normal settle transition, so the job's accounting and the budgets stay equal); a job still
 *   waiting for that call ends;
 * - at the reservation: it stays charged, and is no longer held.
 * The ledger row is then closed, still `uncertain` (the provider's outcome is still unknown), the
 * decision is stored (provider_spend_resolutions, migration 121) and written to the workspace
 * audit log (`provider.spend_settled`). Nothing is ever settled without that request.
 */
const SETTLE_AFTER_MS = 10 * 60_000;
const MAX_LISTED = 100;
type Happened = 'no_response' | 'stopped' | 'stalled' | 'service_error' | 'no_receipt';
interface Row {
  id: string; reserved_at: Date; role: string; reserved: string; operation_id: string; attempt: number; enrollment_id: string | null;
  job_id: string | null; job_state: string | null; generation: number | null; op: Snapshot['operations'][number] | null;
  dispatch_state: string | null; dispatch_owner: string | null; failure_code: string | null; provider_usage: unknown; model_id: string | null;
  finished_at: Date | null; now: Date;
}
/** Open uncertain calls of runs Core still holds (their job and operation are recorded). The
 * spending view's "held" total also counts any other open reservation. */
const SELECT = `SELECT l.id,l.reserved_at,l.role,l.reserved_micro_usd::text AS reserved,l.source_ref AS operation_id,l.attempt,l.enrollment_id,
    j.id AS job_id,j.state AS job_state,(j.runtime_snapshot->>'generation')::integer AS generation,o.value AS op,
    d.state AS dispatch_state,d.owner_id::text AS dispatch_owner,d.failure_code,d.provider_usage,COALESCE(d.model_id,l.model_id) AS model_id,d.finished_at,
    clock_timestamp() AS now
  FROM provider_spend_ledger l
  LEFT JOIN supervisor_jobs j ON l.source_ref ~ '^[0-9a-f-]{36}/' AND j.id=split_part(l.source_ref,'/',1)::uuid AND j.workspace_id=l.workspace_id
    AND j.enrollment_id=l.enrollment_id
  LEFT JOIN LATERAL (SELECT value FROM jsonb_array_elements(COALESCE(j.runtime_snapshot->'operations','[]'::jsonb)) WHERE value->>'id'=l.source_ref LIMIT 1) o ON true
  LEFT JOIN provider_dispatches d ON d.operation_id=l.source_ref AND d.job_id=j.id
  WHERE l.workspace_id=$1 AND l.source='supervisor' AND l.state='uncertain' AND l.settled_at IS NULL AND o.value IS NOT NULL`;

/** What happened to the call, from the gateway receipt: codes only, never provider text. */
function happened(row: Row): Happened {
  if (!row.dispatch_state) return 'no_receipt';
  if (row.failure_code === 'JOB_CANCELLED') return 'stopped';
  if (row.failure_code === 'STREAM_STALLED') return 'stalled';
  const attempts = (row.provider_usage as { attempts?: { status?: unknown; outcome?: unknown }[] } | null)?.attempts;
  // Nothing came back at all: not even a status (an older Core recorded this as CANCELLED or TIMEOUT).
  if (row.failure_code === 'NO_RESPONSE' || (Array.isArray(attempts) && attempts.length > 0 && attempts.every(a => a?.status === null && a?.outcome === 'unknown')))
    return 'no_response';
  return 'service_error';
}
/** Whether nothing but an owner can settle the call now: its run recorded it as uncertain, and its
 * gateway receipt is final and uncertain, or there is none and the run's last step is long past. */
function settleable(row: Row) {
  const op = row.op;
  if (!row.job_id || !op || op.status !== 'uncertain' || op.attempt !== row.attempt || row.generation === null) return false;
  if (!row.dispatch_state) return row.now.getTime() - row.reserved_at.getTime() >= SETTLE_AFTER_MS;
  return row.dispatch_state === 'uncertain' && row.dispatch_owner === op.ownerId && row.finished_at !== null;
}
function view(row: Row) {
  return { id: row.id, reservedAt: row.reserved_at.toISOString(), role: row.role, modelId: row.model_id, reservedMicroUsd: Number(row.reserved),
    enrollmentId: row.enrollment_id, happened: happened(row), settleable: settleable(row) };
}

const settleSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  decision: z.enum(['zero', 'reservation']),
  /** The amount the person saw held, so a decision is never made on a changed row. */
  expectedReservedMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(3).max(500).refine(v => !/[\u0000-\u001f\u007f]/.test(v)),
});
type Settled = { ledgerId: string; decision: 'zero' | 'reservation'; chargedMicroUsd: number; releasedMicroUsd: number; settledAt: string };

export function registerProviderSpendResolutionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = '/api/admin/workspaces/:workspaceId/provider-spend/uncertain';
  const params = { type: 'object', additionalProperties: false, required: ['workspaceId'], properties: { workspaceId: { type: 'string', format: 'uuid' } } };
  app.get(base, { schema: { params }, logLevel: 'silent' }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    await workspaceRole(db, actor, workspaceId, ['owner', 'admin']);
    const rows = (await db.query<Row>(`${SELECT} ORDER BY l.reserved_at DESC,l.id LIMIT ${MAX_LISTED + 1}`, [workspaceId])).rows;
    const held = (await db.query<{ calls: number; held: string }>(`SELECT count(*)::int AS calls,COALESCE(sum(t.reserved::bigint),0)::text AS held FROM (${SELECT}) t`,
      [workspaceId])).rows[0]!;
    // Each decision names its call (the job and when it was sent), as the list of calls does.
    const recent = (await db.query<{ ledger_id: string; decision: 'zero' | 'reservation'; reserved: string; charged: string; released: string; reason: string;
      created_at: Date; actor: string | null; role: string | null; reserved_at: Date | null }>(`SELECT r.ledger_id,r.decision,r.reserved_micro_usd::text AS reserved,
        r.charged_micro_usd::text AS charged,r.released_micro_usd::text AS released,r.reason,r.created_at,u.display_name AS actor,l.role,l.reserved_at
      FROM provider_spend_resolutions r LEFT JOIN app_users u ON u.id=r.actor_id
      LEFT JOIN provider_spend_ledger l ON l.id=r.ledger_id AND l.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 ORDER BY r.created_at DESC,r.id LIMIT 10`, [workspaceId])).rows;
    return { currency: 'USD' as const, calls: rows.slice(0, MAX_LISTED).map(view), more: rows.length > MAX_LISTED,
      uncertainCalls: held.calls, heldMicroUsd: Number(held.held), settleAfterMinutes: SETTLE_AFTER_MS / 60_000,
      recent: recent.map(r => ({ ledgerId: r.ledger_id, decision: r.decision, reservedMicroUsd: Number(r.reserved), chargedMicroUsd: Number(r.charged),
        releasedMicroUsd: Number(r.released), reason: r.reason, decidedAt: r.created_at.toISOString(), decidedBy: r.actor,
        role: r.role, reservedAt: r.reserved_at?.toISOString() ?? null })) };
  });
  app.post(`${base}/:ledgerId/settle`, { schema: { params: { type: 'object', additionalProperties: false, required: ['workspaceId', 'ledgerId'],
    properties: { workspaceId: { type: 'string', format: 'uuid' }, ledgerId: { type: 'string', format: 'uuid' } } } }, bodyLimit: 4096, logLevel: 'silent' }, async request => {
    const actor = await auth.authenticate(request), { workspaceId, ledgerId } = request.params as { workspaceId: string; ledgerId: string };
    const parsed = settleSchema.safeParse(request.body);
    requireCondition(parsed.success, 'PROVIDER_SPEND_SETTLE_INVALID', 400);
    const input = parsed.data;
    await workspaceRole(db, actor, workspaceId, ['owner', 'admin']);
    const digest = digestJson({ kind: 'provider_spend_settle', workspaceId, ledgerId, ...input });
    // The job's settle records its spend telemetry once this commits.
    return afterCommitTransaction(db, async client => {
      // Membership again inside the transaction: a role removed meanwhile cannot settle money.
      await workspaceRole(client, actor, workspaceId, ['owner', 'admin']);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider-spend-settle:${workspaceId}`]);
      const earlier = (await client.query<{ ledger_id: string; request_digest: string; decision: 'zero' | 'reservation'; charged: string; released: string; created_at: Date }>(
        `SELECT ledger_id,request_digest,decision,charged_micro_usd::text AS charged,released_micro_usd::text AS released,created_at FROM provider_spend_resolutions
         WHERE workspace_id=$1 AND (idempotency_key=$2 OR ledger_id=$3) ORDER BY (idempotency_key=$2) DESC LIMIT 1`, [workspaceId, input.idempotencyKey, ledgerId])).rows[0];
      if (earlier) {
        // The same request again answers with its decision; any other request about a settled call is refused.
        requireCondition(earlier.request_digest === digest, earlier.ledger_id === ledgerId ? 'PROVIDER_SPEND_ALREADY_SETTLED' : 'IDEMPOTENCY_CONFLICT', 409);
        return { ledgerId, decision: earlier.decision, chargedMicroUsd: Number(earlier.charged), releasedMicroUsd: Number(earlier.released),
          settledAt: earlier.created_at.toISOString() } satisfies Settled;
      }
      const row = (await client.query<Row>(`${SELECT} AND l.id=$2`, [workspaceId, ledgerId])).rows[0];
      requireCondition(row, 'PROVIDER_SPEND_CALL_NOT_FOUND', 404);
      requireCondition(Number(row.reserved) === input.expectedReservedMicroUsd, 'STALE_PROVIDER_SPEND_CALL', 409);
      requireCondition(settleable(row), 'PROVIDER_SPEND_STILL_SETTLING', 409);
      const reserved = Number(row.reserved), op = row.op!;
      const ref = runRefSchema.parse({ jobId: row.job_id, workspaceId, enrollmentId: row.enrollment_id, generation: row.generation });
      if (input.decision === 'zero') {
        // The job's own settle transition (under its locks, in the canonical order) releases the
        // reservation from both budgets and the job's spend; the ledger row it closes as a
        // non-start is relabelled below, since the provider's outcome is still unknown.
        await transitionWithin(client, { type: 'settle', ref, operationId: row.operation_id, ownerId: op.ownerId, outcome: { status: 'not_started', retryable: false } });
        const closed = await client.query(`UPDATE provider_spend_ledger SET state='uncertain' WHERE id=$1 AND state='not_started' AND charged_micro_usd=0
          AND released_micro_usd=reserved_micro_usd AND settled_at IS NOT NULL`, [ledgerId]);
        requireCondition(closed.rowCount === 1, 'PROVIDER_SPEND_STILL_SETTLING', 409);
      } else {
        // Kept charged: the job's accounting already holds the reservation; only the hold ends.
        await lockJob(client, ref.jobId);
        const closed = await client.query(`UPDATE provider_spend_ledger SET settled_at=clock_timestamp() WHERE id=$1 AND state='uncertain' AND settled_at IS NULL
          AND charged_micro_usd=reserved_micro_usd`, [ledgerId]);
        requireCondition(closed.rowCount === 1, 'PROVIDER_SPEND_STILL_SETTLING', 409);
      }
      const charged = input.decision === 'zero' ? 0 : reserved, released = reserved - charged;
      const settledAt = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      await client.query(`INSERT INTO provider_spend_resolutions(id,ledger_id,workspace_id,decision,reserved_micro_usd,charged_micro_usd,released_micro_usd,reason,actor_id,
          idempotency_key,request_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(), ledgerId, workspaceId, input.decision, reserved, charged, released, input.reason, actor.id, input.idempotencyKey, digest, settledAt]);
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'provider.spend_settled',
        payload: { ledgerId, operationId: row.operation_id, jobId: row.job_id, role: row.role, happened: happened(row), decision: input.decision,
          reservedMicroUsd: reserved, chargedMicroUsd: charged, releasedMicroUsd: released, reason: input.reason },
        idempotencyKey: `provider-spend-settle:${ledgerId}`, supervise: false });
      return { ledgerId, decision: input.decision, chargedMicroUsd: charged, releasedMicroUsd: released, settledAt: settledAt.toISOString() } satisfies Settled;
    });
  });
}
async function lockJob(client: PoolClient, jobId: string) {
  await client.query('SELECT 1 FROM supervisor_jobs WHERE id=$1 FOR UPDATE', [jobId]);
}
