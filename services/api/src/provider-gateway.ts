import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ProviderError } from '@course-core/providers';
import { outcomeSchema, providerRequestSchema, type Outcome, type ProviderRequest } from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { ApiError, requireCondition } from './errors.js';
import { digestJson } from './repository.js';
import { resolveSupervisorOperation, storeSupervisorArtifact, type SupervisorArtifactContent } from './supervisor-bridge.js';
import { teachingContext } from './provider-context.js';
import type { ProviderRuntime } from './provider-runtime.js';
import {supervisorTools} from './supervisor-tools.js';
import type {WorkspaceProviders} from './provider-setup.js';

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
  app.get('/v1/capabilities',{schema:{querystring:{type:'object',additionalProperties:false,properties:{workspaceId:{type:'string',format:'uuid'}}}}}, async request => { authorize(request);const {workspaceId} = request.query as {workspaceId?:string};if(workspaceId){requireCondition(options.workspaceIds?.includes(workspaceId),'PROVIDER_FORBIDDEN',403);return (await options.workspaceProviders?.resolve(workspaceId)??runtime).status();}return runtime.status(); });
  app.post('/v1/operations', { bodyLimit: 262144, logLevel: 'silent' }, async (request, reply) => {
    authorize(request);
    const parsed = providerRequestSchema.safeParse(request.body);
    requireCondition(parsed.success, 'PROVIDER_INVALID_REQUEST');
    const body = parsed.data;
    requireCondition(options.workspaceIds?.includes(body.job.workspaceId), 'PROVIDER_FORBIDDEN', 403);
    requireCondition(request.headers['idempotency-key'] === body.operationId, 'PROVIDER_IDEMPOTENCY_REQUIRED');
    const digest = digestJson(body);
    const cached = (await db.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4',
      [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId])).rows[0];
    if (cached) {
      requireCondition(cached.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409);
      // A completed receipt remains retrievable after cancellation so usage can be settled.
      if (cached.state === 'completed') return outcomeSchema.parse(cached.outcome);
    }
    // Provider retries must resolve the committed host operation, never accept a worker-supplied owner.
    const operation = await resolveSupervisorOperation(db, body);
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
    let started = false, acquired = false, result: Outcome = { status: 'uncertain' }, usage: unknown = null, candidate: unknown = null, failureCode: string | null = null;
    try {
      if (active >= limit) { result = { status: 'not_started', retryable: true }; failureCode = 'CONCURRENCY_LIMIT'; }
      else {
        active += 1; acquired = true;
        const selected=await options.workspaceProviders?.resolveJob(body.job.jobId,body.job.workspaceId)??runtime;
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
        // This is conservative application allowance consumption, not a provider invoice.
        result = { status: 'succeeded', artifact, usage: { microUsd: body.checkpoint.allowance.microUsd, tokens },
          usageBasis: { microUsd: 'reserved_ceiling', tokens: knownTokens ? 'reported' : 'reserved_ceiling' } };
      }
    } catch (error) {
      const definitelyNotSent = !started || (error instanceof ProviderError && error.submission === 'not_sent' && !error.usage?.attempts.length);
      result = definitelyNotSent ? { status: 'not_started', retryable: false } : { status: 'uncertain' };
      failureCode = error instanceof ProviderError ? error.code : error instanceof ApiError ? error.code : 'PROVIDER_OPERATION_FAILED';
      if (error instanceof ProviderError) usage = error.usage ?? null;
    } finally { if (acquired) active -= 1; }
    result = outcomeSchema.parse(result);
    const state = result.status === 'succeeded' ? 'completed' : result.status;
    await db.query('UPDATE provider_dispatches SET state=$2,outcome=$3,provider_usage=$4,candidate=$5,failure_code=$6,finished_at=now() WHERE operation_id=$1 AND owner_id=$7',
      [body.operationId, state, JSON.stringify(result), usage === null ? null : JSON.stringify(usage), candidate === null ? null : JSON.stringify(candidate), failureCode, operation.ownerId]);
    return result;
  });
}
