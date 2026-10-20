import type { PoolClient } from 'pg';
import { outcomeSchema, snapshotSchema, type ProviderRequest, type Snapshot } from '@course-core/supervisor';
import { telemetry } from '@course-core/supervisor/telemetry';
import { digestJson } from './repository.js';
import type { SpendEvent } from './provider-costs.js';
import { lockPaidWorkBudgets } from './supervisor-bridge.js';

/**
 * Data erasure clears the supervisor job snapshot, which is what the bridge settles against, and
 * cancels the enrollment's media jobs. Before that, every reservation of the enrollment that is
 * still open (a `reserved` or `uncertain` ledger row with no settlement) is finished here, in the
 * erasure transaction, so it never stays held in the enrollment and workspace budgets:
 *
 * - work that certainly never ran is released in full (`not_started`);
 * - a supervisor call whose dispatch receipt records a completed outcome is settled at that
 *   recorded usage, exactly as the bridge would have settled it;
 * - a dispatch the gateway admitted but had not yet let past its last fence (`sent_at` unset,
 *   migration 042) can no longer be sent: its receipt becomes a certified refusal and the
 *   reservation is released;
 * - anything that may have run (in flight or uncertain) is closed at its reservation: the row
 *   stays `uncertain` and keeps the full allowance charged, but is settled, so nothing can
 *   settle it again and it no longer counts as an open hold.
 *
 * Idempotent: only unsettled rows are touched, each by a guarded update.
 */
export const ERASED_RECEIPT_CODE = 'ENROLLMENT_ERASED';
const OPEN = "state IN('reserved','uncertain') AND settled_at IS NULL";
const NOT_STARTED: { status: 'not_started'; retryable: false } = { status: 'not_started', retryable: false };

/** Advisory keys the gateway takes before admitting or certifying a supervisor operation. The
 * erasure transaction takes them before it locks the enrollment, as the gateway does. */
