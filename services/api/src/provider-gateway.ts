import { courseStrategiesFor } from './course-strategies.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { definiteRejection, ProviderError, priceUsage, type ModelPricing, type ReceiptCost } from '@course-core/providers';
import { MAX_RETRY_AFTER_MS, outcomeSchema, providerRequestSchema, type Outcome, type ProviderRequest } from '@course-core/supervisor';
import { transaction, type Database } from './database.js';
import { afterCommitTransaction, onCommit } from './after-commit.js';
import { ApiError, requireCondition } from './errors.js';
import { digestJson } from './repository.js';
import { endedSupervisorOperationWithin, resolveSupervisorOperation, resolveSupervisorOperationWithin, storeSupervisorArtifact, type SupervisorArtifactContent } from './supervisor-bridge.js';
import { teachingContext } from './provider-context.js';
import type { ProviderRuntime } from './provider-runtime.js';
import {supervisorTools} from './supervisor-tools.js';
import type {WorkspaceProviders} from './provider-setup.js';
import { telemetry } from './telemetry.js';
import { replyDrafts, type ReplyDrafts } from './reply-drafts.js';
import { pricedStatus, pricingDecision } from './provider-costs.js';
import { answeredRefusalReason } from './output-refusal.js';
import { guardCompanionReply } from './companion-check-integrity.js';
import type { TeachingContext } from './agent-strategies.js';
import { dispatchRevision } from './agent-evals/gate.js';
import type { ConfigurationShape } from './agent-evals/revision.js';
import { publicSuite } from './agent-evals/public-suite.js';

import type {AdaptationRuntime} from "./adaptation-store.js";

interface Options { adaptation?:AdaptationRuntime; serviceToken?: string; workspaceIds?: readonly string[]; maxConcurrent?: number;workspaceProviders?:WorkspaceProviders;
  /** The host's provider configuration file, when loaded: the configuration of the fallback runtime. */
  hostConfiguration?: unknown;
  /** Where streamed companion drafts go: the process's own by default; null turns streaming off. */
  drafts?: ReplyDrafts | null }
interface DispatchRow { request_digest: string; owner_id: string; state: string; outcome: Outcome | null }
/** The recorded answer for a repeated request. A dispatch still running is uncertain. A finished
 * dispatch whose outcome was cleared by an erasure made before erasure kept the outcome's
 * non-personal fields is also uncertain: its reservation stays held rather than being guessed. */
