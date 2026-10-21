import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { modelPricingSchema, pricingCovers, MAX_MICRO_USD_PER_MILLION_TOKENS, MAX_MICRO_USD_PER_UNIT, type ModelPricing } from '@course-core/providers';
import type { Snapshot } from '@course-core/supervisor';
import type { authService } from './auth.js';
import { workspaceRole } from './course-access.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { digestJson } from './repository.js';
import type { AgentRole, ProviderRuntime } from './provider-runtime.js';
import { telemetry } from './telemetry.js';
import { composeProviders } from './provider-composition.js';
import { PRICE_TABLE_CHECKED, suggestedPrice } from './price-table.js';

/**
 * Operator-entered model pricing, the workspace rule for unpriced paid work, and the
 * reserved-versus-actual spend ledger. Every price in force was entered (or confirmed) by a
 * workspace owner or administrator with a source note. The bundled, dated table in
 * price-table.ts only suggests values for the admin page to prefill; it never prices a call.
 */
type Queryable = Database | PoolClient;
interface PriceRow {
  id: string; model_id: string; version: number; status: 'active' | 'withdrawn'; currency: 'USD';
  input_micro_usd_per_million: string | null; output_micro_usd_per_million: string | null;
  cached_input_micro_usd_per_million: string | null; micro_usd_per_request: string | null;
  micro_usd_per_output_second: string | null; micro_usd_per_server_tool_request: string | null; effective_from: Date; source_note: string; created_at: Date;
}
const num = (value: string | null) => value === null ? null : Number(value);
function pricingOf(row: PriceRow): ModelPricing {
  return { versionId: row.id, currency: row.currency, inputMicroUsdPerMillionTokens: num(row.input_micro_usd_per_million),
    outputMicroUsdPerMillionTokens: num(row.output_micro_usd_per_million), cachedInputMicroUsdPerMillionTokens: num(row.cached_input_micro_usd_per_million),
    microUsdPerRequest: num(row.micro_usd_per_request), microUsdPerOutputSecond: num(row.micro_usd_per_output_second),
    microUsdPerServerToolRequest: num(row.micro_usd_per_server_tool_request) };
}
function versionView(row: PriceRow) {
  const p = pricingOf(row);
  return { id: row.id, version: row.version, status: row.status, currency: row.currency,
    inputMicroUsdPerMillionTokens: p.inputMicroUsdPerMillionTokens, outputMicroUsdPerMillionTokens: p.outputMicroUsdPerMillionTokens,
    cachedInputMicroUsdPerMillionTokens: p.cachedInputMicroUsdPerMillionTokens, microUsdPerRequest: p.microUsdPerRequest,
    microUsdPerOutputSecond: p.microUsdPerOutputSecond, microUsdPerServerToolRequest: p.microUsdPerServerToolRequest ?? null, effectiveFrom: row.effective_from.toISOString(), sourceNote: row.source_note,
    createdAt: row.created_at.toISOString() };
}
const IN_FORCE = `SELECT * FROM provider_model_prices WHERE workspace_id=$1 AND model_id=$2 AND effective_from<=clock_timestamp()
  ORDER BY effective_from DESC,version DESC LIMIT 1`;