export async function openSupervisorOperationKeys(client: PoolClient, enrollmentId: string) {
  const rows = (await client.query<{ source_ref: string }>(
    `SELECT DISTINCT source_ref FROM provider_spend_ledger WHERE enrollment_id=$1 AND source='supervisor' AND ${OPEN} ORDER BY source_ref`, [enrollmentId])).rows;
  return rows.map(row => `provider:${row.source_ref}`);
}
export async function lockKeys(client: PoolClient, keys: readonly string[]) {
  for (const key of [...new Set(keys)].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

interface LedgerRow {
  id: string; source: 'supervisor' | 'media'; source_ref: string; attempt: number; role: string; model_id: string | null;
  reserved_micro_usd: string; reserved_tokens: string;
}
interface DispatchRow { owner_id: string; state: string; sent_at: Date | null; outcome: unknown; model_id: string | null; pricing_version_id: string | null; cost_micro_usd: string | null }
interface MediaRow { id: string; state: string; last_from: string | null }
type Operation = Snapshot['operations'][number];

export interface ErasedPaidWork {
  counts: { paidWorkReleased: number; paidWorkSettled: number; paidWorkClosedUncertain: number; paidWorkReleasedMicroUsd: number; paidWorkClosedMicroUsd: number };
  /** Media jobs whose reservation was released; their charge becomes zero once they are cancelled. */
  releasedMediaJobs: string[];
  /** Telemetry, emitted only after the erasure commits. */
  events: SpendEvent[];
}

/** Call after the enrollment row is locked and every supervisor job is terminal, before any
 * snapshot or media job is changed. Lock order as everywhere else: enrollment -> job rows ->
 * workspace budget -> enrollment budget; supervisor operations' advisory keys come first. */
export async function finalizeErasedPaidWork(client: PoolClient, enrollment: { id: string; workspace_id: string }): Promise<ErasedPaidWork> {
  const result: ErasedPaidWork = { counts: { paidWorkReleased: 0, paidWorkSettled: 0, paidWorkClosedUncertain: 0, paidWorkReleasedMicroUsd: 0, paidWorkClosedMicroUsd: 0 },
    releasedMediaJobs: [], events: [] };
  const jobs = (await client.query<{ id: string; runtime_snapshot: unknown }>(
    'SELECT id,runtime_snapshot FROM supervisor_jobs WHERE enrollment_id=$1 ORDER BY id FOR UPDATE', [enrollment.id])).rows;
  const media = (await client.query<MediaRow>(`SELECT m.id,m.state,(SELECT e.from_state FROM media_job_events e WHERE e.job_id=m.id ORDER BY e.id DESC LIMIT 1) AS last_from
    FROM media_jobs m WHERE m.enrollment_id=$1 ORDER BY m.id FOR UPDATE OF m`, [enrollment.id])).rows;
  const open = (await client.query<LedgerRow>(`SELECT id,source,source_ref,attempt,role,model_id,reserved_micro_usd,reserved_tokens FROM provider_spend_ledger
    WHERE enrollment_id=$1 AND ${OPEN} ORDER BY source,source_ref,attempt FOR UPDATE`, [enrollment.id])).rows;
  if (open.length === 0) return result;
  await lockPaidWorkBudgets(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id });

  const operations = new Map<string, { job: string; snapshot: Snapshot; operation: Operation }>();
  for (const job of jobs) {
    const parsed = snapshotSchema.safeParse(job.runtime_snapshot);
    if (parsed.success) for (const operation of parsed.data.operations) operations.set(operation.id, { job: job.id, snapshot: parsed.data, operation });
  }
  const mediaJobs = new Map(media.map(row => [row.id, row]));

  /** Moves the budgets and the job's spend total back by what this row no longer charges. */
  async function refund(row: LedgerRow, microUsd: number, tokens: number, job: string | null) {
    if (microUsd === 0 && tokens === 0) return;
    await client.query('UPDATE supervisor_workspace_budgets SET used_micro_usd=used_micro_usd-$2,used_tokens=used_tokens-$3 WHERE workspace_id=$1', [enrollment.workspace_id, microUsd, tokens]);
    await client.query('UPDATE supervisor_enrollment_budgets SET used_micro_usd=used_micro_usd-$2,used_tokens=used_tokens-$3 WHERE enrollment_id=$1 AND workspace_id=$4',
      [enrollment.id, microUsd, tokens, enrollment.workspace_id]);
    if (job) await client.query('UPDATE supervisor_job_spend SET micro_usd=GREATEST(0,micro_usd-$2),tokens=GREATEST(0,tokens-$3) WHERE job_id=$1', [job, microUsd, tokens]);
    if (microUsd > 0) result.events.push({ kind: 'released', role: row.role, microUsd, modelId: row.model_id, basis: 'reported' });
  }
  async function release(row: LedgerRow, job: string | null) {
    const done = await client.query(`UPDATE provider_spend_ledger SET state='not_started',charged_micro_usd=0,released_micro_usd=reserved_micro_usd,settled_at=clock_timestamp()
      WHERE id=$1 AND ${OPEN}`, [row.id]);
    if (!done.rowCount) return;
    const microUsd = Number(row.reserved_micro_usd);
    await refund(row, microUsd, Number(row.reserved_tokens), job);
    result.counts.paidWorkReleased += 1; result.counts.paidWorkReleasedMicroUsd += microUsd;
  }
  async function close(row: LedgerRow) {
    const done = await client.query(`UPDATE provider_spend_ledger SET state='uncertain',charged_micro_usd=reserved_micro_usd,released_micro_usd=0,settled_at=clock_timestamp()
      WHERE id=$1 AND ${OPEN}`, [row.id]);
    if (!done.rowCount) return;
    result.counts.paidWorkClosedUncertain += 1; result.counts.paidWorkClosedMicroUsd += Number(row.reserved_micro_usd);
  }
  /** The recorded completed outcome, settled as `syncSupervisorSpend` settles a succeeded operation. */
  async function settle(row: LedgerRow, job: string, dispatch: DispatchRow) {
    const parsed = outcomeSchema.safeParse(dispatch.outcome);
    const outcome = parsed.success && parsed.data.status === 'succeeded' ? parsed.data : null;
    const reserved = Number(row.reserved_micro_usd), reservedTokens = Number(row.reserved_tokens);
    if (!outcome || outcome.usage.microUsd > reserved || outcome.usage.tokens > reservedTokens) return close(row);
    const charged = outcome.usage.microUsd, basis = outcome.usageBasis?.microUsd ?? 'reported';
    const reconciled = basis === 'reported' && dispatch.pricing_version_id !== null && Number(dispatch.cost_micro_usd) === charged;
    const done = await client.query(`UPDATE provider_spend_ledger SET state=$2,model_id=$3,pricing_version_id=$4,actual_micro_usd=$5,charged_micro_usd=$6,
        released_micro_usd=GREATEST(0,reserved_micro_usd-$6),settled_at=clock_timestamp() WHERE id=$1 AND ${OPEN}`,
      [row.id, reconciled ? 'reconciled' : 'unpriced', dispatch.model_id, reconciled ? dispatch.pricing_version_id : null, reconciled ? charged : null, charged]);
    if (!done.rowCount) return;
    if (reconciled) result.events.push({ kind: 'actual', role: row.role, microUsd: charged, modelId: dispatch.model_id, basis: 'reported' });
    await refund({ ...row, model_id: dispatch.model_id }, reserved - charged, reservedTokens - outcome.usage.tokens, job);
    result.counts.paidWorkSettled += 1;
  }

  for (const row of open) {
    if (row.source === 'media') {
      // `requested`/`admitted` are only ever held, or left for an end state, while no submission
      // could have run (media-jobs.ts); every later state may have reached the provider.
      const job = mediaJobs.get(row.source_ref), unsent = ['requested', 'admitted'];
      const neverRan = job && (unsent.includes(job.state) || (['failed', 'cancelled'].includes(job.state) && job.last_from !== null && unsent.includes(job.last_from)));
      if (neverRan) { await release(row, null); result.releasedMediaJobs.push(job.id); }
      else await close(row);
      continue;
    }
    const found = operations.get(row.source_ref);
    if (!found || found.operation.attempt !== row.attempt) { await close(row); continue; }
    const { operation, snapshot, job } = found;
    // Re-entrant: normally already held from before the enrollment lock.
    await lockKeys(client, [`provider:${operation.id}`]);
    const dispatch = (await client.query<DispatchRow>(
      'SELECT owner_id,state,sent_at,outcome,model_id,pricing_version_id,cost_micro_usd FROM provider_dispatches WHERE operation_id=$1 FOR UPDATE', [operation.id])).rows[0];
    if (!dispatch) {
      // The gateway never admitted this attempt, and with the snapshot gone it never can. Record that
      // as the operation's certified refusal, keyed to the exact request the worker would send, so a
      // late first request replays it instead of finding nothing.
      const checkpoint = snapshot.specification.checkpoints.find(cp => cp.id === operation.checkpointId);
      if (checkpoint) {
        const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: snapshot.specification.key, role: snapshot.specification.role,
          checkpoint, fence: snapshot.specification.fence };
        await client.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,outcome,failure_code,finished_at,trace_id)
          VALUES ($1,$2,$3,$4,$5,$6,'not_started',$7,$8,now(),$9)`,
          [operation.id, job, enrollment.id, enrollment.workspace_id, operation.ownerId, digestJson(request), JSON.stringify(NOT_STARTED), ERASED_RECEIPT_CODE, telemetry().traceId()]);
      }
      await release(row, job);
    } else if (dispatch.owner_id !== operation.ownerId) {
      // A receipt from an earlier attempt: only a certified non-start lets a new owner reuse the
      // identity, and this attempt was never admitted under it.
      if (dispatch.state === 'not_started') await release(row, job); else await close(row);
    } else if (dispatch.state === 'not_started') await release(row, job);
    else if (dispatch.state === 'completed') await settle(row, job, dispatch);
    else if (dispatch.state === 'in_flight' && dispatch.sent_at === null) {
      // Admitted but not yet past the gateway's last fence, which needs the enrollment lock held
      // here and a live job: it can no longer be sent. Close the receipt as a certified refusal
      // (the sender then refuses too) and release the reservation once.
      await client.query(`UPDATE provider_dispatches SET state='not_started',outcome=$2,failure_code=$3,finished_at=now()
        WHERE operation_id=$1 AND state='in_flight' AND sent_at IS NULL`, [operation.id, JSON.stringify(NOT_STARTED), ERASED_RECEIPT_CODE]);
      await release(row, job);
    } else await close(row);
  }
  return result;
}