function recordedOutcome(row: DispatchRow): Outcome {
  if (row.state === 'in_flight' || row.outcome === null) return { status: 'uncertain' };
  return outcomeSchema.parse(row.outcome);
}
let suite: ReturnType<typeof publicSuite> | undefined;
/** Core's public eval suite, for hosts without a workspace provider vault. */
const defaultSuite = () => (suite ??= publicSuite());
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
    if (cached?.state === 'completed') return recordedOutcome(cached);
    // Provider retries must resolve the committed host operation, never accept a worker-supplied owner.
    let operation: Awaited<ReturnType<typeof resolveSupervisorOperation>>;
    try { operation = await resolveSupervisorOperation(db, body); }
    catch (error) {
      // The job has ended (cancelled, failed, applied, expired, fenced out), so nothing new may be
      // dispatched. A repeat of a request the gateway already recorded still gets that record's
      // outcome, read-only: no provider call, no dispatch or budget change. Re-read so a dispatch
      // that finished meanwhile answers with its final outcome; one still running is uncertain.
      // An erased enrollment's job keeps no snapshot (SUPERVISOR_NOT_FOUND), but its dispatch
      // receipt still answers a repeat.
      if (!(error instanceof ApiError && (error.code === 'SUPERVISOR_INPUT_STALE' || error.code === 'SUPERVISOR_NOT_FOUND'))) throw error;
      const replay = await recorded();
      if (replay) return recordedOutcome(replay);
      if (error.code !== 'SUPERVISOR_INPUT_STALE') throw error;
      // A first request for an ended job: nothing was ever sent for this identity, and nothing
      // may be now. Certify that durably, under the same lock admission takes, so the activity
      // releases its reservation once. The receipt row then blocks any later admission of this
      // operation by its owner, and a dispatch that was admitted first is answered from its own row.
      return transaction(db, async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider:${body.operationId}`]);
        const old = (await client.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 FOR UPDATE', [body.operationId])).rows[0];
        if (old) { requireCondition(old.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409); return recordedOutcome(old); }
        const ended = await endedSupervisorOperationWithin(client, body);
        // Live again (a transient fence) or already succeeded: no certificate; the refusal stands.
        if (!ended || ended.operationStatus === 'succeeded') throw error;
        const outcome: Outcome = { status: 'not_started', retryable: false };
        await client.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,outcome,failure_code,finished_at,trace_id)
          VALUES ($1,$2,$3,$4,$5,$6,'not_started',$7,'SUPERVISOR_JOB_ENDED',now(),$8)`,
          [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId, ended.ownerId, digest, JSON.stringify(outcome), telemetry().traceId()]);
        return outcome;
      });
    }
    const admitted = await transaction(db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider:${body.operationId}`]);
      const old = (await client.query<DispatchRow>('SELECT request_digest,owner_id,state,outcome FROM provider_dispatches WHERE operation_id=$1 FOR UPDATE', [body.operationId])).rows[0];
      if (old) {
        requireCondition(old.request_digest === digest, 'PROVIDER_REQUEST_CONFLICT', 409);
        if (old.state === 'completed') return { invoke: false as const, outcome: recordedOutcome(old) };
        if (old.state !== 'not_started' || old.owner_id === operation.ownerId) return { invoke: false as const, outcome: old.state === 'not_started' ? recordedOutcome(old) : { status: 'uncertain' as const } };
        // A new host attempt may reuse the logical ID only after a certified non-start.
        // The row now describes the new attempt, so it links that attempt's trace (or none).
        await client.query("UPDATE provider_dispatches SET owner_id=$2,state='in_flight',outcome=NULL,failure_code=NULL,started_at=now(),finished_at=NULL,sent_at=NULL,trace_id=$3 WHERE operation_id=$1",
          [body.operationId, operation.ownerId, telemetry().traceId()]);
      } else {
        requireCondition(operation.operationStatus === 'in_flight', 'PROVIDER_OPERATION_NOT_ADMITTED', 409);
        await client.query(`INSERT INTO provider_dispatches (operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,trace_id) VALUES ($1,$2,$3,$4,$5,$6,'in_flight',$7)`,
          [body.operationId, body.job.jobId, body.job.enrollmentId, body.job.workspaceId, operation.ownerId, digest, telemetry().traceId()]);
      }
      return { invoke: true as const };
    });
    if (!admitted.invoke) return admitted.outcome;
    /** A completed reply the adapter refused, recorded as a refusal artifact (reason code only, never
     * the reply) and priced at its reported usage. Null when the outcome stays uncertain: an
     * attempt without a read response or reported total, a role without a refusal record, or a
     * refusal that could not be stored. */
    const settleRefusedAnswer = async (error: ProviderError, context: TeachingContext | null) => {
      const reason = answeredRefusalReason(error), receipt = error.usage;
      if (!reason || !receipt) return null;
      const content: SupervisorArtifactContent | null = body.role === 'companion' || body.role === 'supervisor'
        ? { kind: 'output_refusal', role: body.role, reason }
        : body.role === 'reviewer' && context?.rubricReview
          ? { kind: 'rubric_refusal', requestId: context.rubricReview.requestId, attemptId: context.rubricReview.attemptId, reason: 'host_check_failed', problems: [reason] }
          : null;
      if (!content) return null;
      let artifact: Awaited<ReturnType<typeof storeSupervisorArtifact>>;
      try { artifact = await storeSupervisorArtifact(db, operation.ref, body.operationId, operation.ownerId, content); }
      catch { return null; }
      const tokens = receipt.attempts.reduce((sum, attempt) => sum + attempt.tokens.total!, 0);
      const priced = pricing ? priceUsage(receipt, pricing).cost : null;
      const charge = priced && priced.microUsd <= 1_000_000_000 ? priced : null;
      receipt.cost = charge;
      const outcome: Outcome = { status: 'succeeded', artifact, usage: { microUsd: charge ? charge.microUsd : body.checkpoint.allowance.microUsd, tokens },
        usageBasis: { microUsd: charge ? 'reported' : 'reserved_ceiling', tokens: 'reported' } };
      return { outcome, cost: charge };
    };
    let assembled: TeachingContext | null = null;
    let draft: ReturnType<ReplyDrafts['open']> = null;
    let started = false, acquired = false, result = { status: 'uncertain' } as Outcome, usage: unknown = null, candidate: unknown = null, failureCode: string | null = null;
    let modelId: string | null = null, pricing: ModelPricing | null = null, cost: ReceiptCost | null = null, pricingState: 'priced' | 'unpriced' | 'refused' | undefined;
    // Which strategy answered and the revision it ran as, recorded on the dispatch (requirement B08).
    let ran: { id: string; version: string; source: 'core' | 'course'; revisionDigest: string | null; standing: string } | null = null;
    // Role, checkpoint, outcome, usage counts and cost estimate only; never the request, context or candidate.
    const observed = telemetry(), span = observed.start('provider.operation', { 'course.supervisor.role': body.role, 'course.supervisor.checkpoint': body.checkpoint.id });
    let counted: Record<string, string | number | null | undefined> = {};
    try { await span.run(async () => {
    try {
      if (active >= limit) { result = { status: 'not_started', retryable: true }; failureCode = 'CONCURRENCY_LIMIT'; }
      else {
        active += 1; acquired = true;
        const resolved = options.workspaceProviders ? await options.workspaceProviders.resolveJobConfigured(body.job.jobId, body.job.workspaceId)
          : { runtime, configuration: null, key: 'host' };
        const selected = resolved.runtime;
        // Paid-work admission: the price in force now prices this call. Without one, a
        // workspace that requires prices refuses before any context is read or sent.
        const decision = await pricingDecision(db, body.job.workspaceId, selected, body.role);
        modelId = decision.modelId; pricingState = decision.admit ? decision.pricing ? 'priced' : 'unpriced' : 'refused';
        requireCondition(decision.admit, 'PROVIDER_PRICING_REQUIRED', 409);
        pricing = decision.pricing;
        const context = await teachingContext(db, operation.ref, operation.input.context);
        assembled = context;
        // Strategies the course release declared, bound by Core to narrow its own (course-strategies.ts).
        // A declaration's tool references name tools the course declares, so both are read.
        const release = (await db.query<{ digest: string; strategies: unknown; tools: unknown }>(`SELECT r.digest,r.server_bundle->'agentStrategies' AS strategies,
          r.server_bundle->'tools' AS tools FROM enrollments e
          JOIN course_releases r ON r.id=e.course_release_id AND r.workspace_id=e.workspace_id WHERE e.id=$1 AND e.workspace_id=$2`, [body.job.enrollmentId, body.job.workspaceId])).rows[0];
        const course = release?.strategies ? courseStrategiesFor(release.digest, { agentStrategies: release.strategies, tools: release.tools ?? undefined }) : [];
        const selection = selected.selection(body.role, course);
        if (selection) {
          const configuration = (resolved.configuration ?? (resolved.key === 'host' ? options.hostConfiguration ?? null : null)) as ConfigurationShape | null;
          const revision = await dispatchRevision(db, { workspace: body.job.workspaceId, suite: options.workspaceProviders?.evalSuite ?? defaultSuite(),
            configuration, configurationKey: configuration ? resolved.key : null, role: body.role, strategy: selection.strategy, source: selection.source });
          ran = { id: selection.strategy.contract.id, version: selection.strategy.contract.version, source: selection.source, ...revision };
          // A course's own strategy answers only once its exact revision has a passing check or an
          // owner's approval (agent-evals/gate.ts). Core's wider strategy never runs in its place.
          requireCondition(selection.source === 'core' || revision.standing === 'passed' || revision.standing === 'approved', 'COURSE_STRATEGY_NOT_CHECKED', 409);
        }
        requireCondition(selected.tokenReservationBound(body.role, context, course) <= body.checkpoint.allowance.tokens, 'PROVIDER_TOKEN_RESERVATION_TOO_SMALL', 409);
        // Context assembly may have waited; fence one last time before sending data to a provider,
        // and record that this dispatch may now be sent, in one transaction under the enrollment
        // lock. Until then the dispatch has certainly not reached a provider: data erasure releases
        // its reservation and closes the receipt, and this fence then refuses (never sent).
        const fresh = await transaction(db, async client => {
          const resolved = await resolveSupervisorOperationWithin(client, body);
          const marked = await client.query("UPDATE provider_dispatches SET sent_at=clock_timestamp() WHERE operation_id=$1 AND owner_id=$2 AND state='in_flight' AND sent_at IS NULL",
            [body.operationId, operation.ownerId]);
          requireCondition(marked.rowCount === 1, 'PROVIDER_DISPATCH_CLOSED', 409);
          return resolved;
        });
        const signal = AbortSignal.timeout(Math.max(1,Math.min(body.checkpoint.timeoutMs,fresh.remainingMs)));
        started = true;
        // A companion answer streams to the learner as a draft while it arrives (reply-drafts.ts):
        // only now, after admission, pricing, the reservation check and the last fence, and only
        // the text the strategy receives. The final result below is still the only stored output.
        const messageId = (operation.input.context as { messageId?: unknown }).messageId;
        draft = body.role === 'companion' && typeof messageId === 'string' && options.drafts !== null
          ? (options.drafts ?? replyDrafts()).open({ enrollmentId: body.job.enrollmentId, jobId: body.job.jobId, messageId }) : null;
        const generated = await selected.execute(body.role, context, createHash('sha256').update(body.operationId).digest('hex'), signal,body.role==='supervisor'?supervisorTools(db,body,context,options.adaptation):undefined,async()=>{await resolveSupervisorOperation(db,body);},course,
          draft ? draft.push : undefined);
        usage = generated.usage;
        // Graded-check integrity (companion-check-integrity.ts): a reply in check-coaching mode that
        // gives away a matched check's answer is withheld here, before anything of it is stored or its
        // draft completed; Core's coaching message takes its place, charged at this call's usage.
        const guarded = generated.role === 'companion'
          ? await guardCompanionReply(db, { workspaceId: body.job.workspaceId, courseReleaseId: operation.input.context.courseReleaseId }, context.question, generated.content)
          : { content: generated.content, withheld: null };
        if (guarded.withheld) draft?.withdraw('check_answer_withheld');
        candidate = guarded.content;
        requireCondition(JSON.stringify(candidate).length <= 2 * 1024 * 1024, 'PROVIDER_CANDIDATE_TOO_LARGE', 413);
        const value = guarded.content as Record<string, unknown>;
        const artifactContent: SupervisorArtifactContent = value.kind === 'output_refusal' ? guarded.content as unknown as SupervisorArtifactContent
          : generated.role === 'companion'
          ? { kind: 'companion_message', text: String(value.text), ...(value.cutShort === true ? { cutShort: true as const } : {}),
            ...(guarded.withheld ? { withheld: guarded.withheld } : {}) }
          : (value.kind==='supervised_plan'||value.kind==='research_candidate'||value.kind==='rubric_suggestion'||value.kind==='rubric_refusal')?generated.content as unknown as SupervisorArtifactContent:{ kind: 'proposed_adaptation', summary: typeof value.summary === 'string' ? value.summary : 'Generated candidate requires scoped review before it can become course material.' };
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
        // The draft ends with the answer Core kept, or is withdrawn when Core refused it.
        if (value.kind === 'output_refusal') draft?.withdraw('output_refused'); else draft?.complete();
        result = { status: 'succeeded', artifact, usage: { microUsd: cost ? cost.microUsd : body.checkpoint.allowance.microUsd, tokens },
          usageBasis: { microUsd: cost ? 'reported' : 'reserved_ceiling', tokens: knownTokens ? 'reported' : 'reserved_ceiling' } };
      }
    } catch (error) {
      // The provider answered in full and reported its usage, but the adapter's own checks refused
      // the reply (cut off at the output limit, malformed, blocked): a definite outcome, charged at
      // the reported usage like any answer and then rejected by the verifier, never an uncertain one.
      const refusedAnswer = started && error instanceof ProviderError ? await settleRefusedAnswer(error, assembled) : null;
      if (refusedAnswer) {
        draft?.withdraw(error instanceof ProviderError && error.code === 'BLOCKED' ? 'provider_refused' : 'output_refused');
        usage = error instanceof ProviderError ? error.usage ?? null : null; failureCode = error instanceof ProviderError ? error.code : null;
        cost = refusedAnswer.cost; if (!cost) pricingState = 'unpriced';
        result = refusedAnswer.outcome;
      } else {
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
      draft?.withdraw(error instanceof ProviderError && error.code === 'BLOCKED' ? 'provider_refused' : 'provider_failed');
      if (error instanceof ProviderError) usage = error.usage ?? null;
      }
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
      counted = attributes;
    }
    const state = result.status === 'succeeded' ? 'completed' : result.status;
    // Assigned inside the traced callback above; widen what control-flow narrowing assumed.
    const charge = cost as ReceiptCost | null;
    const final = result;
    // A response that arrives after the learner's data was erased keeps only what erasure keeps: the
    // generated candidate is dropped. Erasure holds the enrollment row while it redacts, so waiting
    // for a share lock on it orders this write before or after the whole erasure. The spend ledger
    // is not touched here; erasure already finished this operation's reservation.
    await afterCommitTransaction(db, async client => {
      const erased = (await client.query<{ status: string }>('SELECT status FROM enrollments WHERE id=$1 FOR SHARE', [body.job.enrollmentId])).rows[0]?.status === 'erased';
      const strategy = ran as { id: string; version: string; source: 'core' | 'course'; revisionDigest: string | null; standing: string } | null;
      const stored = await client.query(`UPDATE provider_dispatches SET state=$2,outcome=$3,provider_usage=$4,candidate=$5,failure_code=$6,finished_at=now(),model_id=$8,pricing_version_id=$9,cost_micro_usd=$10,
          strategy_id=$11,strategy_version=$12,strategy_source=$13,role_revision_digest=$14,eval_standing=$15
        WHERE operation_id=$1 AND owner_id=$7`,
        [body.operationId, state, JSON.stringify(result), usage === null ? null : JSON.stringify(usage), candidate === null || erased ? null : JSON.stringify(candidate), failureCode, operation.ownerId,
          modelId, charge ? charge.pricingVersionId : null, charge ? charge.microUsd : null,
          strategy?.id.slice(0, 200) ?? null, strategy?.version.slice(0, 64) ?? null, strategy?.source ?? null, strategy?.revisionDigest ?? null, strategy?.standing ?? null]);
      // Counted once the receipt is committed: a failed or superseded write reports nothing, and a
      // retried request answered from the stored receipt never reaches this point.
      if (stored.rowCount === 1) onCommit(client, () => {
        observed.count('course.provider.operations', 1, counted);
        if (final.status === 'succeeded') observed.count('course.provider.cost.estimate', final.usage.microUsd, counted);
      });
    });
    return result;
  });
}