/** The active price version in force now, or null when the model is unpriced or withdrawn. */
export async function pricingInForce(client: Queryable, workspaceId: string, modelId: string): Promise<ModelPricing | null> {
  const row = (await client.query<PriceRow>(IN_FORCE, [workspaceId, modelId])).rows[0];
  return row && row.status === 'active' ? pricingOf(row) : null;
}
/** Default true: paid work needs an operator price for the bound model. */
export async function requiresPricing(client: Queryable, workspaceId: string) {
  const row = (await client.query<{ require_priced_models: boolean }>('SELECT require_priced_models FROM workspace_cost_settings WHERE workspace_id=$1', [workspaceId])).rows[0];
  return row ? row.require_priced_models : true;
}
export type PricingDecision = { admit: true; pricing: ModelPricing | null; modelId: string | null } | { admit: false; modelId: string | null };
/** Admission rule for one role call: priced, or unpriced while the workspace allows conservative charging. */
export async function pricingDecision(client: Queryable, workspaceId: string, runtime: ProviderRuntime, role: AgentRole): Promise<PricingDecision> {
  const bound = runtime.roleModels()[role];
  const found = bound ? await pricingInForce(client, workspaceId, bound.modelId) : null;
  const pricing = found && bound && pricingCovers(found, bound.pricingKind) ? found : null;
  if (pricing) return { admit: true, pricing, modelId: bound!.modelId };
  if (await requiresPricing(client, workspaceId)) return { admit: false, modelId: bound?.modelId ?? null };
  return { admit: true, pricing: null, modelId: bound?.modelId ?? null };
}
/** Availability as seen by the worker: a ready role without a required price is reported as
 * configuration_missing, so the run waits before anything is reserved or sent. */
export async function pricedStatus(client: Queryable, workspaceId: string, runtime: ProviderRuntime) {
  const status = runtime.status();
  for (const role of Object.keys(status) as AgentRole[]) {
    if (status[role]?.status !== 'ready') continue;
    if (!(await pricingDecision(client, workspaceId, runtime, role)).admit) status[role] = { status: 'configuration_missing' };
  }
  return status;
}

// ---- Spend ledger ----
export interface SpendEvent { kind: 'reserved' | 'released' | 'actual'; role: string; microUsd: number; modelId: string | null; basis: 'reported' | 'reserved_ceiling' }
/** Mirrors the budget effect of one supervisor transition. The budgets themselves move by the
 * snapshot accounting difference in the same transaction, so this never charges twice:
 * every update is guarded by the row's open state (never settled). A row data erasure closed
 * (`uncertain`, settled at its reservation) is final. */
