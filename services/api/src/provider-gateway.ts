import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { definiteRejection, ProviderError, priceUsage, type ModelPricing, type ReceiptCost } from '@course-core/providers';
import { MAX_RETRY_AFTER_MS, outcomeSchema, providerRequestSchema, type Outcome, type ProviderRequest } from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { digestJson } from './repository.js';
import { resolveSupervisorOperation, storeSupervisorArtifact, type SupervisorArtifactContent } from './supervisor-bridge.js';
import { teachingContext } from './provider-context.js';
import type { ProviderRuntime } from './provider-runtime.js';
import {supervisorTools} from './supervisor-tools.js';
import type {WorkspaceProviders} from './provider-setup.js';
import { telemetry } from './telemetry.js';
import { pricedStatus, pricingDecision } from './provider-costs.js';

import type {AdaptationRuntime} from "./adaptation-store.js";

interface Options { adaptation?:AdaptationRuntime; serviceToken?: string; workspaceIds?: readonly string[]; maxConcurrent?: number;workspaceProviders?:WorkspaceProviders }
interface DispatchRow { request_digest: string; owner_id: string; state: string; outcome: Outcome | null }
export function registerProviderGateway(app: FastifyInstance, db: Database, runtime: ProviderRuntime, options: Options) {
  const expected = options.serviceToken ? createHash('sha256').update(options.serviceToken).digest() : null;
  const limit = options.maxConcurrent ?? 2; requireCondition(Number.isSafeInteger(limit) && limit >= 1 && limit <= 8, 'PROVIDER_INVALID_CONCURRENCY');
  let active = 0;
  function authorize(request: FastifyRequest) {
    requireCondition(expected, 'PROVIDER_UNCONFIGURED', 503);
    const header = request.headers.authorization, value = typeof header === 'string' && /^Bearer \S+$/.test(header) ? header.slice(7) : '';
    requireCondition(timingSafeEqual(expected, createHash('sha256').update(value).digest()), 'PROVIDER_UNAUTHENTICATED', 401);
  }
  app.get('/v1/capabilities',{schema:{querystring:{type:'object',additionalProperties:false,properties:{workspaceId:{type:'string',format:'uuid'}}}}}, async request => { authorize(request);const {workspaceId} = request.query as {workspaceId?:string};if(workspaceId){requireCondition(options.workspaceIds?.includes(workspaceId),'PROVIDER_FORBIDDEN',403);return pricedStatus(db,workspaceId,await options.workspaceProviders?.resolve(workspaceId)??runtime);}return runtime.status(); });
  app.post('/v1/operations', { bodyLimit: 262144, logLevel: 'silent' }, async (request, reply) => {
    authorize(request);
    const parsed = providerRequestSchema.safeParse(request.body);
    requireCondition(parsed.success, 'PROVIDER_INVALID_REQUEST');
    const body = parsed.data;
    requireCondition(options.workspaceIds?.includes(body.job.workspaceId), 'PROVIDER_FORBIDDEN', 403);
    requireCondition(request.headers['idempotency-key'] === body.operationId, 'PROVIDER_IDEMPOTENCY_REQUIRED');
    const digest = digestJson(body);
    const recorded = async () => {
      const row = (await db.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4',
        [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId])).rows[0];
      // The same identity with a different request is never a replay.
      if (row) requireCondition(row.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409);
      return row;
    };
    const cached = await recorded();
    // A completed receipt remains retrievable after cancellation so usage can be settled.
    if (cached?.state === 'completed') return outcomeSchema.parse(cached.outcome);
    // Provider retries must resolve the committed host operation, never accept a worker-supplied owner.
    let operation: Awaited<ReturnType<typeof resolveSupervisorOperation>>;
    try { operation = await resolveSupervisorOperation(db, body); }
    catch (error) {
      // The job has ended (cancelled, failed, applied, expired, fenced out), so nothing new may be
      // dispatched. A repeat of a request the gateway already recorded still gets that record's
      // outcome, read-only: no provider call, no dispatch or budget change. Re-read so a dispatch
      // that finished meanwhile answers with its final outcome; one still running is uncertain.
      if (!(error instanceof ApiError && error.code === 'SUPERVISOR_INPUT_STALE')) throw error;
      const replay = await recorded();
      if (!replay) throw error;
      return replay.state === 'in_flight' ? { status: 'uncertain' as const } : outcomeSchema.parse(replay.outcome);
    }
    const admitted = await transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider:${body.operationId}`]);
      const old = (await client.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 FOR UPDATE', [body.operationId])).rows[0];
      if (old) {
        requireCondition(old.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409);
        if (old.state === 'completed') return { invoke: false as const, outcome: outcomeSchema.parse(old.outcome) };
        if (old.state !== 'not_started' || old.owner_id === operation.ownerId) return { invoke: false as const, outcome: old.state === 'not_started' ? outcomeSchema.parse(old.outcome) : { status: 'uncertain' as const } };
        // A new host attempt may reuse the logical ID only after a certified non-start.
        await client.query("UPDATE provider_dispatches SET owner_id=$2,state='in_flight',outcome=NULL,failure_code=NULL,started_at=now(),finished_at=NULL WHERE operation_id=$1", [body.operationId, operation.ownerId]);
      } else {
        requireCondition(operation.operationStatus === 'in_flight', 'PROVIDER_OPERATION_NOT_ADMITTED', 409);
        await client.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state) VALUES ($1,$2,$3,$4,$5,$6,'in_flight')`,
          [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId, operation.ownerId, digest]);
      }
      return { invoke: true as const };
    });
    if (!admitted.invoke) return admitted.outcome;
    let started = false, acquired = false, result = { status: 'uncertain' } as Outcome, usage: unknown = null, candidate: unknown = null, failureCode: string | null = null;
    let modelId: string | null = null, pricing: ModelPricing | null = null, cost: ReceiptCost | null = null, pricingState: 'priced' | 'unpriced' | 'refused' | undefined;
    // Role, checkpoint, outcome, usage counts and cost estimate only; never the request, context or candidate.
    const observed = telemetry(), span = observed.start('provider.operation', { 'course.supervisor.role': body.role, 'course.supervisor.checkpoint': body.checkpoint.id });
    try { await span.run(async () => {
    try {
      if (active >= limit) { result = { status: 'not_started', retryable: true }; failureCode = 'CONCURRENCY_LIMIT'; }
      else {
        active += 1; acquired = true;
        const selected=await options.workspaceProviders?.resolveJob(body.job.jobId,body.job.workspaceId)??runtime;
        // Paid-work admission: the price in force now prices this call. Without one, a
        // workspace that requires prices refuses before any context is read or sent.
        const decision = await pricingDecision(db, body.job.workspaceId, selected, body.role);
        modelId = decision.modelId; pricingState = decision.admit ? decision.pricing ? 'priced' : 'unpriced' : 'refused';
        requireCondition(decision.admit, 'PROVIDER_PRICING_REQUIRED', 409);
        pricing = decision.pricing;
        const context = await teachingContext(db, operation.ref, operation.input.context);
        requireCondition(selected.tokenReservationBound(body.role, context) <= body.checkpoint.allowance.tokens, 'PROVIDER_TOKEN_RESERVATION_TOO_SMALL', 409);
        // Context assembly may have waited; fence one last time before sending data to a provider.
        const fresh=await resolveSupervisorOperation(db, body);
        const signal = AbortSignal.timeout(Math.max(1,Math.min(body.checkpoint.timeoutMs,fresh.remainingMs)));
        started = true;
        const generated = await selected.execute(body.role, context, createHash('sha256').update(body.operationId).digest('hex'), signal,body.role==='supervisor'?supervisorTools(db,body,context,options.adaptation):undefined,async()=>{await resolveSupervisorOperation(db,body);});
        usage = generated.usage; candidate = generated.content;
        requireCondition(JSON.stringify(candidate).length <= 2 * 1024 * 1024, 'PROVIDER_CANDIDATE_TOO_LARGE', 413);
        const value = generated.content as Record<string, unknown>;
        const artifactContent: SupervisorArtifactContent = generated.role === 'companion'
          ? { kind: 'companion_message', text: String(value.text) }
          : (value.kind==='supervised_plan'||value.kind==='research_candidate'||value.kind==='rubric_suggestion')?generated.content as unknown as SupervisorArtifactContent:{ kind: 'proposed_adaptation', summary: typeof value.summary === 'string' ? value.summary : 'Generated candidate requires scoped review before it can become course material.' };
        const artifact = await storeSupervisorArtifact(db, operation.ref, body.operationId, operation.ownerId, artifactContent);
        const totals = generated.usage.attempts.map(attempt => attempt.tokens.total);
        const knownTokens = totals.length > 0 && totals.every(total => total !== null);
        const tokens = knownTokens ? totals.reduce<number>((sum, total) => sum + total!, 0) : body.checkpoint.allowance.tokens;
        // Reported usage times the operator's price version, rounded up in whole micro-USD.
        // Without a price or with any unknown attempt, the full allowance stays charged.
        const priced = pricing ? priceUsage(generated.usage, pricing).cost : null;
        cost = priced && priced.microUsd <= 1_000_000_000 ? priced : null;
        generated.usage.cost = cost;
        if (!cost) pricingState = 'unpriced';
        result = { status: 'succeeded', artifact, usage: { microUsd: cost ? cost.microUsd : body.checkpoint.allowance.microUsd, tokens },
          usageBasis: { microUsd: cost ? 'reported' : 'reserved_ceiling', tokens: knownTokens ? 'reported' : 'reserved_ceiling' } };
      }
    } catch (error) {
      const definitelyNotSent = !started || (error instanceof ProviderError && error.submission === 'not_sent' && !error.usage?.attempts.length);
      // Sent, but every attempt was refused with a documented rejection status (auth, permission,
      // invalid request, rate limit...): the model never ran, so the reservation is released.
      // Anything that might have run (timeouts, 5xx, 529, resets, later tool rounds) stays uncertain.
      const rejected = definitelyNotSent ? null : definiteRejection(error);
      result = definitelyNotSent ? { status: 'not_started', retryable: false }
        : rejected ? { status: 'not_started', retryable: rejected.retryable,
          ...(rejected.retryAfterMs !== null ? { retryAfterMs: Math.min(rejected.retryAfterMs, MAX_RETRY_AFTER_MS) } : {}) }
        : { status: 'uncertain' };
      failureCode = error instanceof ProviderError ? error.code : error instanceof ApiError ? error.code : 'PROVIDER_OPERATION_FAILED';
      if (error instanceof ProviderError) usage = error.usage ?? null;
    } finally { if (acquired) active -= 1; }
    result = outcomeSchema.parse(result);
    }); } finally {
      const final = result, succeeded = final.status === 'succeeded' ? final : null;
      const attributes = { 'course.supervisor.role': body.role, 'course.supervisor.outcome': final.status, 'error.type': failureCode,
        'course.cost.estimate_micro_usd': succeeded?.usage.microUsd, 'course.cost.basis': succeeded ? succeeded.usageBasis?.microUsd ?? 'reported' : undefined,
        'course.usage.total_tokens': succeeded?.usage.tokens, 'course.usage.tokens_basis': succeeded ? succeeded.usageBasis?.tokens ?? 'reported' : undefined,
        'course.cost.pricing': pricingState };
      span.setAttributes(attributes);
      if (failureCode) span.fail(failureCode);
      span.end();
      observed.count('course.provider.operations', 1, attributes);
      if (succeeded) observed.count('course.provider.cost.estimate', succeeded.usage.microUsd, attributes);
    }
    const state = result.status === 'succeeded' ? 'completed' : result.status;
    // Assigned inside the traced callback above; widen what control-flow narrowing assumed.
    const charge = cost as ReceiptCost | null;
    await db.query(`UPDATE provider_dispatches SET state=$2,outcome=$3,provider_usage=$4,candidate=$5,failure_code=$6,finished_at=now(),model_id=$8,pricing_version_id=$9,cost_micro_usd=$10
      WHERE operation_id=$1 AND owner_id=$7`,
      [body.operationId, state, JSON.stringify(result), usage === null ? null : JSON.stringify(usage), candidate === null ? null : JSON.stringify(candidate), failureCode, operation.ownerId,
        modelId, charge ? charge.pricingVersionId : null, charge ? charge.microUsd : null]);
    return result;
  });
}