export async function syncSupervisorSpend(client: PoolClient, old: Snapshot, next: Snapshot): Promise<SpendEvent[]> {
  const key = next.specification.key, role = next.specification.role, events: SpendEvent[] = [];
  for (const op of next.operations) {
    const before = old.operations.find(o => o.id === op.id);
    if (op.status === 'in_flight' && (!before || before.attempt !== op.attempt || before.status !== 'in_flight')) {
      const inserted = await client.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,state,reserved_micro_usd,reserved_tokens,charged_micro_usd)
        VALUES($1,'supervisor',$2,$3,$4,$5,$6,'reserved',$7,$8,$7) ON CONFLICT DO NOTHING`,
        [randomUUID(), op.id, op.attempt, key.workspaceId, key.enrollmentId, role, op.reservation.microUsd, op.reservation.tokens]);
      if (inserted.rowCount) events.push({ kind: 'reserved', role, microUsd: op.reservation.microUsd, modelId: null, basis: 'reserved_ceiling' });
      continue;
    }
    if (before?.status === op.status && before.attempt === op.attempt) continue;
    if (op.status === 'uncertain') {
      await client.query("UPDATE provider_spend_ledger SET state='uncertain' WHERE source='supervisor' AND source_ref=$1 AND attempt=$2 AND state='reserved' AND settled_at IS NULL", [op.id, op.attempt]);
      continue;
    }
    if (op.status === 'not_started') {
      const released = await client.query<{ reserved_micro_usd: string }>(`UPDATE provider_spend_ledger SET state='not_started',charged_micro_usd=0,released_micro_usd=reserved_micro_usd,settled_at=clock_timestamp()
        WHERE source='supervisor' AND source_ref=$1 AND attempt=$2 AND state IN('reserved','uncertain') AND settled_at IS NULL RETURNING reserved_micro_usd`, [op.id, op.attempt]);
      if (released.rows[0]) events.push({ kind: 'released', role, microUsd: Number(released.rows[0].reserved_micro_usd), modelId: null, basis: 'reported' });
      continue;
    }
    if (op.status === 'succeeded' && op.outcome?.status === 'succeeded') {
      const charged = op.outcome.usage.microUsd, basis = op.outcome.usageBasis?.microUsd ?? 'reported';
      const dispatch = (await client.query<{ model_id: string | null; pricing_version_id: string | null; cost_micro_usd: string | null }>(
        'SELECT model_id,pricing_version_id,cost_micro_usd FROM provider_dispatches WHERE operation_id=$1 AND job_id=$2', [op.id, key.jobId])).rows[0];
      const reconciled = basis === 'reported' && dispatch?.pricing_version_id && Number(dispatch.cost_micro_usd) === charged;
      const settled = await client.query<{ reserved_micro_usd: string }>(`UPDATE provider_spend_ledger SET state=$3,model_id=$4,pricing_version_id=$5,actual_micro_usd=$6,charged_micro_usd=$7,
          released_micro_usd=GREATEST(0,reserved_micro_usd-$7),settled_at=clock_timestamp()
        WHERE source='supervisor' AND source_ref=$1 AND attempt=$2 AND state IN('reserved','uncertain') AND settled_at IS NULL RETURNING reserved_micro_usd`,
        [op.id, op.attempt, reconciled ? 'reconciled' : 'unpriced', dispatch?.model_id ?? null, reconciled ? dispatch!.pricing_version_id : null, reconciled ? charged : null, charged]);
      const row = settled.rows[0];
      if (row) {
        const modelId = dispatch?.model_id ?? null, released = Math.max(0, Number(row.reserved_micro_usd) - charged);
        if (reconciled) events.push({ kind: 'actual', role, microUsd: charged, modelId, basis: 'reported' });
        if (released > 0) events.push({ kind: 'released', role, microUsd: released, modelId, basis: 'reported' });
      }
    }
  }
  return events;
}
/** Emitted only after the transaction that wrote them commits. */
export function recordSpendEvents(events: readonly SpendEvent[]) {
  const runtime = telemetry();
  if (!runtime.enabled) return;
  for (const event of events) {
    const attributes = { 'course.supervisor.role': event.role, 'gen_ai.request.model': event.modelId, 'course.cost.basis': event.basis };
    runtime.count(event.kind === 'reserved' ? 'course.provider.cost.reserved' : event.kind === 'released' ? 'course.provider.cost.released' : 'course.provider.cost.actual', event.microUsd, attributes);
  }
}

// ---- Admin routes ----
const rate = (max: number) => z.number().int().min(0).max(max).nullable();
const priceInputSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  modelId: z.string().min(1).max(2048),
  expectedVersion: z.number().int().min(0).max(1_000_000),
  status: z.enum(['active', 'withdrawn']),
  currency: z.literal('USD'),
  inputMicroUsdPerMillionTokens: rate(MAX_MICRO_USD_PER_MILLION_TOKENS),
  outputMicroUsdPerMillionTokens: rate(MAX_MICRO_USD_PER_MILLION_TOKENS),
  cachedInputMicroUsdPerMillionTokens: rate(MAX_MICRO_USD_PER_MILLION_TOKENS),
  microUsdPerRequest: rate(MAX_MICRO_USD_PER_UNIT),
  microUsdPerOutputSecond: rate(MAX_MICRO_USD_PER_UNIT),
  /** Optional for clients that predate it; absent is no price. */
  microUsdPerServerToolRequest: rate(MAX_MICRO_USD_PER_UNIT).optional(),
  effectiveFrom: z.iso.datetime({ offset: true }),
  sourceNote: z.string().trim().min(3).max(500).refine(v => !/[\u0000-\u001f\u007f]/.test(v)),
});
const settingsInputSchema = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  expectedRevision: z.number().int().min(0),
  requirePricing: z.boolean(),
  /** Turning the rule off needs an explicit statement that unpriced calls keep the full allowance. */
  acknowledgeConservativeCharge: z.boolean().optional(),
});
const spendQuerySchema = z.strictObject({
  period: z.enum(['day', 'month']).default('day'),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
const DAY = 86_400_000;
function spendWindow(query: z.infer<typeof spendQuerySchema>, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = query.to ? Date.parse(`${query.to}T00:00:00Z`) + DAY : today + DAY;
  const from = query.from ? Date.parse(`${query.from}T00:00:00Z`)
    : query.period === 'day' ? to - 30 * DAY : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1);
  requireCondition(Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= (query.period === 'day' ? 93 : 1100) * DAY, 'PROVIDER_SPEND_RANGE_INVALID', 400);
  return { from: new Date(from), to: new Date(to) };
}
const SUMS = `count(*)::int AS calls,COALESCE(sum(reserved_micro_usd),0)::text AS reserved,COALESCE(sum(charged_micro_usd),0)::text AS charged,
  COALESCE(sum(actual_micro_usd),0)::text AS actual,COALESCE(sum(released_micro_usd),0)::text AS released,
  COALESCE(sum(charged_micro_usd) FILTER (WHERE state IN('reserved','uncertain') AND settled_at IS NULL),0)::text AS held,
  COALESCE(sum(charged_micro_usd) FILTER (WHERE state='unpriced'),0)::text AS unpriced,
  (count(*) FILTER (WHERE state='uncertain'))::int AS uncertain`;

/** The open setup draft composed for pricing questions only (no credential is read). */
async function draftRuntime(db: Database, workspaceId: string) {
  const row = (await db.query<{ configuration: unknown }>('SELECT configuration FROM provider_setup_drafts WHERE workspace_id=$1', [workspaceId])).rows[0];
  if (!row) return null;
  try { return composeProviders(row.configuration, () => 'pricing-only'); } catch { return null; }
}
/** Model id -> provider kind and listed model name, from the active setup and the open draft. */
async function modelOrigins(db: Database, workspaceId: string) {
  const rows = (await db.query<{ configuration: unknown }>(
    `SELECT v.configuration FROM workspace_provider_settings s JOIN workspace_provider_versions v USING(workspace_id,revision) WHERE s.workspace_id=$1
     UNION ALL SELECT configuration FROM provider_setup_drafts WHERE workspace_id=$1`, [workspaceId])).rows;
  const origins = new Map<string, { kind: string; remoteModel: string }>();
  for (const { configuration } of rows) {
    const value = configuration as { registry?: { models?: { id?: unknown; providerId?: unknown; remoteModel?: unknown }[] }; adapters?: { id?: unknown; kind?: unknown }[] };
    for (const model of Array.isArray(value?.registry?.models) ? value.registry.models : []) {
      const kind = value.adapters?.find((a) => a.id === model.providerId)?.kind;
      if (typeof model.id === 'string' && typeof model.remoteModel === 'string' && typeof kind === 'string')
        origins.set(model.id, { kind, remoteModel: model.remoteModel });
    }
  }
  return origins;
}
/** Every bound model with its role and pricing kind, including an image model bound beside a video model (role media). */
function boundRoles(runtime: ProviderRuntime) {
  const rows = Object.entries(runtime.roleModels()).flatMap(([role, b]) => b ? [{ role, modelId: b.modelId, pricingKind: b.pricingKind }] : []);
  for (const media of runtime.mediaModels())
    if (!rows.some(r => r.modelId === media.modelId)) rows.push({ role: 'media', modelId: media.modelId, pricingKind: 'tokens' as const });
  return rows;
}
export type RuntimeResolver = (workspaceId: string, client?: PoolClient) => Promise<ProviderRuntime>;
export function registerProviderCostRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, resolve: RuntimeResolver) {
  const base = '/api/admin/workspaces/:workspaceId/provider-pricing';
  const params = { type: 'object', additionalProperties: false, required: ['workspaceId'], properties: { workspaceId: { type: 'string', format: 'uuid' } } };
  async function view(workspaceId: string) {
    const runtime = await resolve(workspaceId), roles = boundRoles(runtime);
    const configured = runtime.describe().map(m => m.id);
    // Models of the open setup draft can be priced before the draft is activated.
    const draft = await draftRuntime(db, workspaceId), draftRoles = draft ? boundRoles(draft) : [];
    const draftModels = (draft?.describe().map(m => m.id) ?? []).filter(id => draftRoles.some(b => b.modelId === id));
    const history = (await db.query<PriceRow>(`SELECT * FROM (SELECT p.*,row_number() OVER (PARTITION BY model_id ORDER BY version DESC) AS n
      FROM provider_model_prices p WHERE workspace_id=$1) h WHERE n<=20 ORDER BY model_id,version DESC`, [workspaceId])).rows;
    const settings = (await db.query<{ require_priced_models: boolean; revision: number }>('SELECT require_priced_models,revision FROM workspace_cost_settings WHERE workspace_id=$1', [workspaceId])).rows[0];
    const requirePricing = settings ? settings.require_priced_models : true;
    const ids = [...new Set([...configured, ...draftModels, ...history.map(r => r.model_id)])].slice(0, 50);
    const origins = await modelOrigins(db, workspaceId), now = new Date();
    const models = [];
    for (const modelId of ids) {
      const inForce = (await db.query<PriceRow>(IN_FORCE, [workspaceId, modelId])).rows[0];
      const active = roles.filter(b => b.modelId === modelId).map(({ role, pricingKind }) => ({ role, pricingKind }));
      const bound = active.length ? active : draftRoles.filter(b => b.modelId === modelId).map(({ role, pricingKind }) => ({ role, pricingKind }));
      const rows = history.filter(r => r.model_id === modelId);
      models.push({ modelId, configured: configured.includes(modelId), draft: draftModels.includes(modelId), roles: bound.map(b => b.role),
        inForce: inForce ? versionView(inForce) : null, latestVersion: rows[0]?.version ?? 0,
        coverage: bound.map(b => ({ role: b.role, priced: !!inForce && inForce.status === 'active' && pricingCovers(pricingOf(inForce), b.pricingKind),
          // Research models may report web searches billed per request (Anthropic does); without
          // that price such a call stays unpriced and keeps its full reservation.
          ...(b.role === 'research' ? { serverToolsUnpriced: !inForce || inForce.status !== 'active' || inForce.micro_usd_per_server_tool_request === null } : {}) })),
        history: rows.map(versionView),
        // From the bundled price table: a suggestion to confirm, never a price in force.
        suggested: origins.has(modelId) ? suggestedPrice(origins.get(modelId)!.kind, origins.get(modelId)!.remoteModel, now) : null });
    }
    return { requirePricing, settingsRevision: settings?.revision ?? 0, models, currency: 'USD' as const,
      units: { tokens: 'micro-USD per million tokens', request: 'micro-USD per request', outputSecond: 'micro-USD per output second',
        serverToolRequest: 'micro-USD per server tool request' },
      builtInPrices: false as const, suggestedPricesCheckedOn: PRICE_TABLE_CHECKED };
  }
  app.get(base, { schema: { params }, logLevel: 'silent' }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    await workspaceRole(db, actor, workspaceId, ['owner', 'admin']);
    return view(workspaceId);
  });
  async function receipt(client: PoolClient, workspaceId: string, actorId: string, key: string, digest: string) {
    const member = (await client.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE', [workspaceId, actorId])).rows[0];
    requireCondition(member && ['owner', 'admin'].includes(member.role), 'FORBIDDEN', 403);
    const old = (await client.query('SELECT request_digest,result FROM provider_setup_receipts WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, key])).rows[0];
    if (old) requireCondition(old.request_digest === digest, 'IDEMPOTENCY_CONFLICT', 409);
    return old?.result as unknown;
  }
  app.post(base, { schema: { params }, bodyLimit: 8192, logLevel: 'silent' }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    const parsed = priceInputSchema.safeParse(request.body);
    requireCondition(parsed.success, 'PROVIDER_PRICING_INVALID', 400);
    const input = parsed.data;
    const prices = { inputMicroUsdPerMillionTokens: input.inputMicroUsdPerMillionTokens, outputMicroUsdPerMillionTokens: input.outputMicroUsdPerMillionTokens,
      cachedInputMicroUsdPerMillionTokens: input.cachedInputMicroUsdPerMillionTokens, microUsdPerRequest: input.microUsdPerRequest, microUsdPerOutputSecond: input.microUsdPerOutputSecond,
      microUsdPerServerToolRequest: input.microUsdPerServerToolRequest ?? null };
    if (input.status === 'active') requireCondition(modelPricingSchema.safeParse({ versionId: 'draft', currency: input.currency, ...prices }).success, 'PROVIDER_PRICING_INVALID', 400);
    else requireCondition(Object.values(prices).every(v => v === null), 'PROVIDER_PRICING_INVALID', 400);
    const effectiveFrom = new Date(input.effectiveFrom);
    await workspaceRole(db, actor, workspaceId, ['owner', 'admin']);
    const configured = (await resolve(workspaceId)).describe().some(m => m.id === input.modelId)
      || !!(await draftRuntime(db, workspaceId))?.describe().some(m => m.id === input.modelId);
    const digest = digestJson({ kind: 'provider_pricing', workspaceId, ...input });
    return transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider-pricing:${workspaceId}`]);
      const cached = await receipt(client, workspaceId, actor.id, input.idempotencyKey, digest);
      if (cached) return cached;
      const latest = (await client.query<PriceRow>('SELECT * FROM provider_model_prices WHERE workspace_id=$1 AND model_id=$2 ORDER BY version DESC LIMIT 1', [workspaceId, input.modelId])).rows[0];
      requireCondition(configured || latest, 'PROVIDER_PRICING_UNKNOWN_MODEL', 404);
      requireCondition((latest?.version ?? 0) === input.expectedVersion, 'STALE_PROVIDER_PRICING_VERSION', 409);
      requireCondition(input.status === 'active' || (latest && latest.status === 'active'), 'PROVIDER_PRICING_INVALID', 400);
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      // Never earlier than the version it replaces: the order of versions is the order in force.
      requireCondition((!latest || effectiveFrom >= latest.effective_from) && effectiveFrom.getTime() <= now.getTime() + 366 * DAY
        && effectiveFrom.getTime() >= now.getTime() - 3660 * DAY, 'PROVIDER_PRICING_EFFECTIVE_DATE_INVALID', 400);
      const id = randomUUID(), version = (latest?.version ?? 0) + 1;
      await client.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,
          cached_input_micro_usd_per_million,micro_usd_per_request,micro_usd_per_output_second,micro_usd_per_server_tool_request,effective_from,source_note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, workspaceId, input.modelId, version, input.status, input.currency, prices.inputMicroUsdPerMillionTokens, prices.outputMicroUsdPerMillionTokens,
          prices.cachedInputMicroUsdPerMillionTokens, prices.microUsdPerRequest, prices.microUsdPerOutputSecond, prices.microUsdPerServerToolRequest,
          effectiveFrom, input.sourceNote, actor.id]);
      const result = { id, modelId: input.modelId, version, status: input.status, effectiveFrom: effectiveFrom.toISOString(),
        inForceNow: effectiveFrom <= now, appliesToCallsAlreadyAdmitted: false as const };
      await client.query('INSERT INTO provider_setup_receipts(workspace_id,idempotency_key,request_digest,result,actor_id,operation) VALUES($1,$2,$3,$4,$5,$6)',
        [workspaceId, input.idempotencyKey, digest, JSON.stringify(result), actor.id, 'pricing']);
      return result;
    });
  });
  app.post(base + '/settings', { schema: { params }, bodyLimit: 2048, logLevel: 'silent' }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    const parsed = settingsInputSchema.safeParse(request.body);
    requireCondition(parsed.success, 'PROVIDER_COST_SETTINGS_INVALID', 400);
    const input = parsed.data;
    requireCondition(input.requirePricing || input.acknowledgeConservativeCharge === true, 'PROVIDER_UNPRICED_ACKNOWLEDGEMENT_REQUIRED', 409);
    const digest = digestJson({ kind: 'provider_cost_settings', workspaceId, ...input });
    return transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider-pricing:${workspaceId}`]);
      const cached = await receipt(client, workspaceId, actor.id, input.idempotencyKey, digest);
      if (cached) return cached;
      const old = (await client.query<{ revision: number }>('SELECT revision FROM workspace_cost_settings WHERE workspace_id=$1 FOR UPDATE', [workspaceId])).rows[0];
      requireCondition((old?.revision ?? 0) === input.expectedRevision, 'STALE_PROVIDER_COST_SETTINGS', 409);
      const revision = input.expectedRevision + 1;
      await client.query(`INSERT INTO workspace_cost_settings(workspace_id,require_priced_models,revision,changed_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id) DO UPDATE SET require_priced_models=EXCLUDED.require_priced_models,revision=EXCLUDED.revision,changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp()`,
        [workspaceId, input.requirePricing, revision, actor.id]);
      const result = { revision, requirePricing: input.requirePricing, budgetsChanged: false as const };
      await client.query('INSERT INTO provider_setup_receipts(workspace_id,idempotency_key,request_digest,result,actor_id,operation) VALUES($1,$2,$3,$4,$5,$6)',
        [workspaceId, input.idempotencyKey, digest, JSON.stringify(result), actor.id, 'cost_settings']);
      return result;
    });
  });
  app.get('/api/admin/workspaces/:workspaceId/provider-spend', { schema: { params }, logLevel: 'silent' }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    await workspaceRole(db, actor, workspaceId, ['owner', 'admin']);
    const parsed = spendQuerySchema.safeParse(request.query ?? {});
    requireCondition(parsed.success, 'PROVIDER_SPEND_RANGE_INVALID', 400);
    const query = parsed.data, now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now, range = spendWindow(query, now);
    const args = [workspaceId, range.from, range.to];
    const where = 'workspace_id=$1 AND reserved_at>=$2 AND reserved_at<$3';
    const totals = (await db.query(`SELECT ${SUMS} FROM provider_spend_ledger WHERE ${where}`, args)).rows[0];
    const byRole = (await db.query(`SELECT role,${SUMS} FROM provider_spend_ledger WHERE ${where} GROUP BY role ORDER BY role`, args)).rows;
    const byEnrollment = (await db.query(`SELECT enrollment_id AS "enrollmentId",${SUMS} FROM provider_spend_ledger WHERE ${where}
      AND enrollment_id IS NOT NULL GROUP BY enrollment_id ORDER BY sum(charged_micro_usd) DESC,enrollment_id LIMIT 100`, args)).rows;
    const byPeriod = (await db.query(`SELECT to_char(date_trunc('${query.period}',reserved_at AT TIME ZONE 'UTC'),'${query.period === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM'}') AS period,${SUMS}
      FROM provider_spend_ledger WHERE ${where} GROUP BY 1 ORDER BY 1 DESC`, args)).rows;
    return { period: query.period, from: range.from.toISOString(), to: range.to.toISOString(), timeZone: 'UTC', currency: 'USD' as const,
      totals, byRole, byEnrollment, byPeriod, maximumEnrollments: 100,
      notes: { charged: 'What the budgets hold now: actual cost once reconciled, the full reservation while in flight, uncertain or unpriced.',
        held: 'Charged for calls not yet settled. A call closed by data erasure stays charged and uncertain but is no longer held.',
        notAnInvoice: true } };
  });
}
